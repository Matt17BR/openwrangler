export interface RendererGridScrollMeasurementInput {
  row: number;
  column: number;
  totalRows: number;
  totalColumns: number;
  expectedText: string;
  rowHeight: number;
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

  const matchesCommittedTarget = (): boolean => {
    const grid = runtime.document.querySelector('table[role="grid"]');
    const cell = runtime.document.querySelector(targetSelector);
    if (
      !grid ||
      !cell ||
      !scroller.isConnected ||
      !grid.isConnected ||
      !cell.isConnected ||
      !scroller.contains(grid) ||
      !scroller.contains(cell) ||
      grid.getAttribute("aria-busy") !== "false" ||
      grid.getAttribute("aria-rowcount") !== String(input.totalRows + 1) ||
      grid.getAttribute("aria-colcount") !== String(input.totalColumns + 1) ||
      cell.textContent !== input.expectedText ||
      !hasVisibleStyle(scroller) ||
      !hasVisibleStyle(grid) ||
      !hasVisibleStyle(cell)
    ) {
      return false;
    }

    const scrollerRectangle = scroller.getBoundingClientRect();
    const cellRectangle = cell.getBoundingClientRect();
    if (
      scrollerRectangle.width <= 0 ||
      scrollerRectangle.height <= 0 ||
      cellRectangle.width <= 0 ||
      cellRectangle.height <= 0
    ) {
      return false;
    }

    const viewportRectangle: RendererRectangle = {
      top: 0,
      right: viewportWidth,
      bottom: viewportHeight,
      left: 0,
      width: viewportWidth,
      height: viewportHeight
    };
    return (
      viewportWidth > 0 &&
      viewportHeight > 0 &&
      rectanglesIntersect(cellRectangle, scrollerRectangle) &&
      rectanglesIntersect(cellRectangle, viewportRectangle)
    );
  };

  return new Promise<number>((resolve, reject) => {
    let animationFrame: number | undefined;
    let timeout: unknown;
    let started = 0;
    let settled = false;
    let matchedPreviousFrame = false;

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

      let matches: boolean;
      try {
        matches = matchesCommittedTarget();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (matches && matchedPreviousFrame) {
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
      matchedPreviousFrame = matches;
      schedule(poll);
    };

    timeout = runtime.setTimeout(() => {
      fail(
        new Error(
          `The production grid did not visibly commit ${input.totalRows} rows with value ${input.expectedText} at ${input.row},${input.column} within ${input.timeoutMs} ms.`
        )
      );
    }, input.timeoutMs);
    try {
      started = runtime.performance.now();
      scroller.scrollTop = input.row * input.rowHeight;
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    schedule(poll);
  });
}
