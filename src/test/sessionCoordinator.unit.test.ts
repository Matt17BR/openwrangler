import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import type { FilterModel } from "../shared/filterModel";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse,
  TransformStep
} from "../shared/protocol";

const openRequest = {
  kind: "openSession",
  source: { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" },
  backend: "polars",
  mode: "editing",
  pageSize: 100
} as const;

describe("SessionCoordinator", () => {
  it("restores persisted viewing state without synchronously profiling columns", async () => {
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    };
    const stored = {
      [persistenceKey(openRequest.source)]: { steps: [], filterModel }
    };
    const workspaceState = {
      get: vi.fn((key: string) => (key === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const runtimeOpened = openedResponse();
    runtimeOpened.summaries = [
      {
        column: "sales",
        type: "float",
        rawType: "Float64",
        totalCount: 1,
        nullCount: 0,
        nanCount: 0,
        distinctCount: 1,
        topValues: [{ value: "10", count: 1 }]
      }
    ];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "getPage") {
        return {
          kind: "page",
          revision: 0,
          viewRequestId: request.viewRequestId,
          metadata: { ...runtimeOpened.metadata, filterModel },
          page: runtimeOpened.page
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const restored = await bridge.request(openRequest);

    expect(restored.kind).toBe("sessionOpened");
    if (restored.kind !== "sessionOpened") throw new Error("Expected the persisted session to open.");
    expect(restored.metadata.filterModel).toEqual(filterModel);
    expect(restored.summaries).toEqual([]);
    expect(delegateRequest.mock.calls.map(([request]) => request.kind)).toEqual(["openSession", "getPage"]);
  });

  it("lets an interactive page overtake active and queued background profiling", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    let profileNumber = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        profileNumber += 1;
        executionOrder.push(`profile-${profileNumber}`);
        return profileNumber === 1 ? activeProfile.promise : summaryResponse(request.viewRequestId);
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const firstProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "priority-profile-active",
      filterModel: opened.metadata.filterModel,
      columns: ["first"]
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile-1"]));
    const queuedProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "priority-profile-queued",
      filterModel: opened.metadata.filterModel,
      columns: ["second"]
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "priority-page",
      offset: 100,
      limit: 100,
      filterModel: opened.metadata.filterModel
    });

    await page;
    expect(executionOrder).toEqual(["profile-1", "page"]);
    activeProfile.resolve(summaryResponse("priority-profile-active"));
    await Promise.all([firstProfile, queuedProfile]);

    expect(executionOrder).toEqual(["profile-1", "page", "profile-2"]);
  });

  it("honors an explicit priority override", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getDatasetStats") {
        executionOrder.push("stats");
        return activeProfile.promise;
      }
      if (request.kind === "getSummary") {
        executionOrder.push(request.columns?.[0] ?? "summary");
        return summaryResponse(request.viewRequestId);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const stats = bridge.request({
      kind: "getDatasetStats",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "override-stats-active",
      filterModel: opened.metadata.filterModel
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["stats"]));
    const background = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "override-summary-background",
      filterModel: opened.metadata.filterModel,
      columns: ["background"]
    });
    const promoted = bridge.request(
      {
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "override-summary-promoted",
        filterModel: opened.metadata.filterModel,
        columns: ["promoted"]
      },
      { priority: "interactive" }
    );

    activeProfile.resolve(datasetStatsResponse("override-stats-active"));
    await Promise.all([stats, background, promoted]);
    expect(executionOrder).toEqual(["stats", "promoted", "background"]);
  });

  it("drops only obsolete queued background view requests", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        const column = request.columns?.[0] ?? "unknown";
        executionOrder.push(column);
        return column === "active" ? activeProfile.promise : summaryResponse(request.viewRequestId);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const requestSummary = (viewRequestId: string, column: string) =>
      bridge.request({
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId,
        filterModel: opened.metadata.filterModel,
        columns: [column]
      });
    const active = requestSummary("cancel-active", "active");
    await vi.waitFor(() => expect(executionOrder).toEqual(["active"]));
    const obsolete = requestSummary("cancel-obsolete", "obsolete");
    const retained = requestSummary("cancel-retained", "retained");

    bridge.cancelViewRequests?.(opened.metadata.sessionId, ["cancel-obsolete", "unknown"]);
    await expect(obsolete).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "cancel-obsolete"
    });

    activeProfile.resolve(summaryResponse("cancel-active"));
    await Promise.all([active, retained]);
    expect(executionOrder).toEqual(["active", "retained"]);
  });

  it("cancels queued interactive column values without cancelling a queued page", async () => {
    const activeValues = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getColumnValues") {
        executionOrder.push(request.viewRequestId);
        if (request.viewRequestId === "values-active") return activeValues.promise;
        return columnValuesResponse(request.viewRequestId, request.column);
      }
      if (request.kind === "getPage") {
        executionOrder.push(request.viewRequestId);
        return pageResponse(request);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const valuesRequest = (viewRequestId: string) =>
      bridge.request({
        kind: "getColumnValues",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId,
        column: "sales",
        filterModel: opened.metadata.filterModel,
        limit: 20
      });

    const active = valuesRequest("values-active");
    await vi.waitFor(() => expect(executionOrder).toEqual(["values-active"]));
    const obsolete = valuesRequest("values-obsolete");
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "page-retained",
      offset: 0,
      limit: 100,
      filterModel: opened.metadata.filterModel
    });

    bridge.cancelViewRequests?.(opened.metadata.sessionId, ["values-obsolete", "page-retained"]);
    await expect(obsolete).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getColumnValues",
      viewRequestId: "values-obsolete"
    });

    activeValues.resolve(columnValuesResponse("values-active", "sales"));
    await expect(active).resolves.toMatchObject({ kind: "columnValues", viewRequestId: "values-active" });
    await expect(page).resolves.toMatchObject({ kind: "page", viewRequestId: "page-retained" });
    expect(executionOrder).toEqual(["values-active", "page-retained"]);
  });

  it("rejects queued mutations and pages when an earlier mutation advances the public revision", async () => {
    const activeMutation = deferred<OpenWranglerResponse>();
    const dispatched: string[] = [];
    const step: TransformStep = { id: "queued-revision", kind: "dropColumns", params: { columns: ["sales"] } };
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
      limit: 100
    });
    await vi.waitFor(() => expect(dispatched).toEqual(["preview"]));
    const staleApply = bridge.request({
      kind: "applyDraft",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 100
    });
    const stalePage = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "queued-stale-page",
      offset: 0,
      limit: 100,
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

  it("does not replay a failed background profile and lets the next interactive request recover", async () => {
    const executionOrder: string[] = [];
    let openCount = 0;
    let interactivePageAttempts = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openedResponse(`runtime-${openCount}`);
      }
      if (request.kind === "getSummary") {
        executionOrder.push("profile");
        throw new Error("profile transport failed");
      }
      if (request.kind === "getPage") {
        if (request.limit === 1) {
          executionOrder.push("restore-page");
        } else {
          interactivePageAttempts += 1;
          executionOrder.push(`interactive-page-${interactivePageAttempts}`);
          if (interactivePageAttempts === 1) throw new Error("interactive transport failed");
        }
        return pageResponse(request, `runtime-${openCount}`);
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

    await expect(
      bridge.request({
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "failure-profile",
        filterModel: opened.metadata.filterModel
      })
    ).rejects.toThrow("profile transport failed");
    expect(openCount).toBe(1);

    const page = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "failure-interactive-page",
      offset: 0,
      limit: 100,
      filterModel: opened.metadata.filterModel
    });

    expect(page).toMatchObject({ kind: "page", viewRequestId: "failure-interactive-page" });
    expect(executionOrder).toEqual([
      "open-1",
      "profile",
      "interactive-page-1",
      "open-2",
      "restore-page",
      "close-runtime-1",
      "interactive-page-2"
    ]);
  });

  it("rejects a background response from the runtime replaced by concurrent recovery", async () => {
    const oldStats = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    let openCount = 0;
    let livePageAttempts = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openedResponse(`runtime-${openCount}`);
      }
      if (request.kind === "getDatasetStats" && request.sessionId === "runtime-1") {
        executionOrder.push("old-stats");
        return oldStats.promise;
      }
      if (request.kind === "getPage") {
        if (request.limit === 1) {
          executionOrder.push("restore-page");
          return pageResponse(request, "runtime-2");
        }
        livePageAttempts += 1;
        executionOrder.push(`page-${request.sessionId}-${livePageAttempts}`);
        if (request.sessionId === "runtime-1") throw new Error("old runtime failed");
        return pageResponse(request, "runtime-2");
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
    bridge.setViewContext?.(opened.metadata.sessionId, "logical-view-a");

    const stats = bridge.request(
      {
        kind: "getDatasetStats",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "old-runtime-stats",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "logical-view-a" }
    );
    await vi.waitFor(() => expect(executionOrder).toEqual(["open-1", "old-stats"]));
    const page = bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "recovering-page",
        offset: 0,
        limit: 100,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "logical-view-b" }
    );
    await expect(page).resolves.toMatchObject({ kind: "page", viewRequestId: "recovering-page" });

    oldStats.resolve(datasetStatsResponse("old-runtime-stats"));
    await expect(stats).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "old-runtime-stats"
    });
    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
    expect(executionOrder).toEqual([
      "open-1",
      "old-stats",
      "page-runtime-1-1",
      "open-2",
      "restore-page",
      "close-runtime-1",
      "page-runtime-2-2"
    ]);
  });

  it("closes a failed replay candidate without corrupting the live coordinated state", async () => {
    const firstStep: TransformStep = { id: "replay-first", kind: "dropColumns", params: { columns: ["first"] } };
    const secondStep: TransformStep = {
      id: "replay-second",
      kind: "renameColumn",
      params: { column: "second", newName: "renamed" }
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
          return stepPreviewResponse(1, firstStep, "runtime-candidate", "candidate-preview-code");
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
        return planUpdatedResponse(2, [firstStep], "runtime-candidate", "candidate-applied-code");
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
      filterModel: opened.metadata.filterModel
    });
    expect(retried).toMatchObject({ kind: "page", revision: 4, viewRequestId: "live-state-retry" });
    expect(delegateRequest.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "getPage",
      sessionId: "runtime-live",
      revision: 4
    });
  });

  it("uses fresh bounded options and diagnoses a cancelled recovery-candidate close", async () => {
    let openCount = 0;
    let failLivePage = true;
    let cleanupOptions: BridgeRequestOptions | undefined;
    const reportDiagnostic = vi.fn();
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          openCount += 1;
          return openedResponse(openCount === 1 ? "runtime-live" : "runtime-candidate");
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-live") {
          if (failLivePage) {
            failLivePage = false;
            throw new Error("live transport failed");
          }
          return pageResponse(request, "runtime-live");
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-candidate") {
          return {
            kind: "error",
            code: "engine_error",
            message: "candidate restore failed",
            recoverable: true,
            sessionId: request.sessionId,
            viewRequestId: request.viewRequestId
          };
        }
        if (request.kind === "closeSession" && request.sessionId === "runtime-candidate") {
          cleanupOptions = options;
          return { kind: "cancelled", targetRequestId: "candidate-close" };
        }
        throw new Error(`Unexpected delegate request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, reportDiagnostic });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const cancelledRequestOptions: BridgeRequestOptions = {
      cancellation: {
        isCancellationRequested: true,
        onCancellationRequested: () => ({ dispose: () => undefined })
      },
      timeoutMs: 7,
      viewContextId: "candidate-view"
    };

    await expect(
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId: "candidate-cleanup-page",
          offset: 0,
          limit: 100,
          filterModel: opened.metadata.filterModel
        },
        cancelledRequestOptions
      )
    ).rejects.toThrow("live transport failed");

    expect(cleanupOptions).toEqual({
      priority: "interactive",
      timeoutMs: 2_000,
      restartRuntimeOnTimeout: false
    });
    expect(cleanupOptions).not.toBe(cancelledRequestOptions);
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/recovery candidate session runtime-candidate.*close was cancelled \(candidate-close\)/)
    );
    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({ runtimeId: "runtime-live", runtimeRevision: 0 })
    ]);

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "candidate-cleanup-retry",
        offset: 0,
        limit: 100,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "candidate-cleanup-retry" });
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
          filterModel: opened.metadata.filterModel
        },
        { timeoutMs: 11, viewContextId: "replacement-view" }
      )
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "retired-cleanup-page" });

    await vi.waitFor(() => expect(reportDiagnostic).toHaveBeenCalledOnce());
    expect(cleanupOptions).toEqual({
      priority: "interactive",
      timeoutMs: 2_000,
      restartRuntimeOnTimeout: false
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
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "page", viewRequestId: "replacement-still-live" });
  });

  it("runs different sessions concurrently and lets same-session pages bypass profiles", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const firstSessionOrder: string[] = [];
    const secondSessionOrder: string[] = [];
    const firstDelegate = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse("runtime-first");
      if (request.kind === "getSummary") {
        firstSessionOrder.push("profile");
        return activeProfile.promise;
      }
      if (request.kind === "getPage") {
        firstSessionOrder.push("page");
        return pageResponse(request, "runtime-first");
      }
      throw new Error(`Unexpected first delegate request: ${request.kind}`);
    });
    const secondDelegate = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse("runtime-second");
      if (request.kind === "getPage") {
        secondSessionOrder.push("page");
        return pageResponse(request, "runtime-second");
      }
      throw new Error(`Unexpected second delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const firstBridge = coordinator.createBridge({ request: firstDelegate });
    const secondBridge = coordinator.createBridge({ request: secondDelegate });
    const firstOpened = await firstBridge.request(openRequest);
    const secondOpened = await secondBridge.request(openRequest);
    if (firstOpened.kind !== "sessionOpened" || secondOpened.kind !== "sessionOpened") {
      throw new Error("Expected both fake sessions to open.");
    }

    const profile = firstBridge.request({
      kind: "getSummary",
      sessionId: firstOpened.metadata.sessionId,
      revision: firstOpened.metadata.revision,
      viewRequestId: "concurrency-first-profile",
      filterModel: firstOpened.metadata.filterModel
    });
    await vi.waitFor(() => expect(firstSessionOrder).toEqual(["profile"]));
    const firstPage = firstBridge.request({
      kind: "getPage",
      sessionId: firstOpened.metadata.sessionId,
      revision: firstOpened.metadata.revision,
      viewRequestId: "concurrency-first-page",
      offset: 0,
      limit: 100,
      filterModel: firstOpened.metadata.filterModel
    });
    const secondPage = secondBridge.request({
      kind: "getPage",
      sessionId: secondOpened.metadata.sessionId,
      revision: secondOpened.metadata.revision,
      viewRequestId: "concurrency-second-page",
      offset: 0,
      limit: 100,
      filterModel: secondOpened.metadata.filterModel
    });

    await Promise.all([firstPage, secondPage]);
    expect(secondSessionOrder).toEqual(["page"]);
    expect(firstSessionOrder).toEqual(["profile", "page"]);

    activeProfile.resolve(summaryResponse("concurrency-first-profile"));
    await profile;
    expect(firstSessionOrder).toEqual(["profile", "page"]);
  });

  it("cancels queued background work on close and does not replay a failing active profile", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    let profileNumber = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        profileNumber += 1;
        executionOrder.push(`profile-${profileNumber}`);
        return profileNumber === 1 ? activeProfile.promise : summaryResponse(request.viewRequestId);
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      if (request.kind === "closeSession") {
        executionOrder.push("close");
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const profile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "close-profile-active",
      filterModel: opened.metadata.filterModel,
      columns: ["active"]
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile-1"]));
    const queuedProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "close-profile-queued",
      filterModel: opened.metadata.filterModel,
      columns: ["queued"]
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "close-page",
      offset: 0,
      limit: 100,
      filterModel: opened.metadata.filterModel
    });
    const close = bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });

    await expect(queuedProfile).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "close-profile-queued"
    });
    await page;
    expect(executionOrder).toEqual(["profile-1", "page"]);
    const activeFailure = expect(profile).rejects.toThrow("profile transport failed");
    activeProfile.reject(new Error("profile transport failed"));
    await Promise.all([activeFailure, close]);

    expect(executionOrder).toEqual(["profile-1", "page", "close"]);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("cancels queued background work and drains active plus interactive work before shutdown closes", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        const label = request.columns?.[0] ?? "profile";
        executionOrder.push(label);
        return label === "active" ? activeProfile.promise : summaryResponse(request.viewRequestId);
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      if (request.kind === "closeSession") {
        executionOrder.push("close");
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const profile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "shutdown-profile-active",
      filterModel: opened.metadata.filterModel,
      columns: ["active"]
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["active"]));
    const queuedProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "shutdown-profile-queued",
      filterModel: opened.metadata.filterModel,
      columns: ["queued"]
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "shutdown-page",
      offset: 0,
      limit: 100,
      filterModel: opened.metadata.filterModel
    });
    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });

    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    await expect(queuedProfile).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "shutdown-profile-queued"
    });
    await page;
    expect(executionOrder).toEqual(["active", "page"]);

    activeProfile.resolve(summaryResponse("shutdown-profile-active"));
    await Promise.all([profile, shutdown]);
    expect(executionOrder).toEqual(["active", "page", "close"]);
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("cancels queued work at the shutdown bound but closes after active work settles", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        executionOrder.push("profile");
        return activeProfile.promise;
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      if (request.kind === "closeSession") {
        executionOrder.push("close");
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const profile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "timeout-profile-active",
      filterModel: opened.metadata.filterModel
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile"]));
    const queuedInteractive = bridge.request(
      {
        kind: "getSummary",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "timeout-promoted-profile",
        filterModel: opened.metadata.filterModel,
        columns: ["queued"]
      },
      { priority: "interactive" }
    );

    await coordinator.shutdown(0);
    await expect(queuedInteractive).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "timeout-promoted-profile"
    });
    expect(executionOrder).toEqual(["profile"]);
    expect(coordinator.diagnostics().sessionCount).toBe(0);

    activeProfile.resolve(summaryResponse("timeout-profile-active"));
    await profile;
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile", "close"]));
  });

  it("does not attach queued statistics calculated for an obsolete filter model", async () => {
    const activeProfile = deferred<OpenWranglerResponse>();
    const executionOrder: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getSummary") {
        executionOrder.push("profile");
        return activeProfile.promise;
      }
      if (request.kind === "getPage") {
        executionOrder.push("page");
        return pageResponse(request);
      }
      if (request.kind === "getDatasetStats") {
        executionOrder.push("stats");
        return {
          kind: "datasetStats",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          stats: { missingCells: 7, missingRows: 3, duplicateRows: 2, missingValuesByColumn: [] }
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const originalFilter = opened.metadata.filterModel;
    const changedFilter: FilterModel = {
      filters: [
        {
          column: "sales",
          type: "integer",
          predicates: [{ kind: "predicate", operator: "gt", value: 5 }]
        }
      ],
      sort: []
    };

    const profile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "stale-stats-profile",
      filterModel: originalFilter
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile"]));
    const stats = bridge.request({
      kind: "getDatasetStats",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "stale-stats-request",
      filterModel: originalFilter
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "stale-stats-page",
      offset: 0,
      limit: 100,
      filterModel: changedFilter
    });

    activeProfile.resolve(summaryResponse("stale-stats-profile"));
    await Promise.all([profile, stats, page]);

    expect(executionOrder).toEqual(["profile", "page", "stats"]);
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(changedFilter);
    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
  });

  it("clears retained statistics and publishes native state when a same-filter page changes view context", async () => {
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") return pageResponse(request);
      if (request.kind === "getDatasetStats") return datasetStatsResponse(request.viewRequestId);
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const requestPage = (viewRequestId: string, viewContextId: string) =>
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId,
          offset: 0,
          limit: 100,
          filterModel: opened.metadata.filterModel
        },
        { viewContextId }
      );

    await requestPage("context-page-a", "logical-context-a");
    await bridge.request(
      {
        kind: "getDatasetStats",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "context-stats-a",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "logical-context-a" }
    );
    expect(coordinator.activeSession()?.metadata.stats).toEqual(datasetStatsResponse("ignored").stats);
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    await expect(requestPage("context-page-b", "logical-context-b")).resolves.toMatchObject({
      kind: "page",
      viewRequestId: "context-page-b"
    });

    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
    expect(activeChanges).toHaveBeenCalledOnce();
    expect(activeChanges.mock.calls[0]?.[0]?.metadata.stats).toBeUndefined();
  });

  it("rejects A-to-B-to-A statistics by opaque view context even when filters match", async () => {
    const pendingStats = deferred<OpenWranglerResponse>();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") return pageResponse(request);
      if (request.kind === "getDatasetStats") return pendingStats.promise;
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const pageRequest = (viewRequestId: string, viewContextId: string) =>
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId,
          offset: 0,
          limit: 100,
          filterModel: opened.metadata.filterModel
        },
        { viewContextId }
      );

    await pageRequest("same-filter-page-a", "logical-view-a");
    const stats = bridge.request(
      {
        kind: "getDatasetStats",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "same-filter-stats-a",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "logical-view-a" }
    );
    await vi.waitFor(() =>
      expect(delegateRequest.mock.calls.some(([request]) => request.kind === "getDatasetStats")).toBe(true)
    );
    await pageRequest("same-filter-page-b", "logical-view-b");
    await pageRequest("same-filter-page-a-again", "logical-view-a-again");

    pendingStats.resolve(datasetStatsResponse("same-filter-stats-a"));
    await stats;
    expect(coordinator.activeSession()?.metadata.stats).toBeUndefined();
  });

  it("rejects a mismatched page response ID before changing retained or persisted state", async () => {
    const changedFilter: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 9 }] }],
      sort: []
    };
    const update = vi.fn(async () => undefined);
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const runtimePageRevisions: number[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") {
        runtimePageRevisions.push(request.revision);
        if (request.viewRequestId === "mismatched-page") {
          const page = pageResponse(request);
          return {
            ...page,
            revision: 1,
            viewRequestId: "different-runtime-request",
            metadata: { ...page.metadata, revision: 1, filterModel: changedFilter }
          };
        }
        return pageResponse(request);
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    const mismatched = await bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "mismatched-page",
        offset: 0,
        limit: 100,
        filterModel: changedFilter
      },
      { viewContextId: "mismatched-view" }
    );

    expect(mismatched).toMatchObject({
      kind: "error",
      code: "invalid_runtime_response",
      sessionId: opened.metadata.sessionId,
      viewRequestId: "mismatched-page"
    });
    expect(update).not.toHaveBeenCalled();
    expect(activeChanges).not.toHaveBeenCalled();
    expect(coordinator.activeSession()?.metadata).toMatchObject({
      revision: opened.metadata.revision,
      filterModel: opened.metadata.filterModel
    });

    const retry = await bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "matching-page",
        offset: 0,
        limit: 100,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "matching-view" }
    );
    expect(retry).toMatchObject({ kind: "page", revision: opened.metadata.revision, viewRequestId: "matching-page" });
    expect(runtimePageRevisions).toEqual([0, 0]);
  });

  it("rejects a superseded page before it can persist or update native state", async () => {
    const delayedPage = deferred<OpenWranglerResponse>();
    const update = vi.fn(async () => undefined);
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage" && request.viewRequestId === "superseded-page-a") {
        return delayedPage.promise;
      }
      if (request.kind === "getPage") return pageResponse(request);
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const filterA: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 1 }] }],
      sort: []
    };
    const filterB: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 2 }] }],
      sort: []
    };
    const requestPage = (viewRequestId: string, viewContextId: string, filterModel: FilterModel) =>
      bridge.request(
        {
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId,
          offset: 0,
          limit: 100,
          filterModel
        },
        { viewContextId }
      );

    const pageA = requestPage("superseded-page-a", "logical-view-a", filterA);
    await vi.waitFor(() => expect(delegateRequest).toHaveBeenCalledTimes(2));
    const pageB = requestPage("latest-page-b", "logical-view-b", filterB);
    delayedPage.resolve(
      pageResponse({
        kind: "getPage",
        sessionId: "runtime-session",
        revision: 0,
        viewRequestId: "superseded-page-a",
        offset: 0,
        limit: 100,
        filterModel: filterA
      })
    );

    await expect(pageA).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "superseded-page-a"
    });
    await expect(pageB).resolves.toMatchObject({ kind: "page", viewRequestId: "latest-page-b" });
    expect(update).toHaveBeenCalledOnce();
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(filterB);
  });

  it("rolls back a page superseded while persistence is deferred without publishing it", async () => {
    const filterA: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 1 }] }],
      sort: []
    };
    const filterB: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 2 }] }],
      sort: []
    };
    const filterC: FilterModel = {
      filters: [{ column: "sales", type: "integer", predicates: [{ kind: "predicate", operator: "gt", value: 3 }] }],
      sort: []
    };
    const key = persistenceKey(openRequest.source);
    const savedA = { steps: [], filterModel: filterA };
    let stored: Record<string, unknown> = { [key]: savedA };
    const firstUpdate = deferred<void>();
    let updateCount = 0;
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      updateCount += 1;
      stored = value;
      if (updateCount === 1) await firstUpdate.promise;
    });
    const workspaceState = {
      get: vi.fn((storageKey: string, fallback?: unknown) => (storageKey === SESSION_STORAGE_KEY ? stored : fallback)),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage" && request.viewRequestId === "deferred-latest-page") {
        return {
          kind: "error",
          code: "engine_error",
          message: "The latest page failed.",
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "getPage") return pageResponse(request);
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the persisted session to open.");
    expect(opened.metadata.filterModel).toEqual(filterA);
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    const pageB = bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "deferred-page",
        offset: 0,
        limit: 100,
        filterModel: filterB
      },
      { viewContextId: "deferred-view" }
    );
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(filterA);
    expect(activeChanges).not.toHaveBeenCalled();

    const pageC = bridge.request(
      {
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "deferred-latest-page",
        offset: 0,
        limit: 100,
        filterModel: filterC
      },
      { viewContextId: "deferred-view" }
    );
    firstUpdate.resolve();

    await expect(pageB).resolves.toMatchObject({
      kind: "error",
      code: "stale_response",
      viewRequestId: "deferred-page"
    });
    await expect(pageC).resolves.toMatchObject({
      kind: "error",
      code: "engine_error",
      viewRequestId: "deferred-latest-page"
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(stored).toEqual({ [key]: savedA });
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(filterA);
    expect(activeChanges).not.toHaveBeenCalled();
  });

  it("persists page viewing state only when the filter model changes", async () => {
    let stored: Record<string, unknown> = {};
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      stored = value;
    });
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? stored : fallback)),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "getPage") {
        return pageResponse({
          ...request,
          filterModel: { ...request.filterModel, logic: request.filterModel.logic ?? "and" }
        });
      }
      if (request.kind === "getSummary") return summaryResponse(request.viewRequestId);
      if (request.kind === "getDatasetStats") return datasetStatsResponse(request.viewRequestId);
      if (request.kind === "getColumnValues") {
        return {
          kind: "columnValues",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          column: request.column,
          values: [],
          hasMore: false
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);
    const base = {
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    };

    await bridge.request(
      {
        kind: "getPage",
        ...base,
        viewRequestId: "persistence-page-initial",
        offset: 100,
        limit: 100,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "persistence-view" }
    );
    expect(activeChanges).not.toHaveBeenCalled();
    await bridge.request({
      kind: "getSummary",
      ...base,
      viewRequestId: "persistence-summary",
      filterModel: opened.metadata.filterModel
    });
    await bridge.request(
      {
        kind: "getDatasetStats",
        ...base,
        viewRequestId: "persistence-stats",
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "persistence-view" }
    );
    await bridge.request({
      kind: "getColumnValues",
      ...base,
      viewRequestId: "persistence-values",
      column: "sales",
      filterModel: opened.metadata.filterModel,
      limit: 20
    });
    expect(update).not.toHaveBeenCalled();
    expect(activeChanges).toHaveBeenCalledOnce();
    expect(coordinator.activeSession()?.metadata.stats).toEqual(datasetStatsResponse("ignored").stats);

    activeChanges.mockClear();
    await bridge.request(
      {
        kind: "getPage",
        ...base,
        viewRequestId: "persistence-page-after-stats",
        offset: 200,
        limit: 100,
        filterModel: opened.metadata.filterModel
      },
      { viewContextId: "persistence-view" }
    );
    expect(activeChanges).not.toHaveBeenCalled();
    expect(coordinator.activeSession()?.metadata.stats).toEqual(datasetStatsResponse("ignored").stats);

    const changedFilter: FilterModel = {
      filters: [
        {
          column: "sales",
          type: "integer",
          predicates: [{ kind: "predicate", operator: "gt", value: 5 }]
        }
      ],
      sort: []
    };
    await bridge.request({
      kind: "getPage",
      ...base,
      viewRequestId: "persistence-page-filter-change",
      offset: 0,
      limit: 100,
      filterModel: changedFilter
    });
    await bridge.request({
      kind: "getPage",
      ...base,
      viewRequestId: "persistence-page-filter-unchanged",
      offset: 100,
      limit: 100,
      filterModel: changedFilter
    });

    expect(update).toHaveBeenCalledOnce();
    expect(activeChanges).toHaveBeenCalledOnce();
    expect(stored[persistenceKey(openRequest.source)]).toMatchObject({
      filterModel: { ...changedFilter, logic: "and" }
    });
  });

  it("retires a session after terminal close failure without replaying or reviving it", async () => {
    const onIdle = vi.fn();
    let finishClose!: (response: OpenWranglerResponse) => void;
    const closeResponse = new Promise<OpenWranglerResponse>((resolve) => {
      finishClose = resolve;
    });
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") return closeResponse;
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const delegate: OpenWranglerBridge = { request: delegateRequest, onIdle };
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(delegate);

    const opened = await bridge.request(openRequest);
    expect(opened.kind).toBe("sessionOpened");
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    const publicSessionId = opened.metadata.sessionId;

    const closePromise = bridge.request({
      kind: "closeSession",
      sessionId: publicSessionId,
      revision: opened.metadata.revision
    });
    const duringClose = await bridge.request({
      kind: "getPage",
      sessionId: publicSessionId,
      revision: opened.metadata.revision,
      viewRequestId: "terminal-close-during",
      offset: 0,
      limit: 1,
      filterModel: { filters: [], sort: [] }
    });
    expect(duringClose).toMatchObject({ kind: "error", code: "session_closing" });
    finishClose({
      kind: "error",
      code: "engine_error",
      message: "Engine close failed: close exploded",
      recoverable: false,
      sessionId: "runtime-session"
    });
    const close = await closePromise;

    expect(close).toMatchObject({ kind: "error", code: "engine_error", message: expect.stringContaining("close") });
    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: undefined,
      sessionCount: 0,
      sessions: []
    });
    expect(coordinator.activeSession()).toBeUndefined();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);

    const afterClose = await bridge.request({
      kind: "getPage",
      sessionId: publicSessionId,
      revision: opened.metadata.revision,
      viewRequestId: "terminal-close-after",
      offset: 0,
      limit: 1,
      filterModel: { filters: [], sort: [] }
    });
    expect(afterClose).toMatchObject({ kind: "error", code: "unknown_session" });
    expect(delegateRequest).toHaveBeenCalledTimes(3);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(2);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("awaits runtime close before shutdown resolves", async () => {
    const onIdle = vi.fn();
    let finishClose!: (response: OpenWranglerResponse) => void;
    const closeResponse = new Promise<OpenWranglerResponse>((resolve) => {
      finishClose = resolve;
    });
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") return closeResponse;
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });

    const opened = await bridge.request(openRequest);
    expect(opened.kind).toBe("sessionOpened");
    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });

    await vi.waitFor(() => {
      expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(1);
    });
    expect(shutdownSettled).toBe(false);
    expect(coordinator.diagnostics().sessionCount).toBe(1);

    finishClose({ kind: "sessionClosed", sessionId: "runtime-session" });
    await shutdown;

    expect(shutdownSettled).toBe(true);
    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: undefined,
      sessionCount: 0,
      sessions: []
    });
    expect(coordinator.activeSession()).toBeUndefined();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(delegateRequest).toHaveBeenCalledTimes(2);
  });

  it("treats a thrown close transport failure as terminal without replay", async () => {
    const onIdle = vi.fn();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") throw new Error("close transport exploded");
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const opened = await bridge.request(openRequest);
    expect(opened.kind).toBe("sessionOpened");
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    await expect(
      bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      })
    ).rejects.toThrow("close transport exploded");

    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: undefined,
      sessionCount: 0,
      sessions: []
    });
    expect(coordinator.activeSession()).toBeUndefined();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(delegateRequest).toHaveBeenCalledTimes(3);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(2);
  });

  it("waits for a delayed open during shutdown and closes its late runtime session", async () => {
    const onIdle = vi.fn();
    let finishOpen!: (response: OpenWranglerResponse) => void;
    const openResponse = new Promise<OpenWranglerResponse>((resolve) => {
      finishOpen = resolve;
    });
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openResponse;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const activeChanges = vi.fn();
    coordinator.onDidChangeActiveSession(activeChanges);

    const pendingOpen = bridge.request(openRequest);
    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shutdownSettled).toBe(false);
    expect(coordinator.diagnostics().sessionCount).toBe(0);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(0);

    finishOpen(openedResponse());
    const openResult = await pendingOpen;
    await shutdown;

    expect(openResult).toMatchObject({ kind: "error", code: "coordinator_disposed" });
    const closeRequests = delegateRequest.mock.calls
      .map(([request]) => request)
      .filter((request) => request.kind === "closeSession");
    expect(closeRequests).toEqual([{ kind: "closeSession", sessionId: "runtime-session", revision: 0 }]);
    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: undefined,
      sessionCount: 0,
      sessions: []
    });
    expect(coordinator.activeSession()).toBeUndefined();
    expect(activeChanges).not.toHaveBeenCalled();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(delegateRequest).toHaveBeenCalledTimes(2);
  });
});

function openedResponse(sessionId = "runtime-session"): SessionOpenedResponse {
  const metadata: SessionMetadata = {
    protocolVersion: 2,
    sessionId,
    revision: 0,
    backend: "polars",
    mode: "editing",
    source: openRequest.source,
    capabilities: {
      editable: true,
      lazy: true,
      cancel: true,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: false
    },
    shape: { rows: 0, columns: 0 },
    filteredShape: { rows: 0, columns: 0 },
    schema: [],
    filterModel: { filters: [], sort: [] },
    steps: []
  };
  return {
    kind: "sessionOpened",
    metadata,
    page: { offset: 0, limit: openRequest.pageSize, totalRows: 0, rows: [] },
    summaries: []
  };
}

function pageResponse(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  sessionId = "runtime-session"
): Extract<OpenWranglerResponse, { kind: "page" }> {
  const opened = openedResponse(sessionId);
  return {
    kind: "page",
    revision: opened.metadata.revision,
    viewRequestId: request.viewRequestId,
    metadata: { ...opened.metadata, filterModel: request.filterModel },
    page: { ...opened.page, offset: request.offset }
  };
}

function pageResponseForMetadata(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  metadata: SessionMetadata
): Extract<OpenWranglerResponse, { kind: "page" }> {
  return {
    kind: "page",
    revision: request.revision,
    viewRequestId: request.viewRequestId,
    metadata: {
      ...metadata,
      sessionId: request.sessionId,
      revision: request.revision,
      filterModel: request.filterModel
    },
    page: { offset: request.offset, limit: request.limit, totalRows: metadata.filteredShape.rows, rows: [] }
  };
}

function stepPreviewResponse(
  revision: number,
  step: TransformStep,
  sessionId = "runtime-session",
  code = "# preview"
): Extract<OpenWranglerResponse, { kind: "stepPreview" }> {
  const opened = openedResponse(sessionId);
  return {
    kind: "stepPreview",
    revision,
    metadata: { ...opened.metadata, revision, draftStep: step },
    page: opened.page,
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    },
    code
  };
}

function planUpdatedResponse(
  revision: number,
  steps: TransformStep[],
  sessionId = "runtime-session",
  code = "# applied"
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  const opened = openedResponse(sessionId);
  return {
    kind: "planUpdated",
    action: "apply",
    revision,
    metadata: { ...opened.metadata, revision, steps },
    page: opened.page,
    code
  };
}

function summaryResponse(viewRequestId: string): Extract<OpenWranglerResponse, { kind: "summary" }> {
  return { kind: "summary", revision: 0, viewRequestId, summaries: [] };
}

function columnValuesResponse(
  viewRequestId: string,
  column: string
): Extract<OpenWranglerResponse, { kind: "columnValues" }> {
  return { kind: "columnValues", revision: 0, viewRequestId, column, values: [], hasMore: false };
}

function datasetStatsResponse(viewRequestId: string): Extract<OpenWranglerResponse, { kind: "datasetStats" }> {
  return {
    kind: "datasetStats",
    revision: 0,
    viewRequestId,
    stats: { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
