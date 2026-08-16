import { describe, expect, it, vi } from "vitest";
import type { BridgeRequestOptions, CancellationTokenLike } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type {
  OpenSessionRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionSource
} from "../shared/protocol";
import {
  appliedStep,
  clone,
  deferred,
  initialSource,
  metadataFor,
  open,
  openedFor,
  openRequest,
  pageFor,
  previewFor,
  replacementSource,
  simpleReconfiguringDelegate,
  type CloseRequest
} from "./sessionReconfigurationTestFixtures";

describe("SessionCoordinator file-session reconfiguration lifecycle", () => {
  it("closes an opened candidate and rolls back when cancellation arrives after dispatch", async () => {
    let cancelled = false;
    let candidateId = "";
    const closeCalls: CloseRequest[] = [];
    const cancellation: CancellationTokenLike = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: () => ({ dispose: () => undefined })
    };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
      }
      if (request.kind === "openSession") {
        candidateId = request.requestedSessionId ?? "";
        cancelled = true;
        return openedFor(request, metadataFor({ runtimeId: candidateId, source: request.source }));
      }
      if (request.kind === "closeSession") {
        closeCalls.push(request);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge, initialSource);
    const before = clone(coordinator.activeSession());

    const response = await bridge.reconfigureFileSession?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource,
      { cancellation }
    );

    expect(response).toEqual({
      kind: "cancelled",
      targetRequestId: `reconfigure-import:${opened.metadata.sessionId}`
    });
    expect(closeCalls).toEqual([{ kind: "closeSession", sessionId: candidateId, revision: 0 }]);
    expect(coordinator.activeSession()).toEqual(before);
  });

  it.each(["close", "shutdown"] as const)(
    "lets %s win a race with a dispatched replacement and cleans both runtimes",
    async (terminalAction) => {
      const candidateOpen = deferred<OpenWranglerResponse>();
      let candidateRequest: OpenSessionRequest | undefined;
      const closeCalls: string[] = [];
      const candidateReads: OpenWranglerRequest[] = [];
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
          return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
        }
        if (request.kind === "openSession") {
          candidateRequest = request;
          return candidateOpen.promise;
        }
        if (
          request.kind === "getPage" &&
          candidateRequest?.requestedSessionId &&
          request.sessionId === candidateRequest.requestedSessionId
        ) {
          candidateReads.push(request);
          return pageFor(
            request,
            metadataFor({
              runtimeId: request.sessionId,
              source: replacementSource,
              revision: request.revision,
              filterModel: request.filterModel
            })
          );
        }
        if (request.kind === "closeSession") {
          closeCalls.push(request.sessionId);
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        throw new Error(`Unexpected request: ${request.kind}`);
      });
      const coordinator = new SessionCoordinator();
      const bridge = coordinator.createBridge({ request: delegateRequest });
      const opened = await open(bridge, initialSource);
      const reconfigured = bridge.reconfigureFileSession!(
        opened.metadata.sessionId,
        opened.metadata.revision,
        replacementSource
      );
      await vi.waitFor(() => expect(candidateRequest).toBeDefined());

      const terminal =
        terminalAction === "close"
          ? bridge.request({
              kind: "closeSession",
              sessionId: opened.metadata.sessionId,
              revision: opened.metadata.revision
            })
          : coordinator.shutdown(1_000).then(() => undefined);
      await vi.waitFor(() => expect(closeCalls).toContain("runtime-old"));
      const dispatched = candidateRequest;
      if (!dispatched) throw new Error("Expected a dispatched candidate open request.");
      candidateOpen.resolve(
        openedFor(
          dispatched,
          metadataFor({
            runtimeId: dispatched.requestedSessionId ?? "",
            source: replacementSource
          })
        )
      );

      await expect(reconfigured).resolves.toMatchObject({
        kind: "error",
        code: terminalAction === "shutdown" ? "coordinator_disposed" : "session_closing"
      });
      await terminal;
      expect(closeCalls).toEqual(expect.arrayContaining(["runtime-old", dispatched.requestedSessionId]));
      expect(closeCalls.filter((sessionId) => sessionId === dispatched.requestedSessionId)).toHaveLength(1);
      expect(candidateReads).toEqual([]);
      expect(coordinator.diagnostics().sessionCount).toBe(0);
      expect(coordinator.activeSession()).toBeUndefined();
    }
  );

  it("stops candidate replay when close arrives during an in-flight restored step", async () => {
    const replayPreview = deferred<OpenWranglerResponse>();
    const initialMetadata = metadataFor({
      runtimeId: "runtime-old",
      source: initialSource,
      revision: 1,
      steps: [appliedStep]
    });
    let candidateId = "";
    const candidateRequests: OpenWranglerRequest[] = [];
    const closeCalls: CloseRequest[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, initialMetadata);
      }
      if (request.kind === "openSession") {
        candidateId = request.requestedSessionId ?? "";
        return openedFor(request, metadataFor({ runtimeId: candidateId, source: replacementSource }));
      }
      if (request.kind === "previewStep" && request.sessionId === candidateId) {
        candidateRequests.push(request);
        return replayPreview.promise;
      }
      if ((request.kind === "applyDraft" || request.kind === "getPage") && request.sessionId === candidateId) {
        candidateRequests.push(request);
        throw new Error(`Candidate replay continued with ${request.kind} after close.`);
      }
      if (request.kind === "closeSession") {
        closeCalls.push(request);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge, initialSource);
    const reconfigured = bridge.reconfigureFileSession!(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    );
    await vi.waitFor(() => expect(candidateRequests).toHaveLength(1));

    const closed = bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
    await vi.waitFor(() =>
      expect(closeCalls).toContainEqual({
        kind: "closeSession",
        sessionId: "runtime-old",
        revision: initialMetadata.revision
      })
    );
    const previewRequest = candidateRequests[0];
    if (previewRequest.kind !== "previewStep") throw new Error("Expected a candidate preview request.");
    replayPreview.resolve(
      previewFor(
        previewRequest,
        metadataFor({
          runtimeId: candidateId,
          source: replacementSource,
          revision: 1,
          draftStep: appliedStep
        }),
        "# late preview"
      )
    );

    await expect(reconfigured).resolves.toMatchObject({ kind: "error", code: "session_closing" });
    await expect(closed).resolves.toMatchObject({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    expect(candidateRequests).toEqual([previewRequest]);
    expect(closeCalls).toContainEqual({ kind: "closeSession", sessionId: candidateId, revision: 0 });
    expect(closeCalls.filter((request) => request.sessionId === candidateId)).toHaveLength(1);
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it("uses reconfiguration as a barrier and rejects concurrent work until the accepted read finishes", async () => {
    const activePage = deferred<OpenWranglerResponse>();
    let candidateId = "";
    let candidateOpenCount = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
      }
      if (request.kind === "getPage" && request.sessionId === "runtime-old") return activePage.promise;
      if (request.kind === "openSession") {
        candidateOpenCount += 1;
        candidateId = request.requestedSessionId ?? "";
        return openedFor(request, metadataFor({ runtimeId: candidateId, source: replacementSource }));
      }
      if (request.kind === "getPage" && request.sessionId === candidateId) {
        return pageFor(
          request,
          metadataFor({
            runtimeId: candidateId,
            source: replacementSource,
            revision: request.revision,
            filterModel: request.filterModel
          })
        );
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge, initialSource);
    const activeRead = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "accepted-before-reconfigure",
      offset: 0,
      limit: 100,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: opened.metadata.filterModel
    });
    await vi.waitFor(() =>
      expect(delegateRequest).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "getPage", sessionId: "runtime-old" }),
        undefined
      )
    );
    const replacement = bridge.reconfigureFileSession!(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    );

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "rejected-during-reconfigure",
        offset: 100,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "error", code: "session_reconfiguring" });
    await expect(
      bridge.reconfigureFileSession!(opened.metadata.sessionId, opened.metadata.revision, replacementSource)
    ).resolves.toMatchObject({ kind: "error", code: "session_reconfiguring" });
    expect(candidateOpenCount).toBe(0);

    activePage.resolve(
      pageFor(
        {
          kind: "getPage",
          sessionId: "runtime-old",
          revision: 0,
          viewRequestId: "accepted-before-reconfigure",
          offset: 0,
          limit: 100,
          columnOffset: 0,
          columnLimit: 16,
          filterModel: opened.metadata.filterModel
        },
        metadataFor({ runtimeId: "runtime-old", source: initialSource })
      )
    );
    await expect(activeRead).resolves.toMatchObject({ kind: "page" });
    await expect(replacement).resolves.toMatchObject({ kind: "sessionOpened", metadata: { revision: 1 } });
    expect(candidateOpenCount).toBe(1);
  });

  it("does not release a delegate while a replacement candidate is still settling", async () => {
    const candidateOpen = deferred<OpenWranglerResponse>();
    const candidateCleanup = deferred<OpenWranglerResponse>();
    const onIdle = vi.fn();
    let candidateRequest: OpenSessionRequest | undefined;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
      }
      if (request.kind === "openSession") {
        candidateRequest = request;
        return candidateOpen.promise;
      }
      if (request.kind === "closeSession" && request.sessionId === "runtime-old") {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      if (request.kind === "closeSession" && request.sessionId === candidateRequest?.requestedSessionId) {
        return candidateCleanup.promise;
      }
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const opened = await open(bridge, initialSource);
    const reconfigured = bridge.reconfigureFileSession!(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    );
    await vi.waitFor(() => expect(candidateRequest).toBeDefined());

    const closed = bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
    await expect(closed).resolves.toMatchObject({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    expect(onIdle).not.toHaveBeenCalled();
    const dispatched = candidateRequest;
    if (!dispatched) throw new Error("Expected a dispatched replacement candidate.");
    candidateOpen.resolve(
      openedFor(
        dispatched,
        metadataFor({
          runtimeId: dispatched.requestedSessionId ?? "",
          source: replacementSource
        })
      )
    );
    await vi.waitFor(() =>
      expect(delegateRequest).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "closeSession", sessionId: dispatched.requestedSessionId }),
        expect.objectContaining({ restartRuntimeOnTimeout: false, startRuntimeIfNeeded: false })
      )
    );
    expect(onIdle).not.toHaveBeenCalled();
    candidateCleanup.resolve({ kind: "sessionClosed", sessionId: dispatched.requestedSessionId ?? "" });

    await expect(reconfigured).resolves.toMatchObject({ kind: "error", code: "session_closing" });
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("does not release a delegate until detached retired-runtime cleanup settles", async () => {
    const retiredCleanup = deferred<OpenWranglerResponse>();
    const onIdle = vi.fn();
    let candidateId = "";
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
      }
      if (request.kind === "openSession") {
        candidateId = request.requestedSessionId ?? "";
        return openedFor(request, metadataFor({ runtimeId: candidateId, source: replacementSource }));
      }
      if (request.kind === "getPage" && request.sessionId === candidateId) {
        return pageFor(
          request,
          metadataFor({
            runtimeId: candidateId,
            source: replacementSource,
            revision: request.revision,
            filterModel: request.filterModel
          })
        );
      }
      if (request.kind === "closeSession" && request.sessionId === "runtime-old") {
        return retiredCleanup.promise;
      }
      if (request.kind === "closeSession" && request.sessionId === candidateId) {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });
    const opened = await open(bridge, initialSource);
    await expect(
      bridge.reconfigureFileSession!(opened.metadata.sessionId, opened.metadata.revision, replacementSource)
    ).resolves.toMatchObject({ kind: "sessionOpened", metadata: { revision: 1 } });
    await vi.waitFor(() =>
      expect(delegateRequest).toHaveBeenCalledWith(
        { kind: "closeSession", sessionId: "runtime-old", revision: 0 },
        expect.objectContaining({ restartRuntimeOnTimeout: false })
      )
    );

    await expect(
      bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision + 1
      })
    ).resolves.toMatchObject({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    const idleCallsBeforeRetiredCleanup = onIdle.mock.calls.length;
    retiredCleanup.resolve({ kind: "sessionClosed", sessionId: "runtime-old" });

    await vi.waitFor(() => expect(onIdle).toHaveBeenCalledOnce());
    expect(idleCallsBeforeRetiredCleanup).toBe(0);
  });

  it("recovers the confirmed runtime after a replacement-open transport failure", async () => {
    const closeCalls: Array<{ request: CloseRequest; options?: BridgeRequestOptions }> = [];
    const openRequests: OpenSessionRequest[] = [];
    let candidateId = "";
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          openRequests.push(request);
          if (openRequests.length === 1) {
            return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
          }
          if (openRequests.length === 2) {
            candidateId = request.requestedSessionId ?? "";
            throw new Error("candidate transport disconnected");
          }
          return openedFor(request, metadataFor({ runtimeId: "runtime-recovered", source: initialSource }));
        }
        if (request.kind === "getPage" && request.sessionId === "runtime-recovered") {
          return pageFor(
            request,
            metadataFor({
              runtimeId: "runtime-recovered",
              source: initialSource,
              revision: request.revision,
              filterModel: request.filterModel
            })
          );
        }
        if (request.kind === "closeSession") {
          closeCalls.push({ request, options });
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        throw new Error(`Unexpected request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge, initialSource);
    const before = clone(coordinator.activeSession());

    const response = await bridge.reconfigureFileSession!(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    );

    expect(response).toMatchObject({
      kind: "error",
      code: "import_reconfiguration_transport_failed",
      message: expect.stringContaining("candidate transport disconnected")
    });
    expect(openRequests).toHaveLength(3);
    expect(openRequests[1]).toMatchObject({ source: replacementSource, requestedSessionId: candidateId });
    expect(openRequests[2]).toMatchObject({ source: initialSource, backend: "polars" });
    expect(coordinator.activeSession()).toEqual(before);
    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({
        runtimeId: "runtime-recovered",
        publicRevision: opened.metadata.revision,
        runtimeRevision: opened.metadata.revision
      })
    ]);
    expect(closeCalls).toEqual(
      expect.arrayContaining([
        {
          request: { kind: "closeSession", sessionId: candidateId, revision: 0 },
          options: {
            priority: "interactive",
            timeoutMs: 2_000,
            restartRuntimeOnTimeout: false,
            startRuntimeIfNeeded: false
          }
        },
        {
          request: { kind: "closeSession", sessionId: "runtime-old", revision: 0 },
          options: {
            priority: "interactive",
            timeoutMs: 2_000,
            restartRuntimeOnTimeout: false,
            startRuntimeIfNeeded: false
          }
        }
      ])
    );
  });

  it.each(["error response", "transport timeout"] as const)(
    "keeps the committed candidate active when retired cleanup reports a %s",
    async (failureKind) => {
      const reportDiagnostic = vi.fn();
      let candidateId = "";
      let openCount = 0;
      let retiredCleanupOptions: BridgeRequestOptions | undefined;
      const delegateRequest = vi.fn(
        async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
          if (request.kind === "openSession") {
            openCount += 1;
            if (openCount === 1) {
              return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
            }
            candidateId = request.requestedSessionId ?? "";
            return openedFor(request, metadataFor({ runtimeId: candidateId, source: replacementSource }));
          }
          if (request.kind === "getPage" && request.sessionId === candidateId) {
            return pageFor(
              request,
              metadataFor({
                runtimeId: candidateId,
                source: replacementSource,
                revision: request.revision,
                filterModel: request.filterModel
              })
            );
          }
          if (request.kind === "closeSession" && request.sessionId === "runtime-old") {
            retiredCleanupOptions = options;
            if (failureKind === "transport timeout") throw new Error("retired close timed out");
            return {
              kind: "error",
              code: "engine_error",
              message: "retired close failed",
              recoverable: true,
              sessionId: request.sessionId
            };
          }
          if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
          throw new Error(`Unexpected request: ${request.kind}`);
        }
      );
      const coordinator = new SessionCoordinator();
      const bridge = coordinator.createBridge({ request: delegateRequest, reportDiagnostic });
      const opened = await open(bridge, initialSource);

      await expect(
        bridge.reconfigureFileSession!(opened.metadata.sessionId, opened.metadata.revision, replacementSource)
      ).resolves.toMatchObject({
        kind: "sessionOpened",
        metadata: { sessionId: opened.metadata.sessionId, revision: 1, source: replacementSource }
      });
      await vi.waitFor(() => expect(reportDiagnostic).toHaveBeenCalledOnce());

      expect(retiredCleanupOptions).toEqual({
        priority: "interactive",
        timeoutMs: 2_000,
        restartRuntimeOnTimeout: false,
        startRuntimeIfNeeded: false
      });
      expect(openCount).toBe(2);
      expect(coordinator.diagnostics().sessions).toEqual([
        expect.objectContaining({ runtimeId: candidateId, publicRevision: 1, runtimeRevision: 0 })
      ]);
      expect(coordinator.activeSession()).toMatchObject({
        sessionId: opened.metadata.sessionId,
        metadata: { revision: 1, source: replacementSource }
      });
      expect(reportDiagnostic).toHaveBeenCalledWith(
        expect.stringMatching(
          failureKind === "transport timeout" ? /retired runtime.*timed out/ : /retired runtime.*engine_error/
        )
      );
      const pageResponse = await bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: 1,
        viewRequestId: `candidate-after-${failureKind.replaceAll(" ", "-")}`,
        offset: 0,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16,
        filterModel: coordinator.activeSession()?.metadata.filterModel ?? { filters: [], sort: [] }
      });
      if (pageResponse.kind !== "page") {
        throw new Error(`Expected the committed candidate page, received ${JSON.stringify(pageResponse)}.`);
      }
      expect(pageResponse).toMatchObject({
        kind: "page",
        metadata: { sessionId: opened.metadata.sessionId }
      });
      expect(openCount).toBe(2);
    }
  );

  it.each([
    {
      label: "backend",
      invalidMetadata: (runtimeId: string): SessionMetadata =>
        metadataFor({ runtimeId, source: replacementSource, backend: "polars" })
    },
    {
      label: "mode",
      invalidMetadata: (runtimeId: string): SessionMetadata => ({
        ...metadataFor({ runtimeId, source: replacementSource, backend: "pandas" }),
        mode: "viewing"
      })
    },
    {
      label: "source",
      invalidMetadata: (runtimeId: string): SessionMetadata =>
        metadataFor({
          runtimeId,
          source: { ...replacementSource, label: "different.csv" },
          backend: "pandas"
        })
    }
  ])("rejects a recovery $label mismatch after import reconfiguration", async ({ invalidMetadata }) => {
    let candidateId = "";
    let recoveryId = "";
    let openCount = 0;
    const closeCalls: CloseRequest[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        if (openCount === 1) {
          return openedFor(
            request,
            metadataFor({ runtimeId: "runtime-old", source: initialSource, backend: "pandas" })
          );
        }
        if (openCount === 2) {
          candidateId = request.requestedSessionId ?? "";
          return openedFor(
            request,
            metadataFor({ runtimeId: candidateId, source: replacementSource, backend: "pandas" })
          );
        }
        recoveryId = "runtime-invalid-recovery";
        return openedFor(request, invalidMetadata(recoveryId));
      }
      if (request.kind === "getPage" && request.sessionId === candidateId) {
        if (request.viewRequestId === "trigger-recovery") {
          return {
            kind: "error",
            code: "engine_error",
            message: `Unknown session: ${candidateId}`,
            recoverable: true,
            sessionId: candidateId,
            viewRequestId: request.viewRequestId
          };
        }
        return pageFor(
          request,
          metadataFor({
            runtimeId: candidateId,
            source: replacementSource,
            backend: "pandas",
            revision: request.revision,
            filterModel: request.filterModel
          })
        );
      }
      if (request.kind === "closeSession") {
        closeCalls.push(request);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const openedResponse = await bridge.request({ ...openRequest(initialSource), backend: "pandas" });
    if (openedResponse.kind !== "sessionOpened") throw new Error("Expected a pinned Pandas session.");
    const reconfigured = await bridge.reconfigureFileSession!(
      openedResponse.metadata.sessionId,
      openedResponse.metadata.revision,
      replacementSource
    );
    if (reconfigured.kind !== "sessionOpened") throw new Error("Expected import reconfiguration to succeed.");

    const response = await bridge.request({
      kind: "getPage",
      sessionId: reconfigured.metadata.sessionId,
      revision: reconfigured.metadata.revision,
      viewRequestId: "trigger-recovery",
      offset: 0,
      limit: 100,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: reconfigured.metadata.filterModel
    });

    expect(response).toMatchObject({
      kind: "error",
      code: "engine_error",
      sessionId: reconfigured.metadata.sessionId
    });
    expect(closeCalls).toContainEqual({
      kind: "closeSession",
      sessionId: recoveryId,
      revision: 0
    });
    expect(coordinator.activeSession()).toMatchObject({
      sessionId: reconfigured.metadata.sessionId,
      metadata: {
        backend: "pandas",
        mode: "editing",
        source: replacementSource,
        revision: reconfigured.metadata.revision
      }
    });
    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({
        runtimeId: candidateId,
        publicRevision: reconfigured.metadata.revision
      })
    ]);
  });

  it("does not activate an inactive session when its runtime is replaced", async () => {
    const first = simpleReconfiguringDelegate("runtime-first");
    const second = simpleReconfiguringDelegate("runtime-second");
    const coordinator = new SessionCoordinator();
    const firstBridge = coordinator.createBridge({ request: first.request });
    const secondBridge = coordinator.createBridge({ request: second.request });
    const firstOpened = await open(firstBridge, { ...initialSource, label: "first.csv", path: "/workspace/first.csv" });
    const secondSource: SessionSource = {
      ...initialSource,
      label: "second.csv",
      path: "/workspace/second.csv",
      uri: "file:///workspace/second.csv"
    };
    const secondOpened = await open(secondBridge, secondSource);
    expect(coordinator.activeSession()?.sessionId).toBe(secondOpened.metadata.sessionId);

    const firstReplacement: SessionSource = {
      ...firstOpened.metadata.source,
      importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const response = await firstBridge.reconfigureFileSession!(
      firstOpened.metadata.sessionId,
      firstOpened.metadata.revision,
      firstReplacement
    );

    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: firstOpened.metadata.sessionId, revision: 1, source: firstReplacement }
    });
    expect(coordinator.activeSession()?.sessionId).toBe(secondOpened.metadata.sessionId);
    expect(coordinator.diagnostics().activeSessionId).toBe(secondOpened.metadata.sessionId);
  });

  it("requires the exact same file identity and treats unchanged options as a no-op error", async () => {
    const delegate = simpleReconfiguringDelegate("runtime-old");
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegate.request });
    const opened = await open(bridge, initialSource);
    const candidateCallsBefore = delegate.openRequests().length;
    const invalidSources: SessionSource[] = [
      { ...replacementSource, path: "/workspace/other.csv" },
      { ...replacementSource, uri: "file:///workspace/other.csv" },
      { ...replacementSource, label: "other.csv" },
      { ...replacementSource, variableName: "unexpected" },
      { kind: "notebookVariable", label: initialSource.label, variableName: "frame" }
    ];

    for (const source of invalidSources) {
      await expect(
        bridge.reconfigureFileSession!(opened.metadata.sessionId, opened.metadata.revision, source)
      ).resolves.toMatchObject({ kind: "error", code: "invalid_import_source" });
    }
    await expect(
      bridge.reconfigureFileSession!(opened.metadata.sessionId, opened.metadata.revision, initialSource)
    ).resolves.toMatchObject({ kind: "error", code: "import_options_unchanged" });
    expect(delegate.openRequests()).toHaveLength(candidateCallsBefore);
    expect(coordinator.activeSession()?.metadata.source).toEqual(initialSource);
  });
});
