import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPresentation } from "../extension/dataBridge";
import {
  RendererSynchronizationCoordinator,
  type RendererSynchronizationCallbacks,
  type RendererSynchronizationIdentity
} from "../extension/rendererSynchronizationCoordinator";
import type { OpenWranglerResponse, SessionOpenedResponse } from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";

const snapshot: SessionOpenedResponse = {
  kind: "sessionOpened",
  metadata: {
    protocolVersion: 2,
    sessionId: "session",
    revision: 3,
    backend: "polars",
    mode: "editing",
    source: { kind: "file", label: "sample.csv", path: "sample.csv" },
    capabilities: {
      editable: true,
      lazy: true,
      cancel: false,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: false
    },
    shape: { rows: 1, columns: 1 },
    filteredShape: { rows: 1, columns: 1 },
    filterModel: { filters: [], sort: [] },
    steps: [],
    schema: [{ id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false }]
  },
  page: {
    offset: 0,
    limit: 200,
    totalRows: 1,
    columnIds: ["c:0"],
    rows: [
      {
        id: "r:0",
        rowNumber: 0,
        values: [{ kind: "string", raw: "Berlin", display: "Berlin", isNull: false, isNaN: false }]
      }
    ]
  },
  summaries: []
};

const presentation: SessionPresentation = {
  sessionId: "session",
  revision: 3,
  code: "clean_df = df.clone()"
};

const viewState: GridViewState = {
  columnWidths: new Map([["c:0", 240]]),
  selectedColumnId: "c:0",
  viewport: { firstVisibleRow: 0, scrollLeft: 12 }
};

describe("RendererSynchronizationCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes one complete retained snapshot before accepting its exact post-commit acknowledgement", async () => {
    const harness = createHarness({ presentation, viewState, importBusy: true });
    harness.coordinator.replaceRenderer();
    harness.coordinator.rendererStarted();

    await harness.coordinator.enqueueSynchronization(true);

    const synchronization = latestSynchronization(harness.posted);
    expect(harness.clearStepInspection).toHaveBeenCalledOnce();
    expect(harness.posted).toEqual([
      { kind: "stepInspectionCleared", resumeProfiling: false },
      snapshot,
      { kind: "sessionPresentation", presentation },
      {
        kind: "viewState",
        state: {
          columnWidths: [["c:0", 240]],
          selectedColumnId: "c:0",
          viewport: { firstVisibleRow: 0, scrollLeft: 12 }
        }
      },
      { kind: "importOptionsState", busy: true },
      synchronization
    ]);
    expect(harness.coordinator.hasHydratedRenderer()).toBe(false);
    expect(harness.coordinator.rendererViewStateLocked).toBe(true);
    expect(harness.didPublishAuthoritativeSnapshot).toHaveBeenCalledOnce();

    expect(
      harness.coordinator.acknowledge({
        ...synchronization,
        syncId: "stale-synchronization"
      })
    ).toBeUndefined();
    expect(harness.coordinator.hasHydratedRenderer()).toBe(false);
    expect(harness.didSynchronize).not.toHaveBeenCalled();

    expect(harness.coordinator.acknowledge(synchronization)).toBe(harness.coordinator.currentSynchronization);
    expect(harness.coordinator.hasHydratedRenderer()).toBe(true);
    expect(harness.coordinator.rendererViewStateLocked).toBe(false);
    expect(harness.didSynchronize).toHaveBeenCalledWith(harness.coordinator.currentSynchronization);
  });

  it("invalidates an acknowledged renderer on a fresh pull and rejects the stale acknowledgement", async () => {
    const harness = createHarness();
    harness.coordinator.replaceRenderer();
    harness.coordinator.rendererStarted();
    await harness.coordinator.enqueueSynchronization(false);
    const first = latestSynchronization(harness.posted);
    harness.coordinator.acknowledge(first);
    expect(harness.coordinator.hasHydratedRenderer()).toBe(true);

    harness.coordinator.rendererStarted();
    await harness.coordinator.enqueueSynchronization(false);
    const second = latestSynchronization(harness.posted);
    expect(second.syncId).not.toBe(first.syncId);
    expect(harness.coordinator.hasHydratedRenderer()).toBe(false);
    expect(harness.coordinator.acknowledge(first)).toBeUndefined();
    expect(harness.coordinator.hasHydratedRenderer()).toBe(false);

    const waiting = harness.coordinator.waitForAcknowledgement(second.syncId);
    harness.coordinator.acknowledge(second);
    await expect(waiting).resolves.toBe(true);
    expect(harness.coordinator.hasHydratedRenderer()).toBe(true);
  });

  it("drains a replay requested while the current synchronization marker is settling", async () => {
    const firstMarker = deferred<boolean>();
    let markerCount = 0;
    const harness = createHarness({
      postMessage: (message) => {
        harness.posted.push(message);
        if (isSynchronization(message) && ++markerCount === 1) return firstMarker.promise;
        return Promise.resolve(true);
      }
    });
    harness.coordinator.replaceRenderer();
    harness.coordinator.rendererStarted();

    const initial = harness.coordinator.enqueueSynchronization(false);
    await vi.waitFor(() => expect(markerCount).toBe(1));
    const pulled = harness.coordinator.enqueueSynchronization(false);
    firstMarker.resolve(true);

    await Promise.all([initial, pulled]);
    expect(markerCount).toBe(2);
  });

  it("allows at most two visible startup reloads without reopening or mutating the retained runtime", async () => {
    const harness = createHarness();
    harness.coordinator.replaceRenderer();
    harness.coordinator.scheduleStartupRecovery();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.replaceRenderer).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.replaceRenderer).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.replaceRenderer).toHaveBeenCalledTimes(3);
    expect(harness.ensureSessionOpen).not.toHaveBeenCalled();
    expect(harness.clearStepInspection).not.toHaveBeenCalled();
    expect(harness.reportDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("defers recovery while hidden and starts a fresh bounded grace period when visible", async () => {
    const harness = createHarness({ visible: false });
    harness.coordinator.replaceRenderer();
    harness.coordinator.scheduleStartupRecovery();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.replaceRenderer).toHaveBeenCalledOnce();

    harness.state.visible = true;
    harness.coordinator.scheduleStartupRecovery();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.replaceRenderer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.replaceRenderer).toHaveBeenCalledTimes(2);

    harness.state.visible = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.replaceRenderer).toHaveBeenCalledTimes(2);
  });

  it("cancels acknowledgement, watchdog, and import preparation ownership on disposal", async () => {
    const harness = createHarness();
    harness.coordinator.replaceRenderer();
    harness.coordinator.rendererStarted();
    await harness.coordinator.enqueueSynchronization(false);
    const synchronization = latestSynchronization(harness.posted);
    const acknowledgement = harness.coordinator.waitForAcknowledgement(synchronization.syncId);
    const importPreparation = harness.coordinator.requestImportOptionsChange();

    harness.coordinator.dispose();
    await vi.runAllTimersAsync();

    await expect(acknowledgement).resolves.toBe(false);
    await expect(importPreparation).resolves.toBeUndefined();
    expect(harness.replaceRenderer).toHaveBeenCalledOnce();
    expect(harness.coordinator.hasHydratedRenderer()).toBe(false);
  });

  it("accepts only the current renderer import action and falls back once after its bounded timeout", async () => {
    const harness = createHarness();
    harness.coordinator.replaceRenderer();
    harness.coordinator.rendererStarted();
    await harness.coordinator.enqueueSynchronization(false);
    harness.coordinator.acknowledge(latestSynchronization(harness.posted));
    harness.posted.length = 0;

    const preparation = harness.coordinator.requestImportOptionsChange();
    const request = harness.posted.at(-1) as { kind: string; actionId: string };
    const task = Promise.resolve();
    expect(harness.coordinator.expectsImportAction("stale-action")).toBe(false);
    expect(harness.coordinator.settleImportAction("stale-action", { task })).toBe(false);
    expect(harness.coordinator.expectsImportAction(request.actionId)).toBe(true);
    expect(harness.coordinator.settleImportAction(request.actionId, { task })).toBe(true);
    await expect(preparation).resolves.toEqual({ task });

    const fallback = harness.coordinator.requestImportOptionsChange();
    const fallbackRequest = harness.posted.at(-1) as { kind: string; actionId: string };
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(fallback).resolves.toBeUndefined();
    expect(harness.coordinator.settleImportAction(fallbackRequest.actionId, { task })).toBe(false);
  });

  it("replays a retained import failure after the authoritative snapshot and ignores an older acknowledgement", async () => {
    const harness = createHarness();
    const failure: OpenWranglerResponse = {
      kind: "error",
      code: "invalid_import_options",
      message: "The selected delimiter does not match this file.",
      recoverable: true,
      sessionId: snapshot.metadata.sessionId
    };
    harness.coordinator.replaceRenderer();
    harness.coordinator.rendererStarted();
    await harness.coordinator.enqueueSynchronization(false);
    const older = latestSynchronization(harness.posted);
    await harness.coordinator.postImportResponse(failure);

    expect(harness.coordinator.acknowledge(older)).toBeUndefined();
    harness.posted.length = 0;
    harness.coordinator.rendererStarted();
    await harness.coordinator.enqueueSynchronization(false);

    expect(harness.posted[0]).toBe(snapshot);
    expect(harness.posted[1]).toBe(failure);
    const current = latestSynchronization(harness.posted);
    expect(current.sessionId).toBe(snapshot.metadata.sessionId);
    expect(harness.coordinator.acknowledge(current)).toBe(harness.coordinator.currentSynchronization);
  });

  it("opens only an empty host state and never reopens a retained response during renderer recovery", async () => {
    const harness = createHarness({ snapshot: undefined, openResponse: undefined });
    harness.ensureSessionOpen.mockImplementation(async () => {
      harness.state.openResponse = {
        kind: "error",
        code: "missing_dependencies",
        message: "Install the selected runtime dependencies.",
        recoverable: true
      };
    });
    harness.coordinator.replaceRenderer();
    harness.coordinator.rendererStarted();
    await harness.coordinator.enqueueSynchronization(false);
    expect(harness.ensureSessionOpen).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    harness.coordinator.rendererStarted();
    await harness.coordinator.enqueueSynchronization(false);
    expect(harness.ensureSessionOpen).toHaveBeenCalledOnce();
    expect(harness.clearStepInspection).not.toHaveBeenCalled();
  });
});

interface HarnessState {
  snapshot: SessionOpenedResponse | undefined;
  openResponse: OpenWranglerResponse | undefined;
  presentation: SessionPresentation | undefined;
  viewState: GridViewState | undefined;
  importBusy: boolean;
  visible: boolean;
}

interface Harness {
  readonly coordinator: RendererSynchronizationCoordinator;
  readonly state: HarnessState;
  readonly posted: unknown[];
  readonly replaceRenderer: ReturnType<typeof vi.fn<() => void>>;
  readonly ensureSessionOpen: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly clearStepInspection: ReturnType<typeof vi.fn<() => void>>;
  readonly didSynchronize: ReturnType<typeof vi.fn<(value: RendererSynchronizationIdentity) => void>>;
  readonly didPublishAuthoritativeSnapshot: ReturnType<typeof vi.fn<() => void>>;
  readonly reportDiagnostic: ReturnType<typeof vi.fn<(message: string) => void>>;
}

function createHarness(
  options: Partial<HarnessState> & {
    postMessage?: RendererSynchronizationCallbacks["postMessage"];
  } = {}
): Harness {
  const state: HarnessState = {
    snapshot,
    openResponse: snapshot,
    presentation: undefined,
    viewState: undefined,
    importBusy: false,
    visible: true,
    ...options
  };
  const posted: unknown[] = [];
  const replaceRenderer = vi.fn();
  const ensureSessionOpen = vi.fn(async () => undefined);
  const clearStepInspection = vi.fn();
  const didSynchronize = vi.fn();
  const didPublishAuthoritativeSnapshot = vi.fn();
  const reportDiagnostic = vi.fn();
  let nextId = 0;
  const coordinator = new RendererSynchronizationCoordinator(
    {
      postMessage:
        options.postMessage ??
        ((message) => {
          posted.push(message);
          return Promise.resolve(true);
        }),
      replaceRenderer,
      isVisible: () => state.visible,
      getSnapshot: () => state.snapshot,
      getOpenResponse: () => state.openResponse,
      getSessionPresentation: () => state.presentation,
      getViewState: () => state.viewState,
      isImportBusy: () => state.importBusy,
      ensureSessionOpen,
      clearStepInspection,
      layoutTransitionPending: () => false,
      didSynchronize,
      didPublishAuthoritativeSnapshot,
      reportDiagnostic
    },
    {
      createId: () => `synchronization-${String(++nextId).padStart(16, "0")}`
    }
  );
  return {
    coordinator,
    state,
    posted,
    replaceRenderer,
    ensureSessionOpen,
    clearStepInspection,
    didSynchronize,
    didPublishAuthoritativeSnapshot,
    reportDiagnostic
  };
}

function latestSynchronization(posted: readonly unknown[]): RendererSynchronizationIdentity {
  for (let index = posted.length - 1; index >= 0; index -= 1) {
    const synchronization = posted[index];
    if (isSynchronization(synchronization)) return synchronization;
  }
  throw new Error("The coordinator did not publish a synchronization marker.");
}

function isSynchronization(value: unknown): value is RendererSynchronizationIdentity & { kind: string } {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "rendererSynchronization"
  );
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
