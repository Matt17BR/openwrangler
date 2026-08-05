interface NotebookRendererDocument extends NotebookRendererElement {
  readonly readyState: string;
}

interface NotebookRendererElement {
  readonly contentDocument?: NotebookRendererDocument | null;
  readonly isConnected: boolean;
  readonly parentElement: NotebookRendererElement | null;
  readonly textContent: string | null;
  closest(selector: string): NotebookRendererElement | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): NotebookRendererElement | null;
  querySelectorAll(selector: string): ArrayLike<NotebookRendererElement>;
}

/** Resolve one public action from a settled renderer guest with known preview labels. */
export function findExactActiveNotebookPreviewButton({
  expectedButtonNames,
  requiredLabels
}: {
  readonly expectedButtonNames: readonly string[];
  readonly requiredLabels: readonly string[];
}): unknown | null {
  const outerDocument = (globalThis as unknown as { readonly document: NotebookRendererDocument }).document;
  const activeFrames = Array.from(outerDocument.querySelectorAll("iframe#active-frame"));
  const pendingFrames = Array.from(outerDocument.querySelectorAll("iframe#pending-frame"));
  if (activeFrames.length !== 1 || pendingFrames.length !== 0) return null;
  const activeFrame = activeFrames[0];
  const innerDocument = activeFrame?.isConnected ? activeFrame.contentDocument : null;
  if (!innerDocument || innerDocument.readyState === "loading") return null;

  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const expected = new Set(expectedButtonNames);
  const outputSelector =
    "section.openwrangler-notebook, [data-output-id], [data-notebook-output], [data-vscode-notebook-output], .cell-output, .notebook-output, .output_container";
  const matches = Array.from(innerDocument.querySelectorAll('button, [role="button"]')).filter((button) => {
    const name = normalize(button.getAttribute("aria-label") || button.textContent || button.getAttribute("title"));
    if (!button.isConnected || !expected.has(name)) return false;
    const root = button.closest(outputSelector) ?? innerDocument;
    const semanticItems = Array.from(root.querySelectorAll('[role="columnheader"], [role="cell"], th, td')).slice(
      0,
      20_001
    );
    if (semanticItems.length <= 20_000) {
      const semanticLabels = new Set(semanticItems.map((element) => normalize(element.textContent)));
      if (requiredLabels.every((label) => semanticLabels.has(label))) return true;
    }
    const descendants = Array.from(root.querySelectorAll("*")).slice(0, 4_097);
    if (descendants.length > 4_096) return false;
    const labels = new Set(
      descendants
        .filter((element) => element.isConnected && element.querySelectorAll("*").length === 0)
        .map((element) => normalize(element.textContent))
    );
    return requiredLabels.every((label) => labels.has(label));
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve an action only through VS Code's authoritative notebook renderer
 * guest. During output replacement VS Code can retain a visible old guest
 * while a pending guest is being promoted; either representation may contain
 * working DOM, but only the single settled active frame owns authoritative
 * renderer messaging.
 *
 * This function is closure-free because Playwright serializes it into the
 * candidate notebook wrapper frame.
 */
export function findExactActiveNotebookRendererButton({
  expectedLabel,
  expectedButtonName
}: {
  readonly expectedLabel: string;
  readonly expectedButtonName: string;
}): unknown | null {
  const outerDocument = (globalThis as unknown as { readonly document: NotebookRendererDocument }).document;
  const activeFrames = Array.from(outerDocument.querySelectorAll("iframe#active-frame"));
  const pendingFrames = Array.from(outerDocument.querySelectorAll("iframe#pending-frame"));
  if (activeFrames.length !== 1 || pendingFrames.length !== 0) return null;

  const activeFrame = activeFrames[0];
  if (!activeFrame?.isConnected) return null;
  const innerDocument = activeFrame.contentDocument;
  if (!innerDocument || innerDocument.readyState === "loading") return null;

  const titlePrefix = `Open Wrangler preview: ${expectedLabel} (`;
  const matches = Array.from(innerDocument.querySelectorAll("section.openwrangler-notebook")).flatMap((section) => {
    const title = section.querySelector("header > span")?.textContent ?? "";
    if (!title.startsWith(titlePrefix)) return [];
    return Array.from(section.querySelectorAll("button")).filter(
      (button) => button.isConnected && (button.textContent ?? "").trim() === expectedButtonName
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Verifies that a launch action and deterministic preview sentinels share one output boundary. */
export function observeInlinePreviewReady(
  elementValue: unknown,
  input: {
    readonly actionName: string;
    readonly firstColumn: string;
    readonly secondColumn: string;
    readonly requiredCellValues: readonly string[];
  }
): boolean {
  type Candidate = {
    readonly isConnected: boolean;
    readonly ownerDocument: Boundary & {
      readonly defaultView: {
        readonly frameElement: { getAttribute(name: string): string | null } | null;
        getComputedStyle(value: unknown): {
          readonly display: string;
          readonly visibility: string;
          readonly opacity: string;
        };
      } | null;
    };
    readonly parentElement: Candidate | null;
    readonly textContent: string | null;
    closest(selector: string): Candidate | null;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): { readonly width: number; readonly height: number };
    querySelectorAll(selector: string): ArrayLike<Candidate>;
  };
  type Boundary = { querySelectorAll(selector: string): ArrayLike<Candidate> };

  const action = elementValue as Candidate;
  const window_ = action?.ownerDocument?.defaultView;
  if (!action?.isConnected || !window_) return false;
  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const actionName = normalize(action.getAttribute("aria-label") || action.textContent || action.getAttribute("title"));
  if (actionName !== input.actionName) return false;

  const outputSelector =
    "section.openwrangler-notebook, [data-output-id], [data-notebook-output], [data-vscode-notebook-output], .cell-output, .notebook-output, .output_container";
  const outputRoot = action.closest(outputSelector);
  const activeFrameDocument = window_.frameElement?.getAttribute("id") === "active-frame" ? action.ownerDocument : null;
  const root: Boundary | null = outputRoot ?? activeFrameDocument;
  if (!root) return false;

  const visible = (candidate: Candidate): boolean => {
    if (!candidate.isConnected) return false;
    const box = candidate.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    let current: Candidate | null = candidate;
    while (current) {
      const style = window_.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      current = current.parentElement;
    }
    return true;
  };
  const tables = Array.from(root.querySelectorAll('[role="grid"], [role="table"], table')).slice(0, 64);
  const semanticTableReady = tables.some((table) => {
    if (!visible(table)) return false;
    const headers = Array.from(table.querySelectorAll('[role="columnheader"], th')).map((item) =>
      normalize(item.textContent)
    );
    if (!headers.some((text) => text === input.firstColumn || text.startsWith(`${input.firstColumn} `))) return false;
    if (!headers.some((text) => text === input.secondColumn || text.startsWith(`${input.secondColumn} `))) return false;
    const cells = Array.from(table.querySelectorAll('[role="cell"], tbody td')).map((item) =>
      normalize(item.textContent)
    );
    return input.requiredCellValues.length === 0
      ? cells.length > 0
      : input.requiredCellValues.every((value) => cells.includes(value));
  });
  if (semanticTableReady) return true;

  const descendants = Array.from(root.querySelectorAll("*")).slice(0, 4_097);
  if (descendants.length > 4_096) return false;
  const labels = new Set(
    descendants
      .filter((candidate) => candidate.querySelectorAll("*").length === 0 && visible(candidate))
      .map((candidate) => normalize(candidate.textContent))
  );
  return (
    labels.has(input.firstColumn) &&
    labels.has(input.secondColumn) &&
    (input.requiredCellValues.length === 0
      ? labels.size > 2
      : input.requiredCellValues.every((value) => labels.has(value)))
  );
}

export interface GridScrollability {
  readonly verticalOverflow: number;
  readonly horizontalOverflow: number;
  readonly pointerUsable: true;
}

export interface GridScrollabilityInput {
  readonly headers: readonly [string, string];
}

/** Product-neutral scrollability probe used after the public grid is ready. */
export function observeGridScrollability(input: GridScrollabilityInput): GridScrollability | null {
  type Candidate = {
    readonly isConnected: boolean;
    readonly parentElement: Candidate | null;
    readonly textContent: string | null;
    readonly clientHeight: number;
    readonly clientWidth: number;
    readonly scrollHeight: number;
    readonly scrollWidth: number;
    contains(value: unknown): boolean;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): {
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    };
    querySelectorAll(selector: string): ArrayLike<Candidate>;
  };
  const runtime = globalThis as unknown as {
    readonly document: {
      readonly defaultView: { readonly innerHeight: number; readonly innerWidth: number } | null;
      elementFromPoint(x: number, y: number): unknown;
      querySelectorAll(selector: string): ArrayLike<Candidate>;
    };
  };
  const window_ = runtime.document.defaultView;
  if (!window_) return null;
  const expectedHeaders =
    Array.isArray(input?.headers) &&
    input.headers.length === 2 &&
    input.headers.every((value) => typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/u.test(value)) &&
    input.headers[0] !== input.headers[1]
      ? input.headers
      : undefined;
  if (!expectedHeaders) return null;
  const normalize = (value: string | null): string => (value ?? "").replace(/\s+/gu, " ").trim();
  const headerMatches = (header: Candidate, expected: string): boolean => {
    const boundary = "[,;:()\\[\\]{}\\u2013\\u2014#|\\-]";
    const pattern = new RegExp(`(?:^|\\s|${boundary})${expected}(?:$|\\s|${boundary})`, "u");
    if (pattern.test(normalize(header.getAttribute("aria-label"))) || pattern.test(normalize(header.textContent))) {
      return true;
    }
    return Array.from(header.querySelectorAll("*"))
      .slice(0, 256)
      .some((child) => normalize(child.textContent) === expected);
  };

  const roots = Array.from(runtime.document.querySelectorAll('[role="grid"], [role="table"], table')).slice(0, 64);
  for (const root of roots) {
    if (!root.isConnected) continue;
    const headers = Array.from(root.querySelectorAll('[role="columnheader"], th'));
    if (
      !headers.some((header) => headerMatches(header, expectedHeaders[0])) ||
      !headers.some((header) => headerMatches(header, expectedHeaders[1]))
    ) {
      continue;
    }

    const box = root.getBoundingClientRect();
    const left = Math.max(0, box.left);
    const top = Math.max(0, box.top);
    const right = Math.min(window_.innerWidth, box.left + box.width);
    const bottom = Math.min(window_.innerHeight, box.top + box.height);
    if (right <= left || bottom <= top) continue;
    const hit = runtime.document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    if (hit !== root && !root.contains(hit)) continue;

    const candidates: Candidate[] = [root];
    let parent = root.parentElement;
    for (let depth = 0; parent && depth < 12; depth += 1) {
      candidates.push(parent);
      parent = parent.parentElement;
    }
    candidates.push(...Array.from(root.querySelectorAll("*")).slice(0, 4_096));
    const verticalOverflow = Math.max(...candidates.map((item) => Math.max(0, item.scrollHeight - item.clientHeight)));
    const horizontalOverflow = Math.max(...candidates.map((item) => Math.max(0, item.scrollWidth - item.clientWidth)));
    return { verticalOverflow, horizontalOverflow, pointerUsable: true };
  }
  return null;
}
