import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "../../shared/viewState";

export type BeginColumnResize = (
  event: ReactPointerEvent<HTMLButtonElement>,
  initialWidth: number,
  onResize: (width: number) => void
) => void;

interface ActiveColumnResize {
  cancel(): void;
}

/** Owns the one permitted column-resize drag for a grid instance. */
export function useColumnResizeLifecycle(): BeginColumnResize {
  const active = useRef<ActiveColumnResize | undefined>(undefined);

  const cancelActive = useCallback(() => {
    const current = active.current;
    active.current = undefined;
    current?.cancel();
  }, []);

  useEffect(() => cancelActive, [cancelActive]);

  return useCallback(
    (event, initialWidth, onResize) => {
      event.preventDefault();
      cancelActive();

      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      let settled = false;

      const matchesPointer = (candidate: PointerEvent): boolean => candidate.pointerId === pointerId;
      const move = (moveEvent: PointerEvent): void => {
        if (!matchesPointer(moveEvent)) return;
        const width = initialWidth + moveEvent.clientX - startClientX;
        onResize(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)));
      };
      const finish = (finishEvent: PointerEvent): void => {
        if (matchesPointer(finishEvent)) cancel();
      };
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", cancel);
        target.removeEventListener("lostpointercapture", finish);
        if (active.current?.cancel === cancel) active.current = undefined;
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // Capture can already be absent after pointerup, cancellation, or detach.
        }
      };

      active.current = { cancel };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", cancel);
      target.addEventListener("lostpointercapture", finish);
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Window listeners still provide the bounded fallback lifecycle.
      }
    },
    [cancelActive]
  );
}
