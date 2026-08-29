import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridViewState } from "../shared/viewState";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import {
  useRendererPresentationLifecycle,
  type CommittedRendererSession
} from "../webviews/rendererPresentationLifecycle";

const committedSession: CommittedRendererSession = { sessionId: "session", revision: 7 };

describe("renderer presentation lifecycle", () => {
  beforeEach(() => postMessage.mockClear());

  it("restores host-owned grid presentation and publishes bounded changes independently from runtime requests", async () => {
    const { result } = renderHook(() => useRendererPresentationLifecycle(committedSession));
    act(() => result.current.restoreHostGridViewState(gridViewState(275, 200, 90)));

    expect(result.current.gridViewState).toEqual(gridViewState(275, 200, 90));
    expect(result.current.viewStateRestoreVersion).toBe(1);

    postMessage.mockClear();
    act(() => result.current.publishGridViewState(gridViewState(285, 200, 90)));

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        kind: "updateViewState",
        state: {
          columnWidths: [["c:1", 285]],
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 200, scrollLeft: 90 }
        }
      })
    );
    expect(messagesOfKind("runtimeRequest")).toHaveLength(0);
  });

  it("trailing-debounces presentation persistence until scrolling and resizing settle", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRendererPresentationLifecycle(committedSession));
    try {
      act(() => result.current.restoreHostGridViewState(gridViewState(275)));
      postMessage.mockClear();

      act(() => result.current.publishGridViewState(gridViewState(285)));
      act(() => vi.advanceTimersByTime(75));
      act(() => result.current.publishGridViewState(gridViewState(295)));
      act(() => vi.advanceTimersByTime(75));
      expect(messagesOfKind("updateViewState")).toHaveLength(0);

      act(() => vi.advanceTimersByTime(25));
      expect(messagesOfKind("updateViewState")).toEqual([
        {
          kind: "updateViewState",
          state: {
            columnWidths: [["c:1", 295]],
            selectedColumnId: "c:1",
            viewport: { firstVisibleRow: 0, scrollLeft: 0 }
          }
        }
      ]);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("acknowledges a committed synchronization before flushing presentation and recovers only after a clear", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRendererPresentationLifecycle(committedSession));
    try {
      act(() => result.current.publishGridViewState(gridViewState(285)));
      postMessage.mockClear();

      act(() =>
        result.current.acceptSynchronization({
          kind: "rendererSynchronization",
          syncId: "S".repeat(32),
          sessionId: committedSession.sessionId,
          revision: committedSession.revision,
          layoutTransitionPending: false
        })
      );

      expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
        {
          kind: "rendererSynchronized",
          syncId: "S".repeat(32),
          sessionId: committedSession.sessionId,
          revision: committedSession.revision
        },
        {
          kind: "updateViewState",
          state: {
            columnWidths: [["c:1", 285]],
            selectedColumnId: "c:1",
            viewport: { firstVisibleRow: 0, scrollLeft: 0 }
          }
        }
      ]);

      act(() => vi.advanceTimersByTime(30_000));
      expect(messagesOfKind("requestSessionSnapshot")).toHaveLength(0);

      act(() => result.current.clearSynchronization());
      act(() => vi.advanceTimersByTime(250));
      expect(messagesOfKind("requestSessionSnapshot")).toHaveLength(1);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("bounds snapshot recovery to each visible period", () => {
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      const { unmount } = renderHook(() => useRendererPresentationLifecycle(undefined));
      postMessage.mockClear();

      act(() => vi.advanceTimersByTime(30_000));
      expect(messagesOfKind("requestSessionSnapshot")).toHaveLength(0);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      act(() => vi.advanceTimersByTime(30_000));
      expect(messagesOfKind("requestSessionSnapshot")).toHaveLength(6);

      unmount();
      act(() => vi.advanceTimersByTime(30_000));
      expect(messagesOfKind("requestSessionSnapshot")).toHaveLength(6);
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      vi.useRealTimers();
    }
  });

  it("flushes before one non-bfcache retirement and never retires twice", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRendererPresentationLifecycle(committedSession));
    try {
      act(() =>
        result.current.acceptSynchronization({
          kind: "rendererSynchronization",
          syncId: "R".repeat(32),
          sessionId: committedSession.sessionId,
          revision: committedSession.revision,
          layoutTransitionPending: false
        })
      );
      postMessage.mockClear();

      act(() => result.current.publishGridViewState(gridViewState(285)));
      dispatchPageHide(true);
      expect(messagesOfKind("rendererRetiring")).toHaveLength(0);

      postMessage.mockClear();
      act(() => result.current.publishGridViewState(gridViewState(295)));
      dispatchPageHide(false);
      dispatchPageHide(false);

      expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
        {
          kind: "updateViewState",
          state: {
            columnWidths: [["c:1", 295]],
            selectedColumnId: "c:1",
            viewport: { firstVisibleRow: 0, scrollLeft: 0 }
          }
        },
        {
          kind: "rendererRetiring",
          syncId: "R".repeat(32),
          sessionId: committedSession.sessionId,
          revision: committedSession.revision
        }
      ]);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});

function gridViewState(width: number, firstVisibleRow = 0, scrollLeft = 0): GridViewState {
  return {
    columnWidths: new Map([["c:1", width]]),
    selectedColumnId: "c:1",
    viewport: { firstVisibleRow, scrollLeft }
  };
}

function messagesOfKind(kind: string): unknown[] {
  return postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => typeof message === "object" && message !== null && message.kind === kind);
}

function dispatchPageHide(persisted: boolean): void {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  act(() => window.dispatchEvent(event));
}
