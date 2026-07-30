export const installedPerformanceGridRowHeight = 29;
export const installedPerformanceMaximumCanvasHeight = 16_000_000;
export const installedPerformanceCachedGridWarmupTransitionCount = 10;

/**
 * Builds transitions from an already-visible first row. The first target is
 * therefore the second row, and every following target changes rows.
 */
export function createAlternatingGridScrollTargets(
  rows: readonly [first: number, second: number],
  transitionCount: number
): number[] {
  if (
    !Number.isSafeInteger(rows[0]) ||
    rows[0] < 0 ||
    !Number.isSafeInteger(rows[1]) ||
    rows[1] < 0 ||
    rows[0] === rows[1]
  ) {
    throw new Error("Cached grid targets must be two distinct non-negative safe integers.");
  }
  if (!Number.isSafeInteger(transitionCount) || transitionCount < 1) {
    throw new Error("Cached grid transition count must be a positive safe integer.");
  }
  return Array.from({ length: transitionCount }, (_, index) => rows[(index + 1) % rows.length]!);
}

export interface InstalledPerformanceRendererAcknowledgementOptions {
  readonly attempt: () => Promise<boolean>;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

export async function waitForInstalledPerformanceRendererAcknowledgement({
  attempt,
  timeoutMs,
  retryDelayMs,
  now = Date.now,
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
}: InstalledPerformanceRendererAcknowledgementOptions): Promise<boolean> {
  const deadline = now() + timeoutMs;
  do {
    const attemptBudget = deadline - now();
    if (attemptBudget <= 0) return false;
    const outcome = await settleInstalledPerformanceRendererAcknowledgement(attempt(), attemptBudget);
    if (outcome.kind === "timeout") return false;
    if (outcome.acknowledged) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await wait(Math.min(retryDelayMs, remaining));
  } while (now() < deadline);
  return false;
}

function settleInstalledPerformanceRendererAcknowledgement(
  attempt: Promise<boolean>,
  timeoutMs: number
): Promise<{ readonly kind: "settled"; readonly acknowledged: boolean } | { readonly kind: "timeout" }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    void attempt.then(
      (acknowledged) => {
        clearTimeout(timer);
        resolve({ kind: "settled", acknowledged });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export interface RendererGridScrollMeasurementInput {
  row: number;
  column: number;
  totalRows: number;
  totalColumns: number;
  expectedText: string;
  rowHeight: number;
  maximumCanvasHeight: number;
  timeoutMs: number;
}

interface RendererRectangle {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface RendererGridMeasurementElement {
  readonly isConnected: boolean;
  readonly clientHeight: number;
  readonly parentElement: RendererGridMeasurementElement | null;
  readonly textContent: string | null;
  scrollTop: number;
  contains(other: RendererGridMeasurementElement): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): RendererRectangle;
}

export interface RendererGridMeasurementRuntime {
  readonly document: {
    readonly documentElement?: {
      readonly clientWidth: number;
      readonly clientHeight: number;
    };
    querySelector(selector: string): RendererGridMeasurementElement | null;
  };
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly performance: {
    now(): number;
  };
  requestAnimationFrame(callback: (timestamp: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
  getComputedStyle(element: RendererGridMeasurementElement): {
    readonly display: string;
    readonly visibility: string;
    readonly opacity: string;
  };
}

export interface RendererUsableGridGeometryInput {
  cells: ReadonlyArray<readonly [row: number, column: number]>;
}

/**
 * Runs through Playwright's `frame.evaluate`. Return only a boolean so failed
 * discovery cannot retain dataframe text or renderer geometry.
 */
export function rendererHasUsableGridGeometry(
  input: RendererUsableGridGeometryInput,
  runtimeOverride?: RendererGridMeasurementRuntime
): boolean {
  const browser = globalThis as unknown as RendererGridMeasurementRuntime;
  const runtime = runtimeOverride ?? browser;
  const scroller = runtime.document.querySelector('[data-testid="data-grid-scroller"]');
  if (!scroller?.isConnected) return false;

  const viewportWidth = runtime.innerWidth || runtime.document.documentElement?.clientWidth || 0;
  const viewportHeight = runtime.innerHeight || runtime.document.documentElement?.clientHeight || 0;
  const scrollerRectangle = scroller.getBoundingClientRect();
  if (viewportWidth <= 0 || viewportHeight <= 0 || scrollerRectangle.width <= 0 || scrollerRectangle.height <= 0) {
    return false;
  }

  const rectanglesIntersect = (first: RendererRectangle, second: RendererRectangle): boolean =>
    first.right > second.left && first.left < second.right && first.bottom > second.top && first.top < second.bottom;
  const viewportRectangle: RendererRectangle = {
    top: 0,
    right: viewportWidth,
    bottom: viewportHeight,
    left: 0,
    width: viewportWidth,
    height: viewportHeight
  };
  return input.cells.every(([row, column]) => {
    const cell = runtime.document.querySelector(`[data-grid-row="${row}"][data-grid-column="${column}"]`);
    if (!cell?.isConnected || !scroller.contains(cell)) return false;
    const cellRectangle = cell.getBoundingClientRect();
    return (
      cellRectangle.width > 0 &&
      cellRectangle.height > 0 &&
      rectanglesIntersect(cellRectangle, scrollerRectangle) &&
      rectanglesIntersect(cellRectangle, viewportRectangle)
    );
  });
}

/**
 * Runs as one Playwright `frame.evaluate` operation. Keep every production
 * dependency inside this function so Playwright can serialize it without a
 * closure.
 */
export function measureRendererGridScroll(
  input: RendererGridScrollMeasurementInput,
  runtimeOverride?: RendererGridMeasurementRuntime
): Promise<number> {
  const browser = globalThis as unknown as RendererGridMeasurementRuntime;
  const runtime = runtimeOverride ?? browser;
  const scroller = runtime.document.querySelector('[data-testid="data-grid-scroller"]');
  if (!scroller) {
    return Promise.reject(new Error("The production grid scroller is not present."));
  }

  const viewportWidth = runtime.innerWidth || runtime.document.documentElement?.clientWidth || 0;
  const viewportHeight = runtime.innerHeight || runtime.document.documentElement?.clientHeight || 0;
  const targetSelector = `[data-grid-row="${input.row}"][data-grid-column="${input.column}"]`;
  const logicalHeight = input.totalRows * input.rowHeight;
  const scrollViewportHeight = Math.max(
    input.rowHeight,
    Math.min(scroller.clientHeight, input.maximumCanvasHeight / 2)
  );
  const targetScrollTop =
    logicalHeight <= input.maximumCanvasHeight
      ? input.row * input.rowHeight
      : input.totalRows <= 1
        ? 0
        : (input.row / (input.totalRows - 1)) * (input.maximumCanvasHeight - scrollViewportHeight);

  const hasVisibleStyle = (element: RendererGridMeasurementElement): boolean => {
    let current: RendererGridMeasurementElement | null = element;
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
      current = current.parentElement;
    }
    return true;
  };

  const rectanglesIntersect = (first: RendererRectangle, second: RendererRectangle): boolean =>
    first.right > second.left && first.left < second.right && first.bottom > second.top && first.top < second.bottom;

  const observeCommittedTarget = (animationFramesObserved: number, consecutiveMatchingFrames: number) => {
    const currentScroller = runtime.document.querySelector('[data-testid="data-grid-scroller"]');
    const grid = runtime.document.querySelector('table[role="grid"]');
    const cell = runtime.document.querySelector(targetSelector);
    const scrollerConnected = scroller.isConnected;
    const gridConnected = grid?.isConnected ?? false;
    const cellConnected = cell?.isConnected ?? false;
    const scrollerContainsGrid = grid ? scroller.contains(grid) : false;
    const scrollerContainsCell = cell ? scroller.contains(cell) : false;
    const ariaBusyMatches = grid?.getAttribute("aria-busy") === "false";
    const ariaRowCountMatches = grid?.getAttribute("aria-rowcount") === String(input.totalRows + 1);
    const ariaColumnCountMatches = grid?.getAttribute("aria-colcount") === String(input.totalColumns + 1);
    const textMatches = cell?.textContent === input.expectedText;
    const scrollerVisibleStyle = hasVisibleStyle(scroller);
    const gridVisibleStyle = grid ? hasVisibleStyle(grid) : false;
    const cellVisibleStyle = cell ? hasVisibleStyle(cell) : false;
    const scrollerRectangle = scroller.getBoundingClientRect();
    const cellRectangle = cell?.getBoundingClientRect();
    const scrollerPositiveSize = scrollerRectangle.width > 0 && scrollerRectangle.height > 0;
    const cellPositiveSize = Boolean(cellRectangle && cellRectangle.width > 0 && cellRectangle.height > 0);
    const viewportRectangle: RendererRectangle = {
      top: 0,
      right: viewportWidth,
      bottom: viewportHeight,
      left: 0,
      width: viewportWidth,
      height: viewportHeight
    };
    const cellIntersectsScroller = Boolean(
      cellRectangle && scrollerPositiveSize && cellPositiveSize && rectanglesIntersect(cellRectangle, scrollerRectangle)
    );
    const cellIntersectsViewport = Boolean(
      cellRectangle &&
      viewportWidth > 0 &&
      viewportHeight > 0 &&
      cellPositiveSize &&
      rectanglesIntersect(cellRectangle, viewportRectangle)
    );
    const matches =
      Boolean(grid && cell) &&
      scrollerConnected &&
      gridConnected &&
      cellConnected &&
      scrollerContainsGrid &&
      scrollerContainsCell &&
      ariaBusyMatches &&
      ariaRowCountMatches &&
      ariaColumnCountMatches &&
      textMatches &&
      scrollerVisibleStyle &&
      gridVisibleStyle &&
      cellVisibleStyle &&
      scrollerPositiveSize &&
      cellPositiveSize &&
      viewportWidth > 0 &&
      viewportHeight > 0 &&
      cellIntersectsScroller &&
      cellIntersectsViewport;
    return {
      matches,
      diagnostic: {
        animationFramesObserved,
        consecutiveMatchingFrames,
        viewportWidth,
        viewportHeight,
        scrollTop: scroller.scrollTop,
        scrollerPresent: currentScroller !== null,
        gridPresent: grid !== null,
        cellPresent: cell !== null,
        scrollerConnected,
        gridConnected,
        cellConnected,
        scrollerContainsGrid,
        scrollerContainsCell,
        ariaBusyMatches,
        ariaRowCountMatches,
        ariaColumnCountMatches,
        textMatches,
        scrollerVisibleStyle,
        gridVisibleStyle,
        cellVisibleStyle,
        scrollerPositiveSize,
        cellPositiveSize,
        cellIntersectsScroller,
        cellIntersectsViewport,
        committedTargetMatches: matches
      }
    };
  };

  return new Promise<number>((resolve, reject) => {
    let animationFrame: number | undefined;
    let timeout: unknown;
    let started = 0;
    let settled = false;
    let animationFramesObserved = 0;
    let consecutiveMatchingFrames = 0;
    let lastDiagnostic: ReturnType<typeof observeCommittedTarget>["diagnostic"] | undefined;

    const cleanup = (): void => {
      if (animationFrame !== undefined) {
        runtime.cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }
      if (timeout !== undefined) {
        runtime.clearTimeout(timeout);
        timeout = undefined;
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const schedule = (callback: (timestamp: number) => void): void => {
      try {
        animationFrame = runtime.requestAnimationFrame(callback);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const poll = (): void => {
      animationFrame = undefined;
      if (settled) return;

      let observation: ReturnType<typeof observeCommittedTarget>;
      try {
        animationFramesObserved += 1;
        observation = observeCommittedTarget(animationFramesObserved, consecutiveMatchingFrames);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      consecutiveMatchingFrames = observation.matches ? consecutiveMatchingFrames + 1 : 0;
      lastDiagnostic = {
        ...observation.diagnostic,
        consecutiveMatchingFrames
      };
      if (consecutiveMatchingFrames >= 2) {
        let duration: number;
        try {
          duration = runtime.performance.now() - started;
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        settled = true;
        cleanup();
        resolve(duration);
        return;
      }
      schedule(poll);
    };

    timeout = runtime.setTimeout(() => {
      fail(
        new Error(
          `The production grid did not visibly commit ${input.totalRows} rows and ${input.totalColumns} columns at ${input.row},${input.column} within ${input.timeoutMs} ms. State: ${JSON.stringify(lastDiagnostic)}`
        )
      );
    }, input.timeoutMs);
    try {
      started = runtime.performance.now();
      scroller.scrollTop = targetScrollTop;
      lastDiagnostic = observeCommittedTarget(0, 0).diagnostic;
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    schedule(poll);
  });
}
