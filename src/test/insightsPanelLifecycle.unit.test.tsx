import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInsightsPanelLifecycle } from "../webviews/insightsPanelLifecycle";

describe("insights panel lifecycle", () => {
  beforeEach(() => document.body.replaceChildren());

  afterEach(() => vi.restoreAllMocks());

  it("publishes open and active-view transitions as one owned state", () => {
    const scheduler = createFocusScheduler();
    const { result } = renderHook(() =>
      useInsightsPanelLifecycle({ scheduleFocusRestoration: scheduler.schedule, canRestoreFocus })
    );

    expect(result.current).toMatchObject({ open: false, view: "column" });

    let closedSynchronously = false;
    act(() => {
      result.current.openPanel("column");
      closedSynchronously = result.current.closePanel({ restoreFocus: false });
    });
    expect(closedSynchronously).toBe(true);
    expect(result.current).toMatchObject({ open: false, view: "column" });
    expect(scheduler.schedule).not.toHaveBeenCalled();

    act(() => result.current.openPanel("filters"));
    expect(result.current).toMatchObject({ open: true, view: "filters" });
    expect(scheduler.schedule).toHaveBeenCalledOnce();

    act(() => result.current.selectPanelView("dataset"));
    expect(result.current).toMatchObject({ open: true, view: "dataset" });
    expect(scheduler.schedule).toHaveBeenCalledOnce();

    act(() => result.current.reconcileAvailability(false, true));
    expect(result.current).toMatchObject({ open: true, view: "filters" });

    act(() => result.current.reconcileAvailability(true, false));
    expect(result.current).toMatchObject({ open: true, view: "column" });

    act(() => result.current.selectPanelView("dataset"));
    act(() => result.current.reconcileAvailability(true, false));
    expect(result.current).toMatchObject({ open: true, view: "dataset" });

    act(() => result.current.reconcileAvailability(false, false));
    expect(result.current).toMatchObject({ open: false, view: "dataset" });
    expect(scheduler.schedule).toHaveBeenCalledOnce();
  });

  it("focuses the close control once and restores the exact origin or toolbar fallback", () => {
    const { trigger, toggle, close } = appendPanelControls();
    const scheduler = createFocusScheduler();
    const { result } = renderHook(() =>
      useInsightsPanelLifecycle({ scheduleFocusRestoration: scheduler.schedule, canRestoreFocus })
    );

    trigger.focus();
    act(() => result.current.openPanel("column", trigger));
    act(() => scheduler.runLatest());
    expect(document.activeElement).toBe(close);

    act(() => result.current.selectPanelView("filters"));
    expect(scheduler.schedule).toHaveBeenCalledOnce();

    act(() => result.current.closePanel());
    act(() => scheduler.runLatest());
    expect(document.activeElement).toBe(trigger);

    act(() => result.current.openPanel("column", trigger));
    act(() => scheduler.runLatest());
    trigger.remove();
    act(() => result.current.closePanel());
    act(() => scheduler.runLatest());
    expect(document.activeElement).toBe(toggle);
  });

  it("silently dismisses without restoring or retaining an earlier origin", () => {
    const { trigger, toggle } = appendPanelControls();
    const scheduler = createFocusScheduler();
    const { result } = renderHook(() =>
      useInsightsPanelLifecycle({ scheduleFocusRestoration: scheduler.schedule, canRestoreFocus })
    );

    act(() => result.current.openPanel("column", trigger));
    const scheduledAfterOpen = scheduler.schedule.mock.calls.length;
    act(() => result.current.closePanel({ restoreFocus: false }));

    expect(result.current.open).toBe(false);
    expect(scheduler.schedule).toHaveBeenCalledTimes(scheduledAfterOpen);

    act(() => result.current.openPanel("column"));
    act(() => scheduler.runLatest());
    act(() => result.current.closePanel());
    act(() => scheduler.runLatest());
    expect(document.activeElement).toBe(toggle);
  });

  it("honors webview focus ownership and cancels replaced or unmounted frames", () => {
    const { trigger, close } = appendPanelControls();
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    let webviewOwnsFocus = false;
    const scheduler = createFocusScheduler(() => webviewOwnsFocus);
    const { result, unmount } = renderHook(() =>
      useInsightsPanelLifecycle({ scheduleFocusRestoration: scheduler.schedule, canRestoreFocus })
    );

    trigger.focus();
    act(() => result.current.openPanel("column", trigger));
    act(() => scheduler.runLatest());
    expect(document.activeElement).not.toBe(close);

    act(() => result.current.closePanel());
    act(() => scheduler.runLatest());
    expect(document.activeElement).toBe(trigger);

    webviewOwnsFocus = true;
    act(() => result.current.openPanel("column", trigger));
    const openFrame = scheduler.latestId();
    act(() => result.current.closePanel());
    expect(cancelFrame).toHaveBeenCalledWith(openFrame);
    const closeFrame = scheduler.latestId();

    act(() => result.current.openPanel("filters", trigger));
    expect(cancelFrame).toHaveBeenCalledWith(closeFrame);
    const replacementFrame = scheduler.latestId();

    unmount();
    expect(cancelFrame).toHaveBeenLastCalledWith(replacementFrame);
  });
});

function appendPanelControls(): {
  trigger: HTMLButtonElement;
  toggle: HTMLButtonElement;
  close: HTMLButtonElement;
} {
  const trigger = document.createElement("button");
  const toggle = document.createElement("button");
  toggle.setAttribute("aria-controls", "openwrangler-insights-panel");
  const panel = document.createElement("aside");
  panel.id = "openwrangler-insights-panel";
  const close = document.createElement("button");
  close.setAttribute("aria-label", "Close panel");
  panel.append(close);
  document.body.append(trigger, toggle, panel);
  return { trigger, toggle, close };
}

function createFocusScheduler(webviewOwnsFocus: () => boolean = () => true): {
  schedule: ReturnType<typeof vi.fn<(restore: () => void) => number>>;
  latestId(): number;
  runLatest(): void;
} {
  let nextId = 10;
  let latestId = 0;
  const callbacks = new Map<number, () => void>();
  const schedule = vi.fn((restore: () => void): number => {
    latestId = ++nextId;
    callbacks.set(latestId, () => {
      if (webviewOwnsFocus()) restore();
    });
    return latestId;
  });
  return {
    schedule,
    latestId: () => latestId,
    runLatest: () => {
      const callback = callbacks.get(latestId);
      callbacks.delete(latestId);
      callback?.();
    }
  };
}

function canRestoreFocus(target: HTMLElement | null | undefined): target is HTMLElement {
  return Boolean(target?.isConnected && target.tabIndex >= 0 && !target.matches(":disabled"));
}
