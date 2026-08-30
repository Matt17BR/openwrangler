import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMode } from "../shared/protocol";
import type { SerializedGridViewState } from "../shared/viewState";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { useSessionModeChangeLifecycle } from "../webviews/sessionModeChangeLifecycle";

const gridViewState: SerializedGridViewState = {
  columnWidths: [["c:0", 240]],
  viewport: { firstVisibleRow: 20, scrollLeft: 40 }
};

describe("session mode change lifecycle", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    postMessage.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("captures the renderer view and restores the exact trigger when a mode change fails", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const trigger = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(trigger, other);
    trigger.focus();
    const currentMode: SessionMode | undefined = "viewing";
    let scheduledFocus: (() => void) | undefined;
    const scheduleFocusRestoration = vi.fn((restore: () => void) => {
      scheduledFocus = restore;
      return 17;
    });
    const { result } = renderHook(() =>
      useSessionModeChangeLifecycle({
        takeGridViewState: () => gridViewState,
        readCurrentMode: () => currentMode,
        scheduleFocusRestoration,
        canRestoreFocus
      })
    );

    act(() => result.current.requestModeChange("editing", trigger));
    expect(postMessage).toHaveBeenCalledWith({ kind: "switchSessionMode", mode: "editing", state: gridViewState });
    expect(result.current).toMatchObject({ pending: false, target: "editing" });

    act(() => result.current.settleModeChange(true, "editing"));
    expect(result.current).toMatchObject({ pending: true, target: "editing" });

    act(() => result.current.settleModeChange(false, "editing"));
    expect(result.current).toMatchObject({ pending: false, target: undefined });
    expect(scheduleFocusRestoration).toHaveBeenCalledOnce();
    other.focus();
    expect(document.activeElement).toBe(other);
    act(() => scheduledFocus!());
    expect(document.activeElement).toBe(trigger);
  });

  it.each([
    ["editing", "data-operation-focus-fallback"],
    ["viewing", "data-session-mode-action"]
  ] as const)("reads the settled %s mode inside the frame and focuses its primary action", (mode, attribute) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const trigger = document.createElement("button");
    const destination = document.createElement("button");
    destination.setAttribute(attribute, "");
    document.body.append(trigger, destination);
    trigger.focus();
    let currentMode: SessionMode | undefined = mode === "editing" ? "viewing" : "editing";
    let scheduledFocus: (() => void) | undefined;
    const { result } = renderHook(() =>
      useSessionModeChangeLifecycle({
        takeGridViewState: () => gridViewState,
        readCurrentMode: () => currentMode,
        scheduleFocusRestoration: (restore) => {
          scheduledFocus = restore;
          return 23;
        },
        canRestoreFocus
      })
    );

    act(() => result.current.requestModeChange(mode, trigger));
    act(() => result.current.settleModeChange(false, mode));
    currentMode = mode;
    act(() => scheduledFocus!());

    expect(document.activeElement).toBe(destination);
  });

  it("does not publish without a renderer snapshot and cancels replaced or unmounted focus work", () => {
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    let frame = 30;
    const { result, unmount } = renderHook(() =>
      useSessionModeChangeLifecycle({
        takeGridViewState: () => undefined,
        readCurrentMode: () => "viewing",
        scheduleFocusRestoration: () => ++frame,
        canRestoreFocus
      })
    );

    act(() => result.current.requestModeChange("editing", document.createElement("button")));
    expect(postMessage).not.toHaveBeenCalled();
    expect(result.current.target).toBeUndefined();

    act(() => result.current.settleModeChange(false, "editing"));
    act(() => result.current.settleModeChange(false, "editing"));
    expect(cancelFrame).toHaveBeenCalledWith(31);

    unmount();
    expect(cancelFrame).toHaveBeenLastCalledWith(32);
  });
});

function canRestoreFocus(target: HTMLElement | null | undefined): target is HTMLElement {
  return Boolean(target?.isConnected);
}
