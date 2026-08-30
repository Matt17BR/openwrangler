import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { vscode } from "./vscodeApi";

export interface ImportOptionsLifecycleOptions {
  scheduleFocusRestoration: (restore: () => void) => number;
}

export function useImportOptionsLifecycle({ scheduleFocusRestoration }: ImportOptionsLifecycleOptions) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const focusFrame = useRef<number | undefined>(undefined);
  const dispatchFrame = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (focusFrame.current !== undefined) window.cancelAnimationFrame(focusFrame.current);
      if (dispatchFrame.current !== undefined) window.cancelAnimationFrame(dispatchFrame.current);
      returnFocus.current = null;
    },
    []
  );

  const isPending = useCallback(() => pendingRef.current, []);

  const settlePending = useCallback(
    (nextPending: boolean): boolean => {
      const wasPending = pendingRef.current;
      if (!nextPending && dispatchFrame.current !== undefined) {
        window.cancelAnimationFrame(dispatchFrame.current);
        dispatchFrame.current = undefined;
      }
      pendingRef.current = nextPending;
      setPending(nextPending);
      if (!nextPending && wasPending) {
        const returnTarget = returnFocus.current;
        returnFocus.current = null;
        if (returnTarget) {
          if (focusFrame.current !== undefined) window.cancelAnimationFrame(focusFrame.current);
          focusFrame.current = scheduleFocusRestoration(() => {
            focusFrame.current = undefined;
            const targetIsAvailable = returnTarget.isConnected && !returnTarget.matches(":disabled");
            if (targetIsAvailable) {
              returnTarget.focus();
              return;
            }
            document.querySelector<HTMLButtonElement>("[data-import-options-action]:not(:disabled)")?.focus();
          });
        }
      }
      return wasPending;
    },
    [scheduleFocusRestoration]
  );

  const beginRequest = useCallback((actionId?: string, trigger?: HTMLButtonElement) => {
    if (focusFrame.current !== undefined) {
      window.cancelAnimationFrame(focusFrame.current);
      focusFrame.current = undefined;
    }
    if (dispatchFrame.current !== undefined) {
      window.cancelAnimationFrame(dispatchFrame.current);
      dispatchFrame.current = undefined;
    }
    const returnTarget =
      trigger?.isConnected && document.hasFocus() && trigger === document.activeElement ? trigger : null;
    returnFocus.current = returnTarget;
    if (returnTarget) {
      returnTarget.blur();
    } else if (actionId !== undefined && document.hasFocus() && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    flushSync(() => {
      pendingRef.current = true;
      setPending(true);
    });
    const message = {
      kind: "changeImportOptions",
      ...(actionId === undefined ? {} : { actionId })
    } as const;
    if (actionId !== undefined && trigger === undefined) {
      dispatchFrame.current = window.requestAnimationFrame(() => {
        dispatchFrame.current = undefined;
        vscode.postMessage(message);
      });
    } else {
      vscode.postMessage(message);
    }
  }, []);

  return { pending, isPending, beginRequest, settlePending };
}
