import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  emptyGridViewState,
  encodeGridViewState,
  type GridViewState,
  type SerializedGridViewState
} from "../shared/viewState";
import type { RendererSynchronizationMessage } from "./appState";
import { vscode } from "./vscodeApi";

const gridViewStateDebounceMs = 100;
const sessionSnapshotRetryDelaysMs = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

export interface CommittedRendererSession {
  sessionId: string;
  revision: number;
}

export function useRendererPresentationLifecycle(committedSession: CommittedRendererSession | undefined) {
  const [gridViewState, setGridViewState] = useState<GridViewState>(emptyGridViewState);
  const [viewStateRestoreVersion, setViewStateRestoreVersion] = useState(0);
  const [acceptedSynchronization, setAcceptedSynchronization] = useState<RendererSynchronizationMessage | undefined>();
  const acceptedSynchronizationRef = useRef<RendererSynchronizationMessage | undefined>(undefined);
  const acknowledgedSynchronizationId = useRef<string | undefined>(undefined);
  const rendererRetirementPublished = useRef(false);
  const gridViewStateRef = useRef<GridViewState>(emptyGridViewState());
  const pendingGridViewState = useRef<GridViewState | undefined>(undefined);
  const gridViewStateTimer = useRef<number | undefined>(undefined);
  const committedSessionRef = useRef<CommittedRendererSession | undefined>(committedSession);

  useLayoutEffect(() => {
    committedSessionRef.current = committedSession;
  }, [committedSession]);

  const storeGridViewState = useCallback((next: GridViewState) => {
    gridViewStateRef.current = next;
    setGridViewState(next);
  }, []);

  const discardPendingGridViewState = useCallback(() => {
    if (gridViewStateTimer.current !== undefined) {
      window.clearTimeout(gridViewStateTimer.current);
      gridViewStateTimer.current = undefined;
    }
    pendingGridViewState.current = undefined;
  }, []);

  const flushGridViewState = useCallback(() => {
    if (gridViewStateTimer.current !== undefined) {
      window.clearTimeout(gridViewStateTimer.current);
      gridViewStateTimer.current = undefined;
    }
    const pending = pendingGridViewState.current;
    pendingGridViewState.current = undefined;
    const state = pending ? encodeGridViewState(pending) : undefined;
    if (state) vscode.postMessage({ kind: "updateViewState", state });
  }, []);

  const publishGridViewState = useCallback(
    (next: GridViewState) => {
      storeGridViewState(next);
      pendingGridViewState.current = next;
      if (gridViewStateTimer.current !== undefined) window.clearTimeout(gridViewStateTimer.current);
      gridViewStateTimer.current = window.setTimeout(flushGridViewState, gridViewStateDebounceMs);
    },
    [flushGridViewState, storeGridViewState]
  );

  const restoreHostGridViewState = useCallback(
    (next: GridViewState) => {
      discardPendingGridViewState();
      storeGridViewState(next);
      setViewStateRestoreVersion((current) => current + 1);
    },
    [discardPendingGridViewState, storeGridViewState]
  );

  const resetGridViewState = useCallback(() => {
    storeGridViewState(emptyGridViewState());
  }, [storeGridViewState]);

  const restoreGridViewport = useCallback(
    (firstVisibleRow: number) => {
      const current = gridViewStateRef.current;
      publishGridViewState({
        ...current,
        viewport: { firstVisibleRow, scrollLeft: current.viewport.scrollLeft }
      });
      setViewStateRestoreVersion((version) => version + 1);
    },
    [publishGridViewState]
  );

  const takeGridViewStateForSessionModeChange = useCallback((): SerializedGridViewState | undefined => {
    const state = encodeGridViewState(gridViewStateRef.current);
    if (!state) return undefined;
    discardPendingGridViewState();
    return state;
  }, [discardPendingGridViewState]);

  const acceptSynchronization = useCallback((synchronization: RendererSynchronizationMessage) => {
    acceptedSynchronizationRef.current = synchronization;
    flushSync(() => setAcceptedSynchronization(synchronization));
  }, []);

  const clearSynchronization = useCallback(() => {
    acceptedSynchronizationRef.current = undefined;
    setAcceptedSynchronization(undefined);
    acknowledgedSynchronizationId.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const synchronization = acceptedSynchronization;
    if (!synchronization || acknowledgedSynchronizationId.current === synchronization.syncId) return;
    if (!synchronizationMatchesSession(synchronization, committedSession)) return;
    vscode.postMessage({
      kind: "rendererSynchronized",
      syncId: synchronization.syncId,
      sessionId: synchronization.sessionId,
      revision: synchronization.revision
    });
    acknowledgedSynchronizationId.current = synchronization.syncId;
    flushGridViewState();
  }, [acceptedSynchronization, committedSession, flushGridViewState]);

  useEffect(() => {
    if (acceptedSynchronization !== undefined) return;
    let retryIndex = 0;
    let retry: number | undefined;
    const clearRetry = () => {
      if (retry !== undefined) window.clearTimeout(retry);
      retry = undefined;
    };
    const scheduleRetry = () => {
      clearRetry();
      if (document.visibilityState !== "visible" || retryIndex >= sessionSnapshotRetryDelaysMs.length) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        if (document.visibilityState !== "visible" || acceptedSynchronizationRef.current !== undefined) return;
        vscode.postMessage({ kind: "requestSessionSnapshot" });
        retryIndex += 1;
        scheduleRetry();
      }, sessionSnapshotRetryDelaysMs[retryIndex]);
    };
    const restoreVisibleSnapshot = () => {
      clearRetry();
      retryIndex = 0;
      if (document.visibilityState === "visible" && acceptedSynchronizationRef.current === undefined) {
        vscode.postMessage({ kind: "requestSessionSnapshot" });
        retryIndex = 1;
        scheduleRetry();
      }
    };
    document.addEventListener("visibilitychange", restoreVisibleSnapshot);
    scheduleRetry();
    return () => {
      clearRetry();
      document.removeEventListener("visibilitychange", restoreVisibleSnapshot);
    };
  }, [acceptedSynchronization]);

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      flushGridViewState();
      if (event.persisted || rendererRetirementPublished.current) return;
      const synchronization = acceptedSynchronizationRef.current;
      if (
        !synchronization ||
        acknowledgedSynchronizationId.current !== synchronization.syncId ||
        !synchronizationMatchesSession(synchronization, committedSessionRef.current)
      ) {
        return;
      }
      rendererRetirementPublished.current = true;
      vscode.postMessage({
        kind: "rendererRetiring",
        syncId: synchronization.syncId,
        sessionId: synchronization.sessionId,
        revision: synchronization.revision
      });
    };
    const handleBeforeUnload = () => flushGridViewState();
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      flushGridViewState();
    };
  }, [flushGridViewState]);

  return {
    acceptedSynchronization,
    acceptSynchronization,
    clearSynchronization,
    flushGridViewState,
    gridViewState,
    publishGridViewState,
    resetGridViewState,
    restoreGridViewport,
    restoreHostGridViewState,
    takeGridViewStateForSessionModeChange,
    viewStateRestoreVersion
  };
}

function synchronizationMatchesSession(
  synchronization: RendererSynchronizationMessage,
  committedSession: CommittedRendererSession | undefined
): boolean {
  return synchronization.sessionId === null && synchronization.revision === null
    ? committedSession === undefined
    : committedSession?.sessionId === synchronization.sessionId &&
        committedSession.revision === synchronization.revision;
}
