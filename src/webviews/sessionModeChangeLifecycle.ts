import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionMode } from "../shared/protocol";
import type { SerializedGridViewState } from "../shared/viewState";
import { vscode } from "./vscodeApi";

export interface SessionModeChangeLifecycleOptions {
  takeGridViewState: () => SerializedGridViewState | undefined;
  readCurrentMode: () => SessionMode | undefined;
  scheduleFocusRestoration: (restore: () => void) => number;
  canRestoreFocus: (target: HTMLElement | null | undefined) => target is HTMLElement;
}

export function useSessionModeChangeLifecycle({
  takeGridViewState,
  readCurrentMode,
  scheduleFocusRestoration,
  canRestoreFocus
}: SessionModeChangeLifecycleOptions) {
  const [pending, setPending] = useState(false);
  const [target, setTarget] = useState<SessionMode | undefined>();
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const focusFrame = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (focusFrame.current !== undefined) window.cancelAnimationFrame(focusFrame.current);
      returnFocus.current = null;
    },
    []
  );

  const requestModeChange = useCallback(
    (targetMode: SessionMode, trigger: HTMLButtonElement) => {
      const state = takeGridViewState();
      if (!state) return;
      returnFocus.current = document.hasFocus() && document.activeElement === trigger ? trigger : null;
      setTarget(targetMode);
      vscode.postMessage({ kind: "switchSessionMode", mode: targetMode, state });
    },
    [takeGridViewState]
  );

  const settleModeChange = useCallback(
    (busy: boolean, targetMode: SessionMode) => {
      setPending(busy);
      if (busy) {
        setTarget(targetMode);
        return;
      }
      setTarget(undefined);
      if (focusFrame.current !== undefined) window.cancelAnimationFrame(focusFrame.current);
      const returnTarget = returnFocus.current;
      returnFocus.current = null;
      focusFrame.current = scheduleFocusRestoration(() => {
        focusFrame.current = undefined;
        const currentMode = readCurrentMode();
        if (currentMode !== targetMode && canRestoreFocus(returnTarget)) {
          returnTarget.focus();
          return;
        }
        if (currentMode === "editing") {
          const primaryAction = document.querySelector<HTMLElement>("[data-operation-focus-fallback]:not(:disabled)");
          (primaryAction ?? document.querySelector<HTMLElement>("main.app"))?.focus();
          return;
        }
        document.querySelector<HTMLButtonElement>("[data-session-mode-action]:not(:disabled)")?.focus();
      });
    },
    [canRestoreFocus, readCurrentMode, scheduleFocusRestoration]
  );

  return { pending, target, requestModeChange, settleModeChange };
}
