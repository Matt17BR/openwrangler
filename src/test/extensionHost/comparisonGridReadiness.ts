export interface ComparisonGridReadinessInput {
  readonly headers: readonly [string, string];
  readonly bodyContent:
    | {
        readonly kind: "exact";
        readonly topLeftValues: readonly [readonly [string, string], readonly [string, string]];
      }
    | {
        readonly kind: "minimum-nonempty";
        readonly count: 1 | 2 | 3 | 4;
      };
}

export interface ComparisonGridReadinessEvidence {
  readonly rootRole: "grid" | "table";
  readonly busy: "false" | "absent";
  readonly visible: true;
  readonly pointerUsable: true;
  readonly geometryStableFrames: 2;
  readonly headers: readonly [string, string];
  readonly bodyContentMatched: true;
  readonly ariaRowCount: number | null;
  readonly ariaColumnCount: number | null;
}

interface ComparisonRectangle {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface ComparisonGridElement {
  readonly isConnected: boolean;
  readonly parentElement: ComparisonGridElement | null;
  readonly textContent: string | null;
  readonly tagName?: string;
  getAttribute(name: string): string | null;
  contains(candidate: ComparisonGridElement | null): boolean;
  getBoundingClientRect(): ComparisonRectangle;
  querySelectorAll(selector: string): ArrayLike<ComparisonGridElement>;
}

export interface ComparisonGridRuntime {
  readonly document: {
    readonly documentElement?: {
      readonly clientWidth: number;
      readonly clientHeight: number;
    };
    elementFromPoint(x: number, y: number): ComparisonGridElement | null;
    getElementById(id: string): ComparisonGridElement | null;
    querySelectorAll(selector: string): ArrayLike<ComparisonGridElement>;
  };
  readonly innerWidth: number;
  readonly innerHeight: number;
  requestAnimationFrame(callback: (timestamp: number) => void): number;
  getComputedStyle(element: ComparisonGridElement): {
    readonly display: string;
    readonly visibility: string;
    readonly opacity: string;
  };
}

export const DEFAULT_COMPARISON_GRID_READINESS_INPUT: ComparisonGridReadinessInput = Object.freeze({
  headers: Object.freeze(["c00", "c01"] as const),
  bodyContent: Object.freeze({
    kind: "exact",
    topLeftValues: Object.freeze([Object.freeze(["0", "1"] as const), Object.freeze(["1", "2"] as const)] as const)
  })
});

/**
 * Runs through Playwright's `frame.evaluate`. Every dependency intentionally
 * lives inside this function so the observable remains closure-free and cannot
 * depend on either product's implementation details.
 */
export function observeComparisonGridReadiness(
  input: ComparisonGridReadinessInput,
  runtimeOverride?: ComparisonGridRuntime
): Promise<ComparisonGridReadinessEvidence | null> {
  const browser = globalThis as unknown as ComparisonGridRuntime;
  const runtime = runtimeOverride ?? browser;

  type Snapshot = {
    evidence: ComparisonGridReadinessEvidence;
    geometry: readonly number[];
  };

  const validText = (value: unknown): value is string =>
    typeof value === "string" && value.length >= 1 && value.length <= 64 && !/[\0\r\n]/u.test(value);
  const validHeader = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/u.test(value);
  const expectedHeaders =
    Array.isArray(input?.headers) &&
    input.headers.length === 2 &&
    validHeader(input.headers[0]) &&
    validHeader(input.headers[1]) &&
    input.headers[0] !== input.headers[1]
      ? input.headers
      : undefined;
  const bodyContent = input?.bodyContent;
  const expectedValues =
    bodyContent?.kind === "exact" &&
    Object.keys(bodyContent).length === 2 &&
    Array.isArray(bodyContent.topLeftValues) &&
    bodyContent.topLeftValues.length === 2 &&
    Array.isArray(bodyContent.topLeftValues[0]) &&
    bodyContent.topLeftValues[0].length === 2 &&
    Array.isArray(bodyContent.topLeftValues[1]) &&
    bodyContent.topLeftValues[1].length === 2 &&
    bodyContent.topLeftValues.every((row) => row.every((value) => validText(value)))
      ? bodyContent.topLeftValues
      : undefined;
  const minimumNonEmptyValues =
    bodyContent?.kind === "minimum-nonempty" &&
    Object.keys(bodyContent).length === 2 &&
    Number.isSafeInteger(bodyContent.count) &&
    bodyContent.count >= 1 &&
    bodyContent.count <= 4
      ? bodyContent.count
      : undefined;
  if (!expectedHeaders || (expectedValues === undefined && minimumNonEmptyValues === undefined)) {
    return Promise.resolve(null);
  }

  const viewportWidth = runtime.innerWidth || runtime.document.documentElement?.clientWidth || 0;
  const viewportHeight = runtime.innerHeight || runtime.document.documentElement?.clientHeight || 0;
  if (viewportWidth <= 0 || viewportHeight <= 0) return Promise.resolve(null);
  const viewport: ComparisonRectangle = {
    top: 0,
    right: viewportWidth,
    bottom: viewportHeight,
    left: 0,
    width: viewportWidth,
    height: viewportHeight
  };

  const normalizeText = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const accessibleName = (element: ComparisonGridElement): string => {
    const direct = normalizeText(element.getAttribute("aria-label"));
    if (direct) return direct;
    const labelledBy = normalizeText(element.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const labels = labelledBy
        .split(" ")
        .map((id) => runtime.document.getElementById(id))
        .filter((label): label is ComparisonGridElement => label !== null)
        .map((label) => normalizeText(label.textContent))
        .filter(Boolean);
      if (labels.length > 0) return labels.join(" ");
    }
    return normalizeText(element.textContent);
  };
  const headerNameMatches = (actual: string, expected: string): boolean =>
    actual === expected || new RegExp(`^${expected}(?:\\s|[,;:()\\[\\]{}\\u2013\\u2014-])`, "u").test(actual);
  const rectanglesIntersect = (left: ComparisonRectangle, right: ComparisonRectangle): boolean =>
    left.right > right.left && left.left < right.right && left.bottom > right.top && left.top < right.bottom;
  const hasVisibleStyle = (element: ComparisonGridElement, root: ComparisonGridElement): boolean => {
    let current: ComparisonGridElement | null = element;
    while (current) {
      const style = runtime.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      if (current === root) return true;
      current = current.parentElement;
    }
    return false;
  };
  const visibleRectangle = (
    element: ComparisonGridElement,
    root: ComparisonGridElement,
    rootRectangle: ComparisonRectangle
  ): ComparisonRectangle | undefined => {
    if (!element.isConnected || !hasVisibleStyle(element, root)) return undefined;
    const rectangle = element.getBoundingClientRect();
    if (
      rectangle.width <= 0 ||
      rectangle.height <= 0 ||
      !rectanglesIntersect(rectangle, rootRectangle) ||
      !rectanglesIntersect(rectangle, viewport)
    ) {
      return undefined;
    }
    return rectangle;
  };
  const headerMatches = (
    element: ComparisonGridElement,
    expected: string,
    root: ComparisonGridElement,
    rootRectangle: ComparisonRectangle
  ): boolean => {
    if (headerNameMatches(accessibleName(element), expected)) return true;
    const leafDescendants = Array.from(element.querySelectorAll("*"))
      .slice(0, 512)
      .filter((candidate) => candidate.querySelectorAll("*").length === 0);
    return leafDescendants.some(
      (candidate) =>
        normalizeText(candidate.textContent) === expected &&
        visibleRectangle(candidate, root, rootRectangle) !== undefined
    );
  };
  const parseOptionalCount = (value: string | null): number | null | undefined => {
    if (value === null) return null;
    if (!/^[1-9]\d*$/u.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  const rectangleFingerprint = (rectangle: ComparisonRectangle): number[] =>
    [rectangle.top, rectangle.right, rectangle.bottom, rectangle.left, rectangle.width, rectangle.height].map(
      (value) => Math.round(value * 1_000) / 1_000
    );
  const pointerHits = (element: ComparisonGridElement, rectangle: ComparisonRectangle): boolean => {
    const left = Math.max(0, rectangle.left);
    const right = Math.min(viewportWidth, rectangle.right);
    const top = Math.max(0, rectangle.top);
    const bottom = Math.min(viewportHeight, rectangle.bottom);
    if (right <= left || bottom <= top) return false;
    const hit = runtime.document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return hit !== null && (hit === element || element.contains(hit));
  };

  const snapshot = (): Snapshot | undefined => {
    const roots = Array.from(runtime.document.querySelectorAll('[role="grid"], [role="table"], table')).slice(0, 64);
    for (const root of roots) {
      if (!root.isConnected) continue;
      const explicitRole = normalizeText(root.getAttribute("role")).toLowerCase();
      if (explicitRole === "presentation" || explicitRole === "none") continue;
      const rootRole =
        explicitRole === "grid"
          ? "grid"
          : explicitRole === "table" || root.tagName?.toLowerCase() === "table"
            ? "table"
            : undefined;
      if (!rootRole) continue;
      const busyAttribute = root.getAttribute("aria-busy");
      const busy =
        busyAttribute === null
          ? "absent"
          : normalizeText(busyAttribute).toLowerCase() === "false"
            ? "false"
            : undefined;
      if (!busy) continue;
      if (!hasVisibleStyle(root, root)) continue;
      const rootRectangle = root.getBoundingClientRect();
      if (rootRectangle.width <= 0 || rootRectangle.height <= 0 || !rectanglesIntersect(rootRectangle, viewport)) {
        continue;
      }
      const ariaRowCount = parseOptionalCount(root.getAttribute("aria-rowcount"));
      const ariaColumnCount = parseOptionalCount(root.getAttribute("aria-colcount"));
      if (ariaRowCount === undefined || ariaColumnCount === undefined) continue;

      const rows = Array.from(root.querySelectorAll('[role="row"], tr')).slice(0, 512);
      let headerRow: ComparisonGridElement | undefined;
      let headerElements: ComparisonGridElement[] = [];
      let firstHeaderIndex = -1;
      for (const row of rows) {
        const headers = Array.from(
          row.querySelectorAll('[role="columnheader"], [role="rowheader"], [role="gridcell"], [role="cell"], th, td')
        ).slice(0, 2_048);
        for (let index = 0; index + 1 < headers.length; index += 1) {
          if (
            headerMatches(headers[index], expectedHeaders[0], root, rootRectangle) &&
            headerMatches(headers[index + 1], expectedHeaders[1], root, rootRectangle)
          ) {
            headerRow = row;
            headerElements = headers;
            firstHeaderIndex = index;
            break;
          }
        }
        if (headerRow) break;
      }
      if (!headerRow || firstHeaderIndex < 0) continue;

      const bodyRows = rows
        .filter((row) => row !== headerRow)
        .map((row) => ({
          row,
          cells: Array.from(row.querySelectorAll('[role="rowheader"], [role="gridcell"], [role="cell"], th, td')).slice(
            0,
            2_048
          )
        }))
        .filter(({ cells }) => cells.length > firstHeaderIndex + 1)
        .slice(0, 2);
      if (bodyRows.length !== 2) continue;

      const observedValues = bodyRows.map(({ cells }) => [
        normalizeText(cells[firstHeaderIndex].textContent),
        normalizeText(cells[firstHeaderIndex + 1].textContent)
      ]);
      if (
        expectedValues
          ? observedValues.some((row, rowIndex) =>
              row.some((value, columnIndex) => value !== expectedValues[rowIndex][columnIndex])
            )
          : observedValues.flat().filter((value) => value.length > 0).length < (minimumNonEmptyValues as number)
      ) {
        continue;
      }

      const requiredElements = [
        headerElements[firstHeaderIndex],
        headerElements[firstHeaderIndex + 1],
        bodyRows[0].cells[firstHeaderIndex],
        bodyRows[0].cells[firstHeaderIndex + 1],
        bodyRows[1].cells[firstHeaderIndex],
        bodyRows[1].cells[firstHeaderIndex + 1]
      ];
      const rectangles = requiredElements.map((element) => visibleRectangle(element, root, rootRectangle));
      if (rectangles.some((rectangle) => rectangle === undefined)) continue;
      const firstSentinelRectangle = rectangles[2] as ComparisonRectangle;
      if (!pointerHits(bodyRows[0].cells[firstHeaderIndex], firstSentinelRectangle)) continue;
      return {
        evidence: {
          rootRole,
          busy,
          visible: true,
          pointerUsable: true,
          geometryStableFrames: 2,
          headers: [expectedHeaders[0], expectedHeaders[1]],
          bodyContentMatched: true,
          ariaRowCount,
          ariaColumnCount
        },
        geometry: [
          ...rectangleFingerprint(rootRectangle),
          ...rectangles.flatMap((rectangle) => rectangleFingerprint(rectangle as ComparisonRectangle))
        ]
      };
    }
    return undefined;
  };

  const nextFrame = (): Promise<Snapshot | undefined> =>
    new Promise((resolve) => {
      runtime.requestAnimationFrame(() => resolve(snapshot()));
    });

  return nextFrame().then((first) => {
    if (!first) return null;
    return nextFrame().then((second) => {
      if (
        !second ||
        JSON.stringify(first.evidence) !== JSON.stringify(second.evidence) ||
        JSON.stringify(first.geometry) !== JSON.stringify(second.geometry)
      ) {
        return null;
      }
      return second.evidence;
    });
  });
}
