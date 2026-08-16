import { describe, expect, it, vi } from "vitest";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type { OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";
import {
  openRequest,
  columnWindow,
  inspectionStep,
  openedResponse,
  pageResponse,
  summaryResponse,
  deferred
} from "./sessionCoordinatorTestFixtures";

describe("SessionCoordinator", () => {
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
      ...columnWindow,
      filterModel: firstOpened.metadata.filterModel
    });
    const secondPage = secondBridge.request({
      kind: "getPage",
      sessionId: secondOpened.metadata.sessionId,
      revision: secondOpened.metadata.revision,
      viewRequestId: "concurrency-second-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
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
      filterModel: opened.metadata.filterModel
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile-1"]));
    const queuedProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "close-profile-queued",
      filterModel: opened.metadata.filterModel
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "close-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
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
        const label = request.viewRequestId.includes("active") ? "active" : "queued";
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
      filterModel: opened.metadata.filterModel
    });
    await vi.waitFor(() => expect(executionOrder).toEqual(["active"]));
    const queuedProfile = bridge.request({
      kind: "getSummary",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "shutdown-profile-queued",
      filterModel: opened.metadata.filterModel
    });
    const page = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "shutdown-page",
      offset: 0,
      limit: 100,
      ...columnWindow,
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
    const queuedInteractive = bridge.request({
      kind: "previewStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      step: inspectionStep,
      offset: 0,
      limit: 100,
      ...columnWindow
    });

    await coordinator.shutdown(0);
    await expect(queuedInteractive).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:previewStep"
    });
    expect(executionOrder).toEqual(["profile"]);
    expect(coordinator.diagnostics().sessionCount).toBe(0);

    activeProfile.resolve(summaryResponse("timeout-profile-active"));
    await profile;
    await vi.waitFor(() => expect(executionOrder).toEqual(["profile", "close"]));
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
      ...columnWindow,
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
      ...columnWindow,
      filterModel: { filters: [], sort: [] }
    });
    expect(afterClose).toMatchObject({ kind: "error", code: "unknown_session" });
    expect(delegateRequest).toHaveBeenCalledTimes(3);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(2);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("treats the caller revision as advisory for terminal close", async () => {
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedResponse();
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    expect(opened.kind).toBe("sessionOpened");
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    await expect(
      bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision + 99
      })
    ).resolves.toEqual({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    expect(delegateRequest).toHaveBeenLastCalledWith(
      { kind: "closeSession", sessionId: "runtime-session", revision: opened.metadata.revision },
      {
        priority: "interactive",
        timeoutMs: 2_000,
        restartRuntimeOnTimeout: false,
        startRuntimeIfNeeded: false
      }
    );
    expect(coordinator.diagnostics().sessions).toEqual([]);
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
