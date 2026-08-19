import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type { BridgeRequestOptions } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import type {
  OpenSessionRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata
} from "../shared/protocol";
import {
  appliedFor,
  appliedStep,
  capabilities,
  deferred,
  draftStep,
  initialSource,
  metadataFor,
  open,
  openRequest,
  openedFor,
  pageFor,
  previewFor,
  replacementSource,
  savedFilter,
  schema,
  simpleReconfiguringDelegate,
  type CloseRequest
} from "./sessionReconfigurationTestFixtures";

describe("SessionCoordinator file-session reconfiguration", () => {
  it("releases the reconfiguration barrier before publishing the replacement snapshot", async () => {
    const delegate = simpleReconfiguringDelegate("runtime-old");
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegate.request });
    const opened = await open(bridge, initialSource);
    let publicationUpdate: Promise<void> | undefined;
    const subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      if (
        publicationUpdate ||
        snapshot?.sessionId !== opened.metadata.sessionId ||
        snapshot.metadata.source.importOptions?.delimiter !== replacementSource.importOptions?.delimiter
      ) {
        return;
      }
      publicationUpdate =
        bridge.updateViewState?.(snapshot.sessionId, {
          selectedColumnId: "c:value",
          columnWidths: new Map([["c:value", 247]]),
          viewport: { firstVisibleRow: 1, scrollLeft: 23 }
        }) ?? Promise.resolve();
    });

    const response = await bridge.reconfigureFileSession!(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    );
    subscription.dispose();

    expect(response.kind).toBe("sessionOpened");
    expect(publicationUpdate).toBeDefined();
    await publicationUpdate;
    expect(coordinator.activeSession()?.viewState).toMatchObject({
      selectedColumnId: "c:value",
      columnWidths: new Map([["c:value", 247]]),
      viewport: { firstVisibleRow: 1, scrollLeft: 23 }
    });
  });

  it("atomically keeps the public identity while replaying cleaning and viewing state on a new backend", async () => {
    const requests: Array<{ request: OpenWranglerRequest; options?: BridgeRequestOptions }> = [];
    const initialMetadata = metadataFor({
      runtimeId: "runtime-old",
      source: initialSource,
      revision: 3,
      steps: [appliedStep],
      draftStep,
      filterModel: savedFilter
    });
    let candidateId = "";

    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        requests.push({ request, options });
        if (
          request.kind === "openSession" &&
          requests.filter((item) => item.request.kind === "openSession").length === 1
        ) {
          return openedFor(request, initialMetadata);
        }
        if (request.kind === "openSession") {
          candidateId = request.requestedSessionId ?? "";
          return openedFor(request, metadataFor({ runtimeId: candidateId, source: request.source, backend: "pandas" }));
        }
        if (request.kind === "previewStep" && request.sessionId === candidateId) {
          const priorSteps = request.step.id === draftStep.id ? [appliedStep] : [];
          const preview = previewFor(
            request,
            metadataFor({
              runtimeId: candidateId,
              source: replacementSource,
              backend: "pandas",
              revision: request.revision + 1,
              steps: priorSteps,
              draftStep: request.step
            }),
            request.step.id === draftStep.id ? "# restored draft" : "# restored preview"
          );
          return request.step.id === draftStep.id ? { ...preview, warnings: ["candidate backend warning"] } : preview;
        }
        if (request.kind === "applyDraft" && request.sessionId === candidateId) {
          return appliedFor(
            request,
            metadataFor({
              runtimeId: candidateId,
              source: replacementSource,
              backend: "pandas",
              revision: request.revision + 1,
              steps: [appliedStep]
            }),
            "# restored apply"
          );
        }
        if (request.kind === "getPage" && request.sessionId === candidateId) {
          return pageFor(
            request,
            metadataFor({
              runtimeId: candidateId,
              source: replacementSource,
              backend: "pandas",
              revision: request.revision,
              steps: [appliedStep],
              draftStep,
              filterModel: request.filterModel
            })
          );
        }
        if (request.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        throw new Error(`Unexpected request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge, initialSource);
    const publicId = opened.metadata.sessionId;
    await bridge.updateViewState?.(publicId, {
      selectedColumnId: "c:value",
      columnWidths: new Map([["c:value", 260]]),
      viewport: { firstVisibleRow: 1, scrollLeft: 19 }
    });

    const response = await bridge.reconfigureFileSession?.(publicId, opened.metadata.revision, replacementSource, {
      timeoutMs: 987
    });

    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        sessionId: publicId,
        revision: opened.metadata.revision + 1,
        backend: "pandas",
        source: replacementSource,
        steps: [appliedStep],
        draftStep
      }
    });
    expect(candidateId).not.toBe("");
    expect(candidateId).not.toBe(publicId);
    expect(coordinator.diagnostics()).toMatchObject({
      activeSessionId: publicId,
      sessionCount: 1,
      sessions: [
        {
          publicId,
          runtimeId: candidateId,
          publicRevision: opened.metadata.revision + 1,
          runtimeRevision: 3
        }
      ]
    });
    expect(coordinator.activeSession()).toMatchObject({
      sessionId: publicId,
      metadata: {
        sessionId: publicId,
        revision: opened.metadata.revision + 1,
        backend: "pandas",
        source: replacementSource,
        filterModel: savedFilter,
        steps: [appliedStep],
        draftStep
      },
      code: "# restored draft",
      viewState: {
        selectedColumnId: "c:value",
        columnWidths: new Map([["c:value", 260]]),
        viewport: { firstVisibleRow: 1, scrollLeft: 19 },
        filterModel: savedFilter
      }
    });
    expect(bridge.getSessionPresentation?.(publicId)).toEqual({
      sessionId: publicId,
      revision: opened.metadata.revision + 1,
      code: "# restored draft",
      draft: {
        diff: {
          addedRows: 0,
          removedRows: 0,
          addedColumns: [],
          removedColumns: [],
          changedCells: 0,
          cells: [],
          truncated: false
        },
        warnings: ["candidate backend warning"],
        beforeSchema: schema
      }
    });
    expect(
      requests
        .filter(({ request }) => request.kind === "openSession")
        .map(({ request }) => (request.kind === "openSession" ? request : undefined))
    ).toEqual([
      expect.objectContaining({ source: initialSource }),
      expect.objectContaining({
        source: replacementSource,
        requestedSessionId: candidateId
      })
    ]);
    const replacementOpen = requests
      .map(({ request }) => request)
      .find(
        (request): request is OpenSessionRequest =>
          request.kind === "openSession" && Boolean(request.requestedSessionId)
      );
    expect(replacementOpen).not.toHaveProperty("backend");
    expect(
      requests
        .filter(({ request }) => request.kind === "previewStep")
        .map(({ request }) => (request.kind === "previewStep" ? request.step.id : ""))
    ).toEqual([appliedStep.id, draftStep.id]);
    await vi.waitFor(() => {
      expect(
        requests.find(({ request }) => request.kind === "closeSession" && request.sessionId === "runtime-old")
      ).toEqual({
        request: { kind: "closeSession", sessionId: "runtime-old", revision: 3 },
        options: {
          priority: "interactive",
          timeoutMs: 2_000,
          restartRuntimeOnTimeout: false,
          startRuntimeIfNeeded: false
        }
      });
    });
  });

  it("waits for restored state persistence before acknowledging a replacement closed immediately afterward", async () => {
    let stored: Record<string, unknown> = {};
    const persistenceWrite = deferred<void>();
    const workspaceState = {
      get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? stored : fallback)),
      update: vi.fn(async (key: string, value: unknown) => {
        if (key !== SESSION_STORAGE_KEY) return;
        await persistenceWrite.promise;
        stored = value as Record<string, unknown>;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const initialMetadata = metadataFor({
      runtimeId: "runtime-old",
      source: initialSource,
      revision: 3,
      steps: [appliedStep],
      draftStep,
      filterModel: savedFilter
    });
    let candidateId = "";
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, initialMetadata);
      }
      if (request.kind === "openSession") {
        candidateId = request.requestedSessionId ?? "";
        return openedFor(request, metadataFor({ runtimeId: candidateId, source: replacementSource }));
      }
      if (request.kind === "previewStep" && request.sessionId === candidateId) {
        const restoringDraft = request.step.id === draftStep.id;
        return previewFor(
          request,
          metadataFor({
            runtimeId: candidateId,
            source: replacementSource,
            revision: request.revision + 1,
            steps: restoringDraft ? [appliedStep] : [],
            draftStep: request.step,
            filterModel: savedFilter
          }),
          restoringDraft ? "# restored draft" : "# restored preview"
        );
      }
      if (request.kind === "applyDraft" && request.sessionId === candidateId) {
        return appliedFor(
          request,
          metadataFor({
            runtimeId: candidateId,
            source: replacementSource,
            revision: request.revision + 1,
            steps: [appliedStep],
            filterModel: savedFilter
          }),
          "# restored apply"
        );
      }
      if (request.kind === "getPage" && request.sessionId === candidateId) {
        return pageFor(
          request,
          metadataFor({
            runtimeId: candidateId,
            source: replacementSource,
            revision: request.revision,
            steps: [appliedStep],
            draftStep,
            filterModel: request.filterModel
          })
        );
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await open(bridge, initialSource);
    let acknowledged = false;
    const replacement = bridge.reconfigureFileSession!(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    ).then((response) => {
      acknowledged = true;
      return response;
    });

    await vi.waitFor(() => expect(workspaceState.update).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);

    await expect(
      bridge.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      })
    ).resolves.toEqual({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    expect(acknowledged).toBe(false);

    persistenceWrite.resolve();
    await expect(replacement).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: {
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision + 1,
        source: replacementSource,
        steps: [appliedStep],
        draftStep
      }
    });
    expect(stored[persistenceKey(replacementSource, "polars")]).toMatchObject({
      backend: "polars",
      cleaning: { steps: [appliedStep], draftStep },
      view: { filterModel: savedFilter }
    });
  });

  it.each([
    [
      "runtime error",
      {
        kind: "error",
        code: "unsupported_import_options",
        message: "The selected delimiter is unsupported.",
        recoverable: true
      } satisfies OpenWranglerResponse
    ],
    ["runtime cancellation", { kind: "cancelled", targetRequestId: "candidate-open" } satisfies OpenWranglerResponse]
  ])("leaves the confirmed session untouched after a %s", async (_label, candidateResponse) => {
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
      }
      if (request.kind === "openSession") return candidateResponse;
      if (request.kind === "getPage") {
        return pageFor(
          request,
          metadataFor({
            runtimeId: "runtime-old",
            source: initialSource,
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
    const before = structuredClone(coordinator.activeSession());

    const response = await bridge.reconfigureFileSession?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    );

    expect(response?.kind).toBe(candidateResponse.kind);
    expect(coordinator.activeSession()).toEqual(before);
    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({ runtimeId: "runtime-old", publicRevision: 0, runtimeRevision: 0 })
    ]);
    const candidateRequest = delegateRequest.mock.calls
      .map(([request]) => request)
      .find(
        (request): request is OpenSessionRequest =>
          request.kind === "openSession" && request.requestedSessionId !== undefined
      );
    expect(candidateRequest).toBeDefined();
    expect(
      delegateRequest.mock.calls.find(
        ([request]) => request.kind === "closeSession" && request.sessionId === candidateRequest?.requestedSessionId
      )
    ).toEqual([
      {
        kind: "closeSession",
        sessionId: candidateRequest?.requestedSessionId,
        revision: 0
      },
      {
        priority: "interactive",
        timeoutMs: 2_000,
        restartRuntimeOnTimeout: false,
        startRuntimeIfNeeded: false
      }
    ]);
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: `after-${candidateResponse.kind}`,
        offset: 0,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({ kind: "page", metadata: { sessionId: opened.metadata.sessionId } });
    expect(delegateRequest.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "getPage", sessionId: "runtime-old" });
  });

  it("keeps an explicitly pinned backend on the replacement request", async () => {
    const candidateRequests: OpenSessionRequest[] = [];
    let candidateId = "";
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        expect(request.backend).toBe("pandas");
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource, backend: "pandas" }));
      }
      if (request.kind === "openSession") {
        candidateRequests.push(request);
        candidateId = request.requestedSessionId ?? "";
        return openedFor(
          request,
          metadataFor({ runtimeId: candidateId, source: replacementSource, backend: "pandas" })
        );
      }
      if (request.kind === "getPage" && request.sessionId === candidateId) {
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
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const openedResponse = await bridge.request({ ...openRequest(initialSource), backend: "pandas" });
    if (openedResponse.kind !== "sessionOpened") throw new Error("Expected a pinned Pandas session.");

    const response = await bridge.reconfigureFileSession!(
      openedResponse.metadata.sessionId,
      openedResponse.metadata.revision,
      replacementSource
    );

    expect(candidateRequests).toEqual([
      expect.objectContaining({
        kind: "openSession",
        backend: "pandas",
        source: replacementSource,
        requestedSessionId: candidateId
      })
    ]);
    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        sessionId: openedResponse.metadata.sessionId,
        backend: "pandas",
        source: replacementSource
      }
    });
    expect(coordinator.activeSession()).toMatchObject({
      sessionId: openedResponse.metadata.sessionId,
      metadata: { backend: "pandas", source: replacementSource }
    });
  });

  it("switches the backend without changing import options and pins the confirmed engine", async () => {
    const candidateRequests: OpenSessionRequest[] = [];
    const candidateMetadata = new Map<string, SessionMetadata>();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource, backend: "polars" }));
      }
      if (request.kind === "openSession") {
        candidateRequests.push(request);
        const runtimeId = request.requestedSessionId ?? "";
        const candidate = metadataFor({
          runtimeId,
          source: request.source,
          backend: request.backend ?? "polars"
        });
        candidateMetadata.set(runtimeId, candidate);
        return openedFor(request, candidate);
      }
      if (request.kind === "getPage") {
        const candidate = candidateMetadata.get(request.sessionId);
        if (!candidate) throw new Error(`Unknown replacement runtime: ${request.sessionId}`);
        return pageFor(request, {
          ...candidate,
          revision: request.revision,
          filterModel: request.filterModel
        });
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const openedResponse = await bridge.request(openRequest(initialSource), { backendPreference: "auto" });
    if (openedResponse.kind !== "sessionOpened") throw new Error("Expected a Polars session.");
    await bridge.updateViewState?.(openedResponse.metadata.sessionId, {
      selectedColumnId: "c:value",
      columnWidths: new Map([["c:value", 245]]),
      viewport: { firstVisibleRow: 1, scrollLeft: 17 }
    });

    const switched = await bridge.reconfigureFileSession!(
      openedResponse.metadata.sessionId,
      openedResponse.metadata.revision,
      initialSource,
      { backendPreference: "pandas" }
    );
    if (switched.kind !== "sessionOpened") throw new Error("Expected a Pandas replacement.");

    expect(candidateRequests[0]).toMatchObject({
      kind: "openSession",
      backend: "pandas",
      source: initialSource
    });
    expect(switched).toMatchObject({
      metadata: {
        sessionId: openedResponse.metadata.sessionId,
        backend: "pandas",
        source: initialSource
      }
    });
    expect(coordinator.activeSession()?.viewState).toMatchObject({
      selectedColumnId: "c:value",
      columnWidths: new Map([["c:value", 245]]),
      viewport: { firstVisibleRow: 1, scrollLeft: 17 }
    });

    const imported = await bridge.reconfigureFileSession!(
      switched.metadata.sessionId,
      switched.metadata.revision,
      replacementSource
    );

    expect(imported.kind).toBe("sessionOpened");
    expect(candidateRequests[1]).toMatchObject({
      kind: "openSession",
      backend: "pandas",
      source: replacementSource
    });
  });

  it("keeps an automatic preference after reopening a confirmed backend", async () => {
    const candidateRequests: OpenSessionRequest[] = [];
    let candidateId = "";
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        expect(request.backend).toBe("pandas");
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource, backend: "pandas" }));
      }
      if (request.kind === "openSession") {
        candidateRequests.push(request);
        candidateId = request.requestedSessionId ?? "";
        return openedFor(
          request,
          metadataFor({ runtimeId: candidateId, source: replacementSource, backend: "polars" })
        );
      }
      if (request.kind === "getPage" && request.sessionId === candidateId) {
        return pageFor(
          request,
          metadataFor({
            runtimeId: candidateId,
            source: replacementSource,
            backend: "polars",
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
    const openedResponse = await bridge.request(
      { ...openRequest(initialSource), backend: "pandas" },
      { backendPreference: "auto" }
    );
    if (openedResponse.kind !== "sessionOpened") throw new Error("Expected a confirmed Pandas session.");

    const response = await bridge.reconfigureFileSession!(
      openedResponse.metadata.sessionId,
      openedResponse.metadata.revision,
      replacementSource
    );

    expect(candidateRequests).toEqual([
      expect.objectContaining({
        kind: "openSession",
        source: replacementSource,
        requestedSessionId: candidateId
      })
    ]);
    expect(candidateRequests[0]).not.toHaveProperty("backend");
    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        sessionId: openedResponse.metadata.sessionId,
        backend: "polars",
        source: replacementSource
      }
    });
  });

  it("rejects inconsistent explicit host backend provenance before opening a runtime", async () => {
    const delegateRequest = vi.fn();
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });

    await expect(
      bridge.request({ ...openRequest(initialSource), backend: "pandas" }, { backendPreference: "polars" })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_backend_preference",
      recoverable: false
    });
    expect(delegateRequest).not.toHaveBeenCalled();
  });

  it.each([
    { label: "explicit", options: { backendPreference: "pandas" as const } },
    { label: "confirmed automatic", options: { backendPreference: "auto" as const } }
  ])(
    "rejects a runtime backend mismatch for a $label pinned open without publishing or persisting it",
    async ({ options }) => {
      const get = vi.fn((_key: string, fallback?: unknown) => fallback);
      const update = vi.fn(async () => undefined);
      const workspaceState = {
        get,
        update,
        keys: vi.fn(() => [SESSION_STORAGE_KEY])
      } as unknown as Memento;
      const closeCalls: Array<{ request: CloseRequest; options?: BridgeRequestOptions }> = [];
      const delegateRequest = vi.fn(
        async (request: OpenWranglerRequest, requestOptions?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
          if (request.kind === "openSession") {
            return openedFor(
              request,
              metadataFor({
                runtimeId: "runtime-mismatched",
                source: initialSource,
                backend: "polars"
              })
            );
          }
          if (request.kind === "closeSession") {
            closeCalls.push({ request, options: requestOptions });
            return { kind: "sessionClosed", sessionId: request.sessionId };
          }
          throw new Error(`Unexpected request: ${request.kind}`);
        }
      );
      const coordinator = new SessionCoordinator(workspaceState);
      const activeChanges = vi.fn();
      coordinator.onDidChangeActiveSession(activeChanges);
      const bridge = coordinator.createBridge({ request: delegateRequest });

      const response = await bridge.request({ ...openRequest(initialSource), backend: "pandas" }, options);

      expect(response).toMatchObject({
        kind: "error",
        code: "invalid_runtime_response",
        message: expect.stringContaining("backend polars instead of requested backend pandas"),
        recoverable: true
      });
      expect(closeCalls).toEqual([
        {
          request: { kind: "closeSession", sessionId: "runtime-mismatched", revision: 0 },
          options: {
            priority: "interactive",
            timeoutMs: 2_000,
            restartRuntimeOnTimeout: false,
            startRuntimeIfNeeded: false
          }
        }
      ]);
      expect(coordinator.activeSession()).toBeUndefined();
      expect(coordinator.diagnostics()).toMatchObject({ sessionCount: 0 });
      expect(activeChanges).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }
  );

  it("allows an unpinned automatic open to accept the runtime-selected backend", async () => {
    const closeCalls: CloseRequest[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        expect(request).not.toHaveProperty("backend");
        return openedFor(
          request,
          metadataFor({
            runtimeId: "runtime-auto-duckdb",
            source: initialSource,
            backend: "duckdb"
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

    const response = await bridge.request(openRequest(initialSource), { backendPreference: "auto" });

    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: { backend: "duckdb", source: initialSource }
    });
    expect(coordinator.activeSession()).toMatchObject({ metadata: { backend: "duckdb", source: initialSource } });
    expect(closeCalls).toEqual([]);
    if (response.kind !== "sessionOpened") throw new Error("Expected the automatic session to open.");

    await bridge.request({
      kind: "closeSession",
      sessionId: response.metadata.sessionId,
      revision: response.metadata.revision
    });
    expect(closeCalls).toHaveLength(1);
    expect(coordinator.diagnostics().sessionCount).toBe(0);
  });

  it.each([
    {
      label: "a candidate backend mismatch",
      candidateResponse: (request: OpenSessionRequest): OpenWranglerResponse =>
        openedFor(
          request,
          metadataFor({
            runtimeId: request.requestedSessionId ?? "",
            source: replacementSource,
            backend: "polars"
          })
        ),
      expectedCode: "invalid_runtime_response",
      expectsCandidateClose: true
    },
    {
      label: "an unsupported pinned import",
      candidateResponse: (): OpenWranglerResponse => ({
        kind: "error",
        code: "unsupported_import_options",
        message: "Pandas rejected the requested import options.",
        recoverable: true
      }),
      expectedCode: "unsupported_import_options",
      expectsCandidateClose: true
    }
  ])(
    "preserves exact confirmed state after $label",
    async ({ candidateResponse, expectedCode, expectsCandidateClose }) => {
      const closeCalls: CloseRequest[] = [];
      const candidateRequests: OpenSessionRequest[] = [];
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
          return openedFor(
            request,
            metadataFor({ runtimeId: "runtime-old", source: initialSource, backend: "pandas" })
          );
        }
        if (request.kind === "openSession") {
          candidateRequests.push(request);
          return candidateResponse(request);
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
      await bridge.updateViewState?.(openedResponse.metadata.sessionId, {
        selectedColumnId: "c:value",
        columnWidths: new Map([["c:value", 271]]),
        viewport: { firstVisibleRow: 1, scrollLeft: 13 }
      });
      const before = structuredClone(coordinator.activeSession());

      const response = await bridge.reconfigureFileSession!(
        openedResponse.metadata.sessionId,
        openedResponse.metadata.revision,
        replacementSource
      );

      expect(candidateRequests).toHaveLength(1);
      expect(candidateRequests[0]).toMatchObject({ backend: "pandas", source: replacementSource });
      expect(response).toMatchObject({ kind: "error", code: expectedCode });
      expect(coordinator.activeSession()).toEqual(before);
      expect(coordinator.diagnostics().sessions).toEqual([
        expect.objectContaining({
          runtimeId: "runtime-old",
          publicRevision: openedResponse.metadata.revision,
          runtimeRevision: openedResponse.metadata.revision
        })
      ]);
      const candidateId = candidateRequests[0].requestedSessionId;
      expect(closeCalls.filter((request) => request.sessionId === candidateId)).toHaveLength(
        expectsCandidateClose ? 1 : 0
      );
    }
  );

  it("closes the host-requested candidate identity after an unexpected open response", async () => {
    let requestedCandidateId = "";
    const closeCalls: Array<{ request: OpenWranglerRequest; options?: BridgeRequestOptions }> = [];
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
          return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
        }
        if (request.kind === "openSession") {
          requestedCandidateId = request.requestedSessionId ?? "";
          return {
            kind: "initialized",
            protocolVersion: 2,
            runtimeVersion: "0.3.0",
            capabilities: capabilities()
          };
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
    const before = structuredClone(coordinator.activeSession());

    const response = await bridge.reconfigureFileSession?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    );

    expect(response).toMatchObject({ kind: "error", code: "invalid_runtime_response" });
    expect(requestedCandidateId).not.toBe("");
    expect(closeCalls).toEqual([
      {
        request: { kind: "closeSession", sessionId: requestedCandidateId, revision: 0 },
        options: {
          priority: "interactive",
          timeoutMs: 2_000,
          restartRuntimeOnTimeout: false,
          startRuntimeIfNeeded: false
        }
      }
    ]);
    expect(coordinator.activeSession()).toEqual(before);
  });

  it("rolls back and closes a candidate whose restored page projection is wrong", async () => {
    let candidateId = "";
    const closeCalls: CloseRequest[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
      }
      if (request.kind === "openSession") {
        candidateId = request.requestedSessionId ?? "";
        return openedFor(request, metadataFor({ runtimeId: candidateId, source: request.source }));
      }
      if (request.kind === "getPage" && request.sessionId === candidateId) {
        const valid = pageFor(
          request,
          metadataFor({
            runtimeId: candidateId,
            source: replacementSource,
            revision: request.revision,
            filterModel: request.filterModel
          })
        );
        return { ...valid, page: { ...valid.page, columnIds: ["wrong-column"] } };
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
    const before = structuredClone(coordinator.activeSession());

    const response = await bridge.reconfigureFileSession?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      replacementSource
    );

    expect(response).toMatchObject({ kind: "error", code: "import_state_replay_failed" });
    expect(closeCalls).toEqual([{ kind: "closeSession", sessionId: candidateId, revision: 0 }]);
    expect(coordinator.activeSession()).toEqual(before);
    expect(coordinator.diagnostics().sessions).toEqual([
      expect.objectContaining({ runtimeId: "runtime-old", publicRevision: 0, runtimeRevision: 0 })
    ]);
  });
});
