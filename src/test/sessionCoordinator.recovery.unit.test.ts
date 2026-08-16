import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Memento, NotebookDocument } from "vscode";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { persistedSessionState, persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionOpenedResponse,
  TransformStep
} from "../shared/protocol";
import {
  openRequest,
  columnWindow,
  openedResponse,
  pageResponse,
  projectedPage,
  pageResponseForMetadata,
  stepPreviewResponse,
  planUpdatedResponse,
  summaryResponse,
  datasetStatsResponse,
  setOpenNotebookDocuments,
  deferred
} from "./sessionCoordinatorTestFixtures";

describe("SessionCoordinator", () => {
  it("reopens original data with an empty plan only when saved cleaning replay fails", async () => {
    const savedStep: TransformStep = {
      id: "invalid-for-source",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "missing" }] }
    };
    const key = persistenceKey(openRequest.source, "polars");
    const stored = {
      [key]: persistedSessionState(
        { ...openedResponse().metadata, steps: [savedStep] },
        { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
      )
    };
    const workspaceState = {
      get: vi.fn((storageKey: string) => (storageKey === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    let openCount = 0;
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openedResponse(`cleaning-runtime-${openCount}`);
      }
      if (request.kind === "previewStep") {
        executionOrder.push("preview-failed");
        return {
          kind: "error",
          code: "engine_error",
          message: "The saved step no longer applies to this source.",
          recoverable: true,
          sessionId: request.sessionId
        };
      }
      if (request.kind === "closeSession") {
        executionOrder.push(`close-${request.sessionId}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const restored = await bridge.request(openRequest);

    expect(restored).toMatchObject({
      kind: "sessionOpened",
      metadata: { revision: 0, steps: [], filterModel: { filters: [], sort: [] } }
    });
    expect(executionOrder).toEqual(["open-1", "preview-failed", "close-cleaning-runtime-1", "open-2"]);
    expect(
      delegateRequest.mock.calls.map(([request]) => request).filter((request) => request.kind === "openSession")
    ).toEqual([openRequest, openRequest]);
  });

  it("persists grid presentation separately and notifies native views only when column selection changes", async () => {
    let stored: Record<string, unknown> = {};
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? stored : fallback)),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const opened = openedResponse();
    opened.metadata = {
      ...opened.metadata,
      shape: { rows: 500, columns: 2 },
      filteredShape: { rows: 500, columns: 2 },
      schema: [
        { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
        { id: "c:sales", name: "sales", position: 1, rawType: "Int64", type: "integer", nullable: false }
      ]
    };
    opened.page = { ...opened.page, totalRows: 500, columnIds: opened.metadata.schema.map((column) => column.id) };
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: vi.fn(async () => opened) });
    const response = await bridge.request(openRequest);
    if (response.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    await bridge.updateViewState?.(response.metadata.sessionId, {
      columnWidths: { "c:sales": 260, removed: 300 },
      selectedColumnId: "c:sales",
      viewport: { firstVisibleRow: 240, scrollLeft: 180 }
    });

    expect(activeChanges).toHaveBeenCalledOnce();
    expect(coordinator.activeSession()?.viewState).toMatchObject({
      filterModel: response.metadata.filterModel,
      columnWidths: { "c:sales": 260 },
      selectedColumnId: "c:sales",
      viewport: { firstVisibleRow: 240, scrollLeft: 180 }
    });
    expect(stored[persistenceKey(openRequest.source, "polars")]).toMatchObject({
      cleaning: { steps: [] },
      view: {
        filterModel: response.metadata.filterModel,
        columnWidths: { "c:sales": 260 },
        selectedColumnId: "c:sales",
        viewport: { firstVisibleRow: 240, scrollLeft: 180 }
      }
    });

    await bridge.updateViewState?.(response.metadata.sessionId, {
      columnWidths: { "c:sales": 260 },
      selectedColumnId: "c:sales",
      viewport: { firstVisibleRow: 260, scrollLeft: 220 }
    });
    expect(activeChanges).toHaveBeenCalledOnce();
    expect(workspaceState.update).toHaveBeenCalledTimes(2);
  });

  it("runs a promoted selected summary beside passive profiling while keeping mutations exclusive", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const selectedProfile = deferred<OpenWranglerResponse>();
    const activeMutation = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const selectedOptions: Array<BridgeRequestOptions | undefined> = [];
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return openedResponse();
        if (request.kind === "getDatasetStats") {
          executionOrder.push("active");
          return activeProfile.promise;
        }
        if (request.kind === "getSummary") {
          executionOrder.push(request.viewRequestId.includes("selected") ? "selected" : "other");
          if (request.viewRequestId === "promote-selected") {
            selectedOptions.push(options);
            return selectedProfile.promise;
          }
          return summaryResponse(request.viewRequestId);
        }
        if (request.kind === "previewStep") {
          executionOrder.push("mutation");
          return activeMutation.promise;
        }
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const sessionId = opened.metadata.sessionId;

    const stats = bridge.request({
      kind: "getDatasetStats",
      sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "promote-active",
      filterModel: opened.metadata.filterModel
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["active"]));
    bridge.prioritizeViewRequest?.(sessionId, "promote-active");
    const selected = bridge.request(
      {
        kind: "getSummary",
        sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "promote-selected",
        filterModel: opened.metadata.filterModel
      },
      { priority: "background", timeoutMs: 12_000 }
    );
    const other = bridge.request({
      kind: "getSummary",
      sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "promote-other",
      filterModel: opened.metadata.filterModel
    });
    bridge.prioritizeViewRequest?.(sessionId, "promote-selected");

    await vi.waitFor(() => expect(executionOrder).toEqual(["active", "selected"]));
    expect(selectedOptions).toEqual([{ priority: "interactive", timeoutMs: 12_000 }]);
    expect(coordinator.testingRequestExecutionCheckpoint(sessionId, "getSummary", "promote-selected")).toEqual({
      sessionId,
      state: "active",
      lane: "foreground",
      requestKind: "getSummary",
      viewRequestId: "promote-selected"
    });
    expect(coordinator.testingRequestExecutionCheckpoint(sessionId, "getSummary", "promote-other")).toEqual({
      sessionId,
      state: "queued",
      lane: "background",
      requestKind: "getSummary",
      viewRequestId: "promote-other"
    });
    expect(
      delegateRequest.mock.calls.filter(
        ([request]) => request.kind === "getSummary" && request.viewRequestId === "promote-selected"
      )
    ).toHaveLength(1);

    const step: TransformStep = {
      id: "queued-behind-profile",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "sales" }] }
    };
    const mutation = bridge.request({
      kind: "previewStep",
      sessionId,
      revision: opened.metadata.revision,
      step,
      offset: 0,
      limit: 100,
      ...columnWindow
    });
    expect(coordinator.testingSessionSchedulerState(sessionId)).toMatchObject({
      activeForegroundOperation: true,
      activeBackgroundOperation: true,
      interactiveQueueLength: 1,
      backgroundQueueLength: 1
    });

    selectedProfile.resolve(summaryResponse("promote-selected"));
    await expect(selected).resolves.toMatchObject({ kind: "summary", viewRequestId: "promote-selected" });
    await vi.waitFor(() =>
      expect(coordinator.testingSessionSchedulerState(sessionId)).toMatchObject({
        activeForegroundOperation: false,
        activeBackgroundOperation: true,
        interactiveQueueLength: 1,
        backgroundQueueLength: 1
      })
    );
    expect(executionOrder).toEqual(["active", "selected"]);

    activeProfile.resolve(datasetStatsResponse("promote-active"));
    await expect(stats).resolves.toMatchObject({ kind: "datasetStats", viewRequestId: "promote-active" });
    await vi.waitFor(() => expect(executionOrder).toEqual(["active", "selected", "mutation"]));
    expect(coordinator.testingSessionSchedulerState(sessionId)).toMatchObject({
      activeForegroundOperation: true,
      activeBackgroundOperation: false,
      interactiveQueueLength: 0,
      backgroundQueueLength: 1
    });

    activeMutation.resolve(stepPreviewResponse(1, step));
    await expect(mutation).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
    await expect(other).resolves.toMatchObject({
      kind: "error",
      code: "stale_request",
      viewRequestId: "promote-other"
    });
    expect(executionOrder).toEqual(["active", "selected", "mutation"]);
  });

  it("rejects queued mutations and pages when an earlier mutation advances the public revision", async () => {
    const activeMutation = deferred<OpenWranglerResponse>();
    const dispatched: string[] = [];
    const step: TransformStep = {
      id: "queued-revision",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "sales" }] }
    };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "previewStep") {
        dispatched.push("preview");
        return activeMutation.promise;
      }
      if (request.kind === "applyDraft") {
        dispatched.push("apply");
        return planUpdatedResponse(2, [step]);
      }
      if (request.kind === "getPage") {
        dispatched.push("page");
        return pageResponse(request);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const preview = bridge.request({
      kind: "previewStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      step,
      offset: 0,
      limit: 100,
      ...columnWindow
    });
    await vi.waitFor(() => expect(dispatched).toEqual(["preview"]));
    const staleApply = bridge.request({
      kind: "applyDraft",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 100,
      ...columnWindow
    });
    const stalePage = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "queued-stale-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    activeMutation.resolve(stepPreviewResponse(1, step));
    await expect(preview).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
    await expect(staleApply).resolves.toMatchObject({
      kind: "error",
      code: "stale_request",
      sessionId: opened.metadata.sessionId
    });
    await expect(stalePage).resolves.toMatchObject({
      kind: "error",
      code: "stale_request",
      sessionId: opened.metadata.sessionId,
      viewRequestId: "queued-stale-page"
    });

    expect(dispatched).toEqual(["preview"]);
    expect(coordinator.activeSession()?.metadata.revision).toBe(1);
  });

  it("coalesces concurrent foreground and renderer-background recovery for one lost runtime", async () => {
    const summaryFailure = deferred<OpenWranglerResponse>();
    const pageFailure = deferred<OpenWranglerResponse>();
    const recoveryStarted = deferred<void>();
    const finishRecoveryOpen = deferred<void>();
    const executionOrder: string[] = [];
    let openCount = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        if (openCount === 2) {
          recoveryStarted.resolve(undefined);
          await finishRecoveryOpen.promise;
        }
        return openedResponse(`runtime-${openCount}`);
      }
      if (request.kind === "getSummary") {
        executionOrder.push(`summary-${request.sessionId}`);
        if (request.sessionId === "runtime-1") return summaryFailure.promise;
        return summaryResponse(request.viewRequestId);
      }
      if (request.kind === "getPage") {
        if (request.limit === 1) {
          executionOrder.push(`restore-${request.sessionId}`);
          return pageResponse(request, request.sessionId);
        }
        executionOrder.push(`page-${request.sessionId}`);
        if (request.sessionId === "runtime-1") return pageFailure.promise;
        return pageResponse(request, request.sessionId);
      }
      if (request.kind === "closeSession") {
        executionOrder.push(`close-${request.sessionId}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    bridge.setViewContext?.(opened.metadata.sessionId, "renderer-view");

    const summary = bridge.request(
      {
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "single-flight-summary",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "renderer-view" }
    );
    await vi.waitFor(() => expect(executionOrder).toContain("summary-runtime-1"));
    const page = bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "single-flight-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "renderer-view" }
    );
    await vi.waitFor(() => expect(executionOrder).toContain("page-runtime-1"));
    summaryFailure.resolve({
      kind: "error",
      code: "unknown_session",
      message: "Unknown session: runtime-1",
      recoverable: true,
      sessionId: "runtime-1",
      viewRequestId: "single-flight-summary"
    });
    pageFailure.resolve({
      kind: "error",
      code: "unknown_session",
      message: "Unknown session: runtime-1",
      recoverable: true,
      sessionId: "runtime-1",
      viewRequestId: "single-flight-page"
    });
    await recoveryStarted.promise;
    await Promise.resolve();
    finishRecoveryOpen.resolve(undefined);

    await expect(summary).resolves.toMatchObject({
      kind: "summary",
      viewRequestId: "single-flight-summary"
    });
    await expect(page).resolves.toMatchObject({ kind: "page", viewRequestId: "single-flight-page" });
    expect(openCount).toBe(2);
    expect(executionOrder.filter((entry) => entry === "open-2")).toHaveLength(1);
    expect(executionOrder).toContain("restore-runtime-2");
    expect(executionOrder).toContain("summary-runtime-2");
    expect(executionOrder).toContain("page-runtime-2");
  });

  it("pins an automatically selected backend for confirmed missing-runtime replay", async () => {
    const autoRequest = { ...openRequest, backend: undefined };
    const openedBackends: Array<string | undefined> = [];
    let openCount = 0;
    let pageAttempts = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        openedBackends.push(request.backend);
        return openedResponse(`duckdb-runtime-${openCount}`, "duckdb");
      }
      if (request.kind === "getPage") {
        if (request.limit === 1) return pageResponse(request, `duckdb-runtime-${openCount}`, "duckdb");
        pageAttempts += 1;
        if (pageAttempts === 1) {
          return {
            kind: "error",
            code: "unknown_session",
            message: `Open Wrangler runtime session ${request.sessionId} is not available.`,
            recoverable: true,
            sessionId: request.sessionId,
            viewRequestId: request.viewRequestId
          };
        }
        return pageResponse(request, `duckdb-runtime-${openCount}`, "duckdb");
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(autoRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the automatic session to open.");

    const recovered = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "duckdb-recovery-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    expect(recovered).toMatchObject({ kind: "page", metadata: { backend: "duckdb" } });
    expect(openedBackends).toEqual([undefined, "duckdb"]);
  });

  it("pins the runtime-confirmed view-only mode for missing-runtime replay", async () => {
    const source = {
      kind: "notebookVariable" as const,
      label: "duckdb_relation",
      variableName: "duckdb_relation",
      uri: "file:///workspace/duckdb.ipynb"
    };
    const requestedSessionId = "known-duckdb-runtime";
    const openedModes: Array<string | undefined> = [];
    const requestedSessionIds: Array<string | undefined> = [];
    let openCount = 0;
    let pageAttempts = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        openedModes.push(request.mode);
        requestedSessionIds.push(request.requestedSessionId);
        const response = openedResponse(
          request.requestedSessionId ?? `recovered-duckdb-runtime-${openCount}`,
          "duckdb"
        );
        response.metadata = {
          ...response.metadata,
          source,
          mode: "viewing",
          capabilities: {
            ...response.metadata.capabilities,
            editable: false
          }
        };
        return response;
      }
      if (request.kind === "getPage") {
        if (request.limit !== 1) {
          pageAttempts += 1;
          if (pageAttempts === 1) {
            return {
              kind: "error",
              code: "unknown_session",
              message: `Open Wrangler runtime session ${request.sessionId} is not available.`,
              recoverable: true,
              sessionId: request.sessionId,
              viewRequestId: request.viewRequestId
            };
          }
        }
        const response = pageResponse(request, request.sessionId, "duckdb");
        response.metadata = {
          ...response.metadata,
          source,
          mode: "viewing",
          capabilities: {
            ...response.metadata.capabilities,
            editable: false
          }
        };
        return response;
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected confirmed-mode recovery request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request({
      ...openRequest,
      source,
      backend: "duckdb",
      mode: "editing",
      requestedSessionId
    });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the DuckDB notebook variable to open.");

    expect(opened.metadata).toMatchObject({
      sessionId: expect.any(String),
      backend: "duckdb",
      mode: "viewing"
    });

    const recovered = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "duckdb-confirmed-mode-recovery",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    expect(recovered).toMatchObject({
      kind: "page",
      metadata: {
        sessionId: opened.metadata.sessionId,
        backend: "duckdb",
        mode: "viewing"
      }
    });
    expect(openedModes).toEqual(["editing", "viewing"]);
    expect(requestedSessionIds).toEqual([requestedSessionId, undefined]);
    expect(openCount).toBe(2);
    expect(pageAttempts).toBe(2);
  });

  it("rejects and closes a recovery candidate when a same-URI notebook begins overlapping", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/recovery.ipynb"),
      isClosed: false
    } as NotebookDocument;
    const overlappingReplacement = {
      uri: vscode.Uri.parse("file:///workspace/recovery.ipynb"),
      isClosed: false
    } as NotebookDocument;
    setOpenNotebookDocuments(notebook);
    let openCount = 0;
    const closedRuntimeIds: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        if (openCount === 2) setOpenNotebookDocuments(notebook, overlappingReplacement);
        return openedResponse(openCount === 1 ? "runtime-old" : "runtime-recovery-candidate");
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-old") {
        return {
          kind: "error",
          code: "engine_error",
          message: "Unknown session: runtime-old",
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "closeSession") {
        closedRuntimeIds.push(request.sessionId);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected recovery provenance request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest }, notebook);

    try {
      const opened = await bridge.request({
        ...openRequest,
        source: {
          kind: "notebookVariable",
          label: "frame",
          variableName: "frame",
          uri: notebook.uri.toString()
        },
        mode: "viewing"
      });
      if (opened.kind !== "sessionOpened") throw new Error("Expected the notebook session to open.");

      const response = await bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "same-uri-recovery",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      });

      expect(response).toMatchObject({
        kind: "error",
        code: "engine_error",
        sessionId: opened.metadata.sessionId,
        viewRequestId: "same-uri-recovery"
      });
      expect(openCount).toBe(2);
      expect(closedRuntimeIds).toEqual(["runtime-recovery-candidate"]);
      expect(coordinator.diagnostics().sessions).toEqual([
        expect.objectContaining({ publicId: opened.metadata.sessionId, runtimeId: "runtime-old" })
      ]);

      await bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      });
      expect(closedRuntimeIds).toEqual(["runtime-recovery-candidate", "runtime-old"]);
    } finally {
      setOpenNotebookDocuments();
      await coordinator.shutdown();
    }
  });

  it("serializes concurrent recovery for sessions sharing one runtime delegate", async () => {
    let openCount = 0;
    let firstRecoveryRestoreStarted = false;
    const firstRecoveryRestoreGate = deferred<void>();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        if (openCount <= 3) return openedResponse(`runtime-old-${openCount}`);
        return openedResponse(`runtime-new-${openCount - 3}`);
      }
      if (request.kind === "getPage" && request.sessionId.startsWith("runtime-old-")) {
        return {
          kind: "error",
          code: "engine_error",
          message: `Unknown session: ${request.sessionId}`,
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-new-1" && request.limit === 1) {
        firstRecoveryRestoreStarted = true;
        await firstRecoveryRestoreGate.promise;
        return pageResponse(request, request.sessionId);
      }
      if (request.kind === "getPage") return pageResponse(request, request.sessionId);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened: SessionOpenedResponse[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await bridge.request(openRequest);
      if (response.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
      opened.push(response);
    }

    const recoveries = opened.map((session, index) =>
      bridge.request({
        kind: "getPage",
        sessionId: session.metadata.sessionId,
        revision: session.metadata.revision,
        viewRequestId: `shared-runtime-recovery-${index}`,
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: session.metadata.filterModel
      })
    );

    await vi.waitFor(() => expect(firstRecoveryRestoreStarted).toBe(true));
    await Promise.resolve();
    expect(openCount).toBe(4);
    firstRecoveryRestoreGate.resolve();

    await expect(Promise.all(recoveries)).resolves.toEqual(
      opened.map((session, index) =>
        expect.objectContaining({
          kind: "page",
          revision: session.metadata.revision,
          viewRequestId: `shared-runtime-recovery-${index}`
        })
      )
    );
    expect(openCount).toBe(6);
    expect(coordinator.diagnostics().sessions.map((session) => session.runtimeId)).toEqual([
      "runtime-new-1",
      "runtime-new-2",
      "runtime-new-3"
    ]);
    await coordinator.shutdown();
  });

  it("keeps recovery concurrent for sessions backed by independent runtime delegates", async () => {
    const recoveryRestoreGate = deferred<void>();
    let activeRecoveryRestores = 0;
    let enteredRecoveryRestores = 0;
    let maximumConcurrentRecoveryRestores = 0;
    const makeDelegate = (label: string): OpenWranglerBridge => {
      let openCount = 0;
      return {
        request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
          if (request.kind === "openSession") {
            openCount += 1;
            return openedResponse(`${label}-${openCount === 1 ? "old" : "new"}`);
          }
          if (request.kind === "getPage" && request.sessionId === `${label}-old`) {
            return {
              kind: "error",
              code: "engine_error",
              message: `Unknown session: ${request.sessionId}`,
              recoverable: true,
              sessionId: request.sessionId,
              viewRequestId: request.viewRequestId
            };
          }
          if (request.kind === "getPage" && request.limit === 1) {
            enteredRecoveryRestores += 1;
            activeRecoveryRestores += 1;
            maximumConcurrentRecoveryRestores = Math.max(maximumConcurrentRecoveryRestores, activeRecoveryRestores);
            try {
              await recoveryRestoreGate.promise;
              return pageResponse(request, request.sessionId);
            } finally {
              activeRecoveryRestores -= 1;
            }
          }
          if (request.kind === "getPage") return pageResponse(request, request.sessionId);
          if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
          throw new Error(`Unexpected ${label} delegate request: ${request.kind}`);
        })
      };
    };
    const coordinator = new SessionCoordinator();
    const firstBridge = coordinator.createBridge(makeDelegate("first-runtime"));
    const secondBridge = coordinator.createBridge(makeDelegate("second-runtime"));
    const firstOpened = await firstBridge.request(openRequest);
    const secondOpened = await secondBridge.request(openRequest);
    if (firstOpened.kind !== "sessionOpened" || secondOpened.kind !== "sessionOpened") {
      throw new Error("Expected both independent sessions to open.");
    }

    const recoveries = Promise.all([
      firstBridge.request({
        kind: "getPage",
        sessionId: firstOpened.metadata.sessionId,
        revision: firstOpened.metadata.revision,
        viewRequestId: "independent-recovery-first",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: firstOpened.metadata.filterModel
      }),
      secondBridge.request({
        kind: "getPage",
        sessionId: secondOpened.metadata.sessionId,
        revision: secondOpened.metadata.revision,
        viewRequestId: "independent-recovery-second",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: secondOpened.metadata.filterModel
      })
    ]);

    try {
      await vi.waitFor(() => expect(enteredRecoveryRestores).toBe(2));
      expect(maximumConcurrentRecoveryRestores).toBe(2);
    } finally {
      recoveryRestoreGate.resolve();
    }

    await expect(recoveries).resolves.toEqual([
      expect.objectContaining({ kind: "page", viewRequestId: "independent-recovery-first" }),
      expect.objectContaining({ kind: "page", viewRequestId: "independent-recovery-second" })
    ]);
    expect(coordinator.diagnostics().sessions.map((session) => session.runtimeId)).toEqual([
      "first-runtime-new",
      "second-runtime-new"
    ]);
    await coordinator.shutdown();
  });

  it("does not establish a fresh session on a delegate while recovery is still restoring", async () => {
    let openCount = 0;
    let recoveryRestoreStarted = false;
    const recoveryRestoreGate = deferred<void>();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        if (openCount === 1) return openedResponse("runtime-old");
        if (openCount === 2) return openedResponse("runtime-recovery");
        return openedResponse("runtime-fresh");
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-old") {
        return {
          kind: "error",
          code: "engine_error",
          message: `Unknown session: ${request.sessionId}`,
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-recovery" && request.limit === 1) {
        recoveryRestoreStarted = true;
        await recoveryRestoreGate.promise;
        return pageResponse(request, request.sessionId);
      }
      if (request.kind === "getPage") return pageResponse(request, request.sessionId);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const onIdle = vi.fn();
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the original session to open.");
    const recovery = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "recovery-before-fresh-open",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });
    const recoverySettlement = recovery.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );

    await vi.waitFor(() => expect(recoveryRestoreStarted).toBe(true));
    const freshOpen = bridge.request({
      ...openRequest,
      source: { kind: "file", label: "fresh.csv", path: "/workspace/fresh.csv" }
    });
    const freshSettlement = freshOpen.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );

    try {
      await Promise.resolve();
      expect(openCount).toBe(2);
    } finally {
      recoveryRestoreGate.resolve();
    }

    const [recovered, fresh] = await Promise.all([recoverySettlement, freshSettlement]);
    expect(recovered).toMatchObject({ status: "fulfilled", value: { kind: "page" } });
    expect(fresh).toMatchObject({ status: "fulfilled", value: { kind: "sessionOpened" } });
    expect(openCount).toBe(3);
    expect(coordinator.diagnostics().sessions.map((session) => session.runtimeId)).toEqual([
      "runtime-recovery",
      "runtime-fresh"
    ]);
    await coordinator.shutdown();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("drains a serialized recovery chain before shutdown releases its runtime delegate", async () => {
    let openCount = 0;
    let recoveryRestoreStarted = false;
    const recoveryRestoreGate = deferred<void>();
    const events: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        return openedResponse(openCount <= 2 ? `runtime-old-${openCount}` : `runtime-candidate-${openCount - 2}`);
      }
      if (request.kind === "getPage" && request.sessionId.startsWith("runtime-old-")) {
        return {
          kind: "error",
          code: "engine_error",
          message: `Unknown session: ${request.sessionId}`,
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-candidate-1" && request.limit === 1) {
        recoveryRestoreStarted = true;
        events.push("restore-candidate-1");
        await recoveryRestoreGate.promise;
        return pageResponse(request, request.sessionId);
      }
      if (request.kind === "getPage") return pageResponse(request, request.sessionId);
      if (request.kind === "closeSession") {
        events.push(`close-${request.sessionId}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const onIdle = vi.fn(() => events.push("idle"));
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const opened: SessionOpenedResponse[] = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await bridge.request(openRequest);
      if (response.kind !== "sessionOpened") throw new Error("Expected the original sessions to open.");
      opened.push(response);
    }

    const recoverySettlements = Promise.allSettled(
      opened.map((session, index) =>
        bridge.request({
          kind: "getPage",
          sessionId: session.metadata.sessionId,
          revision: session.metadata.revision,
          viewRequestId: `shutdown-recovery-${index}`,
          offset: 0,
          limit: 100,
          ...columnWindow,
          filterModel: session.metadata.filterModel
        })
      )
    );
    await vi.waitFor(() => expect(recoveryRestoreStarted).toBe(true));

    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();
    recoveryRestoreGate.resolve();

    const [results] = await Promise.all([recoverySettlements, shutdown]);
    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ kind: "error" }) }),
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ kind: "error" }) })
    ]);
    expect(openCount).toBe(3);
    expect(events).toContain("close-runtime-candidate-1");
    expect(events).toContain("close-runtime-old-1");
    expect(events).toContain("close-runtime-old-2");
    expect(events.indexOf("close-runtime-candidate-1")).toBeLessThan(events.indexOf("close-runtime-old-1"));
    expect(events.indexOf("close-runtime-candidate-1")).toBeLessThan(events.indexOf("close-runtime-old-2"));
    expect(events.at(-1)).toBe("idle");
    expect(onIdle).toHaveBeenCalledOnce();
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("closes a failed replay candidate without corrupting the live coordinated state", async () => {
    const firstStep: TransformStep = {
      id: "replay-first",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "first" }] }
    };
    const secondStep: TransformStep = {
      id: "replay-second",
      kind: "renameColumn",
      params: { column: { id: "c:source:1", name: "second" }, newName: "renamed" }
    };
    const liveOpened = openedResponse("runtime-live");
    liveOpened.metadata = {
      ...liveOpened.metadata,
      revision: 4,
      shape: { rows: 7, columns: 2 },
      filteredShape: { rows: 7, columns: 2 },
      steps: [firstStep, secondStep]
    };
    let openCount = 0;
    let failLivePage = true;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        return openCount === 1 ? liveOpened : openedResponse("runtime-candidate");
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-live") {
        if (failLivePage) {
          failLivePage = false;
          throw new Error("live transport failed");
        }
        return pageResponseForMetadata(request, liveOpened.metadata);
      }
      if (request.kind === "previewStep" && request.sessionId === "runtime-candidate") {
        if (request.step.id === firstStep.id) {
          const response = stepPreviewResponse(1, firstStep, "runtime-candidate", "candidate-preview-code");
          return { ...response, page: projectedPage(request, response.metadata) };
        }
        return {
          kind: "error",
          code: "engine_error",
          message: "second replay step failed",
          recoverable: true,
          sessionId: request.sessionId
        };
      }
      if (request.kind === "applyDraft" && request.sessionId === "runtime-candidate") {
        const response = planUpdatedResponse(2, [firstStep], "runtime-candidate", "candidate-applied-code");
        return { ...response, page: projectedPage(request, response.metadata) };
      }
      if (request.kind === "closeSession" && request.sessionId === "runtime-candidate") {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    expect(opened.metadata.revision).toBe(4);
    expect(coordinator.activeSession()?.code).toBe("");

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "failed-replay-page",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).rejects.toThrow("live transport failed");

    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({
        runtimeId: "runtime-live",
        publicRevision: 4,
        runtimeRevision: 4
      })
    ]);
    expect(coordinator.activeSession()).toMatchObject({
      metadata: {
        revision: 4,
        shape: { rows: 7, columns: 2 },
        steps: [firstStep, secondStep]
      },
      code: ""
    });
    expect(
      delegateRequest.mock.calls.map(([request]) => request).filter((request) => request.kind === "closeSession")
    ).toEqual([{ kind: "closeSession", sessionId: "runtime-candidate", revision: 2 }]);

    const retried = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "live-state-retry",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });
    expect(retried).toMatchObject({ kind: "page", revision: 4, viewRequestId: "live-state-retry" });
    expect(delegateRequest.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "getPage",
      sessionId: "runtime-live",
      revision: 4
    });
  });

  it("diagnoses a retired-runtime close error without destabilizing the replacement session", async () => {
    let openCount = 0;
    let failLivePage = true;
    let cleanupOptions: BridgeRequestOptions | undefined;
    const reportDiagnostic = vi.fn();
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          openCount += 1;
          return openedResponse(openCount === 1 ? "runtime-live" : "runtime-replacement");
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-live") {
          if (failLivePage) {
            failLivePage = false;
            throw new Error("live transport failed");
          }
          return pageResponse(request, "runtime-live");
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-replacement") {
          return pageResponse(request, "runtime-replacement");
        }
        if (request.kind === "closeSession" && request.sessionId === "runtime-live") {
          cleanupOptions = options;
          return {
            kind: "error",
            code: "engine_error",
            message: "retired close failed",
            recoverable: true,
            sessionId: request.sessionId
          };
        }
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, reportDiagnostic });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    await expect(
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId: "retired-cleanup-page",
          offset: 0,
          limit: 100,
          ...columnWindow,
          filterModel: opened.metadata.filterModel
        },
        { timeoutMs: 11, viewContextId: "replacement-view" }
      )
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "retired-cleanup-page" });

    await vi.waitFor(() => expect(reportDiagnostic).toHaveBeenCalledOnce());
    expect(cleanupOptions).toEqual({
      priority: "interactive",
      timeoutMs: 2_000,
      restartRuntimeOnTimeout: false,
      startRuntimeIfNeeded: false
    });
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/retired runtime session runtime-live.*engine_error: retired close failed/)
    );
    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({ runtimeId: "runtime-replacement", runtimeRevision: 0 })
    ]);

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "replacement-still-live",
        offset: 100,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "replacement-still-live" });
  });
});
