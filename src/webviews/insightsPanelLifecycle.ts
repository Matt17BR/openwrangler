import { useCallback, useEffect, useRef, useState } from "react";
import type { SummaryPanelView } from "./summary/SummaryPanel";

interface InsightsPanelState {
  open: boolean;
  view: SummaryPanelView;
}

export interface InsightsPanelLifecycleOptions {
  scheduleFocusRestoration: (restore: () => void) => number;
  canRestoreFocus: (target: HTMLElement | null | undefined) => target is HTMLElement;
}

export interface CloseInsightsPanelOptions {
  restoreFocus?: boolean;
}

const initialState: InsightsPanelState = { open: false, view: "column" };

export function useInsightsPanelLifecycle({
  scheduleFocusRestoration,
  canRestoreFocus
}: InsightsPanelLifecycleOptions) {
  const [state, setState] = useState<InsightsPanelState>(initialState);
  const current = useRef<InsightsPanelState>(initialState);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocusOnClose = useRef(false);
  const wasOpen = useRef(false);
  const focusFrame = useRef<number | undefined>(undefined);

  const cancelFocusFrame = useCallback(() => {
    if (focusFrame.current === undefined) return;
    window.cancelAnimationFrame(focusFrame.current);
    focusFrame.current = undefined;
  }, []);

  const publish = useCallback((next: InsightsPanelState) => {
    current.current = next;
    setState(next);
  }, []);

  useEffect(
    () => () => {
      cancelFocusFrame();
      returnFocus.current = null;
    },
    [cancelFocusFrame]
  );

  useEffect(() => {
    cancelFocusFrame();
    if (state.open) {
      wasOpen.current = true;
      focusFrame.current = scheduleFocusRestoration(() => {
        focusFrame.current = undefined;
        document
          .querySelector<HTMLButtonElement>(
            '#openwrangler-insights-panel button[aria-label="Close panel"]:not(:disabled)'
          )
          ?.focus();
      });
      return cancelFocusFrame;
    }

    if (!wasOpen.current) return;
    wasOpen.current = false;
    const shouldRestoreFocus = restoreFocusOnClose.current;
    restoreFocusOnClose.current = false;
    const returnTarget = returnFocus.current;
    returnFocus.current = null;
    if (!shouldRestoreFocus) return;

    focusFrame.current = scheduleFocusRestoration(() => {
      focusFrame.current = undefined;
      if (canRestoreFocus(returnTarget)) {
        returnTarget.focus();
        return;
      }
      document
        .querySelector<HTMLButtonElement>('[aria-controls="openwrangler-insights-panel"]:not(:disabled)')
        ?.focus();
    });
    return cancelFocusFrame;
  }, [canRestoreFocus, cancelFocusFrame, scheduleFocusRestoration, state.open]);

  const openPanel = useCallback(
    (view: SummaryPanelView, returnTarget?: HTMLElement | null) => {
      const previous = current.current;
      if (!previous.open) returnFocus.current = returnTarget ?? null;
      else if (returnTarget !== undefined) returnFocus.current = returnTarget;
      if (previous.open && previous.view === view) return;
      publish({ open: true, view });
    },
    [publish]
  );

  const selectPanelView = useCallback(
    (view: SummaryPanelView) => {
      const previous = current.current;
      if (previous.view === view) return;
      publish({ ...previous, view });
    },
    [publish]
  );

  const closePanel = useCallback(
    ({ restoreFocus = true }: CloseInsightsPanelOptions = {}) => {
      const previous = current.current;
      if (!previous.open) {
        if (!restoreFocus) returnFocus.current = null;
        return false;
      }
      restoreFocusOnClose.current = restoreFocus;
      if (!restoreFocus) returnFocus.current = null;
      publish({ ...previous, open: false });
      return true;
    },
    [publish]
  );

  const reconcileAvailability = useCallback(
    (profileSupported: boolean, filterPanelSupported: boolean) => {
      if (!profileSupported && !filterPanelSupported) {
        closePanel({ restoreFocus: false });
        return;
      }
      if (!profileSupported) {
        selectPanelView("filters");
        return;
      }
      if (!filterPanelSupported && current.current.view === "filters") selectPanelView("column");
    },
    [closePanel, selectPanelView]
  );

  return {
    open: state.open,
    view: state.view,
    openPanel,
    selectPanelView,
    closePanel,
    reconcileAvailability
  };
}
