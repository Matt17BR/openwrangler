import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Memento, NotebookDocument } from "vscode";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionMetadata, SessionSource } from "../shared/protocol";
import { persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import { SessionCoordinator } from "../extension/sessionCoordinator";
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

  it.each([
    ["applyDraft", "apply"],
    ["discardDraft", "discard"],
    ["undoStep", "undo"]
  ] as const)("durably stages %s before runtime dispatch", async (kind, action) => {
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
    ["applyDraft", "stage"],
    ["discardDraft", "read"],
    ["discardDraft", "stage"],
    ["undoStep", "read"],
    ["undoStep", "stage"]
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

  it.each([
    ["applyDraft", "apply"],
    ["discardDraft", "discard"],
    ["undoStep", "undo"]
  ] as const)("rolls back %s after its final persistence write fails", async (kind, action) => {
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
  });

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
