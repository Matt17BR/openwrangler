import { link, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Memento, NotebookDocument } from "vscode";
import type {
  FilterModel,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionSource,
  TransformStep
} from "../shared/protocol";
import {
  persistedSessionState,
  serializePersistedSession,
  persistenceKey,
  SESSION_STORAGE_KEY
} from "../extension/sessionPersistence";
import {
  type OpenWranglerBridge,
  type BridgeRequestOptions,
  type CancellationTokenLike,
  type FilePlanColumnMappingChooser,
  type FilePlanColumnMappingRequest,
  DetachedBridgeRequestError
} from "../extension/dataBridge";
import {
  appliedFor,
  deferred,
  metadataFor,
  openedFor,
  pageFor,
  previewFor
} from "./sessionReconfigurationTestFixtures";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { RKernelBridge } from "../extension/r/rKernelBridge";
import { RKernelDiagnosticError } from "../extension/r/rKernelTransport";
import { R_KERNEL_TRANSPORT_VERSION } from "../extension/r/rKernelProtocol";
import { fakeRKernelTransport, rKernelFrameContract } from "./rKernelBridgeTestFixtures";
import { SessionPersistenceStore } from "../extension/sessionPersistenceStore";
import { isOpenWranglerRequest, isOpenWranglerResponse } from "../shared/protocolValidation";
import type { GridViewState } from "../shared/viewState";
import {
  inspectionStep,
  openedResponse,
  openRequest,
  pageResponseForMetadata,
  planUpdatedResponse,
  setOpenNotebookDocuments,
  setOpenTextDocuments,
  stepInspectionResponse,
  stepPreviewResponse
} from "./sessionCoordinatorTestFixtures";

describe("SessionCoordinator persistence diagnostics", () => {
  it.each([
    "committed",
    "draft",
    "reset",
    "viewing-committed",
    "viewing-draft",
    "viewing-readonly",
    "viewing-cancelled",
    "viewing-disposed"
  ] as const)("preserves saved cleaning across a %s opening failure", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-saved-retry-"));
    const sourcePath = join(directory, "source.csv");
    await writeFile(sourcePath, "sales,units\n2,20\n1,10\n");
    const modeConflict = failure.startsWith("viewing-");
    const notebookSource = failure === "viewing-draft" || failure === "viewing-readonly";
    const notebook = { uri: vscode.Uri.file(sourcePath), isClosed: false } as NotebookDocument;
    const backend = failure === "viewing-readonly" ? "duckdb" : "polars";
    const source: SessionSource = notebookSource
      ? { kind: "notebookVariable", label: "frame", variableName: "frame", uri: notebook.uri.toString() }
      : { ...openRequest.source, path: sourcePath };
    const opening: OpenWranglerRequest = {
      ...openRequest,
      source,
      backend,
      mode: modeConflict && failure !== "viewing-readonly" ? ("viewing" as const) : ("editing" as const)
    };
    const initial = presentationOpenedResponse();
    initial.metadata.source = opening.source;
    initial.metadata.backend = backend;
    initial.metadata.capabilities.notebookInsert = notebookSource && backend !== "duckdb";
    const draft = {
      id: "saved-draft",
      kind: "roundNumber" as const,
      params: { column: { id: "c:sales", name: "sales" }, decimals: 1 }
    };
    const savedCleaning = {
      steps: failure === "viewing-draft" ? [] : [inspectionStep],
      ...(failure === "viewing-committed" || failure === "viewing-readonly" ? {} : { draftStep: draft })
    };
    const saved = serializePersistedSession(
      persistedSessionState(
        { ...initial.metadata, ...savedCleaning },
        { columnWidths: new Map(), viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
      )
    );
    if (!saved) throw new Error("Expected valid saved cleaning.");
    const key = persistenceKey(opening.source, backend);
    let stored: Record<string, unknown> = { [key]: saved };
    const savedBytes = JSON.stringify(stored);
    const workspaceState = {
      get: vi.fn(() => stored),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: () => [SESSION_STORAGE_KEY]
    } as unknown as Memento;
    let fail = true;
    let opens = 0;
    let metadata = initial.metadata;
    const cancellation = new vscode.CancellationTokenSource();
    const wireValid: boolean[] = [];
    const request = vi.fn(async (next: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      wireValid.push(isOpenWranglerRequest(JSON.parse(JSON.stringify(next))));
      let response: OpenWranglerResponse;
      if (next.kind === "openSession") {
        const mode = failure === "viewing-readonly" ? "viewing" : (next.mode ?? "editing");
        metadata = {
          ...initial.metadata,
          sessionId: `retry-${++opens}`,
          mode,
          capabilities: {
            ...initial.metadata.capabilities,
            editable: mode === "editing",
            exportCsv: mode === "editing",
            exportParquet: mode === "editing"
          }
        };
        response = { ...initial, metadata };
      } else if (next.kind === "previewStep") {
        if (metadata.mode === "viewing" || (fail && (failure !== "draft" || next.step.id === draft.id))) {
          response = {
            kind: "error",
            code: "engine_error",
            message: "Temporary replay failure.",
            recoverable: true,
            sessionId: next.sessionId
          };
        } else {
          metadata = { ...metadata, revision: metadata.revision + 1, draftStep: next.step };
          response = {
            ...stepPreviewResponse(metadata.revision, next.step, next.sessionId, `# ${next.step.id}`),
            metadata,
            page: { ...initial.page, limit: next.limit, rows: initial.page.rows.slice(0, next.limit) }
          };
        }
      } else if (next.kind === "applyDraft") {
        const { draftStep, ...confirmed } = metadata;
        if (!draftStep) throw new Error("Expected the restored draft.");
        metadata = {
          ...confirmed,
          revision: metadata.revision + 1,
          steps: [...metadata.steps, draftStep],
          latestStepInputSchema: metadata.schema
        };
        response = {
          ...planUpdatedResponse(metadata.revision, metadata.steps, next.sessionId),
          metadata,
          page: { ...initial.page, limit: next.limit, rows: initial.page.rows.slice(0, next.limit) }
        };
      } else if (next.kind === "getPage") {
        metadata = { ...metadata, filterModel: next.filterModel };
        response = pageResponseForMetadata(next, metadata);
      } else if (next.kind === "closeSession") {
        if (failure === "viewing-cancelled") cancellation.cancel();
        if (failure === "viewing-disposed") coordinator.dispose();
        response = { kind: "sessionClosed", sessionId: next.sessionId };
      } else throw new Error(`Unexpected retry request: ${next.kind}`);
      wireValid.push(isOpenWranglerResponse(response));
      return response;
    });
    const warning = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockImplementation(async (_message, _options, ...items) => (failure === "reset" ? items[0] : undefined));
    warning.mockClear();
    if (notebookSource) setOpenNotebookDocuments(notebook);
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request }, notebookSource ? notebook : undefined);
    const published = vi.fn();
    const subscription = coordinator.onDidChangeActiveSession(published);
    try {
      let reopened = await bridge.request(opening, { cancellation: cancellation.token });
      if (failure !== "reset") {
        expect(reopened).toMatchObject(
          failure === "viewing-cancelled"
            ? { kind: "cancelled" }
            : {
                kind: "error",
                code:
                  failure === "viewing-disposed"
                    ? "coordinator_disposed"
                    : modeConflict
                      ? "viewing_mode_unavailable"
                      : "saved_plan_restore_failed",
                recoverable: failure !== "viewing-disposed"
              }
        );
        expect(coordinator.activeSession()).toBeUndefined();
        expect(published).not.toHaveBeenCalled();
        expect(request.mock.calls.map(([next]) => next.kind)).toEqual([
          "openSession",
          ...(modeConflict ? [] : ["previewStep", ...(failure === "draft" ? ["applyDraft", "previewStep"] : [])]),
          "closeSession"
        ]);
        expect(request.mock.calls.at(-1)?.[0]).toEqual({
          kind: "closeSession",
          sessionId: "retry-1",
          revision: metadata.revision
        });
        expect(stored[key]).toEqual(saved);
        expect(JSON.stringify(stored)).toBe(savedBytes);
        expect(workspaceState.update).not.toHaveBeenCalled();
        expect(wireValid.every(Boolean)).toBe(true);
        if (modeConflict) {
          expect(warning).not.toHaveBeenCalled();
          if (failure === "viewing-cancelled" || failure === "viewing-disposed") return;
          if (reopened.kind !== "error") throw new Error("Expected the saved-cleaning mode conflict.");
          if (failure === "viewing-readonly") {
            expect(reopened.message).toContain("supports Viewing only");
            expect(reopened.message).not.toMatch(/StartMode|reopen.*Editing/u);
            return;
          }
          expect(reopened.message).toContain(`openWrangler.${notebookSource ? "notebookStartMode" : "fileStartMode"}`);
          expect(reopened.message).toContain("close this Open Wrangler panel");
          expect(reopened.message).toContain("reopen the same dataframe");
        }
        fail = false;
        reopened = await bridge.request({ ...opening, mode: "editing" });
      }
      if (reopened.kind !== "sessionOpened") throw new Error("Expected recovery or retry to open.");
      const expectedCleaning = failure === "reset" ? { steps: [] } : savedCleaning;
      expect(reopened.metadata).toMatchObject(expectedCleaning);
      expect(reopened.metadata.mode).toBe("editing");
      expect(reopened.metadata.draftStep).toEqual(failure === "reset" ? undefined : savedCleaning.draftStep);
      await bridge.updateViewState?.(reopened.metadata.sessionId, {
        columnWidths: new Map([["c:sales", 180]]),
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      });
      await expect(
        bridge.request({
          kind: "getPage",
          sessionId: reopened.metadata.sessionId,
          revision: reopened.metadata.revision,
          viewRequestId: "retry-sort",
          offset: 0,
          limit: 2,
          columnOffset: 0,
          columnLimit: 2,
          filterModel: { filters: [], sort: [{ column: "sales", direction: "desc", nulls: "last" }] }
        })
      ).resolves.toMatchObject({ kind: "page" });
      expect(new SessionPersistenceStore(workspaceState).load(opening.source, backend)?.cleaning).toMatchObject(
        expectedCleaning
      );
      expect(wireValid.every(Boolean)).toBe(true);
      expect(opens).toBe(2);
      expect(warning).toHaveBeenCalledTimes(modeConflict ? 0 : 1);
    } finally {
      subscription.dispose();
      cancellation.dispose();
      warning.mockRestore();
      await coordinator.shutdown();
      if (notebookSource) setOpenNotebookDocuments();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "reset",
    "dismiss",
    "cancel",
    "newer-plan",
    "open-error",
    "source-mismatch",
    "detached",
    "read-fault",
    "factory-cancel",
    "source-replacement",
    "save-fault"
  ] as const)("uses a fresh native R file delegate for saved-plan %s", async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-r-file-reset-"));
    const sourcePath = join(directory, "source.csv");
    await writeFile(sourcePath, "sales,units\n2,20\n1,10\n");
    const opening = { ...openRequest, backend: "r" as const, source: { ...openRequest.source, path: sourcePath } };
    const initial = presentationOpenedResponse();
    initial.metadata = { ...initial.metadata, backend: "r", rLibrary: "base", source: opening.source };
    const saved = {
      ...serializePersistedSession(
        persistedSessionState(
          { ...initial.metadata, backend: "polars", steps: [inspectionStep] },
          { columnWidths: new Map(), viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
        )
      )!,
      backend: "r"
    };
    const key = persistenceKey(opening.source, "r");
    let stored: Record<string, unknown> = { [key]: saved };
    const workspaceState = {
      get: vi.fn(() => stored),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        if (outcome === "save-fault") throw new Error("Reset storage unavailable.");
        stored = value;
      }),
      keys: () => [SESSION_STORAGE_KEY]
    } as unknown as Memento;
    const coordinator = new SessionCoordinator(workspaceState);
    const cancellation = new vscode.CancellationTokenSource();
    let closed = false;
    const originalRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (closed) throw new Error("The managed R transport is disposed.");
      if (request.kind === "openSession") return initial;
      if (request.kind === "previewStep")
        return {
          kind: "error",
          code: "engine_error",
          message: "Saved plan no longer applies.",
          recoverable: true,
          sessionId: request.sessionId
        };
      if (request.kind === "closeSession") {
        closed = true;
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected original request: ${request.kind}`);
    });
    const settlement = deferred<void>();
    const disposeCandidate = vi.fn(async () => undefined);
    const candidateIdle = vi.fn();
    const candidateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        expect(request.source).toEqual(opening.source);
        expect(request.backend).toBe("r");
        if (outcome === "open-error")
          return { kind: "error", code: "engine_error", message: "Open failed.", recoverable: true };
        if (outcome === "detached")
          throw new DetachedBridgeRequestError("Held R open.", "timeout", true, settlement.promise);
        if (outcome === "source-replacement") {
          await rename(sourcePath, join(directory, "original.csv"));
          await writeFile(sourcePath, "sales,units\n200,20\n1,10\n");
        }
        if (outcome === "read-fault") {
          vi.mocked(workspaceState.get).mockImplementationOnce(() => {
            throw new Error("Opening storage fault.");
          });
          coordinator["persistence"].load(opening.source, "r");
        }
        return {
          ...initial,
          metadata: {
            ...initial.metadata,
            sessionId: "fresh-r-runtime",
            ...(outcome === "source-mismatch"
              ? { source: { ...opening.source, path: join(directory, "other.csv") } }
              : {})
          }
        };
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      if (request.kind === "getPage")
        return pageResponseForMetadata(request, { ...initial.metadata, sessionId: request.sessionId });
      throw new Error(`Unexpected fresh request: ${request.kind}`);
    });
    const candidate = { request: candidateRequest, onIdle: candidateIdle };
    const createRuntimeRecoveryDelegate = vi.fn(async () => {
      if (outcome === "factory-cancel") cancellation.cancel();
      return { delegate: candidate, dispose: disposeCandidate };
    });
    const warningWindow: {
      showWarningMessage(
        message: string,
        options: vscode.MessageOptions,
        ...items: string[]
      ): Thenable<string | undefined>;
    } = vscode.window;
    const warning = vi
      .spyOn(warningWindow, "showWarningMessage")
      .mockImplementation(async (_message, _options, ...items) => {
        expect(closed).toBe(true);
        if (outcome === "cancel") cancellation.cancel();
        if (outcome === "newer-plan") stored = { [key]: { ...saved, cleaning: { steps: [] } } };
        return outcome === "dismiss" ? undefined : items[0];
      });
    const bridge = coordinator.createBridge({
      request: originalRequest,
      ...{ supportsVerifiedRuntimeRecoveryDelegate: true, createRuntimeRecoveryDelegate }
    });
    try {
      const result = await bridge.request(opening, { cancellation: cancellation.token });
      expect(originalRequest.mock.calls.map(([request]) => request.kind)).toEqual([
        "openSession",
        "previewStep",
        "closeSession"
      ]);
      expect(
        warning.mock.calls.filter(([, , ...items]) => items.includes("Open Original and Reset Plan"))
      ).toHaveLength(1);
      const neverCreated = ["dismiss", "cancel", "newer-plan"].includes(outcome);
      expect(createRuntimeRecoveryDelegate).toHaveBeenCalledTimes(neverCreated ? 0 : 1);
      if (outcome === "reset") {
        expect(result.kind).toBe("sessionOpened");
        if (result.kind !== "sessionOpened") throw new Error("Expected fresh original R file.");
        const current = coordinator["sessions"].get(result.metadata.sessionId)!;
        expect(current.delegate).toBe(candidate);
        expect(current.sourceSchema).toEqual(initial.metadata.schema);
        expect(current.sourceSchema).not.toBe(initial.metadata.schema);
        expect(result.metadata.steps).toEqual([]);
        expect(coordinator["persistence"].load(opening.source, "r")?.cleaning.steps).toEqual([]);
        await expect(
          bridge.request({
            kind: "getPage",
            sessionId: result.metadata.sessionId,
            revision: result.metadata.revision,
            viewRequestId: "after-reset",
            offset: 0,
            limit: 2,
            columnOffset: 0,
            columnLimit: 2,
            filterModel: result.metadata.filterModel
          })
        ).resolves.toMatchObject({ kind: "page" });
        expect(disposeCandidate).not.toHaveBeenCalled();
        expect(candidateIdle).not.toHaveBeenCalled();
      } else {
        expect(result.kind).toBe(outcome === "cancel" || outcome === "factory-cancel" ? "cancelled" : "error");
        expect(coordinator.activeSession()).toBeUndefined();
        expect(stored[key]).toEqual(
          outcome === "newer-plan" || outcome === "read-fault"
            ? { ...saved, ...(outcome === "read-fault" ? { rLibrary: "base" } : {}), cleaning: { steps: [] } }
            : saved
        );
        if (outcome === "read-fault" || outcome === "save-fault") expect(workspaceState.update).toHaveBeenCalled();
        else expect(workspaceState.update).not.toHaveBeenCalled();
        if (outcome === "factory-cancel") expect(candidateRequest).not.toHaveBeenCalled();
        if (outcome === "detached") {
          expect(disposeCandidate).not.toHaveBeenCalled();
          settlement.resolve();
          await coordinator["runtimeCleanup"].waitForTracked();
        }
        expect(disposeCandidate).toHaveBeenCalledTimes(neverCreated || outcome === "read-fault" ? 0 : 1);
        if (outcome === "read-fault") {
          expect(candidateRequest.mock.calls.map(([request]) => request.kind)).toEqual(["openSession", "closeSession"]);
          expect(candidateIdle).toHaveBeenCalledOnce();
        }
      }
    } finally {
      settlement.resolve();
      warning.mockRestore();
      cancellation.dispose();
      await coordinator.shutdown();
      if (outcome === "reset") {
        expect(candidateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(1);
        expect(candidateIdle).toHaveBeenCalledOnce();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])("keeps the latest live presentation after failed saves (overlapping: %s)", async (overlap) => {
    const runtimeOpened = presentationOpenedResponse();
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "units", direction: "desc", nulls: "last" }]
    };
    let stored: Record<string, unknown> = {};
    let fail = false;
    let failedWrites = 0;
    const firstWriteStarted = rejectingDeferred<void>();
    const releaseFirstWrite = rejectingDeferred<void>();
    const workspaceState = {
      get: vi.fn((_key: string, fallback?: unknown) => stored ?? fallback),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        if (fail) {
          if (++failedWrites === 1) {
            firstWriteStarted.resolve(undefined);
            await releaseFirstWrite.promise;
          }
          throw new Error("ordinary presentation storage unavailable");
        }
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const diagnosticSink = vi.fn();
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    warning.mockClear();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      expect(isOpenWranglerRequest(request)).toBe(true);
      let response: OpenWranglerResponse;
      if (request.kind === "openSession") response = runtimeOpened;
      else if (request.kind === "getPage") response = pageResponseForMetadata(request, runtimeOpened.metadata);
      else if (request.kind === "closeSession") response = { kind: "sessionClosed", sessionId: request.sessionId };
      else throw new Error(`Unexpected presentation recovery request: ${request.kind}`);
      expect(isOpenWranglerResponse(response)).toBe(true);
      return response;
    });
    const coordinator = new SessionCoordinator(workspaceState, diagnosticSink);
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const notifiedScrolls: number[] = [];
    const subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      if (snapshot) notifiedScrolls.push(snapshot.viewState.viewport.scrollLeft);
    });
    const view = (scrollLeft: number): GridViewState => ({
      selectedColumnId: scrollLeft === 10 ? "c:units" : "c:sales",
      columnWidths: new Map([["c:sales", 100 + scrollLeft]]),
      viewport: { firstVisibleRow: scrollLeft === 10 ? 0 : 1, scrollLeft }
    });
    try {
      const opened = await bridge.request(openRequest);
      if (opened.kind !== "sessionOpened") throw new Error("Expected the presentation session to open.");
      const sessionId = opened.metadata.sessionId;
      await expect(
        bridge.request({
          kind: "getPage",
          sessionId,
          revision: 0,
          viewRequestId: "confirmed-sort",
          filterModel,
          offset: 0,
          limit: 2,
          columnOffset: 0,
          columnLimit: 2
        })
      ).resolves.toMatchObject({ kind: "page", metadata: { filterModel } });
      await bridge.updateViewState?.(sessionId, view(10));
      const durableBefore = structuredClone(stored);
      notifiedScrolls.length = 0;
      fail = true;
      const first = bridge.updateViewState?.(sessionId, view(20));
      await firstWriteStarted.promise;
      let second = overlap ? bridge.updateViewState?.(sessionId, view(30)) : undefined;
      releaseFirstWrite.resolve(undefined);
      await first;
      if (!overlap) second = bridge.updateViewState?.(sessionId, view(30));
      await second;

      expect(bridge.getViewState?.(sessionId)).toEqual(view(30));
      expect(coordinator.activeSession()).toMatchObject({
        metadata: { revision: 0, steps: [], filterModel },
        viewState: { ...view(30), filterModel }
      });
      expect(stored).toEqual(durableBefore);
      expect(new SessionPersistenceStore(workspaceState).load(openRequest.source, "polars")).toMatchObject({
        cleaning: { steps: [] },
        view: { ...view(10), filterModel }
      });
      expect(failedWrites).toBe(2);
      expect(diagnosticSink.mock.calls).toEqual([["Open Wrangler workspace persistence ordinary save failed: Error"]]);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(notifiedScrolls).toEqual(overlap ? [30] : [20]);

      fail = false;
      await bridge.request({ kind: "closeSession", sessionId, revision: 0 });
      const reopened = await bridge.request(openRequest);
      if (reopened.kind !== "sessionOpened") throw new Error("Expected the presentation session to reopen.");
      expect(bridge.getViewState?.(reopened.metadata.sessionId)).toEqual(view(10));
      expect(stored).toEqual(durableBefore);
      await bridge.updateViewState?.(reopened.metadata.sessionId, view(30));
      expect(bridge.getViewState?.(reopened.metadata.sessionId)).toEqual(view(30));
      expect(new SessionPersistenceStore(workspaceState).load(openRequest.source, "polars")).toMatchObject({
        cleaning: { steps: [] },
        view: { ...view(30), filterModel }
      });
      expect(diagnosticSink).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirstWrite.resolve(undefined);
      subscription.dispose();
      await coordinator.shutdown();
      expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(
        delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession").length
      );
      expect(coordinator.diagnostics().sessionCount).toBe(0);
      warning.mockRestore();
    }
  });

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
    expect(coordinator.activeSession()?.viewState.viewport.scrollLeft).toBe(40);
    expect(
      new SessionPersistenceStore(workspaceState).load(openRequest.source, "polars")?.view?.viewport.scrollLeft
    ).toBe(30);

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

  it.each(["read", "stage", "final", "cancellation", "late-cancellation"] as const)(
    "settles the live-mode %s transition",
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
      const cancellationWrite =
        failurePoint === "cancellation" ? 1 : failurePoint === "late-cancellation" ? 2 : undefined;
      const pendingWrite = deferred<void>();
      let cancelled = false;
      const cancellation: CancellationTokenLike = {
        get isCancellationRequested() {
          return cancelled;
        },
        onCancellationRequested: () => ({ dispose() {} })
      };
      const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
        const attempt = update.mock.calls.length;
        if ((failurePoint === "stage" && attempt === 1) || (failurePoint === "final" && attempt === 2)) {
          throw new Error(`${failurePoint} mode persistence unavailable`);
        }
        if (attempt === cancellationWrite) await pendingWrite.promise;
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
      let replacement: Promise<OpenWranglerResponse> | undefined;
      try {
        const opened = await bridge.request({ ...openRequest, source, mode: "viewing" });
        if (opened.kind !== "sessionOpened") throw new Error("Expected the live-mode session to open.");
        const before = coordinator.activeSession();
        if (!before) throw new Error("Expected the original live-mode session.");
        if (cancellationWrite !== undefined) {
          const saved = serializePersistedSession(persistedSessionState(before.metadata, before.viewState));
          expect(saved).toBeDefined();
          stored = { [persistenceKey(source, before.metadata.backend)]: saved };
        }
        const previousStored = structuredClone(stored);
        let expectedCurrent = before;

        replacement = bridge.reconfigureLiveSessionMode!(
          opened.metadata.sessionId,
          opened.metadata.revision,
          "editing",
          {
            selectedColumnId: undefined,
            columnWidths: new Map(),
            viewport: { firstVisibleRow: 0, scrollLeft: 71 }
          },
          { cancellation }
        );

        if (cancellationWrite !== undefined) {
          await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(cancellationWrite));
          expect(update.mock.calls[0]?.[1][persistenceKey(source, before.metadata.backend)]).toHaveProperty(
            "pendingRuntimeReplacement"
          );
          expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "getPage")).toHaveLength(1);
          if (failurePoint === "late-cancellation") {
            const published = coordinator.activeSession();
            if (!published) throw new Error("Expected the published live-mode replacement.");
            expect(published).toMatchObject({
              sessionId: before.sessionId,
              metadata: { mode: "editing", revision: opened.metadata.revision + 1, source },
              viewState: { viewport: { firstVisibleRow: 0, scrollLeft: 71 } }
            });
            expectedCurrent = published;
          } else expect(coordinator.activeSession()).toEqual(before);
          expect(closedRuntimeIds).toEqual([]);
          cancelled = true;
          pendingWrite.resolve();
        }

        const response = await replacement;
        expect(response).toMatchObject(
          failurePoint === "cancellation"
            ? { kind: "cancelled", targetRequestId: `editing-mode:${opened.metadata.sessionId}` }
            : failurePoint === "late-cancellation"
              ? { kind: "sessionOpened", metadata: expectedCurrent.metadata }
              : { kind: "error", code: "persistence_unavailable", recoverable: true }
        );
        expect(coordinator.activeSession()).toEqual(expectedCurrent);
        if (failurePoint === "late-cancellation") {
          expect(closedRuntimeIds).toEqual(["runtime-old"]);
          expect(stored).toEqual({
            [persistenceKey(source, expectedCurrent.metadata.backend)]: serializePersistedSession(
              persistedSessionState(expectedCurrent.metadata, expectedCurrent.viewState)
            )
          });
        } else {
          expect(closedRuntimeIds).toHaveLength(1);
          expect(closedRuntimeIds).not.toContain("runtime-old");
        }
        if (failurePoint === "cancellation") {
          expect(coordinator.diagnostics().sessions).toEqual([
            expect.objectContaining({ runtimeId: "runtime-old", publicRevision: opened.metadata.revision })
          ]);
          expect(stored).toEqual(previousStored);
        }
      } finally {
        pendingWrite.resolve();
        await replacement?.catch(() => undefined);
        await coordinator.shutdown();
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

describe("SessionCoordinator R library copies", () => {
  it.each([
    ["rInteractiveVariable", "active"],
    ["rInteractiveVariable", "pending"],
    ["documentVariable", "active"],
    ["documentVariable", "pending"]
  ] as const)("keeps independent %s copy families separate from an %s target", async (kind, state) => {
    const coordinator = new SessionCoordinator();
    const document = {
      uri: vscode.Uri.parse("untitled:copy-family.R"),
      isClosed: false,
      version: 1
    } as vscode.TextDocument;
    const source: SessionSource = {
      kind,
      label: "df",
      variableName: "df",
      ...(kind === "documentVariable" ? { uri: document.uri.toString() } : {})
    };
    const opening = {
      ...openRequest,
      source,
      backend: "r" as const,
      rLibrary: "base" as const,
      mode: "viewing" as const,
      pageSize: 100,
      columnLimit: 100
    };
    const copyRequest = { ...opening, rLibrary: "dplyr" as const, mode: "editing" as const };
    const released = deferred<void>();
    const entered = deferred<void>();
    const contract = rKernelFrameContract();
    if (kind === "documentVariable") setOpenTextDocuments(document);
    const openFamily = async (waitForCopy: boolean) => {
      const transport = fakeRKernelTransport(contract);
      transport.open.mockImplementation(async (_name, page, options) => {
        if (waitForCopy && options?.library === "dplyr") {
          entered.resolve();
          await released.promise;
        }
        return {
          sessionId: options!.requestedSessionId!,
          library: options!.library!,
          exportFormats: ["csv"],
          page: {
            ...contract,
            page: {
              ...contract.page,
              offset: page.rowOffset,
              limit: page.rowLimit,
              columnOffset: page.columnOffset,
              columnLimit: page.columnLimit
            }
          }
        };
      });
      transport.getPage.mockImplementation(async (_id, page) => ({
        ...contract,
        page: {
          ...contract.page,
          offset: page.rowOffset,
          limit: page.rowLimit,
          columnOffset: page.columnOffset,
          columnLimit: page.columnLimit
        }
      }));
      const delegate = new RKernelBridge({ subscriptions: [] } as unknown as vscode.ExtensionContext, transport);
      const bridge = coordinator.createBridge(
        delegate,
        kind === "documentVariable" ? { kind: "textDocument", document, version: document.version } : undefined
      );
      const opened = await bridge.request(opening);
      if (opened.kind !== "sessionOpened") throw new Error(JSON.stringify(opened));
      const capture = bridge.captureRLibraryCopy!(opened.metadata.sessionId, opened.metadata.revision);
      if ("kind" in capture) throw new Error(capture.message);
      return { bridge, capture, transport };
    };
    let firstCopy: Promise<OpenWranglerResponse> | undefined;
    try {
      const first = await openFamily(state === "pending");
      const second = await openFamily(false);
      firstCopy = first.capture.createBridge("dplyr").request(copyRequest);
      if (state === "pending") await entered.promise;
      else await expect(firstCopy).resolves.toMatchObject({ kind: "sessionOpened" });
      await expect(first.capture.createBridge("dplyr").request(copyRequest)).resolves.toMatchObject({
        kind: "error",
        code: "r_library_target_occupied"
      });
      const ordinary = await second.bridge.request(copyRequest);
      expect(ordinary).toMatchObject({ kind: "sessionOpened", metadata: { rLibrary: "dplyr" } });
      if (ordinary.kind !== "sessionOpened") throw new Error(JSON.stringify(ordinary));
      await second.bridge.request({
        kind: "closeSession",
        sessionId: ordinary.metadata.sessionId,
        revision: ordinary.metadata.revision
      });
      await expect(second.capture.createBridge("dplyr").request(copyRequest)).resolves.toMatchObject({
        kind: "sessionOpened",
        metadata: { rLibrary: "dplyr", mode: "editing" }
      });
      released.resolve();
      await expect(firstCopy).resolves.toMatchObject({ kind: "sessionOpened", metadata: { rLibrary: "dplyr" } });
      for (const family of [first, second]) {
        const initialId = family.transport.open.mock.calls[0]?.[2]?.requestedSessionId;
        const cloned = family.transport.open.mock.calls.find(([, , options]) => options?.cloneFrom);
        expect(cloned?.[2]?.cloneFrom).toEqual({ sessionId: initialId, revision: 0 });
      }
      expect(coordinator.diagnostics().sessionCount).toBe(4);
    } finally {
      released.resolve();
      await firstCopy;
      await coordinator.shutdown();
      if (kind === "documentVariable") setOpenTextDocuments();
    }
  });

  it("rejects a valid ordinary page from another R library without changing confirmed state", async () => {
    const fixture = await rLibraryCopyFixture("editing");
    try {
      const before = fixture.snapshot();
      fixture.driftOnPage = true;
      await expect(
        fixture.bridge.request({
          kind: "getPage",
          sessionId: fixture.original.metadata.sessionId,
          revision: 0,
          viewRequestId: "wrong-library",
          filterModel: fixture.original.metadata.filterModel,
          offset: 0,
          limit: 2,
          columnOffset: 0,
          columnLimit: 16
        })
      ).resolves.toMatchObject({
        kind: "error",
        code: "invalid_runtime_response",
        message: expect.stringContaining("confirmed R library")
      });
      expect(fixture.snapshot()).toEqual(before);
      expect(fixture.idle).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
  it("keeps an R library copy current while its original serves a read-only page", async () => {
    const fixture = await rLibraryCopyFixture("editing");
    const copyEntered = deferred<void>();
    const copyReleased = deferred<void>();
    const pageEntered = deferred<void>();
    const pageReleased = deferred<void>();
    let page: Promise<OpenWranglerResponse> | undefined;
    let opening: Promise<OpenWranglerResponse> | undefined;
    try {
      fixture.beforeCopyOpen = async () => {
        copyEntered.resolve();
        await copyReleased.promise;
      };
      fixture.beforeOriginalPage = async () => {
        pageEntered.resolve();
        await pageReleased.promise;
      };
      const original = fixture.snapshot();
      opening = fixture.capture().createBridge("dplyr").request(fixture.copyRequest);
      await copyEntered.promise;
      page = fixture.bridge.request({
        kind: "getPage",
        sessionId: fixture.original.metadata.sessionId,
        revision: 0,
        viewRequestId: "original-projection-during-copy",
        filterModel: fixture.original.metadata.filterModel,
        offset: 0,
        limit: 2,
        columnOffset: 0,
        columnLimit: 16
      });
      await pageEntered.promise;
      copyReleased.resolve();
      const result = await opening;
      expect(result, result.kind === "error" ? `${result.code}: ${result.message}` : undefined).toMatchObject({
        kind: "sessionOpened",
        metadata: { rLibrary: "dplyr", steps: original.metadata.steps }
      });
      expect(fixture.snapshot()).toEqual(original);
      pageReleased.resolve();
      await expect(page).resolves.toMatchObject({ kind: "page", revision: 0 });
      expect(fixture.idle).not.toHaveBeenCalled();
    } finally {
      copyReleased.resolve();
      pageReleased.resolve();
      await opening;
      await page;
      await fixture.close();
    }
  });

  it.each([
    { state: "active", priority: "interactive" },
    { state: "queued", priority: "interactive" },
    { state: "active", priority: "background" },
    { state: "queued", priority: "background" }
  ] as const)("rejects an R library copy during an original $state $priority mutation", async ({ state, priority }) => {
    const fixture = await rLibraryCopyFixture("editing");
    const copyEntered = deferred<void>();
    const copyReleased = deferred<void>();
    const pageEntered = deferred<void>();
    const pageReleased = deferred<void>();
    const mutationEntered = deferred<void>();
    const mutationReleased = deferred<void>();
    let opening: Promise<OpenWranglerResponse> | undefined;
    let page: Promise<OpenWranglerResponse> | undefined;
    let mutation: Promise<OpenWranglerResponse> | undefined;
    try {
      fixture.beforeCopyOpen = async () => {
        copyEntered.resolve();
        await copyReleased.promise;
      };
      fixture.beforeOriginalPage = async () => {
        pageEntered.resolve();
        await pageReleased.promise;
      };
      fixture.beforeOriginalMutation = async () => {
        mutationEntered.resolve();
        await mutationReleased.promise;
      };
      const original = fixture.snapshot();
      opening = fixture.capture().createBridge("dplyr").request(fixture.copyRequest);
      await copyEntered.promise;
      if (state === "queued") {
        page = fixture.bridge.request({
          kind: "getPage",
          sessionId: fixture.original.metadata.sessionId,
          revision: 0,
          viewRequestId: "read-before-original-mutation",
          filterModel: fixture.original.metadata.filterModel,
          offset: 0,
          limit: 2,
          columnOffset: 0,
          columnLimit: 16
        });
        await pageEntered.promise;
      }
      mutation = fixture.bridge.request(
        {
          kind: "applyDraft",
          sessionId: fixture.original.metadata.sessionId,
          revision: 0,
          offset: 0,
          limit: 2,
          columnOffset: 0,
          columnLimit: 16
        },
        { priority }
      );
      if (state === "active") await mutationEntered.promise;
      else
        expect(fixture.coordinator.testingSessionSchedulerState(fixture.original.metadata.sessionId)).toMatchObject({
          [priority === "interactive" ? "interactiveQueueLength" : "backgroundQueueLength"]: 1
        });
      copyReleased.resolve();
      await expect(opening).resolves.toMatchObject({ kind: "error", code: "file_plan_changed", recoverable: true });
      expect(fixture.snapshot()).toEqual(original);
      expect(fixture.coordinator.diagnostics().sessionCount).toBe(1);
      expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
      const candidateId = fixture.request.mock.calls
        .map(([request]) => request)
        .filter((request) => request.kind === "openSession")
        .find((request) => request.rLibrary === "dplyr")?.requestedSessionId;
      expect(candidateId).toEqual(expect.any(String));
      expect(
        fixture.request.mock.calls
          .map(([request]) => request)
          .filter((request) => request.kind === "closeSession")
          .map((request) => request.sessionId)
      ).toEqual([candidateId]);
      expect(fixture.idle).not.toHaveBeenCalled();
    } finally {
      copyReleased.resolve();
      pageReleased.resolve();
      mutationReleased.resolve();
      await Promise.all([opening, page, mutation]);
      await fixture.close();
    }
  });

  it.each(["editing", "viewing"] as const)(
    "copies the captured %s source and applied plan without retiring its original work",
    async (mode) => {
      const fixture = await rLibraryCopyFixture(mode);
      try {
        const original = fixture.snapshot();
        const copy = fixture.capture();
        expect(copy.rerunsCustomCode).toBe(mode === "editing");
        const result = await copy.createBridge("dplyr").request(fixture.copyRequest);
        expect(result).toMatchObject({
          kind: "sessionOpened",
          metadata: { rLibrary: "dplyr", mode: "editing", steps: original?.metadata.steps }
        });
        if (result.kind !== "sessionOpened") throw new Error("Expected an editing copy");
        expect(result.metadata.draftStep).toBeUndefined();
        expect(result.metadata.canRedo).not.toBe(true);
        expect(fixture.coordinator.sessionSnapshot(fixture.original.metadata.sessionId)).toEqual(original);
        const opening = fixture.request.mock.calls
          .map(([request]) => request)
          .find((request) => request.kind === "openSession" && request.rLibrary === "dplyr");
        expect(opening).toMatchObject({
          source: fixture.source,
          cloneFrom: { sessionId: "original-runtime", revision: 0 },
          mode: "editing"
        });
        expect(fixture.stored[fixture.targetKey]).toMatchObject({
          rLibrary: "dplyr",
          cleaning: { steps: original?.metadata.steps }
        });
        const closing = mode === "editing" ? fixture.original : result;
        const remaining = mode === "editing" ? result : fixture.original;
        await fixture.bridge.request({
          kind: "closeSession",
          sessionId: closing.metadata.sessionId,
          revision: closing.metadata.revision
        });
        expect(fixture.idle).not.toHaveBeenCalled();
        await expect(
          fixture.bridge.request({
            kind: "getPage",
            sessionId: remaining.metadata.sessionId,
            revision: remaining.metadata.revision,
            viewRequestId: "remaining-sibling",
            filterModel: remaining.metadata.filterModel,
            offset: 0,
            limit: 2,
            columnOffset: 0,
            columnLimit: 16
          })
        ).resolves.toMatchObject({ kind: "page", metadata: { rLibrary: remaining.metadata.rLibrary } });
      } finally {
        await fixture.close();
      }
    }
  );

  it.each(["saved", "active", "pending", "origin retired"] as const)(
    "refuses an occupied or stale copy target: %s",
    async (conflict) => {
      const fixture = await rLibraryCopyFixture("editing");
      const released = deferred<void>();
      const entered = deferred<void>();
      try {
        const capture = fixture.capture();
        if (conflict === "saved") fixture.stored[fixture.targetKey] = { malformed: "still user-owned" };
        if (conflict === "active")
          await fixture.coordinator.createBridge({ request: fixture.request }).request(fixture.copyRequest);
        if (conflict === "origin retired")
          await fixture.bridge.request({
            kind: "closeSession",
            sessionId: fixture.original.metadata.sessionId,
            revision: 0
          });
        if (conflict === "origin retired") {
          expect(() => capture.createBridge("dplyr")).toThrow(/original session changed/u);
          return;
        }
        const before = structuredClone(fixture.stored);
        if (conflict === "pending") {
          fixture.beforeCopyOpen = async () => {
            entered.resolve();
            await released.promise;
          };
          const first = capture.createBridge("dplyr").request(fixture.copyRequest);
          await entered.promise;
          await expect(capture.createBridge("dplyr").request(fixture.copyRequest)).resolves.toMatchObject({
            kind: "error",
            code: "r_library_target_occupied"
          });
          released.resolve();
          await expect(first).resolves.toMatchObject({ kind: "sessionOpened" });
        } else {
          await expect(capture.createBridge("dplyr").request(fixture.copyRequest)).resolves.toMatchObject({
            kind: "error",
            code: "r_library_target_occupied"
          });
          expect(fixture.stored).toEqual(before);
        }
      } finally {
        released.resolve();
        await fixture.close();
      }
    }
  );

  it.each(["explicit R", "Auto"] as const)(
    "rejects an ordinary %s open started before a copy reserved the same target, then publishes only the copy",
    async (choice) => {
      const fixture = await rLibraryCopyFixture("editing");
      const entered = deferred<void>();
      const released = deferred<void>();
      try {
        fixture.beforeCopyOpen = async () => {
          entered.resolve();
          await released.promise;
        };
        fixture.autoLibrary = "dplyr";
        const ordinaryRequest: Extract<OpenWranglerRequest, { kind: "openSession" }> = { ...fixture.copyRequest };
        if (choice === "Auto") {
          delete ordinaryRequest.backend;
          delete ordinaryRequest.rLibrary;
        }
        const normal = fixture.coordinator.createBridge({ request: fixture.request }).request(ordinaryRequest);
        await entered.promise;
        const copy = fixture.capture().createBridge("dplyr").request(fixture.copyRequest);
        released.resolve();
        await expect(normal).resolves.toMatchObject({ kind: "error", code: "r_library_target_occupied" });
        await expect(copy).resolves.toMatchObject({ kind: "sessionOpened", metadata: { rLibrary: "dplyr" } });
        expect(fixture.coordinator.diagnostics().sessionCount).toBe(2);
        expect(fixture.idle).not.toHaveBeenCalled();
      } finally {
        released.resolve();
        await fixture.close();
      }
    }
  );

  it("closes only the failed copy when replay changes the confirmed R library", async () => {
    const fixture = await rLibraryCopyFixture("editing");
    try {
      fixture.driftOnPreview = true;
      const before = fixture.snapshot();
      await expect(fixture.capture().createBridge("dplyr").request(fixture.copyRequest)).resolves.toMatchObject({
        kind: "error",
        code: "file_plan_replay_failed"
      });
      expect(fixture.coordinator.sessionSnapshot(fixture.original.metadata.sessionId)).toEqual(before);
      expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
      expect(fixture.idle).not.toHaveBeenCalled();
      expect(fixture.coordinator.diagnostics().sessionCount).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it.each(["cancel", "close original"] as const)(
    "retires a pending candidate when its captured owner changes: %s",
    async (action) => {
      const fixture = await rLibraryCopyFixture("editing");
      const entered = deferred<void>();
      const released = deferred<void>();
      const cancellation = new vscode.CancellationTokenSource();
      try {
        fixture.beforeCopyOpen = async () => {
          entered.resolve();
          await released.promise;
        };
        const opening = fixture
          .capture()
          .createBridge("dplyr")
          .request(fixture.copyRequest, { cancellation: cancellation.token });
        await entered.promise;
        if (action === "cancel") cancellation.cancel();
        else
          await fixture.bridge.request({
            kind: "closeSession",
            sessionId: fixture.original.metadata.sessionId,
            revision: 0
          });
        expect(fixture.idle).not.toHaveBeenCalled();
        released.resolve();
        await expect(opening).resolves.toMatchObject({ kind: action === "cancel" ? "cancelled" : "error" });
        expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
        expect(fixture.coordinator.diagnostics().sessionCount).toBe(action === "cancel" ? 1 : 0);
        const closed = fixture.request.mock.calls
          .map(([request]) => request)
          .filter((request) => request.kind === "closeSession");
        expect(closed).toHaveLength(action === "cancel" ? 1 : 2);
      } finally {
        released.resolve();
        cancellation.dispose();
        await fixture.close();
      }
    }
  );
});

async function rLibraryCopyFixture(mode: "editing" | "viewing") {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-r-library-copy-"));
  const sourcePath = join(directory, "source.csv");
  await writeFile(sourcePath, "value\n1\n2\n");
  const source: SessionSource = {
    kind: "file",
    label: "source.csv",
    path: sourcePath,
    uri: vscode.Uri.file(sourcePath).toString()
  };
  const controls = {
    stored: {} as Record<string, unknown>,
    beforeCopyOpen: undefined as (() => Promise<void>) | undefined,
    beforeOriginalPage: undefined as (() => Promise<void>) | undefined,
    beforeOriginalMutation: undefined as (() => Promise<void>) | undefined,
    driftOnPreview: false,
    driftOnPage: false,
    autoLibrary: undefined as SessionMetadata["rLibrary"]
  };
  const coordinator = new SessionCoordinator({
    get: <T>() => controls.stored as T,
    update: async (_key, value) => {
      controls.stored = value;
    },
    keys: () => [SESSION_STORAGE_KEY]
  });
  const sessions = new Map<string, SessionMetadata>();
  let ordinal = 0;
  const idle = vi.fn();
  const request = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
    if (request.kind === "openSession") {
      const library = request.rLibrary ?? (request.backend === undefined ? controls.autoLibrary : undefined) ?? "base";
      if (library === "dplyr") await controls.beforeCopyOpen?.();
      const id = request.requestedSessionId ?? (++ordinal === 1 ? "original-runtime" : `runtime-${ordinal}`);
      const metadata = metadataFor({ runtimeId: id, source: request.source, backend: "r" });
      metadata.rLibrary = library;
      metadata.mode = request.mode ?? "editing";
      metadata.capabilities.editable = metadata.mode === "editing";
      if (id === "original-runtime" && mode === "editing") {
        metadata.steps = [{ id: "custom", kind: "customCode", params: { code: "df" } }];
        metadata.latestStepInputSchema = metadata.schema;
        metadata.draftStep = {
          id: "draft",
          kind: "roundNumber",
          params: { column: { id: "c:value", name: "value" }, decimals: 1 }
        };
        metadata.canRedo = true;
      }
      sessions.set(id, metadata);
      return openedFor(request, structuredClone(metadata));
    }
    if (!("sessionId" in request)) throw new Error("Expected session request");
    const metadata = sessions.get(request.sessionId)!;
    if (request.kind === "closeSession") {
      sessions.delete(request.sessionId);
      return { kind: "sessionClosed", sessionId: request.sessionId };
    }
    if (request.kind === "getPage") {
      if (request.sessionId === "original-runtime") await controls.beforeOriginalPage?.();
      return pageFor(request, {
        ...structuredClone(metadata),
        ...(controls.driftOnPage ? { rLibrary: "collapse" as const } : {})
      });
    }
    if (request.kind === "previewStep") {
      metadata.revision++;
      metadata.draftStep = request.step;
      const response = previewFor(request, structuredClone(metadata), "# selected library");
      if (controls.driftOnPreview) response.metadata.rLibrary = "collapse";
      return response;
    }
    if (request.kind === "applyDraft") {
      if (request.sessionId === "original-runtime") await controls.beforeOriginalMutation?.();
      metadata.revision++;
      metadata.steps.push(metadata.draftStep!);
      delete metadata.draftStep;
      metadata.latestStepInputSchema = metadata.schema;
      return appliedFor(request, structuredClone(metadata), "# selected library");
    }
    throw new Error(`Unexpected R copy request: ${request.kind}`);
  });
  const bridge = coordinator.createBridge({
    request,
    onIdle: idle,
    captureSessionOwner: (id) => {
      const owner = sessions.get(id);
      return owner ? () => sessions.get(id) === owner : undefined;
    }
  });
  const original = await bridge.request({ ...openRequest, source, backend: "r", rLibrary: "base", mode });
  if (original.kind !== "sessionOpened") throw new Error(JSON.stringify(original));
  return Object.assign(controls, {
    source,
    coordinator,
    bridge,
    request,
    idle,
    original,
    targetKey: persistenceKey(source, "r", "dplyr"),
    copyRequest: { ...openRequest, source, backend: "r" as const, rLibrary: "dplyr" as const },
    snapshot() {
      const snapshot = coordinator.sessionSnapshot(original.metadata.sessionId)!;
      return {
        ...snapshot,
        metadata: structuredClone(snapshot.metadata),
        viewState: structuredClone(snapshot.viewState)
      };
    },
    capture() {
      const captured = bridge.captureRLibraryCopy!(original.metadata.sessionId, 0);
      if ("kind" in captured) throw new Error(captured.message);
      return captured;
    },
    async close() {
      await coordinator.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

describe("SessionCoordinator file-plan reuse", () => {
  it.each(["ordinary", "detached"] as const)(
    "disposes only the abandoned R file target after %s close failure settles",
    async (failure) => {
      const fixture = await filePlanFixture(false, "r");
      const sample = rKernelFrameContract();
      const schema = ["value", "other"].map((name, position) => ({
        ...sample.schema[0],
        id: `r:c:${position}`,
        name,
        position
      }));
      const contract = {
        ...sample,
        schema,
        shape: { ...sample.shape, columns: 2 },
        page: {
          ...sample.page,
          limit: fixture.targetRequest.pageSize,
          columnLimit: fixture.targetRequest.columnLimit,
          columnIds: schema.map(({ id }) => id),
          rows: sample.page.rows.map((row) => ({ ...row, values: [row.values[0], row.values[0]] }))
        }
      };
      const transport = fakeRKernelTransport(contract);
      transport.open.mockImplementation(async (_variable, _page, options) => ({
        sessionId: options!.requestedSessionId!,
        page: contract,
        exportFormats: ["csv"],
        library: "base"
      }));
      transport.previewStep.mockRejectedValueOnce(
        new RKernelDiagnosticError({
          transportVersion: R_KERNEL_TRANSPORT_VERSION,
          requestId: "target-preview",
          kind: "error",
          code: "runtime_error",
          message: "target replay failed",
          recoverable: true
        })
      );
      const close = rejectingDeferred<void>();
      const settlement = deferred<void>();
      transport.close.mockImplementationOnce(() =>
        failure === "detached"
          ? Promise.reject(new DetachedBridgeRequestError("target close detached", "timeout", true, settlement.promise))
          : close.promise
      );
      const diagnostics = vi.fn();
      const target = new RKernelBridge(
        {} as vscode.ExtensionContext,
        transport,
        undefined,
        diagnostics,
        undefined,
        {},
        undefined,
        fixture.targetRequest.source
      );
      try {
        const pending = fixture.capture(target).bridge.request(fixture.targetRequest);
        await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(1));
        expect(transport.previewStep).toHaveBeenCalledTimes(1);
        expect(transport.dispose).not.toHaveBeenCalled();
        expect(fixture.coordinator.diagnostics().sessionCount).toBe(1);
        if (failure === "detached") settlement.resolve();
        else close.reject(new Error("target close failed"));
        await expect(pending).resolves.toMatchObject({ kind: "error", code: "file_plan_replay_failed" });
        await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledTimes(1));
        expect(fixture.coordinator.activeSession()?.sessionId).toBe(fixture.originId);
        expect(fixture.coordinator.sessionSnapshot(fixture.originId)).toEqual(fixture.originSnapshot);
        expect(fixture.stored[fixture.originKey]).toEqual(fixture.savedOrigin);
        expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
        expect(await readFile(fixture.originPath, "utf8")).toBe("value,other\n1.2,10\n2.3,20\n");
        expect(await readFile(fixture.targetPath, "utf8")).toBe("value,other\n4.5,30\n6.7,40\n");
      } finally {
        close.resolve();
        settlement.resolve();
        await target.dispose();
        await fixture.close();
      }
    }
  );

  it.each(["compatible", "schema", "replay failure", "cancellation", "target replacement"] as const)(
    "reuses the exact active R file through a separate target delegate: %s",
    async (outcome) => {
      const fixture = await filePlanFixture(true, "r");
      const cancellation = new vscode.CancellationTokenSource();
      try {
        const captured = fixture.capture();
        if (outcome === "schema") fixture.targetSchemaMismatch = true;
        fixture.beforeTargetPreview = async () => {
          if (outcome === "cancellation") cancellation.cancel();
          if (outcome === "target replacement") fixture.targetRuntimeOwnerCurrent = false;
          if (outcome === "replay failure")
            return { kind: "error", code: "engine_error", message: "Cannot replay", recoverable: true };
          return undefined;
        };
        const result = await captured.bridge.request(fixture.targetRequest, { cancellation: cancellation.token });
        if (outcome === "compatible") {
          expect(result).toMatchObject({
            kind: "sessionOpened",
            metadata: { backend: "r", source: fixture.targetRequest.source }
          });
          expect(fixture.coordinator.activeSession()?.metadata.schema.map(({ id, name }) => [id, name])).toEqual([
            ["r:c:0", "other"],
            ["r:c:1", "amount"],
            ["c:step:total:0", "total"]
          ]);
          expect(fixture.coordinator.activeSession()?.metadata.steps[1]).toMatchObject({
            params: { leftColumn: { id: "r:c:1", name: "amount" }, rightColumn: { id: "r:c:0", name: "other" } }
          });
          expect(fixture.coordinator.activeSession()?.code).toBe("# target.csv");
        } else {
          expect(result.kind).toBe(outcome === "cancellation" ? "cancelled" : "error");
          expect(fixture.coordinator.activeSession()?.sessionId).toBe(fixture.originId);
          expect(fixture.targetRequests.filter(({ kind }) => kind === "closeSession")).toHaveLength(1);
          expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
        }
        expect(fixture.coordinator.sessionSnapshot(fixture.originId)).toEqual(fixture.originSnapshot);
        expect(fixture.stored[fixture.originKey]).toEqual(fixture.savedOrigin);
        expect(await readFile(fixture.originPath, "utf8")).toBe("value,other\n1.2,10\n2.3,20\n");
        expect(await readFile(fixture.targetPath, "utf8")).toBe("other,value\n30,4.5\n40,6.7\n");
      } finally {
        cancellation.dispose();
        await fixture.close();
      }
    }
  );

  it.each([false, true])(
    "shows a copied plan without saving it until kept, with reordered input %s",
    async (reordered) => {
      const fixture = await filePlanFixture(reordered);
      try {
        const selected = fixture.capture();
        const result = await selected.bridge.request(fixture.targetRequest);
        expect(fixture.targetRequests.map((request) => request.kind)).toEqual([
          "openSession",
          "previewStep",
          "applyDraft",
          "previewStep",
          "applyDraft",
          "previewStep",
          "applyDraft",
          "getPage"
        ]);
        const copiedSteps: TransformStep[] = [
          {
            id: "rename-value",
            kind: "renameColumn",
            params: { column: { id: `c:source:${reordered ? 1 : 0}`, name: "value" }, newName: "amount" }
          },
          {
            id: "total",
            kind: "formula",
            params: {
              leftColumn: { id: `c:source:${reordered ? 1 : 0}`, name: "amount" },
              rightColumn: { id: `c:source:${reordered ? 0 : 1}`, name: "other" },
              operator: "add",
              newColumn: "total"
            }
          },
          { id: "floor-total", kind: "floorNumber", params: { column: { id: "c:step:total:0", name: "total" } } }
        ];
        expect(
          fixture.targetRequests.filter((request) => request.kind === "previewStep").map((request) => request.step)
        ).toEqual(copiedSteps);
        if (result.kind !== "sessionOpened") throw new Error(JSON.stringify(result));
        const targetId = result.metadata.sessionId;
        expect(result.metadata.source).toEqual(fixture.targetRequest.source);
        expect(result.metadata.steps).toEqual(copiedSteps);
        expect(result.metadata.schema.map((column) => [column.id, column.name])).toEqual([
          ["c:source:0", reordered ? "other" : "amount"],
          ["c:source:1", reordered ? "amount" : "other"],
          ["c:step:total:0", "total"]
        ]);
        expect(fixture.coordinator["sessions"].get(targetId)?.sourceSchema?.map((column) => column.name)).toEqual(
          reordered ? ["other", "value"] : ["value", "other"]
        );
        expect(targetId).not.toBe(fixture.originId);
        expect(fixture.coordinator.activeSession()?.sessionId).toBe(targetId);
        expect(selected.bridge.getSessionPresentation?.(targetId)).toMatchObject({ copiedPlanPending: true });
        await selected.bridge.updateViewState?.(targetId, {
          columnWidths: new Map([["c:source:0", 180]]),
          viewport: { firstVisibleRow: 1, scrollLeft: 0 }
        });
        expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
        expect(fixture.coordinator.sessionSnapshot(fixture.originId)).toEqual(fixture.originSnapshot);
        expect(fixture.stored[fixture.originKey]).toEqual(fixture.savedOrigin);

        await expect(selected.bridge.keepCopiedPlan!(targetId)).resolves.toBeUndefined();
        expect(fixture.stored[fixture.targetKey]).toMatchObject({
          cleaning: { steps: copiedSteps },
          view: { viewport: { firstVisibleRow: 1 } }
        });
        expect(selected.bridge.getSessionPresentation?.(targetId)).not.toHaveProperty("copiedPlanPending");
        await expect(selected.bridge.keepCopiedPlan!(targetId)).resolves.toBeUndefined();
        expect(fixture.coordinator.activeSession()?.code).toBe("# target.csv");
        await fixture.bridge.request({
          kind: "closeSession",
          sessionId: fixture.originId,
          revision: fixture.originSnapshot!.metadata.revision
        });
        await expect(
          selected.bridge.request({
            kind: "getPage",
            sessionId: targetId,
            revision: result.metadata.revision,
            offset: 0,
            limit: 10,
            columnOffset: 0,
            columnLimit: 16,
            viewRequestId: "independent-target",
            filterModel: { filters: [], sort: [] }
          })
        ).resolves.toMatchObject({ kind: "page" });
        expect(await readFile(fixture.originPath, "utf8")).toBe("value,other\n1.2,10\n2.3,20\n");
        expect(await readFile(fixture.targetPath, "utf8")).toBe(
          reordered ? "other,value\n30,4.5\n40,6.7\n" : "value,other\n4.5,30\n6.7,40\n"
        );
        expect(fixture.mappingRequests).toEqual([]);
      } finally {
        await fixture.close();
      }
    }
  );

  it("copies a plan onto a renamed column after the user matches it", async () => {
    const fixture = await filePlanFixture();
    try {
      fixture.targetColumnNames = ["other", "price"];
      fixture.chooseColumnMapping = async ({ unmatched, candidates }) => new Map([[unmatched[0].id, candidates[0].id]]);
      const selected = fixture.capture();
      const result = await selected.bridge.request(fixture.targetRequest);
      expect(fixture.mappingRequests).toEqual([
        {
          unmatched: [expect.objectContaining({ id: "c:source:0", name: "value" })],
          candidates: [expect.objectContaining({ id: "c:source:1", name: "price" })]
        }
      ]);
      if (result.kind !== "sessionOpened") throw new Error(JSON.stringify(result));
      const copiedSteps: TransformStep[] = [
        {
          id: "rename-value",
          kind: "renameColumn",
          params: { column: { id: "c:source:1", name: "price" }, newName: "amount" }
        },
        {
          id: "total",
          kind: "formula",
          params: {
            leftColumn: { id: "c:source:1", name: "amount" },
            rightColumn: { id: "c:source:0", name: "other" },
            operator: "add",
            newColumn: "total"
          }
        },
        fixture.steps[2]
      ];
      expect(result.metadata.steps).toEqual(copiedSteps);
      expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
      await expect(selected.bridge.keepCopiedPlan!(result.metadata.sessionId)).resolves.toBeUndefined();
      expect(fixture.stored[fixture.targetKey]).toMatchObject({ cleaning: { steps: copiedSteps } });
      expect(fixture.coordinator.sessionSnapshot(fixture.originId)).toEqual(fixture.originSnapshot);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    "saved target",
    "hard-link alias",
    "retired origin",
    "runtime replacement",
    "changed import options"
  ] as const)("refuses %s before opening a target runtime", async (failure) => {
    const fixture = await filePlanFixture();
    try {
      const selected = fixture.capture();
      const request = structuredClone(fixture.targetRequest);
      if (failure === "saved target") fixture.stored[fixture.targetKey] = { unknownWork: true };
      if (failure === "runtime replacement") fixture.runtimeOwnerCurrent = false;
      if (failure === "hard-link alias") {
        const alias = join(fixture.directory, "alias.csv");
        await link(fixture.originPath, alias);
        request.source = { kind: "file", label: "alias.csv", path: alias, uri: vscode.Uri.file(alias).toString() };
      }
      if (failure === "retired origin")
        await fixture.bridge.request({
          kind: "closeSession",
          sessionId: fixture.originId,
          revision: fixture.originSnapshot!.metadata.revision
        });
      if (failure === "changed import options") request.source.importOptions = { delimiter: ";" };
      await expect(selected.bridge.request(request)).resolves.toMatchObject({ kind: "error" });
      expect(fixture.targetRequests).toEqual([]);
      if (failure === "saved target") expect(fixture.stored[fixture.targetKey]).toEqual({ unknownWork: true });
      else expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    "schema",
    "ambiguous schema",
    "extra column",
    "declined mapping",
    "invalid mapping",
    "origin change during mapping",
    "incomplete plan",
    "page source drift",
    "unsupported operation",
    "target runtime unavailable",
    "target runtime replacement",
    "runtime refusal",
    "cancellation",
    "detached cancellation",
    "retired origin"
  ] as const)("abandons a private target on %s without replacing saved work", async (failure) => {
    const fixture = await filePlanFixture(failure === "schema");
    const cancellation = new vscode.CancellationTokenSource();
    const settlement = deferred<void>();
    try {
      const selected = fixture.capture();
      if (failure === "schema") fixture.targetSchemaMismatch = true;
      if (failure === "ambiguous schema") fixture.targetColumnNames = ["value", "value"];
      if (failure === "extra column") fixture.targetColumnNames = ["value", "other", "extra"];
      if (failure.includes("mapping")) fixture.targetColumnNames = ["value", "absent"];
      if (failure === "invalid mapping")
        fixture.chooseColumnMapping = async () => new Map([["c:source:1", "c:source:0"]]);
      if (failure === "origin change during mapping")
        fixture.chooseColumnMapping = async () => {
          fixture.runtimeOwnerCurrent = false;
          return new Map([["c:source:1", "c:source:1"]]);
        };
      if (failure === "incomplete plan") fixture.targetIncompletePlan = true;
      if (failure === "page source drift") fixture.targetPageSourceDrift = true;
      if (failure === "unsupported operation") fixture.targetUnsupported = true;
      if (failure === "target runtime unavailable") fixture.targetRuntimeOwnerCurrent = false;
      fixture.beforeTargetPreview = async () => {
        if (failure === "target runtime replacement") fixture.targetRuntimeOwnerCurrent = false;
        if (failure === "runtime refusal")
          return { kind: "error", code: "engine_error", message: "Cannot replay this value.", recoverable: true };
        if (failure === "cancellation") cancellation.cancel();
        if (failure === "detached cancellation")
          throw new DetachedBridgeRequestError("cancelled", "cancellation", true, settlement.promise);
        if (failure === "retired origin")
          await fixture.bridge.request({
            kind: "closeSession",
            sessionId: fixture.originId,
            revision: fixture.originSnapshot!.metadata.revision
          });
        return undefined;
      };
      const result = await selected.bridge.request(fixture.targetRequest, { cancellation: cancellation.token });
      expect(result.kind).toBe(failure === "cancellation" ? "cancelled" : "error");
      expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
      expect(fixture.stored[fixture.originKey]).toEqual(fixture.savedOrigin);
      expect(fixture.coordinator.diagnostics().sessionCount).toBe(failure === "retired origin" ? 0 : 1);
      if (failure === "detached cancellation") {
        expect(fixture.targetRequests.some((request) => request.kind === "closeSession")).toBe(false);
        settlement.resolve();
        await vi.waitFor(() =>
          expect(fixture.targetRequests.filter((request) => request.kind === "closeSession")).toHaveLength(1)
        );
      } else expect(fixture.targetRequests.filter((request) => request.kind === "closeSession")).toHaveLength(1);
      expect(fixture.targetRequests.filter((request) => request.kind === "applyDraft")).toHaveLength(
        failure === "incomplete plan" || failure === "page source drift" ? 3 : 0
      );
      expect(fixture.mappingRequests.map(({ unmatched, candidates }) => [unmatched, candidates])).toEqual(
        failure.includes("mapping")
          ? [[[expect.objectContaining({ name: "other" })], [expect.objectContaining({ name: "absent" })]]]
          : []
      );
      const messages = new Map<typeof failure, [code: string, message?: string]>([
        [
          "schema",
          ["file_plan_replay_failed", "The selected file has no remaining column with the same type as “other”."]
        ],
        [
          "extra column",
          ["file_plan_replay_failed", "The selected file has 3 columns, but the plan's original input has 2."]
        ],
        ["declined mapping", ["file_plan_mapping_declined"]],
        ["invalid mapping", ["file_plan_replay_failed", "The chosen columns do not match the plan's original input."]],
        ["origin change during mapping", ["file_plan_changed"]]
      ]);
      const expected = messages.get(failure);
      if (expected)
        expect(result).toMatchObject({
          kind: "error",
          code: expected[0],
          recoverable: true,
          ...(expected[1] ? { message: expected[1] } : {})
        });
      if (failure === "target runtime replacement")
        expect(result).toMatchObject({
          kind: "error",
          code: "file_plan_target_runtime_changed",
          recoverable: true
        });
      if (failure === "runtime refusal") {
        fixture.beforeTargetPreview = undefined;
        await expect(selected.bridge.request(fixture.targetRequest)).resolves.toMatchObject({
          kind: "sessionOpened",
          metadata: { steps: fixture.steps }
        });
      }
    } finally {
      settlement.resolve();
      cancellation.dispose();
      await fixture.close();
    }
  });

  it("closes a copied plan when its target gains saved work during replay", async () => {
    const fixture = await filePlanFixture();
    try {
      const selected = fixture.capture();
      fixture.beforeTargetPreview = async () => {
        fixture.stored = { ...fixture.stored, [fixture.targetKey]: { unknownWork: true } };
        return undefined;
      };
      await expect(selected.bridge.request(fixture.targetRequest)).resolves.toMatchObject({
        kind: "error",
        code: "file_plan_target_changed",
        message: "The target's saved state changed before the plan could be shown. Choose another file."
      });
      expect(fixture.stored[fixture.targetKey]).toEqual({ unknownWork: true });
      expect(fixture.targetRequests.filter((request) => request.kind === "closeSession")).toHaveLength(1);
      expect(fixture.coordinator.activeSession()?.sessionId).toBe(fixture.originId);
      expect(fixture.coordinator.diagnostics().sessionCount).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses changes to a copied plan until it is kept", async () => {
    const fixture = await filePlanFixture();
    try {
      const selected = fixture.capture();
      const opened = await selected.bridge.request(fixture.targetRequest);
      if (opened.kind !== "sessionOpened") throw new Error(JSON.stringify(opened));
      const { sessionId, revision } = opened.metadata;
      const window = { offset: 0, limit: 10, columnOffset: 0, columnLimit: 16 };
      const refused = {
        kind: "error",
        code: "copied_plan_pending",
        recoverable: true,
        message: "Keep the copied plan before changing it. Nothing is saved for this file until you keep it."
      };
      const step: TransformStep = {
        id: "round-other",
        kind: "roundNumber",
        params: { column: { id: "c:source:1", name: "other" } }
      };
      const previews = () => fixture.targetRequests.filter((request) => request.kind === "previewStep").length;
      await expect(
        selected.bridge.request({ kind: "previewStep", sessionId, revision, step, ...window })
      ).resolves.toMatchObject(refused);
      await expect(
        selected.bridge.request({ kind: "undoStep", sessionId, revision, ...window })
      ).resolves.toMatchObject(refused);
      await expect(
        selected.bridge.rewriteCleaningPlan!(sessionId, revision, "rename-value", "deleteStep", window)
      ).resolves.toMatchObject(refused);
      await expect(
        selected.bridge.reconfigureFileSession!(sessionId, revision, {
          ...fixture.targetRequest.source,
          importOptions: { delimiter: ";" }
        })
      ).resolves.toMatchObject(refused);
      expect(fixture.bridge.captureActiveFilePlan!(async () => undefined)).toMatchObject({
        kind: "error",
        code: "file_plan_unavailable",
        message: "Keep the copied plan before using it on another file."
      });
      expect(previews()).toBe(3);
      expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);

      await expect(selected.bridge.keepCopiedPlan!(sessionId)).resolves.toBeUndefined();
      await expect(
        selected.bridge.request({ kind: "previewStep", sessionId, revision, step, ...window })
      ).resolves.toMatchObject({ kind: "stepPreview" });
      expect(previews()).toBe(4);
    } finally {
      await fixture.close();
    }
  });

  it.each(["saved elsewhere", "storage failure"] as const)(
    "leaves a copied plan pending when keeping it fails: %s",
    async (failure) => {
      const fixture = await filePlanFixture();
      try {
        const selected = fixture.capture();
        const opened = await selected.bridge.request(fixture.targetRequest);
        if (opened.kind !== "sessionOpened") throw new Error(JSON.stringify(opened));
        const sessionId = opened.metadata.sessionId;
        if (failure === "saved elsewhere")
          fixture.stored = { ...fixture.stored, [fixture.targetKey]: { unknownWork: true } };
        else
          fixture.beforeSave = async (value) => {
            if (Object.hasOwn(value, fixture.targetKey)) throw new Error("Workspace state write unavailable.");
          };

        await expect(selected.bridge.keepCopiedPlan!(sessionId)).resolves.toMatchObject(
          failure === "saved elsewhere"
            ? {
                code: "file_plan_target_changed",
                message:
                  "target.csv now has other saved Open Wrangler work, so the copied plan was not saved. Discard this copy to keep that work."
              }
            : { code: "persistence_unavailable" }
        );
        expect(fixture.stored[fixture.targetKey]).toEqual(
          failure === "saved elsewhere" ? { unknownWork: true } : undefined
        );
        expect(selected.bridge.getSessionPresentation?.(sessionId)).toMatchObject({ copiedPlanPending: true });
        expect(fixture.stored[fixture.originKey]).toEqual(fixture.savedOrigin);
      } finally {
        await fixture.close();
      }
    }
  );

  it("saves nothing when a copied plan is closed before it is kept", async () => {
    const fixture = await filePlanFixture();
    try {
      const selected = fixture.capture();
      const opened = await selected.bridge.request(fixture.targetRequest);
      if (opened.kind !== "sessionOpened") throw new Error(JSON.stringify(opened));
      await expect(
        selected.bridge.request({
          kind: "closeSession",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision
        })
      ).resolves.toMatchObject({ kind: "sessionClosed" });
      expect(Object.hasOwn(fixture.stored, fixture.targetKey)).toBe(false);
      expect(fixture.stored[fixture.originKey]).toEqual(fixture.savedOrigin);
      await expect(selected.bridge.keepCopiedPlan!(opened.metadata.sessionId)).resolves.toMatchObject({
        code: "unknown_session"
      });
    } finally {
      await fixture.close();
    }
  });
});

async function filePlanFixture(reordered = false, backend: "polars" | "r" = "polars") {
  const columnId = (position: number): string => `${backend === "r" ? "r:c" : "c:source"}:${position}`;
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-file-plan-"));
  const originPath = join(directory, "origin.csv");
  const targetPath = join(directory, "target.csv");
  await writeFile(originPath, "value,other\n1.2,10\n2.3,20\n");
  await writeFile(targetPath, reordered ? "other,value\n30,4.5\n40,6.7\n" : "value,other\n4.5,30\n6.7,40\n");
  const source = (path: string, label: string): SessionSource => ({
    kind: "file",
    label,
    path,
    uri: vscode.Uri.file(path).toString()
  });
  const originSource = source(originPath, "origin.csv");
  const targetSource = source(targetPath, "target.csv");
  const steps: TransformStep[] = [
    {
      id: "rename-value",
      kind: "renameColumn",
      params: { column: { id: columnId(0), name: "value" }, newName: "amount" }
    },
    {
      id: "total",
      kind: "formula",
      params: {
        leftColumn: { id: columnId(0), name: "amount" },
        rightColumn: { id: columnId(1), name: "other" },
        operator: "add",
        newColumn: "total"
      }
    },
    { id: "floor-total", kind: "floorNumber", params: { column: { id: "c:step:total:0", name: "total" } } }
  ];
  const originKey = persistenceKey(originSource, backend);
  const targetKey = persistenceKey(targetSource, backend);
  const originMetadata = { ...metadataFor({ runtimeId: "seed", source: originSource, steps }), backend };
  const savedOrigin = serializePersistedSession(
    persistedSessionState(originMetadata, { columnWidths: new Map(), viewport: { firstVisibleRow: 0, scrollLeft: 0 } })
  );
  if (!savedOrigin) throw new Error("Expected saved origin fixture.");
  const controls: {
    stored: Record<string, unknown>;
    beforeSave?: (value: Record<string, unknown>) => Promise<void>;
    beforeTargetPreview?: () => Promise<OpenWranglerResponse | undefined>;
    runtimeOwnerCurrent: boolean;
    targetRuntimeOwnerCurrent: boolean;
    targetSchemaMismatch: boolean;
    targetColumnNames?: string[];
    targetIncompletePlan: boolean;
    targetPageSourceDrift: boolean;
    targetUnsupported: boolean;
    chooseColumnMapping?: FilePlanColumnMappingChooser;
    mappingRequests: FilePlanColumnMappingRequest[];
  } = {
    stored: { [originKey]: savedOrigin },
    mappingRequests: [],
    runtimeOwnerCurrent: true,
    targetRuntimeOwnerCurrent: true,
    targetSchemaMismatch: false,
    targetIncompletePlan: false,
    targetPageSourceDrift: false,
    targetUnsupported: false
  };
  const memory: Memento = {
    get: <T>() => controls.stored as T,
    keys: () => [SESSION_STORAGE_KEY],
    update: async (_key, value) => {
      await controls.beforeSave?.(value);
      controls.stored = value;
    }
  };
  const coordinator = new SessionCoordinator(memory);
  const sessions = new Map<string, SessionMetadata>();
  const targetRequests: OpenWranglerRequest[] = [];
  let ordinal = 0;
  const delegate: OpenWranglerBridge = {
    captureFileSessionOwner: (sessionId) => {
      const owner = sessions.get(sessionId);
      const available = () =>
        Boolean(owner) &&
        controls.runtimeOwnerCurrent &&
        sessions.get(sessionId) === owner &&
        (owner?.source.path === originPath || controls.targetRuntimeOwnerCurrent);
      return available() ? available : undefined;
    },
    request: async (request: OpenWranglerRequest, _options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        const metadata = { ...metadataFor({ runtimeId: `runtime-${++ordinal}`, source: request.source, backend }) };
        metadata.schema = (
          request.source.path !== originPath
            ? (controls.targetColumnNames ?? (reordered ? ["other", "value"] : ["value", "other"]))
            : ["value", "other"]
        ).map((name, position) => ({
          ...metadata.schema[0],
          rawType: backend === "r" ? "double" : metadata.schema[0].rawType,
          id: columnId(position),
          name,
          position
        }));
        metadata.shape.columns = metadata.filteredShape.columns = metadata.schema.length;
        if (request.source.path !== originPath) {
          targetRequests.push(request);
          if (controls.targetSchemaMismatch) metadata.schema[0].rawType = "Int64";
          if (controls.targetUnsupported) metadata.capabilities.supportedOperations = [];
        }
        sessions.set(metadata.sessionId, metadata);
        const opened = openedFor(request, metadata);
        opened.page.columnIds = metadata.schema.map((column) => column.id);
        return opened;
      }
      if (!("sessionId" in request)) throw new Error(`Unexpected request ${request.kind}`);
      const metadata = sessions.get(request.sessionId);
      if (!metadata) throw new Error("Unknown fixture runtime.");
      const target = metadata.source.path !== originPath;
      if (target) targetRequests.push(request);
      if (request.kind === "closeSession") {
        sessions.delete(request.sessionId);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      if (request.kind === "getPage")
        return pageFor(
          request,
          target && controls.targetPageSourceDrift
            ? { ...metadata, source: { ...metadata.source, path: join(directory, "unselected.csv") } }
            : metadata
        );
      if (request.kind === "previewStep") {
        if (target) {
          const refused = await controls.beforeTargetPreview?.();
          if (refused) return refused;
        }
        metadata.revision++;
        metadata.draftStep = request.step;
        return previewFor(request, structuredClone(metadata), `# ${metadata.source.label}`);
      }
      if (request.kind === "applyDraft") {
        if (!metadata.draftStep) throw new Error("Expected fixture draft.");
        metadata.revision++;
        metadata.steps.push(metadata.draftStep);
        metadata.latestStepInputSchema = structuredClone(metadata.schema);
        if (metadata.draftStep.kind === "renameColumn") {
          const { column, newName } = metadata.draftStep.params;
          metadata.schema = metadata.schema.map((item) => (item.id === column.id ? { ...item, name: newName } : item));
        } else if (metadata.draftStep.kind === "formula") {
          metadata.schema.push({
            ...metadata.schema[0],
            id: `c:step:${metadata.draftStep.id}:0`,
            name: metadata.draftStep.params.newColumn,
            position: metadata.schema.length
          });
        }
        metadata.shape.columns = metadata.filteredShape.columns = metadata.schema.length;
        if (target && controls.targetIncompletePlan && metadata.steps.length === steps.length) metadata.steps.pop();
        delete metadata.draftStep;
        return appliedFor(request, structuredClone(metadata), `# ${metadata.source.label}`);
      }
      throw new Error(`Unexpected fixture request ${request.kind}`);
    }
  };
  const bindSource = (source: SessionSource): OpenWranglerBridge => ({
    ...delegate,
    request: (request, options) => {
      if (request.kind === "openSession" && request.source.path !== source.path)
        throw new Error("R delegate received another file");
      return delegate.request(request, options);
    }
  });
  const originDelegate = backend === "r" ? bindSource(originSource) : delegate;
  const targetDelegate = backend === "r" ? bindSource(targetSource) : undefined;
  const bridge = coordinator.createBridge(originDelegate);
  const commandBridge = backend === "r" ? coordinator.createBridge({ request: vi.fn() }) : bridge;
  const originRequest = { ...openRequest, source: originSource, backend };
  const origin = await bridge.request(originRequest);
  if (origin.kind !== "sessionOpened") {
    await coordinator.shutdown();
    await rm(directory, { recursive: true, force: true });
    throw new Error(`Origin failed: ${JSON.stringify(origin)}`);
  }
  const snapshot = coordinator.activeSession()!;
  const originSnapshot = {
    ...snapshot,
    metadata: structuredClone(snapshot.metadata),
    viewState: structuredClone(snapshot.viewState)
  };
  return Object.assign(controls, {
    directory,
    originPath,
    targetPath,
    targetKey,
    originKey,
    savedOrigin: structuredClone(controls.stored[originKey]),
    steps,
    coordinator,
    bridge,
    originId: origin.metadata.sessionId,
    originSnapshot,
    targetRequests,
    targetRequest: { ...openRequest, source: targetSource, backend },
    capture(delegate = targetDelegate) {
      const selected = commandBridge.captureActiveFilePlan!(async (request) => {
        controls.mappingRequests.push(structuredClone(request));
        return controls.chooseColumnMapping?.(request);
      });
      if ("kind" in selected) throw new Error(selected.message);
      return { ...selected, bridge: selected.createBridge(delegate) };
    },
    async close() {
      await coordinator.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
