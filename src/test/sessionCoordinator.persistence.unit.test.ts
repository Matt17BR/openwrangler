import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Memento } from "vscode";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionSource } from "../shared/protocol";
import { SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { inspectionStep, openedResponse, openRequest, stepInspectionResponse } from "./sessionCoordinatorTestFixtures";

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
    expect(coordinator.activeSession()?.viewState.viewport.scrollLeft).toBe(40);

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

  it("rolls back real active-session publication side effects when a page callback fails", async () => {
    let stored: Record<string, unknown> = {};
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => stored ?? fallback),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    let runtimeOrdinal = 0;
    const runtimeSources = new Map<string, SessionSource>();
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
        const source = runtimeSources.get(request.sessionId);
        if (!source) throw new Error("Expected the runtime source to remain mapped.");
        const opened = openedResponse(request.sessionId);
        return {
          kind: "page",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          metadata: {
            ...opened.metadata,
            source,
            steps: [inspectionStep],
            shape: { rows: 1, columns: 0 },
            filteredShape: { rows: 1, columns: 0 }
          },
          page: { ...opened.page, offset: request.offset, limit: request.limit, totalRows: 1 }
        };
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
      throw new Error("Expected both transactional-publication sessions to open.");
    }
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
    await inspect(second.metadata.sessionId);
    await inspect(first.metadata.sessionId);
    const beforeActive = coordinator.activeSession();
    const beforeFirst = coordinator.sessionSnapshot(first.metadata.sessionId);
    const beforeSecond = coordinator.sessionSnapshot(second.metadata.sessionId);
    expect(beforeFirst?.stepInspection).toBeDefined();
    expect(beforeSecond?.stepInspection).toBeDefined();

    const callbackFailure = new Error("active publication failed after candidate emission");
    const publications: Array<ReturnType<SessionCoordinator["activeSession"]>> = [];
    let rejectCandidate = true;
    const subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      publications.push(snapshot);
      if (rejectCandidate && snapshot?.sessionId === second.metadata.sessionId) {
        rejectCandidate = false;
        throw callbackFailure;
      }
    });

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: second.metadata.sessionId,
        revision: 0,
        viewRequestId: "candidate-page",
        offset: 0,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16,
        filterModel: second.metadata.filterModel
      })
    ).rejects.toBe(callbackFailure);

    expect(publications).toHaveLength(2);
    expect(publications[0]).toMatchObject({
      sessionId: second.metadata.sessionId,
      metadata: { shape: { rows: 1, columns: 0 } }
    });
    expect(publications[0]?.stepInspection).toBeUndefined();
    expect(publications[1]).toEqual(beforeActive);
    expect(coordinator.activeSession()).toEqual(beforeActive);
    expect(coordinator.sessionSnapshot(first.metadata.sessionId)).toEqual(beforeFirst);
    expect(coordinator.sessionSnapshot(second.metadata.sessionId)).toEqual(beforeSecond);

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
