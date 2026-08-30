import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { ColumnSchema } from "../../shared/protocol";
import type { GridViewState } from "../../shared/viewState";

interface GridColumnRevealRequestIdentity {
  requestId: number;
  restoreVersion: number;
}

interface GridColumnRevealRequest {
  columnId: string | undefined;
  requestId: number | undefined;
  restoreVersion: number;
}

interface VisibleColumnRange {
  start: number;
  end: number;
}

export interface GridColumnRevealCommit {
  columnId: string;
  columnIndex: number;
  firstVisibleRow: number;
  height: number;
  prepareFocus: boolean;
  scrollLeft: number;
  scrollTop: number;
  targetIsVisible: boolean;
  width: number;
}

interface UseGridColumnRevealLifecycleOptions {
  busy: boolean;
  columnId: string | undefined;
  defaultColumnWidth: number;
  loadedColumnIds: readonly string[];
  loadedColumnSignature: string;
  logicalViewContext: string;
  onCommit(commit: GridColumnRevealCommit): void;
  onHandled(requestId: number, outcome: "revealed" | "interrupted"): void;
  pageOffset: number;
  projecting: boolean;
  requestId: number | undefined;
  restoreVersion: number;
  rowHeaderWidth: number;
  schema: readonly ColumnSchema[];
  scrollTolerance: number;
  scrollerRef: RefObject<HTMLDivElement | null>;
  viewStateRef: RefObject<GridViewState>;
  viewportScrollLeft: number;
  viewportWidth: number;
  visibleColumnRange: VisibleColumnRange;
  widths: readonly number[];
}

interface GridColumnRevealLifecycle {
  interrupt(): void;
  isPending(): boolean;
}

// Chromium can publish the final horizontal grid geometry without notifying a
// ResizeObserver (notably while Cursor reveals another workbench panel). Keep
// one short, bounded post-layout watch so that silent geometry changes still
// complete a requested column reveal. Concrete wake signals remain installed
// after this budget is exhausted and may start another bounded watch.
const maximumColumnRevealLayoutFrames = 120;
const ignoreColumnRevealSignal = (): void => undefined;

/** Owns the exact pending generated-column reveal and every wake source that may settle it. */
export function useGridColumnRevealLifecycle({
  busy,
  columnId,
  defaultColumnWidth,
  loadedColumnIds,
  loadedColumnSignature,
  logicalViewContext,
  onCommit,
  onHandled,
  pageOffset,
  projecting,
  requestId,
  restoreVersion,
  rowHeaderWidth,
  schema,
  scrollTolerance,
  scrollerRef,
  viewStateRef,
  viewportScrollLeft,
  viewportWidth,
  visibleColumnRange,
  widths
}: UseGridColumnRevealLifecycleOptions): GridColumnRevealLifecycle {
  const requested = useRef<GridColumnRevealRequestIdentity | undefined>(undefined);
  const handled = useRef<GridColumnRevealRequestIdentity | undefined>(undefined);
  const scheduleAttempt = useRef<() => void>(ignoreColumnRevealSignal);
  const stopWakeSources = useRef<() => void>(ignoreColumnRevealSignal);
  const requestRef = useRef<GridColumnRevealRequest>({ columnId, requestId, restoreVersion });
  const callbacksRef = useRef({ onCommit, onHandled });

  useLayoutEffect(() => {
    requestRef.current = { columnId, requestId, restoreVersion };
    callbacksRef.current = { onCommit, onHandled };
  }, [columnId, onCommit, onHandled, requestId, restoreVersion]);

  const isPending = useCallback((): boolean => {
    const pending = requestRef.current;
    return (
      pending.columnId !== undefined &&
      pending.requestId !== undefined &&
      sameRequest(requested.current, pending.requestId, pending.restoreVersion) &&
      !sameRequest(handled.current, pending.requestId, pending.restoreVersion)
    );
  }, []);

  const interrupt = useCallback((): void => {
    stopWakeSources.current();
    const pending = requestRef.current;
    if (
      pending.columnId &&
      pending.requestId !== undefined &&
      sameRequest(requested.current, pending.requestId, pending.restoreVersion) &&
      !sameRequest(handled.current, pending.requestId, pending.restoreVersion)
    ) {
      handled.current = { requestId: pending.requestId, restoreVersion: pending.restoreVersion };
      callbacksRef.current.onHandled(pending.requestId, "interrupted");
    }
  }, []);

  useLayoutEffect(() => {
    if (
      !columnId ||
      requestId === undefined ||
      sameRequest(handled.current, requestId, restoreVersion) ||
      sameRequest(requested.current, requestId, restoreVersion)
    ) {
      return;
    }
    const index = schema.findIndex((column) => column.id === columnId);
    if (index < 0) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    requested.current = { requestId, restoreVersion };

    const grid = scroller.closest<HTMLElement>(".dataGrid");
    const table = scroller.querySelector<HTMLElement>('table[role="grid"]');
    let wakeSourcesActive = true;
    let positionRevealed = false;
    let prepareFocus = true;
    let scheduledFrame: number | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let layoutFramesRemaining = 0;
    let forceRevealOnNextFrame = false;
    let lastRevealGeometry: string | undefined;
    const revealGeometry = (): string => `${scroller.clientWidth}:${scroller.scrollWidth}:${scroller.scrollLeft}`;
    const requestIsCurrent = (): boolean => {
      if (scrollerRef.current !== scroller) return false;
      const pending = requestRef.current;
      return (
        pending.columnId === columnId &&
        pending.requestId === requestId &&
        pending.restoreVersion === restoreVersion &&
        !sameRequest(handled.current, requestId, restoreVersion)
      );
    };
    const reveal = (): "pending" | "revealed" | "stale" => {
      if (!requestIsCurrent()) return "stale";

      const columnStart = rowHeaderWidth + sumBefore(widths, index);
      const targetWidth = widths[index] ?? defaultColumnWidth;
      scroller.scrollLeft = centeredColumnScrollLeft(
        widths,
        index,
        scroller.clientWidth,
        rowHeaderWidth,
        defaultColumnWidth
      );
      const scrollLeft = scroller.scrollLeft;
      const columnEnd = columnStart + targetWidth;
      const visibleStart = scrollLeft + rowHeaderWidth;
      const visibleEnd = scrollLeft + scroller.clientWidth;
      const requiredVisibleWidth = Math.min(targetWidth, Math.max(0, scroller.clientWidth - rowHeaderWidth));
      const actualVisibleWidth = Math.max(0, Math.min(columnEnd, visibleEnd) - Math.max(columnStart, visibleStart));
      const targetIsVisible = requiredVisibleWidth > 0 && actualVisibleWidth + scrollTolerance >= requiredVisibleWidth;
      const firstVisibleRow = viewStateRef.current.viewport.firstVisibleRow;
      callbacksRef.current.onCommit({
        columnId,
        columnIndex: index,
        firstVisibleRow,
        height: scroller.clientHeight,
        prepareFocus,
        scrollLeft,
        scrollTop: scroller.scrollTop,
        targetIsVisible,
        width: scroller.clientWidth
      });
      prepareFocus = false;
      return targetIsVisible ? "revealed" : "pending";
    };

    function stop(): void {
      if (!wakeSourcesActive) return;
      wakeSourcesActive = false;
      if (scheduledFrame !== undefined) {
        window.cancelAnimationFrame(scheduledFrame);
        scheduledFrame = undefined;
      }
      layoutFramesRemaining = 0;
      forceRevealOnNextFrame = false;
      resizeObserver?.disconnect();
      window.removeEventListener("focus", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", scheduleWhenVisible);
      grid?.removeEventListener("transitionend", schedule);
      grid?.removeEventListener("animationend", schedule);
      if (scheduleAttempt.current === schedule) scheduleAttempt.current = ignoreColumnRevealSignal;
      if (stopWakeSources.current === stop) stopWakeSources.current = ignoreColumnRevealSignal;
    }

    function runScheduledAttempt(): void {
      scheduledFrame = undefined;
      if (!wakeSourcesActive) return;
      if (!requestIsCurrent()) {
        stop();
        return;
      }
      const geometry = revealGeometry();
      const shouldReveal = forceRevealOnNextFrame || geometry !== lastRevealGeometry;
      forceRevealOnNextFrame = false;
      const outcome = shouldReveal ? reveal() : "pending";
      lastRevealGeometry = revealGeometry();
      if (outcome !== "pending") {
        positionRevealed = outcome === "revealed";
        stop();
        return;
      }
      layoutFramesRemaining = Math.max(0, layoutFramesRemaining - 1);
      if (layoutFramesRemaining > 0) scheduledFrame = window.requestAnimationFrame(runScheduledAttempt);
    }

    function schedule(): void {
      // Concrete layout, projection, or visibility signals force one attempt
      // and, after a dormant exhaustion, start a fresh bounded geometry watch.
      if (!wakeSourcesActive) return;
      forceRevealOnNextFrame = true;
      if (layoutFramesRemaining === 0) layoutFramesRemaining = maximumColumnRevealLayoutFrames;
      if (scheduledFrame !== undefined) return;
      scheduledFrame = window.requestAnimationFrame(runScheduledAttempt);
    }

    function monitorPostLayoutGeometry(): void {
      if (!wakeSourcesActive || scheduledFrame !== undefined || layoutFramesRemaining === 0) return;
      scheduledFrame = window.requestAnimationFrame(runScheduledAttempt);
    }

    function scheduleWhenVisible(): void {
      if (document.visibilityState === "visible") schedule();
    }

    scheduleAttempt.current = schedule;
    stopWakeSources.current = stop;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(scroller);
      if (grid) resizeObserver.observe(grid);
      if (table) resizeObserver.observe(table);
    }
    window.addEventListener("focus", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", scheduleWhenVisible);
    grid?.addEventListener("transitionend", schedule);
    grid?.addEventListener("animationend", schedule);
    const initialOutcome = reveal();
    lastRevealGeometry = revealGeometry();
    if (initialOutcome !== "pending") {
      positionRevealed = initialOutcome === "revealed";
      stop();
    } else {
      layoutFramesRemaining = maximumColumnRevealLayoutFrames;
      monitorPostLayoutGeometry();
    }

    return () => {
      stop();
      if (
        !positionRevealed &&
        sameRequest(requested.current, requestId, restoreVersion) &&
        !sameRequest(handled.current, requestId, restoreVersion)
      ) {
        requested.current = undefined;
      }
    };
  }, [
    columnId,
    defaultColumnWidth,
    requestId,
    restoreVersion,
    rowHeaderWidth,
    schema,
    scrollTolerance,
    scrollerRef,
    viewStateRef,
    widths
  ]);

  useLayoutEffect(() => {
    scheduleAttempt.current();
  }, [busy, loadedColumnSignature, logicalViewContext, pageOffset, projecting]);

  useLayoutEffect(() => {
    if (!columnId || requestId === undefined) return;
    if (
      !sameRequest(requested.current, requestId, restoreVersion) ||
      sameRequest(handled.current, requestId, restoreVersion)
    ) {
      return;
    }
    const index = schema.findIndex((column) => column.id === columnId);
    if (index < 0 || !loadedColumnIds.includes(columnId)) return;
    if (index < visibleColumnRange.start || index >= visibleColumnRange.end) return;
    const scroller = scrollerRef.current;
    const target = scroller?.querySelector<HTMLElement>(`th[data-grid-column="${index}"]`);
    if (!scroller || !target) return;

    const targetWidth = widths[index] ?? defaultColumnWidth;
    const columnStart = rowHeaderWidth + sumBefore(widths, index);
    const columnEnd = columnStart + targetWidth;
    const visibleStart = scroller.scrollLeft + rowHeaderWidth;
    const visibleEnd = scroller.scrollLeft + scroller.clientWidth;
    const requiredVisibleWidth = Math.min(targetWidth, Math.max(0, scroller.clientWidth - rowHeaderWidth));
    const actualVisibleWidth = Math.max(0, Math.min(columnEnd, visibleEnd) - Math.max(columnStart, visibleStart));
    if (requiredVisibleWidth <= 0 || actualVisibleWidth + scrollTolerance < requiredVisibleWidth) return;

    handled.current = { requestId, restoreVersion };
    callbacksRef.current.onHandled(requestId, "revealed");
  }, [
    columnId,
    defaultColumnWidth,
    loadedColumnIds,
    loadedColumnSignature,
    requestId,
    restoreVersion,
    rowHeaderWidth,
    schema,
    scrollTolerance,
    scrollerRef,
    viewportScrollLeft,
    viewportWidth,
    visibleColumnRange.end,
    visibleColumnRange.start,
    widths
  ]);

  return { interrupt, isPending };
}

export function centeredColumnScrollLeft(
  widths: readonly number[],
  column: number,
  viewportWidth: number,
  rowHeaderWidth: number,
  defaultColumnWidth: number
): number {
  const columnStart = rowHeaderWidth + sumBefore(widths, column);
  const targetWidth = widths[column] ?? defaultColumnWidth;
  const centeredOffset = Math.max(rowHeaderWidth, (viewportWidth - targetWidth) / 2);
  return Math.max(0, columnStart - centeredOffset);
}

function sameRequest(
  candidate: GridColumnRevealRequestIdentity | undefined,
  requestId: number,
  restoreVersion: number
): boolean {
  return candidate?.requestId === requestId && candidate.restoreVersion === restoreVersion;
}

function sumBefore(widths: readonly number[], end: number): number {
  let total = 0;
  for (let index = 0; index < end; index += 1) total += widths[index] ?? 0;
  return total;
}
