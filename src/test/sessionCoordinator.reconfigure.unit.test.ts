import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type { BridgeRequestOptions, CancellationTokenLike, OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import type {
  ColumnSchema,
  DataBackend,
  FilterModel,
  OpenSessionRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource,
  TransformStep
} from "../shared/protocol";

type CloseRequest = Extract<OpenWranglerRequest, { kind: "closeSession" }>;

const schema: ColumnSchema[] = [
  {
    id: "c:value",
    name: "value",
    position: 0,
    rawType: "Float64",
    type: "float",
    nullable: false
  }
];

const initialSource: SessionSource = {
  kind: "file",
  label: "sample.csv",
  path: "/workspace/sample.csv",
  uri: "file:///workspace/sample.csv",
  importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
};

const replacementSource: SessionSource = {
  ...initialSource,
  importOptions: { delimiter: "💠", encoding: "utf-8", quoteChar: '"', hasHeader: true }
};

const appliedStep: TransformStep = {
  id: "round-value",
  kind: "roundNumber",
  params: { column: { id: "c:value", name: "value" }, decimals: 1 }
};

const draftStep: TransformStep = {
  id: "floor-value",
  kind: "floorNumber",
  params: { column: { id: "c:value", name: "value" } }
};

const savedFilter: FilterModel = {
  filters: [],
  sort: [{ column: "value", direction: "desc", nulls: "last" }]
};

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
          columnWidths: { "c:value": 247 },
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
      columnWidths: { "c:value": 247 },
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
      columnWidths: { "c:value": 260 },
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
        columnWidths: { "c:value": 260 },
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
    const before = clone(coordinator.activeSession());

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
        columnWidths: { "c:value": 271 },
        viewport: { firstVisibleRow: 1, scrollLeft: 13 }
      });
      const before = clone(coordinator.activeSession());

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
    const before = clone(coordinator.activeSession());

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

  it.each([
    {
      label: "structured unknown-session response with a mismatched session ID",
      cleanupResponse: (): OpenWranglerResponse => ({
        kind: "error",
        code: "unknown_session",
        message: "A different runtime session is absent.",
        recoverable: true,
        sessionId: "different-runtime-session"
      }),
      expectedDetail: "unknown_session: A different runtime session is absent."
    },
    {
      label: "legacy unknown-session response with a mismatched message",
      cleanupResponse: (candidateId: string): OpenWranglerResponse => ({
        kind: "error",
        code: "engine_error",
        message: "Unknown session: different-runtime-session",
        recoverable: true,
        sessionId: candidateId
      }),
      expectedDetail: "engine_error: Unknown session: different-runtime-session"
    }
  ])("reports a candidate cleanup $label", async ({ cleanupResponse, expectedDetail }) => {
    let candidateId = "";
    const reportDiagnostic = vi.fn();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession" && delegateRequest.mock.calls.length === 1) {
        return openedFor(request, metadataFor({ runtimeId: "runtime-old", source: initialSource }));
      }
      if (request.kind === "openSession") {
        candidateId = request.requestedSessionId ?? "";
        return {
          kind: "error",
          code: "unsupported_import_options",
          message: "The selected delimiter is unsupported.",
          recoverable: true
        };
      }
      if (request.kind === "closeSession" && request.sessionId === candidateId) {
        return cleanupResponse(candidateId);
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, reportDiagnostic });
    const opened = await open(bridge, initialSource);
    const before = clone(coordinator.activeSession());

    await expect(
      bridge.reconfigureFileSession!(opened.metadata.sessionId, opened.metadata.revision, replacementSource)
    ).resolves.toMatchObject({ kind: "error", code: "unsupported_import_options" });

    expect(candidateId).not.toBe("");
    expect(reportDiagnostic).toHaveBeenCalledOnce();
    expect(reportDiagnostic).toHaveBeenCalledWith(
      `Open Wrangler could not confirm cleanup of import candidate session ${candidateId}: ${expectedDetail}`
    );
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
    const before = clone(coordinator.activeSession());

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

  it("never starts a runtime solely to clean a detached retired session", async () => {
    let candidateId = "";
    let runtimeRunning = true;
    let spuriousRuntimeStarts = 0;
    let openCount = 0;
    const retiredCleanup = deferred<void>();
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          openCount += 1;
          runtimeRunning = true;
          const runtimeId = request.requestedSessionId ?? "runtime-old";
          if (request.requestedSessionId) candidateId = runtimeId;
          return openedFor(
            request,
            metadataFor({
              runtimeId,
              source: request.source,
              backend: "pandas"
            })
          );
        }
        if (request.kind === "getPage" && request.sessionId === candidateId) {
          const response = pageFor(
            request,
            metadataFor({
              runtimeId: candidateId,
              source: replacementSource,
              backend: "pandas",
              revision: request.revision,
              filterModel: request.filterModel
            })
          );
          runtimeRunning = false;
          return response;
        }
        if (request.kind === "closeSession" && request.sessionId === "runtime-old") {
          if (!runtimeRunning && options?.startRuntimeIfNeeded !== false) {
            runtimeRunning = true;
            spuriousRuntimeStarts += 1;
          }
          retiredCleanup.resolve();
          return {
            kind: "error",
            code: "unknown_session",
            message: "The stopped runtime no longer owns this session.",
            recoverable: true
          };
        }
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`Unexpected request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const openedResponse = await bridge.request({ ...openRequest(initialSource), backend: "pandas" });
    if (openedResponse.kind !== "sessionOpened") throw new Error("Expected a pinned Pandas session.");

    await expect(
      bridge.reconfigureFileSession!(
        openedResponse.metadata.sessionId,
        openedResponse.metadata.revision,
        replacementSource
      )
    ).resolves.toMatchObject({ kind: "sessionOpened" });
    await retiredCleanup.promise;

    expect(spuriousRuntimeStarts).toBe(0);
    expect(openCount).toBe(2);
    expect(delegateRequest).toHaveBeenCalledWith(
      { kind: "closeSession", sessionId: "runtime-old", revision: 0 },
      expect.objectContaining({ startRuntimeIfNeeded: false })
    );
  });

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

function openRequest(source: SessionSource): OpenSessionRequest {
  return {
    kind: "openSession",
    source,
    mode: "editing",
    pageSize: 100,
    columnOffset: 0,
    columnLimit: 16
  };
}

async function open(bridge: OpenWranglerBridge, source: SessionSource): Promise<SessionOpenedResponse> {
  const response = await bridge.request(openRequest(source));
  if (response.kind !== "sessionOpened") throw new Error(`Expected sessionOpened, received ${response.kind}.`);
  return response;
}

function capabilities(): SessionMetadata["capabilities"] {
  return {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  };
}

function metadataFor({
  runtimeId,
  source,
  backend = "polars",
  revision = 0,
  steps = [],
  draftStep: draft,
  filterModel = { filters: [], sort: [] }
}: {
  runtimeId: string;
  source: SessionSource;
  backend?: DataBackend;
  revision?: number;
  steps?: TransformStep[];
  draftStep?: TransformStep;
  filterModel?: FilterModel;
}): SessionMetadata {
  return {
    protocolVersion: 2,
    sessionId: runtimeId,
    revision,
    backend,
    mode: "editing",
    source,
    capabilities: capabilities(),
    shape: { rows: 2, columns: 1 },
    filteredShape: { rows: 2, columns: 1 },
    schema,
    filterModel,
    steps,
    ...(steps.length > 0 ? { latestStepInputSchema: schema } : {}),
    ...(draft ? { draftStep: draft } : {})
  };
}

function openedFor(request: OpenSessionRequest, metadata: SessionMetadata): SessionOpenedResponse {
  return {
    kind: "sessionOpened",
    metadata,
    page: {
      offset: 0,
      limit: request.pageSize,
      totalRows: exactRows(metadata),
      columnIds: schema.map((column) => column.id),
      rows: []
    },
    summaries: []
  };
}

function pageFor(
  request: Extract<OpenWranglerRequest, { kind: "getPage" }>,
  metadata: SessionMetadata
): Extract<OpenWranglerResponse, { kind: "page" }> {
  return {
    kind: "page",
    revision: request.revision,
    viewRequestId: request.viewRequestId,
    metadata,
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: exactRows(metadata),
      columnIds: metadata.schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id),
      rows: []
    }
  };
}

function previewFor(
  request: Extract<OpenWranglerRequest, { kind: "previewStep" }>,
  metadata: SessionMetadata,
  code: string
): Extract<OpenWranglerResponse, { kind: "stepPreview" }> {
  return {
    kind: "stepPreview",
    revision: metadata.revision,
    metadata,
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: exactRows(metadata),
      columnIds: metadata.schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id),
      rows: []
    },
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

function appliedFor(
  request: Extract<OpenWranglerRequest, { kind: "applyDraft" }>,
  metadata: SessionMetadata,
  code: string
): Extract<OpenWranglerResponse, { kind: "planUpdated" }> {
  return {
    kind: "planUpdated",
    action: "apply",
    revision: metadata.revision,
    metadata,
    page: {
      offset: request.offset,
      limit: request.limit,
      totalRows: exactRows(metadata),
      columnIds: metadata.schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id),
      rows: []
    },
    code
  };
}

function exactRows(metadata: SessionMetadata): number {
  const rows = metadata.filteredShape.rows;
  if (rows === null) throw new Error("This exact-page test fixture requires a known row count.");
  return rows;
}

function simpleReconfiguringDelegate(initialRuntimeId: string): {
  request: OpenWranglerBridge["request"];
  openRequests(): OpenSessionRequest[];
} {
  const requests: OpenWranglerRequest[] = [];
  const sources = new Map<string, SessionSource>();
  const request = vi.fn(async (message: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
    requests.push(message);
    if (message.kind === "openSession") {
      const runtimeId = message.requestedSessionId ?? initialRuntimeId;
      sources.set(runtimeId, message.source);
      return openedFor(message, metadataFor({ runtimeId, source: message.source }));
    }
    if (message.kind === "getPage") {
      return pageFor(
        message,
        metadataFor({
          runtimeId: message.sessionId,
          source: sources.get(message.sessionId) ?? initialSource,
          revision: message.revision,
          filterModel: message.filterModel
        })
      );
    }
    if (message.kind === "closeSession") return { kind: "sessionClosed", sessionId: message.sessionId };
    throw new Error(`Unexpected request: ${message.kind}`);
  });
  return {
    request,
    openRequests: () => requests.filter((message): message is OpenSessionRequest => message.kind === "openSession")
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
