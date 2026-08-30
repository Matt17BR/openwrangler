import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { useImportOptionsLifecycle } from "../webviews/importOptionsLifecycle";

describe("import-options request lifecycle", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    postMessage.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("publishes pending state and blurs before dispatch, then restores the exact trigger", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const trigger = document.createElement("button");
    trigger.dataset.importOptionsAction = "";
    document.body.append(trigger);
    trigger.focus();
    let scheduledFocus: (() => void) | undefined;
    const scheduleFocusRestoration = vi.fn((restore: () => void) => {
      scheduledFocus = restore;
      return 17;
    });
    const { result } = renderHook(() => useImportOptionsLifecycle({ scheduleFocusRestoration }));
    let pendingAtDispatch: boolean | undefined;
    let activeElementAtDispatch: Element | null | undefined;
    postMessage.mockImplementation(() => {
      pendingAtDispatch = result.current.pending;
      activeElementAtDispatch = document.activeElement;
    });

    act(() => result.current.beginRequest(undefined, trigger));

    expect(postMessage).toHaveBeenCalledWith({ kind: "changeImportOptions" });
    expect(pendingAtDispatch).toBe(true);
    expect(activeElementAtDispatch).toBe(document.body);
    expect(result.current.pending).toBe(true);

    act(() => result.current.settlePending(false));
    expect(result.current.pending).toBe(false);
    expect(scheduleFocusRestoration).toHaveBeenCalledOnce();
    act(() => scheduledFocus!());
    expect(document.activeElement).toBe(trigger);
  });

  it("defers native requests and cancels an unpublished request when the busy barrier settles", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const active = document.createElement("button");
    document.body.append(active);
    active.focus();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frame = nextFrame++;
      frames.set(frame, callback);
      return frame;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });
    const { result, unmount } = renderHook(() => useImportOptionsLifecycle({ scheduleFocusRestoration: () => 99 }));

    act(() => result.current.beginRequest("A".repeat(32)));
    expect(result.current.pending).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(postMessage).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    act(() => result.current.settlePending(false));
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(frames.size).toBe(0);
    expect(postMessage).not.toHaveBeenCalled();

    act(() => result.current.beginRequest("B".repeat(32)));
    const dispatch = frames.get(2);
    expect(dispatch).toBeDefined();
    act(() => dispatch!(performance.now()));
    expect(postMessage).toHaveBeenCalledWith({ kind: "changeImportOptions", actionId: "B".repeat(32) });

    act(() => result.current.beginRequest("C".repeat(32)));
    expect(frames.has(3)).toBe(true);
    unmount();
    expect(cancelFrame).toHaveBeenCalledWith(3);
  });

  it("does not restore a trigger after the host takes focus before the completion frame", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const scheduleFocusRestoration = (restore: () => void): number => {
      const webviewOwnedFocus = document.hasFocus();
      return window.requestAnimationFrame(() => {
        if (!webviewOwnedFocus || !document.hasFocus()) return;
        restore();
      });
    };
    const { result } = renderHook(() => useImportOptionsLifecycle({ scheduleFocusRestoration }));

    act(() => result.current.beginRequest(undefined, trigger));
    act(() => result.current.settlePending(false));
    expect(frames).toHaveLength(1);

    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();
    hasFocus.mockReturnValue(false);
    act(() => frames[0](performance.now()));
    expect(focus).not.toHaveBeenCalled();
  });

  it("uses another available import action when the original trigger is replaced", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const trigger = document.createElement("button");
    const fallback = document.createElement("button");
    fallback.dataset.importOptionsAction = "";
    document.body.append(trigger, fallback);
    trigger.focus();
    let scheduledFocus: (() => void) | undefined;
    const { result } = renderHook(() =>
      useImportOptionsLifecycle({
        scheduleFocusRestoration: (restore) => {
          scheduledFocus = restore;
          return 21;
        }
      })
    );

    act(() => result.current.beginRequest(undefined, trigger));
    trigger.remove();
    act(() => result.current.settlePending(false));
    act(() => scheduledFocus!());

    expect(document.activeElement).toBe(fallback);
  });
});
