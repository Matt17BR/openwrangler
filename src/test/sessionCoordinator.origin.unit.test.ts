import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Memento, NotebookDocument } from "vscode";
import type { BridgeRequestOptions } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import { persistedSessionState, persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import type { FilterModel } from "../shared/filterModel";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionMetadata, TransformStep } from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
import {
  openRequest,
  columnWindow,
  inspectionStep,
  ExactSessionOpenedResponse,
  openedResponse,
  pageResponse,
  projectedPage,
  pageResponseForMetadata,
  stepPreviewResponse,
  stepInspectionResponse,
  planUpdatedResponse,
  setOpenNotebookDocuments,
  setOpenTextDocuments,
  rTextDocument,
  rDocumentSource,
  rDocumentOpened,
  deferred
} from "./sessionCoordinatorTestFixtures";

describe("SessionCoordinator", () => {
  it("retains notebook provenance only in host session state", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/origin.ipynb"),
      isClosed: false
    } as NotebookDocument;
    setOpenNotebookDocuments(notebook);
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(
      { request: vi.fn(async (): Promise<OpenWranglerResponse> => openedResponse()) },
      notebook
    );

    const opened = await bridge.request({
      ...openRequest,
      source: {
        kind: "notebookVariable",
        label: "frame",
        variableName: "frame",
        uri: notebook.uri.toString()
      }
    });

    expect(opened.kind).toBe("sessionOpened");
    expect(coordinator.activeNotebookDocument()).toBe(notebook);
    expect(coordinator.activeSession()).not.toHaveProperty("notebookDocument");
    setOpenNotebookDocuments();
  });

  it("atomically reopens the exact live notebook variable in Editing mode and retains its view", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/r-editing.ipynb"),
      isClosed: false
    } as NotebookDocument;
    const source = {
      kind: "notebookVariable" as const,
      label: "orders_frame",
      variableName: "orders_frame",
      uri: notebook.uri.toString()
    };
    const runtimeRequests: OpenWranglerRequest[] = [];
    const runtimeOptions: Array<BridgeRequestOptions | undefined> = [];
    const openedFor = (
      request: Extract<OpenWranglerRequest, { kind: "openSession" }>,
      runtimeId: string
    ): ExactSessionOpenedResponse => {
      const opened = openedResponse(runtimeId, "r");
      return {
        ...opened,
        page: { ...opened.page, totalRows: 10, columnIds: ["c:value"] },
        metadata: {
          ...opened.metadata,
          sessionId: runtimeId,
          backend: "r",
          rDataframeFlavor: "r.data.frame",
          mode: request.mode ?? "viewing",
          source,
          shape: { rows: 10, columns: 1 },
          filteredShape: { rows: 10, columns: 1 },
          schema: [
            {
              id: "c:value",
              name: "value",
              position: 0,
              rawType: "double",
              type: "float",
              nullable: false
            }
          ],
          capabilities: {
            editable: true,
            lazy: false,
            cancel: false,
            exportCsv: request.mode === "editing",
            exportParquet: false,
            notebookInsert: true,
            filter: true,
            sort: true,
            profile: true,
            columnValues: true,
            supportedOperations: ["sortRows"]
          }
        }
      };
    };
    const metadataByRuntime = new Map<string, SessionMetadata>();
    let openCount = 0;
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        runtimeRequests.push(request);
        runtimeOptions.push(options);
        if (request.kind === "openSession") {
          openCount += 1;
          const runtimeId = request.requestedSessionId ?? `r-runtime-${openCount}`;
          const opened = openedFor(request, runtimeId);
          metadataByRuntime.set(runtimeId, opened.metadata);
          return opened;
        }
        if (request.kind === "getPage") {
          const metadata = metadataByRuntime.get(request.sessionId);
          if (!metadata) throw new Error(`Unknown test runtime ${request.sessionId}`);
          return pageResponseForMetadata(request, metadata);
        }
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`Unexpected R mode-change request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest }, notebook);
    setOpenNotebookDocuments(notebook);

    try {
      const opened = await bridge.request({ ...openRequest, source, backend: "r", mode: "viewing" });
      if (opened.kind !== "sessionOpened") throw new Error("Expected the R notebook session to open.");
      const publicId = opened.metadata.sessionId;
      await bridge.updateViewState?.(publicId, {
        selectedColumnId: undefined,
        columnWidths: {},
        viewport: { firstVisibleRow: 0, scrollLeft: 37 }
      });
      const sorted = await bridge.request({
        kind: "getPage",
        sessionId: publicId,
        revision: opened.metadata.revision,
        viewRequestId: "r-viewing-sort",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: { filters: [], sort: [{ column: "value", direction: "desc", nulls: "last" }] }
      });
      if (sorted.kind !== "page") throw new Error("Expected the R viewing sort to resolve.");

      const currentViewState: GridViewState = {
        selectedColumnId: "c:value",
        columnWidths: { "c:value": 240 },
        viewport: { firstVisibleRow: 0, scrollLeft: 81 }
      };
      const editing = await bridge.reconfigureNotebookSessionForEditing?.(publicId, sorted.revision, currentViewState);

      expect(editing).toMatchObject({
        kind: "sessionOpened",
        metadata: {
          sessionId: publicId,
          revision: sorted.revision + 1,
          backend: "r",
          mode: "editing",
          source
        }
      });
      expect(coordinator.activeSession()).toMatchObject({
        sessionId: publicId,
        metadata: { mode: "editing", filterModel: sorted.metadata.filterModel },
        viewState: {
          selectedColumnId: "c:value",
          columnWidths: { "c:value": 240 },
          viewport: { firstVisibleRow: 0, scrollLeft: 81 },
          filterModel: sorted.metadata.filterModel
        }
      });
      const opens = runtimeRequests.filter(
        (request): request is Extract<OpenWranglerRequest, { kind: "openSession" }> => request.kind === "openSession"
      );
      expect(opens).toHaveLength(2);
      expect(opens[1]).toMatchObject({ source, backend: "r", mode: "editing" });
      expect(opens[1]?.requestedSessionId).toBeTruthy();
      const replacementOpenIndex = runtimeRequests.indexOf(opens[1]!);
      expect(runtimeOptions[replacementOpenIndex]?.requiredKernelSessionId).toBe("r-runtime-1");
      const restoredPageIndex = runtimeRequests.findIndex(
        (request) => request.kind === "getPage" && request.sessionId === opens[1]?.requestedSessionId
      );
      expect(restoredPageIndex).toBeGreaterThan(-1);
      expect(runtimeOptions[restoredPageIndex]?.requiredKernelSessionId).toBeUndefined();
      expect(runtimeRequests).toContainEqual(
        expect.objectContaining({
          kind: "getPage",
          sessionId: opens[1]?.requestedSessionId,
          filterModel: sorted.metadata.filterModel
        })
      );
      await vi.waitFor(() =>
        expect(runtimeRequests).toContainEqual(
          expect.objectContaining({ kind: "closeSession", sessionId: "r-runtime-1" })
        )
      );
    } finally {
      setOpenNotebookDocuments();
      await coordinator.shutdown();
    }
  });

  it("reopens an active R-session dataframe in Editing mode without notebook provenance", async () => {
    const source = {
      kind: "rInteractiveVariable" as const,
      label: "orders_frame",
      variableName: "orders_frame"
    };
    const runtimeRequests: OpenWranglerRequest[] = [];
    const metadataByRuntime = new Map<string, SessionMetadata>();
    let openCount = 0;
    const openedFor = (
      request: Extract<OpenWranglerRequest, { kind: "openSession" }>,
      runtimeId: string
    ): ExactSessionOpenedResponse => {
      const opened = openedResponse(runtimeId, "r");
      return {
        ...opened,
        page: { ...opened.page, totalRows: 10, columnIds: ["c:value"] },
        metadata: {
          ...opened.metadata,
          sessionId: runtimeId,
          backend: "r",
          rDataframeFlavor: "r.tibble",
          mode: request.mode ?? "viewing",
          source,
          shape: { rows: 10, columns: 1 },
          filteredShape: { rows: 10, columns: 1 },
          schema: [
            {
              id: "c:value",
              name: "value",
              position: 0,
              rawType: "double",
              type: "float",
              nullable: false
            }
          ],
          capabilities: {
            editable: true,
            lazy: false,
            cancel: false,
            exportCsv: request.mode === "editing",
            exportParquet: false,
            notebookInsert: false,
            documentInsert: false,
            filter: true,
            sort: true,
            profile: true,
            columnValues: true,
            supportedOperations: ["sortRows"]
          }
        }
      };
    };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      runtimeRequests.push(request);
      if (request.kind === "openSession") {
        openCount += 1;
        const runtimeId = request.requestedSessionId ?? `r-interactive-${openCount}`;
        const opened = openedFor(request, runtimeId);
        metadataByRuntime.set(runtimeId, opened.metadata);
        return opened;
      }
      if (request.kind === "getPage") {
        const current = metadataByRuntime.get(request.sessionId);
        if (!current) throw new Error(`Unknown interactive R runtime ${request.sessionId}`);
        return pageResponseForMetadata(request, current);
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected interactive R mode-change request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });

    try {
      const opened = await bridge.request({ ...openRequest, source, backend: "r", mode: "viewing" });
      if (opened.kind !== "sessionOpened") throw new Error("Expected the active R session to open.");

      const editing = await bridge.reconfigureNotebookSessionForEditing?.(
        opened.metadata.sessionId,
        opened.metadata.revision,
        { selectedColumnId: "c:value", columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 42 } }
      );

      expect(editing).toMatchObject({
        kind: "sessionOpened",
        metadata: {
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision + 1,
          backend: "r",
          mode: "editing",
          source,
          capabilities: { notebookInsert: false, documentInsert: false, exportCsv: true }
        }
      });
      expect(runtimeRequests.filter((request) => request.kind === "openSession")).toHaveLength(2);
      expect(runtimeRequests).toContainEqual(
        expect.objectContaining({ kind: "getPage", filterModel: opened.metadata.filterModel })
      );
    } finally {
      await coordinator.shutdown();
    }
  });

  it("keeps the confirmed Viewing session when its exact notebook is replaced while Editing opens", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/r-replaced.ipynb"),
      isClosed: false
    } as NotebookDocument;
    const replacement = {
      uri: notebook.uri,
      isClosed: false
    } as NotebookDocument;
    const source = {
      kind: "notebookVariable" as const,
      label: "orders_frame",
      variableName: "orders_frame",
      uri: notebook.uri.toString()
    };
    const candidateOpen = deferred<OpenWranglerResponse>();
    const closedRuntimeIds: string[] = [];
    let candidateSessionId: string | undefined;
    let openCount = 0;
    const openedFor = (
      request: Extract<OpenWranglerRequest, { kind: "openSession" }>,
      runtimeId: string
    ): ExactSessionOpenedResponse => {
      const opened = openedResponse(runtimeId, "r");
      return {
        ...opened,
        metadata: {
          ...opened.metadata,
          sessionId: runtimeId,
          backend: "r",
          rDataframeFlavor: "r.data.frame",
          mode: request.mode ?? "viewing",
          source,
          capabilities: {
            ...opened.metadata.capabilities,
            editable: true,
            notebookInsert: true,
            supportedOperations: ["sortRows"]
          }
        }
      };
    };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        if (openCount === 1) return openedFor(request, "r-viewing-runtime");
        candidateSessionId = request.requestedSessionId;
        return candidateOpen.promise;
      }
      if (request.kind === "closeSession") {
        closedRuntimeIds.push(request.sessionId);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected replaced-notebook request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest }, notebook);
    setOpenNotebookDocuments(notebook);

    try {
      const opened = await bridge.request({ ...openRequest, source, backend: "r", mode: "viewing" });
      if (opened.kind !== "sessionOpened") throw new Error("Expected the R notebook session to open.");

      const switching = bridge.reconfigureNotebookSessionForEditing?.(
        opened.metadata.sessionId,
        opened.metadata.revision,
        { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 44 } }
      );
      await vi.waitFor(() => expect(candidateSessionId).toBeTruthy());
      setOpenNotebookDocuments(replacement);
      candidateOpen.resolve(
        openedFor(
          {
            ...openRequest,
            source,
            backend: "r",
            mode: "editing",
            requestedSessionId: candidateSessionId
          },
          candidateSessionId as string
        )
      );

      await expect(switching).resolves.toMatchObject({ kind: "error", code: "invalid_source_origin" });
      expect(coordinator.activeSession()).toMatchObject({
        sessionId: opened.metadata.sessionId,
        metadata: { mode: "viewing", revision: opened.metadata.revision },
        viewState: { viewport: { firstVisibleRow: 0, scrollLeft: 44 } }
      });
      expect(closedRuntimeIds).toEqual([candidateSessionId]);
    } finally {
      setOpenNotebookDocuments();
      await coordinator.shutdown();
    }
  });

  it("rejects mismatched notebook provenance before opening a runtime session", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/origin.ipynb"),
      isClosed: false
    } as NotebookDocument;
    setOpenNotebookDocuments(notebook);
    const delegateRequest = vi.fn(async (): Promise<OpenWranglerResponse> => openedResponse());
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest }, notebook);

    const opened = await bridge.request({
      ...openRequest,
      source: {
        kind: "notebookVariable",
        label: "frame",
        variableName: "frame",
        uri: "file:///workspace/replacement.ipynb"
      }
    });

    expect(opened).toMatchObject({ kind: "error", code: "invalid_source_origin" });
    expect(delegateRequest).not.toHaveBeenCalled();
    expect(coordinator.activeNotebookDocument()).toBeUndefined();
    expect(coordinator.diagnostics().sessionCount).toBe(0);
    setOpenNotebookDocuments();
  });

  it("requires exact text-document provenance for document variables", async () => {
    const document = rTextDocument("file:///workspace/orders.R");
    const source = rDocumentSource(document);
    setOpenTextDocuments(document);
    const delegateRequest = vi.fn(async (): Promise<OpenWranglerResponse> => rDocumentOpened(source));
    const onIdle = vi.fn();
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest, onIdle });

    const opened = await bridge.request({ ...openRequest, source, backend: "r" });

    expect(opened).toMatchObject({ kind: "error", code: "invalid_source_origin" });
    expect(delegateRequest).not.toHaveBeenCalled();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(coordinator.activeTextDocumentOrigin()).toBeUndefined();
    setOpenTextDocuments();
  });

  it("retains an exact R text-document origin only in coordinator state", async () => {
    const document = rTextDocument("file:///workspace/orders.R");
    const source = rDocumentSource(document);
    setOpenTextDocuments(document);
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(
      { request: vi.fn(async (): Promise<OpenWranglerResponse> => rDocumentOpened(source)) },
      { kind: "textDocument", document, version: document.version }
    );

    const opened = await bridge.request({ ...openRequest, source, backend: "r" });

    expect(opened.kind).toBe("sessionOpened");
    expect(coordinator.activeTextDocumentOrigin()).toEqual({ kind: "textDocument", document, version: 1 });
    expect(coordinator.activeSession()).not.toHaveProperty("origin");
    setOpenTextDocuments();
  });

  it("closes an R runtime that opened after its source document changed", async () => {
    const document = rTextDocument("file:///workspace/orders.R");
    const source = rDocumentSource(document);
    setOpenTextDocuments(document);
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        (document as { version: number }).version += 1;
        return rDocumentOpened(source);
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected R document request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(
      { request: delegateRequest },
      { kind: "textDocument", document, version: document.version }
    );

    const opened = await bridge.request({ ...openRequest, source, backend: "r" });

    expect(opened).toMatchObject({ kind: "error", code: "invalid_source_origin" });
    expect(delegateRequest.mock.calls.map(([request]) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(coordinator.activeSession()).toBeUndefined();
    setOpenTextDocuments();
  });

  it("rechecks an R source origin after waiting behind another open", async () => {
    const document = rTextDocument("file:///workspace/orders.R");
    const source = rDocumentSource(document);
    setOpenTextDocuments(document);
    const firstRuntime = deferred<OpenWranglerResponse>();
    const onIdle = vi.fn();
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        if (delegateRequest.mock.calls.filter(([candidate]) => candidate.kind === "openSession").length > 1) {
          throw new Error("A stale queued R source must not reach the runtime.");
        }
        return firstRuntime.promise;
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected queued R document request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(
      { request: delegateRequest, onIdle },
      { kind: "textDocument", document, version: document.version }
    );

    const first = bridge.request({ ...openRequest, source, backend: "r" });
    await vi.waitFor(() => expect(delegateRequest).toHaveBeenCalledOnce());
    const second = bridge.request({ ...openRequest, source, backend: "r" });
    (document as { version: number }).version += 1;
    firstRuntime.resolve(rDocumentOpened(source));

    await expect(first).resolves.toMatchObject({ kind: "error", code: "invalid_source_origin" });
    await expect(second).resolves.toMatchObject({ kind: "error", code: "invalid_source_origin" });
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")).toHaveLength(1);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(1);
    expect(onIdle).toHaveBeenCalledOnce();
    setOpenTextDocuments();
  });

  it("pins public source metadata to the immutable open request across runtime responses", async () => {
    const runtimeOpened = openedResponse();
    const substitutedSource = {
      kind: "file" as const,
      label: "different.csv",
      path: "/workspace/different.csv"
    };
    runtimeOpened.metadata = { ...runtimeOpened.metadata, source: substitutedSource };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "getPage") {
        return {
          ...pageResponse(request),
          metadata: {
            ...pageResponse(request).metadata,
            source: substitutedSource,
            sessionId: runtimeOpened.metadata.sessionId
          }
        };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const opened = await bridge.request(openRequest);
    expect(opened).toMatchObject({ kind: "sessionOpened", metadata: { source: openRequest.source } });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    expect(coordinator.activeSession()?.metadata.source).toEqual(openRequest.source);

    const page = await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "immutable-source-page",
      offset: 0,
      limit: 10,
      ...columnWindow,
      filterModel: opened.metadata.filterModel
    });

    expect(page).toMatchObject({ kind: "page", metadata: { source: openRequest.source } });
    expect(coordinator.activeSession()?.metadata.source).toEqual(openRequest.source);
  });

  it("publishes one bounded applied-step inspection and restores full-plan code when cleared", async () => {
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = { ...runtimeOpened.metadata, steps: [inspectionStep] };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "inspectStep") return stepInspectionResponse(request, 0, "# selected prefix");
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const response = await bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      stepId: inspectionStep.id,
      offset: 0,
      limit: 25,
      ...columnWindow
    });

    expect(response).toMatchObject({ kind: "stepInspection", stepId: inspectionStep.id, revision: 0 });
    expect(coordinator.activeSession()).toMatchObject({
      code: "# selected prefix",
      stepInspectionActive: true,
      stepInspection: { stepId: inspectionStep.id, outputPage: { limit: 25 } }
    });
    expect(coordinator.activeSession()?.metadata).toEqual(opened.metadata);

    coordinator.clearActiveStepInspection();
    expect(coordinator.activeSession()?.stepInspectionActive).toBeUndefined();
    expect(coordinator.activeSession()?.stepInspection).toBeUndefined();
    expect(coordinator.activeSession()?.code).toBe("");
  });

  it("recovers and retries an applied-step inspection without changing the source or viewing state", async () => {
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    };
    const schema: SessionMetadata["schema"] = [
      { id: "c:sales", name: "sales", position: 0, rawType: "Int64", type: "integer", nullable: false }
    ];
    const runtimeOpened = openedResponse("runtime-1");
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      revision: 2,
      shape: { rows: 500, columns: 1 },
      filteredShape: { rows: 500, columns: 1 },
      schema,
      filterModel,
      steps: [inspectionStep]
    };
    runtimeOpened.page = { ...runtimeOpened.page, totalRows: 500, columnIds: ["c:sales"] };
    const recoveryOpened = openedResponse("runtime-2");
    recoveryOpened.metadata = {
      ...recoveryOpened.metadata,
      shape: { rows: 500, columns: 1 },
      filteredShape: { rows: 500, columns: 1 },
      schema
    };
    recoveryOpened.page = { ...recoveryOpened.page, totalRows: 500, columnIds: ["c:sales"] };

    const executionOrder: string[] = [];
    let openCount = 0;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openCount === 1 ? runtimeOpened : recoveryOpened;
      }
      if (request.kind === "inspectStep") {
        executionOrder.push(`inspect-${request.sessionId}-${request.revision}`);
        if (request.sessionId === "runtime-1") throw new Error("inspection transport failed");
        return stepInspectionResponse(request, 0, "# recovered prefix");
      }
      if (request.kind === "previewStep") {
        executionOrder.push(`preview-${request.sessionId}-${request.revision}`);
        return {
          ...stepPreviewResponse(1, inspectionStep, "runtime-2"),
          metadata: { ...recoveryOpened.metadata, revision: 1, draftStep: inspectionStep },
          page: projectedPage(request, recoveryOpened.metadata)
        };
      }
      if (request.kind === "applyDraft") {
        executionOrder.push(`apply-${request.sessionId}-${request.revision}`);
        return {
          ...planUpdatedResponse(2, [inspectionStep], "runtime-2"),
          metadata: { ...recoveryOpened.metadata, revision: 2, steps: [inspectionStep] },
          page: projectedPage(request, recoveryOpened.metadata)
        };
      }
      if (request.kind === "getPage") {
        executionOrder.push(`restore-${request.sessionId}-${request.revision}-${request.offset}-${request.limit}`);
        return {
          kind: "page",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          metadata: {
            ...recoveryOpened.metadata,
            revision: request.revision,
            steps: [inspectionStep],
            filterModel: request.filterModel
          },
          page: {
            offset: request.offset,
            limit: request.limit,
            totalRows: 500,
            columnIds: schema
              .slice(request.columnOffset, request.columnOffset + request.columnLimit)
              .map((column) => column.id),
            rows: []
          }
        };
      }
      if (request.kind === "closeSession") {
        executionOrder.push(`close-${request.sessionId}-${request.revision}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");
    await bridge.updateViewState?.(opened.metadata.sessionId, {
      columnWidths: { "c:sales": 260 },
      selectedColumnId: "c:sales",
      viewport: { firstVisibleRow: 240, scrollLeft: 180 }
    });
    const sourceBefore = coordinator.activeSession()?.metadata.source;
    const viewBefore = coordinator.activeSession()?.viewState;

    const response = await bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      stepId: inspectionStep.id,
      offset: 25,
      limit: 25,
      ...columnWindow
    });

    expect(response).toMatchObject({
      kind: "stepInspection",
      stepId: inspectionStep.id,
      revision: opened.metadata.revision,
      code: "# recovered prefix"
    });
    expect(coordinator.activeSession()?.metadata.source).toEqual(sourceBefore);
    expect(coordinator.activeSession()?.viewState).toEqual(viewBefore);
    expect(
      delegateRequest.mock.calls.map(([request]) => request).filter((request) => request.kind === "openSession")
    ).toEqual([openRequest, openRequest]);
    const pageProducingRequests = delegateRequest.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          request.kind === "getPage" ||
          request.kind === "previewStep" ||
          request.kind === "applyDraft" ||
          request.kind === "discardDraft" ||
          request.kind === "undoStep" ||
          request.kind === "inspectStep"
      );
    expect(pageProducingRequests.length).toBeGreaterThan(0);
    expect(
      pageProducingRequests.every(
        (request) =>
          request.columnOffset === openRequest.columnOffset && request.columnLimit === openRequest.columnLimit
      )
    ).toBe(true);
    expect(executionOrder).toEqual([
      "open-1",
      "inspect-runtime-1-2",
      "open-2",
      "preview-runtime-2-0",
      "apply-runtime-2-1",
      "restore-runtime-2-2-240-1",
      "close-runtime-1-2",
      "inspect-runtime-2-2"
    ]);
  });

  it("correlates applied-step inspections to the exact row and column window", async () => {
    const schema: SessionMetadata["schema"] = [
      { id: "c:first", name: "first", position: 0, rawType: "String", type: "string", nullable: false },
      { id: "c:second", name: "second", position: 1, rawType: "String", type: "string", nullable: false }
    ];
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 0, columns: 2 },
      filteredShape: { rows: 0, columns: 2 },
      schema,
      steps: [inspectionStep]
    };
    runtimeOpened.page = { ...runtimeOpened.page, columnIds: schema.map((column) => column.id) };
    const firstInspection = deferred<OpenWranglerResponse>();
    let firstRuntimeRequest: Extract<OpenWranglerRequest, { kind: "inspectStep" }> | undefined;
    const inspectionFor = (
      request: Extract<OpenWranglerRequest, { kind: "inspectStep" }>
    ): Extract<OpenWranglerResponse, { kind: "stepInspection" }> => {
      const columnIds = schema
        .slice(request.columnOffset, request.columnOffset + request.columnLimit)
        .map((column) => column.id);
      const projectedPage = {
        offset: request.offset,
        limit: request.limit,
        totalRows: 0,
        columnIds,
        rows: []
      };
      return {
        ...stepInspectionResponse(request),
        inputPage: projectedPage,
        outputPage: projectedPage,
        inputSchema: schema,
        outputSchema: schema
      };
    };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "inspectStep" && !firstRuntimeRequest) {
        firstRuntimeRequest = request;
        return firstInspection.promise;
      }
      if (request.kind === "inspectStep") return inspectionFor(request);
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const first = bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      stepId: inspectionStep.id,
      offset: 0,
      limit: 25,
      columnOffset: 0,
      columnLimit: 1
    });
    await vi.waitFor(() => expect(firstRuntimeRequest).toBeDefined());
    const second = bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      stepId: inspectionStep.id,
      offset: 0,
      limit: 25,
      columnOffset: 1,
      columnLimit: 1
    });
    firstInspection.resolve(inspectionFor(firstRuntimeRequest!));

    await expect(first).resolves.toMatchObject({ kind: "error", code: "stale_response" });
    await expect(second).resolves.toMatchObject({
      kind: "stepInspection",
      outputPage: { columnIds: ["c:second"] }
    });
    expect(coordinator.activeSession()?.stepInspection?.outputPage.columnIds).toEqual(["c:second"]);
  });

  it("ignores a superseded inspection and clears selection before a mutation is dispatched", async () => {
    const secondStep: TransformStep = {
      id: "drop-city",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "city" }] }
    };
    const previewStep: TransformStep = {
      id: "upper-city",
      kind: "upperText",
      params: { column: { id: "c:source:0", name: "city" } }
    };
    const firstInspection = deferred<OpenWranglerResponse>();
    const pendingPreview = deferred<OpenWranglerResponse>();
    const runtimeOpened = openedResponse();
    runtimeOpened.metadata = { ...runtimeOpened.metadata, steps: [inspectionStep, secondStep] };
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "inspectStep" && request.stepId === inspectionStep.id) return firstInspection.promise;
      if (request.kind === "inspectStep") return stepInspectionResponse(request, 1, "# second prefix");
      if (request.kind === "previewStep") return pendingPreview.promise;
      throw new Error(`Unexpected delegate request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") throw new Error("Expected the fake session to open.");

    const first = bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: 0,
      stepId: inspectionStep.id,
      offset: 0,
      limit: 25,
      ...columnWindow
    });
    await vi.waitFor(() => expect(delegateRequest).toHaveBeenCalledTimes(2));
    const second = bridge.request({
      kind: "inspectStep",
      sessionId: opened.metadata.sessionId,
      revision: 0,
      stepId: secondStep.id,
      offset: 0,
      limit: 25,
      ...columnWindow
    });
    firstInspection.resolve(
      stepInspectionResponse({
        kind: "inspectStep",
        sessionId: "runtime-session",
        revision: 0,
        stepId: inspectionStep.id,
        offset: 0,
        limit: 25,
        ...columnWindow
      })
    );
    await expect(first).resolves.toMatchObject({ kind: "error", code: "stale_response" });
    await expect(second).resolves.toMatchObject({ kind: "stepInspection", stepId: secondStep.id });
    expect(coordinator.activeSession()?.code).toBe("# second prefix");

    const preview = bridge.request({
      kind: "previewStep",
      sessionId: opened.metadata.sessionId,
      revision: 0,
      step: previewStep,
      offset: 0,
      limit: 25,
      ...columnWindow
    });
    expect(coordinator.activeSession()?.stepInspection).toBeUndefined();
    pendingPreview.resolve({
      ...stepPreviewResponse(1, previewStep),
      metadata: { ...runtimeOpened.metadata, revision: 1, draftStep: previewStep },
      page: { ...runtimeOpened.page, offset: 0, limit: 25 }
    });
    await expect(preview).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
  });
  it.each([
    { action: "discardDraft" as const, expectedAction: "discard" as const },
    { action: "applyDraft" as const, expectedAction: "apply" as const }
  ])("restores a persisted draft base before $expectedAction and preserves its view contract", async ({ action }) => {
    const baseSchema: SessionMetadata["schema"] = [
      { id: "c:market", name: "market", position: 0, rawType: "String", type: "string", nullable: false },
      { id: "c:revenue", name: "revenue", position: 1, rawType: "Int64", type: "integer", nullable: false }
    ];
    const draftSchema: SessionMetadata["schema"] = [
      { id: "c:revenue", name: "revenue", position: 0, rawType: "Int64", type: "integer", nullable: false }
    ];
    const step: TransformStep = {
      id: "drop-market",
      kind: "dropColumns",
      params: { columns: [{ id: "c:market", name: "market" }] }
    };
    const draftBaseFilterModel: FilterModel = {
      filters: [
        {
          column: "market",
          type: "string",
          predicates: [{ kind: "predicate", operator: "equals", value: "DACH" }]
        }
      ],
      sort: [
        { column: "market", direction: "asc", nulls: "last" },
        { column: "revenue", direction: "desc", nulls: "last" }
      ]
    };
    const reconciledFilterModel: FilterModel = {
      filters: [],
      sort: [{ column: "revenue", direction: "desc", nulls: "last" }]
    };
    const runtimeOpened = openedResponse("draft-receipt-runtime");
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 5, columns: 2 },
      filteredShape: { rows: 5, columns: 2 },
      schema: baseSchema
    };
    runtimeOpened.page = { ...runtimeOpened.page, totalRows: 5, columnIds: baseSchema.map((column) => column.id) };
    const persistedMetadata: SessionMetadata = {
      ...runtimeOpened.metadata,
      revision: 1,
      shape: { rows: 5, columns: 1 },
      filteredShape: { rows: 5, columns: 1 },
      schema: draftSchema,
      filterModel: reconciledFilterModel,
      draftStep: step
    };
    const key = persistenceKey(openRequest.source, "polars");
    let stored: Record<string, unknown> = {
      [key]: persistedSessionState(
        persistedMetadata,
        { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } },
        draftBaseFilterModel
      )
    };
    const workspaceState = {
      get: vi.fn((storageKey: string, fallback?: unknown) => (storageKey === SESSION_STORAGE_KEY ? stored : fallback)),
      update: vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
        stored = value;
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    let draftOpen = false;
    const viewRequests: FilterModel[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return runtimeOpened;
      if (request.kind === "getPage") {
        viewRequests.push(request.filterModel);
        const metadata = {
          ...(draftOpen ? persistedMetadata : runtimeOpened.metadata),
          revision: request.revision,
          filterModel: request.filterModel
        };
        return {
          kind: "page",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          metadata,
          page: projectedPage(request, metadata)
        };
      }
      if (request.kind === "previewStep") {
        draftOpen = true;
        const metadata = { ...persistedMetadata, revision: 1 };
        return {
          ...stepPreviewResponse(1, step, "draft-receipt-runtime"),
          metadata,
          page: projectedPage(request, metadata)
        };
      }
      if (request.kind === "discardDraft") {
        draftOpen = false;
        const metadata = {
          ...runtimeOpened.metadata,
          revision: 2,
          filterModel: draftBaseFilterModel
        };
        return {
          ...planUpdatedResponse(2, [], "draft-receipt-runtime"),
          action: "discard",
          metadata,
          page: projectedPage(request, metadata)
        };
      }
      if (request.kind === "applyDraft") {
        draftOpen = false;
        const metadata = {
          ...persistedMetadata,
          revision: 2,
          filterModel: reconciledFilterModel,
          steps: [step],
          draftStep: undefined
        };
        return {
          ...planUpdatedResponse(2, [step], "draft-receipt-runtime"),
          metadata,
          page: projectedPage(request, metadata)
        };
      }
      if (request.kind === "closeSession") {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected draft-receipt request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: delegateRequest });

    const restored = await bridge.request(openRequest);
    if (restored.kind !== "sessionOpened") throw new Error("Expected the persisted draft to restore.");
    expect(viewRequests).toEqual([draftBaseFilterModel, reconciledFilterModel]);

    const result = await bridge.request({
      kind: action,
      sessionId: restored.metadata.sessionId,
      revision: restored.metadata.revision,
      offset: 0,
      limit: 10,
      ...columnWindow
    });
    const expectedFilterModel = action === "discardDraft" ? draftBaseFilterModel : reconciledFilterModel;
    expect(result).toMatchObject({ kind: "planUpdated", metadata: { filterModel: expectedFilterModel } });
    expect(stored[key]).toMatchObject({
      cleaning: {
        steps: action === "applyDraft" ? [step] : []
      },
      view: { filterModel: expectedFilterModel }
    });
    const savedCleaning = (stored[key] as { cleaning: { draftStep?: unknown; draftBaseFilterModel?: unknown } })
      .cleaning;
    expect(savedCleaning.draftStep).toBeUndefined();
    expect(savedCleaning).not.toHaveProperty("draftBaseFilterModel");

    if (result.kind === "planUpdated") {
      await bridge.request({
        kind: "closeSession",
        sessionId: restored.metadata.sessionId,
        revision: result.revision
      });
    }
  });
});
