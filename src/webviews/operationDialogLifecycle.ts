import { useCallback, useEffect, useRef, useState } from "react";
import type { ColumnSchema, OperationKind, TransformStep } from "../shared/protocol";

export interface OperationDialogPayload {
  kind?: OperationKind;
  editingStep?: TransformStep;
  editingStepInputSchema?: readonly ColumnSchema[];
}

export interface OperationDialogLifecycleOptions {
  scheduleFocusRestoration: (restore: () => void) => number;
  canRestoreFocus: (target: HTMLElement | null | undefined) => target is HTMLElement;
}

export function useOperationDialogLifecycle({
  scheduleFocusRestoration,
  canRestoreFocus
}: OperationDialogLifecycleOptions) {
  const [dialog, setDialog] = useState<OperationDialogPayload | undefined>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const focusFrame = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (focusFrame.current !== undefined) window.cancelAnimationFrame(focusFrame.current);
      returnFocus.current = null;
    },
    []
  );

  useEffect(() => {
    if (focusFrame.current !== undefined) {
      window.cancelAnimationFrame(focusFrame.current);
      focusFrame.current = undefined;
    }
    if (dialog !== undefined) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const returnTarget = returnFocus.current;
    returnFocus.current = null;
    focusFrame.current = scheduleFocusRestoration(() => {
      focusFrame.current = undefined;
      if (canRestoreFocus(returnTarget)) {
        returnTarget.focus();
        return;
      }
      document
        .querySelector<HTMLElement>(
          "[data-operation-focus-fallback]:not(:disabled), " +
            '[data-testid="data-grid-scroller"] [tabindex="0"], main.app'
        )
        ?.focus();
    });
  }, [canRestoreFocus, dialog, scheduleFocusRestoration]);

  const openDialog = useCallback((payload: OperationDialogPayload) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(payload);
  }, []);

  const closeDialog = useCallback(() => setDialog(undefined), []);

  return { dialog, openDialog, closeDialog };
}
