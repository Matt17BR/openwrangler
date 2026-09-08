import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Memento, NotebookDocument } from "vscode";
import type {
  FilterModel,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionSource
} from "../shared/protocol";
import { persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { SessionPersistenceStore } from "../extension/sessionPersistenceStore";
import { isOpenWranglerRequest, isOpenWranglerResponse } from "../shared/protocolValidation";
import {
  inspectionStep,
  openedResponse,
  openRequest,
  pageResponseForMetadata,
  planUpdatedResponse,
  setOpenNotebookDocuments,
  stepInspectionResponse
} from "./sessionCoordinatorTestFixtures";

describe("SessionCoordinator persistence diagnostics", () => {
  it.each([false, true])(
    "retains current sort and latest presentation across a staged page (final write failure: %s)",
    async (failFinalWrite) => {
      const runtimeOpened = presentationOpenedResponse();
      const firstFilter: FilterModel = {
        filters: [],
        sort: [{ column: "units", direction: "desc", nulls: "last" }]
      };
      const nextFilter: FilterModel = {
        filters: [],
        sort: [{ column: "sales", direction: "desc", nulls: "last" }, ...firstFilter.sort]
      };
      const key = persistenceKey(openRequest.source, "polars");
      let stored: Record<string, unknown> = {};
      let armed = false;
      let paused = false;
      const stageStarted = rejectingDeferred<void>();
      const releaseStage = rejectingDeferred<void>();
      const workspaceState = {
        get: vi.fn((_key: string, fallback?: unknown) => stored ?? fallback),
        update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
          const entry = value[key];
          const pending = typeof entry === "object" && entry !== null && "pendingCurrentCommit" in entry;
          if (armed && !pending && failFinalWrite) throw new Error("final page storage unavailable");
          stored = value;
          if (armed && pending && !paused) {
            paused = true;
            stageStarted.resolve(undefined);
            await releaseStage.promise;
          }
        }),
        keys: vi.fn(() => [SESSION_STORAGE_KEY])
      } as unknown as Memento;
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        expect(isOpenWranglerRequest(request)).toBe(true);
        let response: OpenWranglerResponse;
        if (request.kind === "openSession") response = runtimeOpened;
        else if (request.kind === "getPage") {
          response = {
            ...pageResponseForMetadata(request, runtimeOpened.metadata),
            page: { ...runtimeOpened.page, offset: request.offset, limit: request.limit }
          };
        } else if (request.kind === "closeSession") response = { kind: "sessionClosed", sessionId: request.sessionId };
        else throw new Error(`Unexpected staged-page request: ${request.kind}`);
        expect(isOpenWranglerResponse(response)).toBe(true);
        return response;
      });
      const coordinator = new SessionCoordinator(workspaceState);
      const bridge = coordinator.createBridge({ request: delegateRequest });
      try {
        const opened = await bridge.request(openRequest);
        if (opened.kind !== "sessionOpened") throw new Error("Expected the presentation session to open.");
        const sessionId = opened.metadata.sessionId;
        const sort = (filterModel: FilterModel, viewRequestId: string) =>
          bridge.request(
            {
              kind: "getPage",
              sessionId,
              revision: 0,
              viewRequestId,
              filterModel,
              offset: 0,
              limit: 2,
              columnOffset: 0,
              columnLimit: 2
            },
            { viewContextId: viewRequestId }
          );
        await expect(sort(firstFilter, "first-sort")).resolves.toMatchObject({ kind: "page" });
        armed = true;
        const page = sort(nextFilter, "next-sort");
        await stageStarted.promise;
        const presentation = bridge.updateViewState?.(sessionId, {
          selectedColumnId: "c:sales",
          columnWidths: new Map([["c:sales", 317]]),
          viewport: { firstVisibleRow: 1, scrollLeft: 67 }
        });
        releaseStage.resolve(undefined);
        await presentation;
        await expect(page).resolves.toMatchObject(
          failFinalWrite
            ? { kind: "error", code: "persistence_unavailable" }
            : { kind: "page", metadata: { filterModel: nextFilter } }
        );
        const expectedFilter = failFinalWrite ? firstFilter : nextFilter;
        const expectedView = {
          filterModel: expectedFilter,
          selectedColumnId: "c:sales",
          columnWidths: new Map([["c:sales", 317]]),
          viewport: { firstVisibleRow: failFinalWrite ? 1 : 0, scrollLeft: 67 }
        };
        expect(coordinator.activeSession()).toEqual(coordinator.sessionSnapshot(sessionId));
        expect(coordinator.activeSession()).toMatchObject({
          metadata: { filterModel: expectedFilter },
          viewState: expectedView
        });
        expect(new SessionPersistenceStore(workspaceState).load(openRequest.source, "polars")).toMatchObject({
          cleaning: { steps: [] },
          view: expectedView
        });
        await bridge.request({ kind: "closeSession", sessionId, revision: 0 });
        expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(1);
        expect(coordinator.diagnostics().sessionCount).toBe(0);
      } finally {
        releaseStage.resolve(undefined);
        await coordinator.shutdown();
      }
    }
  );

  it("retains presentation and the pending owner while a mutation is executing", async () => {
    const runtimeOpened = presentationOpenedResponse();
    const mutationStarted = rejectingDeferred<void>();
    const releaseMutation = rejectingDeferred<void>();
    let stored: Record<string, unknown> = {};
    const workspaceState = {
      get: vi.fn(() => stored),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "applyDraft") {
        mutationStarted.resolve(undefined);
        await releaseMutation.promise;
        const response: OpenWranglerResponse = {
          ...planUpdatedResponse(1, [inspectionStep], request.sessionId),
          metadata: {
            ...runtimeOpened.metadata,
            revision: 1,
            steps: [inspectionStep],
            latestStepInputSchema: runtimeOpened.metadata.schema
          },
          page: runtimeOpened.page
        };
        expect(isOpenWranglerResponse(response)).toBe(true);
        return response;
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected pending presentation request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    try {
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the mutation session to open.");
      const sessionId = opened.metadata.sessionId;
      await bridge.updateViewState?.(sessionId, {
        columnWidths: new Map(),
        viewport: { firstVisibleRow: 0, scrollLeft: 5 }
      });
      const mutation = bridge.request({
        kind: "applyDraft",
        sessionId,
        revision: 0,
        offset: 0,
        limit: openRequest.pageSize,
        columnOffset: 0,
        columnLimit: 16
      });
      await mutationStarted.promise;
      await bridge.updateViewState?.(sessionId, {
        selectedColumnId: "c:sales",
        columnWidths: new Map([["c:sales", 317]]),
        viewport: { firstVisibleRow: 1, scrollLeft: 67 }
      });
      expect(stored[persistenceKey(openRequest.source, "polars")]).toHaveProperty("pendingCurrentCommit");
      expect(new SessionPersistenceStore(workspaceState).load(openRequest.source, "polars")?.cleaning.steps).toEqual(
        []
      );
      releaseMutation.resolve(undefined);
      await expect(mutation).resolves.toMatchObject({ kind: "planUpdated", metadata: { steps: [inspectionStep] } });
      expect(coordinator.activeSession()?.viewState).toMatchObject({
        selectedColumnId: "c:sales",
        columnWidths: new Map([["c:sales", 317]]),
        viewport: { firstVisibleRow: 1, scrollLeft: 67 }
      });
      expect(new SessionPersistenceStore(workspaceState).load(openRequest.source, "polars")).toMatchObject({
        cleaning: { steps: [inspectionStep] },
        view: coordinator.activeSession()?.viewState
      });
    } finally {
      releaseMutation.resolve(undefined);
      await coordinator.shutdown();
    }
  });

  it("persists presentation while an unrelated background profile remains active", async () => {
    const runtimeOpened = presentationOpenedResponse();
    const profileStarted = rejectingDeferred<void>();
    const releaseProfile = rejectingDeferred<void>();
    let profileFinished = false;
    let stored: Record<string, unknown> = {};
    const workspaceState = {
      get: vi.fn(() => stored),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "getSummary") {
        profileStarted.resolve(undefined);
        await releaseProfile.promise;
        profileFinished = true;
        return {
          kind: "error",
          code: "owned_profile",
          message: "Synthetic profile settled.",
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected background presentation request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    try {
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the profile session to open.");
      const sessionId = opened.metadata.sessionId;
      const profile = bridge.request(
        {
          kind: "getSummary",
          sessionId,
          revision: 0,
          viewRequestId: "background-profile",
          filterModel: runtimeOpened.metadata.filterModel
        },
        { priority: "background" }
      );
      await profileStarted.promise;
      await bridge.updateViewState?.(sessionId, {
        selectedColumnId: "c:sales",
        columnWidths: new Map(),
        viewport: { firstVisibleRow: 0, scrollLeft: 67 }
      });
      expect(profileFinished).toBe(false);
      expect(new SessionPersistenceStore(workspaceState).load(openRequest.source, "polars")?.view).toMatchObject({
        selectedColumnId: "c:sales",
        viewport: { scrollLeft: 67 }
      });
      releaseProfile.resolve(undefined);
      await expect(profile).resolves.toMatchObject({ kind: "error", code: "owned_profile" });
    } finally {
      releaseProfile.resolve(undefined);
      await coordinator.shutdown();
    }
  });

  it("does not save a queued presentation from a session that has closed", async () => {
    let stored: Record<string, unknown> = {};
    const firstWrite = rejectingDeferred<void>();
    const releaseWrite = rejectingDeferred<void>();
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 1) {
        firstWrite.resolve(undefined);
        await releaseWrite.promise;
      }
      stored = value;
    });
    const workspaceState = {
      get: vi.fn(() => stored),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return presentationOpenedResponse();
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected retired presentation request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    try {
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the closing session to open.");
      const sessionId = opened.metadata.sessionId;
      const save = (scrollLeft: number) =>
        bridge.updateViewState?.(sessionId, {
          columnWidths: new Map(),
          viewport: { firstVisibleRow: 0, scrollLeft }
        });
      const first = save(17);
      await firstWrite.promise;
      const queued = save(29);
      await bridge.request({ kind: "closeSession", sessionId, revision: 0 });
      releaseWrite.resolve(undefined);
      await Promise.all([first, queued]);
      expect(update).toHaveBeenCalledOnce();
      expect(
        new SessionPersistenceStore(workspaceState).load(openRequest.source, "polars")?.view?.viewport.scrollLeft
      ).toBe(17);
      expect(coordinator.activeSession()).toBeUndefined();
      expect(coordinator.diagnostics().sessionCount).toBe(0);
    } finally {
      releaseWrite.resolve(undefined);
      await coordinator.shutdown();
    }
  });

  it.each([
    ["null", null],
    ["array", []],
    ["primitive", "invalid"],
    ["malformed", new Date(0)]
  ])("rejects and closes an automatic open for a %s persistence root", async (_label, root) => {
    const update = vi.fn();
    const workspaceState = {
      get: vi.fn(() => root),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse("invalid-root-runtime");
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected invalid-root request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const { backend: _backend, ...automaticRequest } = openRequest;

    await expect(bridge.request(automaticRequest)).resolves.toMatchObject({
      kind: "error",
      code: "persistence_unavailable",
      recoverable: true
    });
    expect(delegateRequest.mock.calls.map(([request]) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(update).not.toHaveBeenCalled();
    expect(coordinator.activeSession()).toBeUndefined();
    await coordinator.shutdown();
  });

  it("rejects and disposes automatic-backend opens when recovery state cannot be read", async () => {
    const workspaceState = {
      get: vi.fn(() => {
        throw Object.assign(new Error("cannot read /private/workspace/state.json"), { code: "EACCES" });
      }),
      update: vi.fn(),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const diagnosticSink = vi.fn();
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    warning.mockClear();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse(`runtime-${delegateRequest.mock.calls.length}`);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected persistence read-fault request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState, diagnosticSink);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const { backend: _backend, ...automaticRequest } = openRequest;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(bridge.request(automaticRequest)).resolves.toEqual({
        kind: "error",
        code: "persistence_unavailable",
        message:
          "Open Wrangler could not read workspace recovery state, so the dataframe was not opened. Retry after workspace storage is available.",
        recoverable: true
      });
      expect(coordinator.activeSession()).toBeUndefined();
    }

    expect(delegateRequest.mock.calls.map(([request]) => request.kind)).toEqual([
      "openSession",
      "closeSession",
      "openSession",
      "closeSession"
    ]);
    expect(workspaceState.update).not.toHaveBeenCalled();
    expect(diagnosticSink.mock.calls.map(([message]) => message)).toEqual([
      "Open Wrangler workspace persistence read/availability failed: Error (EACCES)",
      "Open Wrangler workspace persistence read/availability failed: Error (EACCES)"
    ]);
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain("/private/workspace");
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      "Open Wrangler could not read workspace recovery state. Retry after workspace storage is available; recent changes may not survive an editor restart."
    );

    await coordinator.shutdown();
  });

  it("shows and records one bounded receipt per degraded epoch", async () => {
    let stored: Record<string, unknown> = {};
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      const attempt = update.mock.calls.length;
      if (attempt === 1 || attempt === 2 || attempt === 4) {
        throw Object.assign(new Error(`workspace write ${attempt} failed at /private/workspace/state.json`), {
          code: "EIO"
        });
      }
      stored = value;
    });
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? stored : fallback)),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const diagnosticSink = vi.fn();
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    warning.mockClear();
    const runtimeOpened = openedResponse();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected persistence diagnostic request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState, diagnosticSink);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the test session to open.");

    for (const scrollLeft of [10, 20, 30, 40]) {
      await bridge.updateViewState?.(opened.metadata.sessionId, {
        columnWidths: new Map(),
        viewport: { firstVisibleRow: 0, scrollLeft }
      });
    }

    expect(update).toHaveBeenCalledTimes(4);
    expect(diagnosticSink.mock.calls.map(([message]) => message)).toEqual([
      "Open Wrangler workspace persistence ordinary save failed: Error (EIO)",
      "Open Wrangler workspace persistence ordinary save failed: Error (EIO)"
    ]);
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain("/private/workspace");
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenNthCalledWith(
      1,
      "Open Wrangler could not save workspace recovery state. The current session remains open, but recent changes may not survive an editor restart."
    );
    expect(warning).toHaveBeenNthCalledWith(
      2,
      "Open Wrangler could not save workspace recovery state. The current session remains open, but recent changes may not survive an editor restart."
    );
    expect(coordinator.activeSession()?.viewState.viewport.scrollLeft).toBe(30);

    await coordinator.shutdown();
  });

  it("records an in-flight persistence failure during shutdown without warning that the session remains open", async () => {
    const write = rejectingDeferred<void>();
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(() => write.promise),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const diagnosticSink = vi.fn();
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    warning.mockClear();
    const runtimeOpened = openedResponse();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected shutdown persistence request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState, diagnosticSink);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the test session to open.");

    const update = bridge.updateViewState?.(opened.metadata.sessionId, {
      columnWidths: new Map(),
      viewport: { firstVisibleRow: 0, scrollLeft: 20 }
    });
    await vi.waitFor(() => expect(workspaceState.update).toHaveBeenCalledOnce());
    const shutdown = coordinator.shutdown();
    write.reject(new Error("workspace unavailable during shutdown"));

    await update;
    await shutdown;

    expect(diagnosticSink).toHaveBeenCalledWith("Open Wrangler workspace persistence ordinary save failed: Error");
    expect(warning).not.toHaveBeenCalled();
  });

  it("starts a fresh bounded epoch after the exact failed session closes", async () => {
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    warning.mockClear();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected lifecycle persistence request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });

    for (const scrollLeft of [10, 20]) {
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the test session to open.");
      await bridge.updateViewState?.(opened.metadata.sessionId, {
        columnWidths: new Map(),
        viewport: { firstVisibleRow: 0, scrollLeft }
      });
      await bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      });
    }

    expect(workspaceState.update).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(2);
    await coordinator.shutdown();
  });

  it("opens an unrelated source and shuts down while another key write never settles", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
      update: vi.fn(() => neverSettles),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    let runtimeOrdinal = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        const opened = openedResponse(`runtime-${++runtimeOrdinal}`);
        return { ...opened, metadata: { ...opened.metadata, source: request.source } };
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected cross-session progress request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const first = await bridge.request(openRequest);
    if (first.kind !== "sessionOpened") throw new Error("Expected the first session to open.");
    void bridge.updateViewState?.(first.metadata.sessionId, {
      columnWidths: new Map(),
      viewport: { firstVisibleRow: 0, scrollLeft: 17 }
    });
    await vi.waitFor(() => expect(workspaceState.update).toHaveBeenCalledOnce());

    const otherSource: SessionSource = { ...openRequest.source, path: "/workspace/other.csv" };
    const second = await bridge.request({ ...openRequest, source: otherSource });
    expect(second).toMatchObject({ kind: "sessionOpened", metadata: { source: otherSource } });

    await coordinator.shutdown(100);
    expect(coordinator.diagnostics()).toMatchObject({ activeSessionId: undefined, sessionCount: 0 });
  });

  it.each([["applyDraft", "apply"]] as const)("durably stages %s before runtime dispatch", async (kind, action) => {
    let stored: Record<string, unknown> = {};
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => (Object.keys(stored).length > 0 ? stored : fallback)),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const key = persistenceKey(openRequest.source, "polars");
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === kind) {
        expect(stored[key]).toHaveProperty("pendingCurrentCommit");
        return {
          ...planUpdatedResponse(1, kind === "applyDraft" ? [inspectionStep] : [], request.sessionId),
          action
        };
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected staged-mutation request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the staged-mutation session to open.");

    const response = await bridge.request({
      kind,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 100,
      columnOffset: 0,
      columnLimit: 16
    });

    expect(response).toMatchObject({ kind: "planUpdated", action });
    expect(stored[key]).not.toHaveProperty("pendingCurrentCommit");
    expect(workspaceState.update).toHaveBeenCalledTimes(2);
    await coordinator.shutdown();
  });

  it.each([
    ["applyDraft", "read"],
    ["applyDraft", "stage"]
  ] as const)(
    "returns a typed persistence error and does not dispatch %s after a %s failure",
    async (kind, failurePoint) => {
      let reads = 0;
      const workspaceState = {
        get: vi.fn((_key: string, fallback?: unknown) => {
          reads += 1;
          if (failurePoint === "read" && reads === 2) throw new Error("mutation persistence read unavailable");
          return fallback;
        }),
        update: vi.fn(async () => {
          if (failurePoint === "stage") throw new Error("mutation persistence stage unavailable");
        }),
        keys: vi.fn(() => [SESSION_STORAGE_KEY])
      } as unknown as Memento;
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return openedResponse();
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`The ${request.kind} mutation must not dispatch after persistence ${failurePoint}.`);
      });
      const coordinator = new SessionCoordinator(workspaceState);
      const bridge = coordinator.createBridge({ request: delegateRequest });
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the persistence-failure session to open.");

      await expect(
        bridge.request({
          kind,
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          offset: 0,
          limit: 100,
          columnOffset: 0,
          columnLimit: 16
        })
      ).resolves.toMatchObject({ kind: "error", code: "persistence_unavailable", recoverable: true });
      expect(delegateRequest.mock.calls.map(([request]) => request.kind)).toEqual(["openSession"]);
      await coordinator.shutdown();
    }
  );

  it.each([["applyDraft", "apply"]] as const)(
    "rolls back %s after its final persistence write fails",
    async (kind, action) => {
      let stored: Record<string, unknown> = {};
      const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
        if (update.mock.calls.length === 2) throw new Error("mutation final persistence unavailable");
        stored = value;
      });
      const workspaceState = {
        get: vi.fn((_key: string, fallback?: unknown) => (Object.keys(stored).length > 0 ? stored : fallback)),
        update,
        keys: vi.fn(() => [SESSION_STORAGE_KEY])
      } as unknown as Memento;
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return openedResponse();
        if (request.kind === kind) {
          return {
            ...planUpdatedResponse(1, kind === "applyDraft" ? [inspectionStep] : [], request.sessionId),
            action
          };
        }
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`Unexpected final-write mutation request: ${request.kind}`);
      });
      const coordinator = new SessionCoordinator(workspaceState);
      const bridge = coordinator.createBridge({ request: delegateRequest });
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the final-write mutation session to open.");
      const before = coordinator.activeSession();

      await expect(
        bridge.request({
          kind,
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          offset: 0,
          limit: 100,
          columnOffset: 0,
          columnLimit: 16
        })
      ).resolves.toMatchObject({ kind: "error", code: "persistence_unavailable", recoverable: true });

      expect(coordinator.activeSession()).toEqual(before);
      expect(delegateRequest.mock.calls.filter(([request]) => request.kind === kind)).toHaveLength(1);
      expect(stored[persistenceKey(openRequest.source, "polars")]).toHaveProperty("pendingCurrentCommit");
      await coordinator.shutdown();
    }
  );

  it.each(["read", "stage", "final"] as const)(
    "keeps the prior live-mode runtime and view when the persistence %s transition fails",
    async (failurePoint) => {
      const notebook = {
        uri: vscode.Uri.parse("file:///workspace/persistence-mode.ipynb"),
        isClosed: false
      } as NotebookDocument;
      const source: SessionSource = {
        kind: "notebookVariable",
        label: "frame",
        variableName: "frame",
        uri: notebook.uri.toString()
      };
      let reads = 0;
      let stored: Record<string, unknown> = {};
      const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
        const attempt = update.mock.calls.length;
        if ((failurePoint === "stage" && attempt === 1) || (failurePoint === "final" && attempt === 2)) {
          throw new Error(`${failurePoint} mode persistence unavailable`);
        }
        stored = value;
      });
      const workspaceState = {
        get: vi.fn((_key: string, fallback?: unknown) => {
          reads += 1;
          if (failurePoint === "read" && reads === 2) throw new Error("mode persistence read unavailable");
          return Object.keys(stored).length > 0 ? stored : fallback;
        }),
        update,
        keys: vi.fn(() => [SESSION_STORAGE_KEY])
      } as unknown as Memento;
      const metadataByRuntime = new Map<string, SessionMetadata>();
      const closedRuntimeIds: string[] = [];
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          const runtimeId = request.requestedSessionId ?? "runtime-old";
          const opened = openedResponse(runtimeId);
          const metadata = {
            ...opened.metadata,
            sessionId: runtimeId,
            source: request.source,
            mode: request.mode ?? "viewing",
            capabilities: { ...opened.metadata.capabilities, notebookInsert: true }
          };
          metadataByRuntime.set(runtimeId, metadata);
          return { ...opened, metadata };
        }
        if (request.kind === "getPage") {
          const metadata = metadataByRuntime.get(request.sessionId);
          if (!metadata) throw new Error("Expected the live-mode runtime metadata.");
          return pageResponseForMetadata(request, {
            ...metadata,
            revision: request.revision,
            filterModel: request.filterModel
          });
        }
        if (request.kind === "closeSession") {
          closedRuntimeIds.push(request.sessionId);
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        throw new Error(`Unexpected live-mode persistence request: ${request.kind}`);
      });
      setOpenNotebookDocuments(notebook);
      const coordinator = new SessionCoordinator(workspaceState);
      const bridge = coordinator.createBridge({ request: delegateRequest }, notebook);
      try {
        const opened = await bridge.request({ ...openRequest, source, mode: "viewing" });
        if (opened.kind !== "sessionOpened") throw new Error("Expected the live-mode session to open.");
        const before = coordinator.activeSession();

        const response = await bridge.reconfigureLiveSessionMode!(
          opened.metadata.sessionId,
          opened.metadata.revision,
          "editing",
          {
            selectedColumnId: undefined,
            columnWidths: new Map(),
            viewport: { firstVisibleRow: 0, scrollLeft: 71 }
          }
        );

        expect(response).toMatchObject({ kind: "error", code: "persistence_unavailable", recoverable: true });
        expect(coordinator.activeSession()).toEqual(before);
        expect(closedRuntimeIds).toHaveLength(1);
        expect(closedRuntimeIds).not.toContain("runtime-old");
        await coordinator.shutdown();
      } finally {
        setOpenNotebookDocuments();
      }
    }
  );

  it("keeps explicit active ownership when inactive page publication completes or rolls back", async () => {
    let stored: Record<string, unknown> = {};
    const failedWrite = rejectingDeferred<void>();
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 2) return failedWrite.promise;
      stored = value;
    });
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => stored ?? fallback),
      update,
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    let runtimeOrdinal = 0;
    const runtimeSources = new Map<string, SessionSource>();
    const latePage = rejectingDeferred<OpenWranglerResponse>();
    let latePageRequest: Extract<OpenWranglerRequest, { kind: "getPage" }> | undefined;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        const runtimeId = `runtime-${++runtimeOrdinal}`;
        runtimeSources.set(runtimeId, request.source);
        const opened = openedResponse(runtimeId);
        return {
          ...opened,
          metadata: { ...opened.metadata, source: request.source, steps: [inspectionStep] }
        };
      }
      if (request.kind === "inspectStep") return stepInspectionResponse(request);
      if (request.kind === "getPage") {
        latePageRequest = request;
        return latePage.promise;
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected publication rollback request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const first = await bridge.request(openRequest);
    const secondSource: SessionSource = { ...openRequest.source, path: "/workspace/second.csv" };
    const second = await bridge.request({ ...openRequest, source: secondSource });
    if (first.kind !== "sessionOpened" || second.kind !== "sessionOpened") {
      throw new Error("Expected both publication-owner sessions to open.");
    }

    const pendingPage = bridge.request({
      kind: "getPage",
      sessionId: second.metadata.sessionId,
      revision: 0,
      viewRequestId: "late-page",
      offset: 0,
      limit: 100,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: second.metadata.filterModel
    });
    await vi.waitFor(() => expect(latePageRequest).toBeDefined());
    coordinator.setActive(first.metadata.sessionId);
    const inspect = (sessionId: string) =>
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 0,
        stepId: inspectionStep.id,
        offset: 0,
        limit: 10,
        columnOffset: 0,
        columnLimit: 16
      });
    await inspect(first.metadata.sessionId);
    const beforeActive = coordinator.activeSession();
    const beforeFirst = coordinator.sessionSnapshot(first.metadata.sessionId);
    expect(beforeFirst?.stepInspection).toBeDefined();

    const publications: Array<ReturnType<SessionCoordinator["activeSession"]>> = [];
    const subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      publications.push(snapshot);
    });
    if (!latePageRequest) throw new Error("Expected the late page request to start.");
    const source = runtimeSources.get(latePageRequest.sessionId);
    if (!source) throw new Error("Expected the runtime source to remain mapped.");
    const opened = openedResponse(latePageRequest.sessionId);
    latePage.resolve({
      kind: "page",
      revision: latePageRequest.revision,
      viewRequestId: latePageRequest.viewRequestId,
      metadata: {
        ...opened.metadata,
        source,
        steps: [inspectionStep],
        shape: { rows: 1, columns: 0 },
        filteredShape: { rows: 1, columns: 0 }
      },
      page: { ...opened.page, offset: latePageRequest.offset, limit: latePageRequest.limit, totalRows: 1 }
    });
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));

    expect(publications).toEqual([]);
    expect(coordinator.activeSession()).toEqual(beforeActive);
    expect(coordinator.sessionSnapshot(first.metadata.sessionId)?.stepInspection).toEqual(beforeFirst?.stepInspection);
    coordinator.setActive(second.metadata.sessionId);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ metadata: { shape: { rows: 1, columns: 0 } } });

    failedWrite.reject(new Error("final persistence unavailable"));
    await expect(pendingPage).resolves.toMatchObject({
      kind: "error",
      code: "persistence_unavailable",
      message: expect.stringContaining("left unchanged")
    });
    expect(publications).toHaveLength(2);
    expect(publications[1]).toMatchObject({ metadata: { shape: { rows: 0, columns: 0 } } });
    expect(coordinator.activeSession()).toMatchObject({ metadata: { shape: { rows: 0, columns: 0 } } });

    subscription.dispose();
    await coordinator.shutdown();
  });
});

function rejectingDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function presentationOpenedResponse(): ReturnType<typeof openedResponse> {
  const opened = openedResponse();
  return {
    ...opened,
    metadata: {
      ...opened.metadata,
      shape: { rows: 2, columns: 2 },
      filteredShape: { rows: 2, columns: 2 },
      schema: [
        { id: "c:sales", name: "sales", position: 0, rawType: "Int64", type: "integer", nullable: false },
        { id: "c:units", name: "units", position: 1, rawType: "Int64", type: "integer", nullable: false }
      ]
    },
    page: {
      offset: 0,
      limit: openRequest.pageSize,
      totalRows: 2,
      columnIds: ["c:sales", "c:units"],
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [2, 20].map((value) => ({
            kind: "integer",
            raw: value,
            display: String(value),
            isNull: false,
            isNaN: false
          }))
        },
        {
          id: "r:1",
          rowNumber: 1,
          values: [1, 10].map((value) => ({
            kind: "integer",
            raw: value,
            display: String(value),
            isNull: false,
            isNaN: false
          }))
        }
      ]
    }
  };
}
