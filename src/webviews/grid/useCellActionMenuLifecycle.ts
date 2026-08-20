import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface CellActionMenuTarget {
  row: number;
  column: number;
  columnId: string;
  clipboardSelection?: "column" | "range";
  generation: number;
  returnFocus: { row: number; column: number };
  viewContextId: string;
}

interface CellActionMenuInput {
  row: number;
  column: number;
  columnId: string;
  clipboardSelection?: "column" | "range";
  returnFocus: { row: number; column: number };
}

interface CellActionMenuOperation {
  owner: CellActionMenuTarget;
  ownsResult(): boolean;
}

export interface CellActionMenuLifecycle {
  beginOperation(expected: CellActionMenuTarget | undefined): CellActionMenuOperation | undefined;
  close(owner: CellActionMenuTarget | undefined, restoreFocus?: boolean): boolean;
  dismiss(owner?: CellActionMenuTarget): boolean;
  open(input: CellActionMenuInput): void;
  target?: CellActionMenuTarget;
}

export function useCellActionMenuLifecycle({
  prepareFocus,
  scrollerRef,
  viewContextId
}: {
  prepareFocus(coordinate: { row: number; column: number }): void;
  scrollerRef: RefObject<HTMLDivElement | null>;
  viewContextId: string;
}): CellActionMenuLifecycle {
  const [target, setTarget] = useState<CellActionMenuTarget>();
  const targetRef = useRef<CellActionMenuTarget | undefined>(undefined);
  const menuGenerationRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const viewContextRef = useRef(viewContextId);
  const mountedRef = useRef(true);

  const dismiss = useCallback((owner?: CellActionMenuTarget): boolean => {
    if (owner && targetRef.current !== owner) return false;
    operationGenerationRef.current += 1;
    targetRef.current = undefined;
    setTarget(undefined);
    return true;
  }, []);

  const open = useCallback(
    (input: CellActionMenuInput): void => {
      menuGenerationRef.current += 1;
      operationGenerationRef.current += 1;
      const next: CellActionMenuTarget = {
        ...input,
        generation: menuGenerationRef.current,
        viewContextId
      };
      targetRef.current = next;
      setTarget(next);
    },
    [viewContextId]
  );

  const beginOperation = useCallback(
    (expected: CellActionMenuTarget | undefined): CellActionMenuOperation | undefined => {
      const owner = targetRef.current;
      if (!owner || owner !== expected || owner.viewContextId !== viewContextRef.current) return undefined;
      operationGenerationRef.current += 1;
      const generation = operationGenerationRef.current;
      return {
        owner,
        ownsResult: () => {
          const scroller = scrollerRef.current;
          return (
            mountedRef.current &&
            targetRef.current === owner &&
            operationGenerationRef.current === generation &&
            viewContextRef.current === owner.viewContextId &&
            document.hasFocus() &&
            scroller !== null &&
            scroller.contains(document.activeElement)
          );
        }
      };
    },
    [scrollerRef]
  );

  const close = useCallback(
    (owner: CellActionMenuTarget | undefined, restoreFocus = false): boolean => {
      if (!owner) return false;
      const scroller = scrollerRef.current;
      const gridRetainsFocus =
        restoreFocus && document.hasFocus() && scroller !== null && scroller.contains(document.activeElement);
      if (!dismiss(owner)) return false;
      if (!gridRetainsFocus || !scroller) return true;
      const focusTarget = scroller.querySelector<HTMLElement>(
        `[data-grid-row="${owner.returnFocus.row}"][data-grid-column="${owner.returnFocus.column}"]`
      );
      if (!focusTarget?.isConnected || !document.hasFocus() || !scroller.contains(document.activeElement)) {
        return true;
      }
      prepareFocus(owner.returnFocus);
      focusTarget.focus({ preventScroll: true });
      return true;
    },
    [dismiss, prepareFocus, scrollerRef]
  );

  useLayoutEffect(() => {
    if (viewContextRef.current === viewContextId) return;
    viewContextRef.current = viewContextId;
    dismiss();
  }, [dismiss, viewContextId]);

  useLayoutEffect(() => {
    if (!target || targetRef.current !== target || target.viewContextId !== viewContextRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller || !document.hasFocus()) return;
    const cell = scroller.querySelector<HTMLElement>(
      `[data-grid-row="${target.row}"][data-grid-column="${target.column}"]`
    );
    const menu = cell?.querySelector<HTMLElement>(".cellFilterMenuPopup");
    const action = menu?.querySelector<HTMLButtonElement>("button:not([disabled])");
    if (!document.hasFocus()) return;
    (action ?? menu)?.focus({ preventScroll: true });
  }, [scrollerRef, target]);

  useEffect(() => {
    if (!target) return;
    const dismissOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      const activeCell = scrollerRef.current?.querySelector<HTMLElement>(
        `[data-grid-row="${target.row}"][data-grid-column="${target.column}"]`
      );
      if (!activeCell?.contains(event.target)) dismiss(target);
    };
    const dismissCurrent = (): void => {
      dismiss(target);
    };
    const scroller = scrollerRef.current;
    document.addEventListener("pointerdown", dismissOutside, true);
    scroller?.addEventListener("scroll", dismissCurrent, { passive: true });
    window.addEventListener("resize", dismissCurrent);
    window.addEventListener("blur", dismissCurrent);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      scroller?.removeEventListener("scroll", dismissCurrent);
      window.removeEventListener("resize", dismissCurrent);
      window.removeEventListener("blur", dismissCurrent);
    };
  }, [dismiss, scrollerRef, target]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      targetRef.current = undefined;
    },
    []
  );

  return { beginOperation, close, dismiss, open, target };
}
