import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { GridCellCoordinate } from "./gridClipboard";
import { gridRowHeight } from "./rowScrollModel";

interface ActiveGridPointerDrag {
  captureTarget: HTMLTableCellElement;
  cleanup(): void;
  focus: GridCellCoordinate;
  pointerId: number;
}

interface BeginGridPointerDragOptions {
  columnCount: number;
  onMove(coordinate: GridCellCoordinate): void;
  rowCount: number;
}

interface GridPointerDragLifecycle {
  begin(
    event: ReactPointerEvent<HTMLTableCellElement>,
    start: GridCellCoordinate,
    options: BeginGridPointerDragOptions
  ): void;
  cancel(pointerId?: number, restoreFocus?: boolean): void;
  continueToRow(row: number): GridCellCoordinate | undefined;
  isActive(): boolean;
}

const pointerAutoScrollEdge = 32;
const maximumPointerAutoScrollStep = gridRowHeight;

/** Owns the one permitted pointer-selection drag for a grid instance. */
export function useGridPointerDragLifecycle(scrollerRef: RefObject<HTMLDivElement | null>): GridPointerDragLifecycle {
  const active = useRef<ActiveGridPointerDrag | undefined>(undefined);

  const cancel = useCallback(
    (pointerId?: number, restoreFocus = false): void => {
      const current = active.current;
      if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) return;
      active.current = undefined;
      current.cleanup();
      try {
        current.captureTarget.releasePointerCapture(current.pointerId);
      } catch {
        // Capture can already be absent after pointerup, cancellation, or detach.
      }
      if (!restoreFocus || !document.hasFocus()) return;
      const scroller = scrollerRef.current;
      if (!scroller || !scroller.contains(document.activeElement)) return;
      scroller
        .querySelector<HTMLElement>(
          `[data-grid-row="${current.focus.row}"][data-grid-column="${current.focus.column}"]`
        )
        ?.focus({ preventScroll: true });
    },
    [scrollerRef]
  );

  const begin = useCallback(
    (
      event: ReactPointerEvent<HTMLTableCellElement>,
      start: GridCellCoordinate,
      { columnCount, onMove, rowCount }: BeginGridPointerDragOptions
    ): void => {
      event.preventDefault();
      cancel();

      const captureTarget = event.currentTarget;
      const pointerId = event.pointerId;
      const move = (moveEvent: PointerEvent): void => {
        const current = active.current;
        if (!current || current.pointerId !== moveEvent.pointerId) return;
        if (moveEvent.buttons === 0) {
          cancel(moveEvent.pointerId, true);
          return;
        }
        if (moveEvent.cancelable) moveEvent.preventDefault();
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const coordinate = gridCellCoordinateAtPointer(moveEvent, scroller);
        if (
          coordinate &&
          coordinate.row >= 0 &&
          coordinate.row < rowCount &&
          coordinate.column >= 0 &&
          coordinate.column < columnCount &&
          (coordinate.row !== current.focus.row || coordinate.column !== current.focus.column)
        ) {
          current.focus = coordinate;
          onMove(coordinate);
        }
        autoScrollGridForPointer(scroller, moveEvent.clientX, moveEvent.clientY);
      };
      const finish = (finishEvent: PointerEvent): void => {
        cancel(finishEvent.pointerId, true);
      };
      const blur = (): void => {
        cancel(undefined, false);
      };
      const cleanup = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", blur);
      };

      active.current = { captureTarget, cleanup, focus: start, pointerId };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", blur);
      try {
        captureTarget.setPointerCapture(pointerId);
      } catch {
        // Window listeners preserve the bounded drag when pointer capture is unavailable.
      }
      captureTarget.focus({ preventScroll: true });
    },
    [cancel, scrollerRef]
  );

  const continueToRow = useCallback((row: number): GridCellCoordinate | undefined => {
    const current = active.current;
    if (!current) return undefined;
    const coordinate = { row, column: current.focus.column };
    current.focus = coordinate;
    return coordinate;
  }, []);

  const isActive = useCallback((): boolean => active.current !== undefined, []);

  useEffect(
    () => () => {
      cancel(undefined, false);
    },
    [cancel]
  );

  return { begin, cancel, continueToRow, isActive };
}

function gridCellCoordinateAtPointer(event: PointerEvent, scroller: HTMLDivElement): GridCellCoordinate | undefined {
  const pointTarget =
    typeof document.elementFromPoint === "function" ? document.elementFromPoint(event.clientX, event.clientY) : null;
  const target = pointTarget ?? (event.target instanceof Element ? event.target : null);
  const cell = target?.closest<HTMLElement>("[data-grid-row][data-grid-column]");
  if (!cell || !scroller.contains(cell)) return undefined;
  const row = Number(cell.dataset.gridRow);
  const column = Number(cell.dataset.gridColumn);
  return Number.isSafeInteger(row) && Number.isSafeInteger(column) ? { row, column } : undefined;
}

function autoScrollGridForPointer(scroller: HTMLDivElement, clientX: number, clientY: number): void {
  const bounds = scroller.getBoundingClientRect();
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    clientX < bounds.left ||
    clientX > bounds.right ||
    clientY < bounds.top ||
    clientY > bounds.bottom
  ) {
    return;
  }
  const horizontal = pointerAutoScrollDelta(clientX, bounds.left, bounds.width);
  const vertical = pointerAutoScrollDelta(clientY, bounds.top, bounds.height);
  if (horizontal !== 0) {
    scroller.scrollLeft = Math.max(
      0,
      Math.min(scroller.scrollLeft + horizontal, Math.max(0, scroller.scrollWidth - scroller.clientWidth))
    );
  }
  if (vertical !== 0) {
    scroller.scrollTop = Math.max(
      0,
      Math.min(scroller.scrollTop + vertical, Math.max(0, scroller.scrollHeight - scroller.clientHeight))
    );
  }
}

function pointerAutoScrollDelta(position: number, start: number, extent: number): number {
  const edge = Math.min(pointerAutoScrollEdge, extent / 2);
  if (edge <= 0) return 0;
  if (position < start + edge) {
    return -Math.ceil(maximumPointerAutoScrollStep * ((start + edge - position) / edge));
  }
  const end = start + extent;
  if (position > end - edge) {
    return Math.ceil(maximumPointerAutoScrollStep * ((position - (end - edge)) / edge));
  }
  return 0;
}
