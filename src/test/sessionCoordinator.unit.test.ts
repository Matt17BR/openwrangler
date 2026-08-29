import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { NotebookDocument } from "vscode";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type { FilterModel } from "../shared/filterModel";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse
} from "../shared/protocol";
import {
  openRequest,
  columnWindow,
  openedResponse,
  pageResponseForMetadata,
  setOpenNotebookDocuments,
  deferred
} from "./sessionCoordinatorTestFixtures";

describe("SessionCoordinator", () => {
  it("observes asynchronous shutdown rejection from its synchronous disposable fallback", () => {
    const coordinator = new SessionCoordinator();
    const observeRejection = vi.fn((_onRejected: (reason: unknown) => unknown) => Promise.resolve());
    const shutdown = vi
      .spyOn(coordinator, "shutdown")
      .mockReturnValue({ catch: observeRejection } as unknown as Promise<void>);

    coordinator.dispose();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(observeRejection).toHaveBeenCalledOnce();
    expect(observeRejection.mock.calls[0][0]).toBeTypeOf("function");
  });

  it("forwards a fixed panel diagnostic without opening or changing a session", () => {
    const fallbackDiagnostic = vi.fn();
    const request = vi.fn(async (): Promise<OpenWranglerResponse> => {
      throw new Error("A diagnostic must not dispatch a runtime request.");
    });
    const reportDiagnostic = vi.fn();
    const coordinator = new SessionCoordinator(undefined, fallbackDiagnostic);
    const bridge = coordinator.createBridge({ request, reportDiagnostic });

    bridge.reportDiagnostic?.("Open Wrangler webview rendering stopped. A renderer reload was offered.");

    expect(reportDiagnostic).toHaveBeenCalledOnce();
    expect(reportDiagnostic).toHaveBeenCalledWith(
      "Open Wrangler webview rendering stopped. A renderer reload was offered."
    );
    expect(fallbackDiagnostic).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(coordinator.diagnostics()).toMatchObject({ activeSessionId: undefined, sessionCount: 0, sessions: [] });
  });

  it.each(["missing", "throwing"] as const)(
    "contains a %s delegate reporter and uses the fixed fallback diagnostic without changing a session",
    (reporter) => {
      const request = vi.fn(async (): Promise<OpenWranglerResponse> => {
        throw new Error("A diagnostic must not dispatch a runtime request.");
      });
      const fallbackDiagnostic = vi.fn();
      const reportDiagnostic = vi.fn(() => {
        throw new Error("private delegate diagnostic failure");
      });
      const coordinator = new SessionCoordinator(undefined, fallbackDiagnostic);
      const bridge = coordinator.createBridge({
        request,
        ...(reporter === "throwing" ? { reportDiagnostic } : {})
      });

      expect(() =>
        bridge.reportDiagnostic?.("Open Wrangler webview message handling stopped. A renderer reload was offered.")
      ).not.toThrow();

      if (reporter === "throwing") expect(reportDiagnostic).toHaveBeenCalledOnce();
      else expect(reportDiagnostic).not.toHaveBeenCalled();
      expect(fallbackDiagnostic).toHaveBeenCalledOnce();
      expect(fallbackDiagnostic).toHaveBeenCalledWith(
        "Open Wrangler webview message handling stopped. A renderer reload was offered."
      );
      expect(request).not.toHaveBeenCalled();
      expect(coordinator.diagnostics()).toMatchObject({ activeSessionId: undefined, sessionCount: 0, sessions: [] });
    }
  );

  it("translates live Excel sheet discovery through the confirmed runtime identity only", async () => {
    const source = {
      kind: "file" as const,
      label: "workbook.xlsx",
      path: "/workspace/workbook.xlsx",
      uri: "file:///workspace/workbook.xlsx",
      importOptions: { sheetIndex: 0 }
    };
    const runtimeOpened = openedResponse("private-excel", "polars");
    runtimeOpened.metadata = { ...runtimeOpened.metadata, source };
    const listExcelSheets = vi.fn(async () => ["Overview", "Sales"]);
    const delegate: OpenWranglerBridge = {
      request: vi.fn(async (): Promise<OpenWranglerResponse> => runtimeOpened),
      listExcelSheets
    };
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(delegate);
    const opened = await bridge.request({ ...openRequest, source });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the workbook session to open.");

    await expect(bridge.listExcelSheets?.(opened.metadata.sessionId, source, "polars")).resolves.toEqual([
      "Overview",
      "Sales"
    ]);
    expect(listExcelSheets).toHaveBeenCalledWith("private-excel", source, "polars", undefined);

    await expect(
      bridge.listExcelSheets?.(opened.metadata.sessionId, { ...source, path: "/workspace/other.xlsx" }, "polars")
    ).resolves.toBeUndefined();
    await expect(bridge.listExcelSheets?.(opened.metadata.sessionId, source, "pandas")).resolves.toBeUndefined();
    expect(listExcelSheets).toHaveBeenCalledOnce();
  });

  it("cancels a queued ephemeral clipboard page without cancelling visible work", async () => {
    const runtimeOpened = openedResponse("runtime-clipboard");
    runtimeOpened.metadata = {
      ...runtimeOpened.metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "String", type: "string", nullable: false }]
    };
    runtimeOpened.page = {
      offset: 0,
      limit: 100,
      totalRows: 2,
      columnIds: ["c:value"],
      rows: []
    };
    const blockingPage = deferred<OpenWranglerResponse>();
    let blockingRuntimeRequest: Extract<OpenWranglerRequest, { kind: "getPage" }> | undefined;
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, _options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return runtimeOpened;
        if (request.kind !== "getPage") throw new Error(`Unexpected clipboard page request: ${request.kind}`);
        if (request.viewRequestId === "blocking-page") {
          blockingRuntimeRequest = request;
          return blockingPage.promise;
        }
        return pageResponseForMetadata(request, runtimeOpened.metadata);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request(openRequest);
    if (opened.kind !== "sessionOpened") {
      throw new Error(`Expected the clipboard session to open: ${JSON.stringify(opened)}.`);
    }
    bridge.setViewContext?.(opened.metadata.sessionId, "view-a");
    const pageRequest = (viewRequestId: string) => ({
      kind: "getPage" as const,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId,
      offset: 0,
      limit: 2,
      columnOffset: 0,
      columnLimit: 1,
      filterModel: opened.metadata.filterModel
    });

    const activeVisiblePage = bridge.request(pageRequest("blocking-page"), { viewContextId: "view-a" });
    await vi.waitFor(() =>
      expect(delegateRequest).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "getPage", viewRequestId: "blocking-page" }),
        { viewContextId: "view-a" }
      )
    );
    const queuedClipboardPage = bridge.request(pageRequest("clipboard-cancelled"), {
      viewContextId: "view-a",
      ephemeralPage: true
    });
    bridge.cancelViewRequests?.(opened.metadata.sessionId, ["clipboard-cancelled"]);
    await expect(queuedClipboardPage).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getPage",
      viewRequestId: "clipboard-cancelled"
    });
    expect(delegateRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "getPage", viewRequestId: "clipboard-cancelled" }),
      expect.anything()
    );
    if (!blockingRuntimeRequest) throw new Error("Expected the blocking runtime page request to start.");
    blockingPage.resolve(pageResponseForMetadata(blockingRuntimeRequest, runtimeOpened.metadata));
    await expect(activeVisiblePage).resolves.toMatchObject({ kind: "page", viewRequestId: "blocking-page" });
  });

  it("exports through an exact public session and revision instead of the later active session", async () => {
    const makeDelegate = (runtimeId: string) =>
      vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          const opened = openedResponse(runtimeId);
          opened.metadata = { ...opened.metadata, source: request.source };
          return opened;
        }
        if (request.kind === "exportData") {
          return {
            kind: "dataExported",
            revision: request.revision,
            path: request.path,
            format: request.options.format,
            shape: { rows: 2, columns: 1 }
          };
        }
        throw new Error(`Unexpected exact-export request: ${request.kind}`);
      });
    const firstDelegate = makeDelegate("runtime-first");
    const secondDelegate = makeDelegate("runtime-second");
    const coordinator = new SessionCoordinator();
    const firstBridge = coordinator.createBridge({ request: firstDelegate });
    const secondBridge = coordinator.createBridge({ request: secondDelegate });
    const first = await firstBridge.request({
      ...openRequest,
      source: { kind: "file", label: "first.csv", path: "/workspace/first.csv" }
    });
    const second = await secondBridge.request({
      ...openRequest,
      source: { kind: "file", label: "second.csv", path: "/workspace/second.csv" }
    });
    if (first.kind !== "sessionOpened" || second.kind !== "sessionOpened") {
      throw new Error("Expected both exact-export sessions to open.");
    }
    expect(coordinator.activeSession()?.sessionId).toBe(second.metadata.sessionId);

    await expect(
      coordinator.exportData(first.metadata.sessionId, first.metadata.revision, "/tmp/first.csv", {
        format: "csv",
        delimiter: ",",
        quoteChar: '"',
        encoding: "utf-8",
        header: true
      })
    ).resolves.toMatchObject({ kind: "dataExported", path: "/tmp/first.csv", format: "csv" });
    expect(firstDelegate).toHaveBeenLastCalledWith(
      {
        kind: "exportData",
        sessionId: "runtime-first",
        revision: 0,
        path: "/tmp/first.csv",
        options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "utf-8", header: true }
      },
      undefined
    );
    expect(secondDelegate).toHaveBeenCalledOnce();

    await expect(
      coordinator.exportData(first.metadata.sessionId, first.metadata.revision, "/tmp/invalid-index.csv", {
        format: "csv",
        delimiter: ",",
        quoteChar: '"',
        encoding: "utf-8",
        header: true,
        rowAxisPolicy: "preserve"
      })
    ).rejects.toThrow("polars backend does not accept a Pandas row-axis policy");
    expect(firstDelegate).toHaveBeenCalledTimes(2);

    await expect(
      coordinator.exportData(first.metadata.sessionId, first.metadata.revision + 1, "/tmp/stale.csv", {
        format: "csv",
        delimiter: ",",
        quoteChar: '"',
        encoding: "utf-8",
        header: true
      })
    ).rejects.toThrow("Ignored stale request revision");
    expect(firstDelegate).toHaveBeenCalledTimes(2);
  });

  it("requires and forwards an explicit Pandas row-axis export policy only for Pandas", async () => {
    const delegate = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        const opened = openedResponse("runtime-pandas", "pandas");
        opened.metadata = { ...opened.metadata, source: request.source };
        return opened;
      }
      if (request.kind === "exportData") {
        return {
          kind: "dataExported",
          revision: request.revision,
          path: request.path,
          format: request.options.format,
          shape: { rows: 2, columns: 1 }
        };
      }
      throw new Error(`Unexpected Pandas export request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegate });
    const opened = await bridge.request({ ...openRequest, backend: "pandas" });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the Pandas session to open.");

    await expect(
      coordinator.exportData(opened.metadata.sessionId, opened.metadata.revision, "/tmp/missing.csv", {
        format: "csv",
        delimiter: ",",
        quoteChar: '"',
        encoding: "utf-8",
        header: true
      })
    ).rejects.toThrow("explicit preserve-or-omit");
    expect(delegate).toHaveBeenCalledOnce();

    await expect(
      coordinator.exportData(opened.metadata.sessionId, opened.metadata.revision, "/tmp/preserved.csv", {
        format: "csv",
        delimiter: ";",
        quoteChar: "'",
        encoding: "utf-16le",
        header: false,
        rowAxisPolicy: "preserve"
      })
    ).resolves.toMatchObject({ kind: "dataExported", path: "/tmp/preserved.csv" });
    expect(delegate).toHaveBeenLastCalledWith(
      {
        kind: "exportData",
        sessionId: "runtime-pandas",
        revision: 0,
        path: "/tmp/preserved.csv",
        options: {
          format: "csv",
          delimiter: ";",
          quoteChar: "'",
          encoding: "utf-16le",
          header: false,
          rowAxisPolicy: "preserve"
        }
      },
      undefined
    );
  });

  it.each(["pyspark_connect_unavailable", "pyspark_connect_state_lost"] as const)(
    "keeps the confirmed PySpark view after %s",
    async (code) => {
      const source = {
        kind: "notebookVariable" as const,
        label: "orders",
        variableName: "orders",
        uri: "file:///workspace/spark.ipynb"
      };
      const runtimeOpened = openedResponse("spark-runtime", "pyspark");
      runtimeOpened.metadata = {
        ...runtimeOpened.metadata,
        source,
        mode: "viewing",
        capabilities: {
          editable: false,
          lazy: false,
          cancel: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: false
        }
      };
      const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") return runtimeOpened;
        if (request.kind === "getPage") {
          return {
            kind: "error",
            code,
            message: "Spark Connect request failed.",
            recoverable: true,
            sessionId: request.sessionId,
            viewRequestId: request.viewRequestId
          };
        }
        throw new Error(`Unexpected Spark Connect failure request: ${request.kind}`);
      });
      const coordinator = new SessionCoordinator();
      const bridge = coordinator.createBridge({ request: delegateRequest });
      const opened = await bridge.request({ ...openRequest, source, backend: "pyspark", mode: "viewing" });
      if (opened.kind !== "sessionOpened") throw new Error("Expected the PySpark session to open.");
      await bridge.updateViewState?.(opened.metadata.sessionId, {
        selectedColumnId: "c:value",
        columnWidths: new Map([["c:value", 240]]),
        viewport: { firstVisibleRow: 12, scrollLeft: 40 }
      });
      const confirmed = coordinator.activeSession();

      const response = await bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        offset: 100,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16,
        filterModel: {
          filters: [],
          sort: [{ column: "value", direction: "desc", nulls: "last" }]
        },
        viewRequestId: `spark-connect-${code}`
      });

      expect(response).toMatchObject({
        kind: "error",
        code,
        recoverable: true,
        sessionId: opened.metadata.sessionId,
        viewRequestId: `spark-connect-${code}`
      });
      expect(coordinator.activeSession()).toEqual(confirmed);
      expect(delegateRequest.mock.calls.map(([request]) => request.kind)).toEqual(["openSession", "getPage"]);
    }
  );

  it("requires an explicit same-kernel reconnect after Spark Connect loses the dataframe", async () => {
    const notebook = {
      uri: vscode.Uri.parse("file:///workspace/connect-reconnect.ipynb"),
      isClosed: false
    } as NotebookDocument;
    const source = {
      kind: "notebookVariable" as const,
      label: "orders",
      variableName: "orders",
      uri: notebook.uri.toString()
    };
    const schema = [
      { id: "c:value", name: "value", position: 0, rawType: "bigint", type: "integer" as const, nullable: false }
    ];
    const openedFor = (runtimeId: string, openedSchema = schema): SessionOpenedResponse => {
      const opened = openedResponse(runtimeId, "pyspark");
      opened.metadata = {
        ...opened.metadata,
        source,
        mode: "viewing",
        capabilities: {
          editable: false,
          lazy: false,
          cancel: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: false
        },
        shape: { rows: null, columns: 1 },
        filteredShape: { rows: null, columns: 1 },
        schema: openedSchema
      };
      return {
        ...opened,
        page: {
          offset: 0,
          limit: 100,
          totalRows: null,
          hasMore: true,
          columnIds: ["c:value"],
          rows: []
        }
      };
    };
    let openCount = 0;
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind === "openSession") {
          openCount += 1;
          if (openCount > 1) expect(options?.requiredKernelSessionId).toBe("spark-runtime-1");
          if (openCount === 2) {
            return openedFor("spark-runtime-2", [
              { id: "c:changed", name: "changed", position: 0, rawType: "bigint", type: "integer", nullable: false }
            ]);
          }
          return openedFor(`spark-runtime-${openCount}`);
        }
        if (request.kind === "getPage" && request.sessionId === "spark-runtime-1") {
          return {
            kind: "error",
            code: "pyspark_connect_state_lost",
            message: "Run the cell that creates orders, then choose Reconnect.",
            recoverable: true,
            sessionId: request.sessionId,
            viewRequestId: request.viewRequestId
          };
        }
        if (request.kind === "getPage" && request.sessionId === "spark-runtime-3") {
          return {
            kind: "page",
            revision: request.revision,
            viewRequestId: request.viewRequestId,
            metadata: { ...openedFor(request.sessionId).metadata, filterModel: request.filterModel },
            page: {
              offset: request.offset,
              limit: request.limit,
              totalRows: null,
              hasMore: true,
              columnIds: ["c:value"],
              rows: []
            }
          };
        }
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`Unexpected explicit reconnect request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest }, notebook);
    setOpenNotebookDocuments(notebook);

    try {
      const opened = await bridge.request({ ...openRequest, source, backend: "pyspark", mode: "viewing" });
      if (opened.kind !== "sessionOpened") throw new Error("Expected the Spark Connect dataframe to open.");
      await bridge.updateViewState?.(opened.metadata.sessionId, {
        selectedColumnId: "c:value",
        columnWidths: new Map([["c:value", 260]]),
        viewport: { firstVisibleRow: 12, scrollLeft: 40 }
      });
      const confirmed = coordinator.activeSession();

      const lost = await bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "connect-state-lost",
        offset: 100,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      });
      expect(lost).toMatchObject({ kind: "error", code: "pyspark_connect_state_lost" });
      expect(coordinator.activeSession()).toEqual(confirmed);

      const ordinaryRetry = await bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "ordinary-retry",
        offset: 100,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      });
      expect(ordinaryRetry).toMatchObject({
        kind: "error",
        code: "pyspark_connect_state_lost",
        viewRequestId: "ordinary-retry"
      });
      expect(openCount).toBe(1);
      expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "getPage")).toHaveLength(1);

      const rejectedReconnect = await bridge.reconnectLiveSession?.(
        opened.metadata.sessionId,
        opened.metadata.revision
      );
      expect(rejectedReconnect).toMatchObject({ kind: "error", code: "pyspark_connect_state_lost" });
      expect(coordinator.activeSession()).toEqual(confirmed);
      expect(openCount).toBe(2);

      const reconnected = await bridge.reconnectLiveSession?.(opened.metadata.sessionId, opened.metadata.revision);
      expect(reconnected).toMatchObject({
        kind: "sessionOpened",
        metadata: {
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          backend: "pyspark",
          source
        },
        page: { offset: 0, columnIds: ["c:value"] }
      });
      expect(openCount).toBe(3);
      expect(coordinator.activeSession()?.viewState).toEqual(confirmed?.viewState);
      expect(
        delegateRequest.mock.calls
          .filter(([request]) => request.kind === "openSession")
          .map(([, options]) => options?.requiredKernelSessionId)
      ).toEqual([undefined, "spark-runtime-1", "spark-runtime-1"]);
    } finally {
      setOpenNotebookDocuments();
      await coordinator.shutdown();
    }
  });

  it("rebinds an invalidated PySpark variable without losing the confirmed compound view", async () => {
    const source = {
      kind: "notebookVariable" as const,
      label: "spark_frame",
      variableName: "spark_frame",
      uri: "file:///workspace/spark-recovery.ipynb"
    };
    const schema = [
      { id: "c:region", name: "region", position: 0, rawType: "string", type: "string" as const, nullable: true },
      { id: "c:sales", name: "sales", position: 1, rawType: "bigint", type: "integer" as const, nullable: false }
    ];
    const filterModel: FilterModel = {
      logic: "and",
      filters: [
        {
          column: "region",
          type: "string",
          logic: "and",
          predicates: [{ kind: "predicate", operator: "contains", value: "north" }]
        }
      ],
      sort: [
        { column: "sales", direction: "desc", nulls: "last" },
        { column: "region", direction: "asc", nulls: "first" }
      ]
    };
    const sparkRows = (offset: number, limit: number) =>
      Array.from({ length: Math.min(limit, 500 - offset) }, (_, position) => {
        const rowNumber = offset + position;
        return {
          id: `r:spark:${rowNumber}`,
          rowNumber,
          values: [
            {
              raw: `region-${rowNumber}`,
              display: `region-${rowNumber}`,
              kind: "string" as const,
              isNull: false,
              isNaN: false
            },
            {
              raw: String(rowNumber),
              display: String(rowNumber),
              kind: "integer" as const,
              isNull: false,
              isNaN: false
            }
          ]
        };
      });
    const sparkOpened = (runtimeId: string): SessionOpenedResponse => {
      const response: SessionOpenedResponse = openedResponse(runtimeId, "pyspark");
      response.metadata = {
        ...response.metadata,
        source,
        mode: "viewing",
        capabilities: {
          editable: false,
          lazy: false,
          cancel: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: false
        },
        shape: { rows: null, columns: 2 },
        filteredShape: { rows: null, columns: 2 },
        schema,
        steps: []
      };
      response.page = {
        offset: 0,
        limit: 100,
        totalRows: null,
        hasMore: true,
        columnIds: schema.map((column) => column.id),
        rows: sparkRows(0, 100)
      };
      return response;
    };
    const sparkPage = (
      request: Extract<OpenWranglerRequest, { kind: "getPage" }>
    ): Extract<OpenWranglerResponse, { kind: "page" }> => {
      const rows = sparkRows(request.offset, request.limit);
      const hasMore = request.offset + rows.length < 500;
      const metadata = {
        ...sparkOpened(request.sessionId).metadata,
        filterModel: request.filterModel,
        ...(hasMore
          ? {}
          : {
              shape: { rows: 500, columns: 2 },
              filteredShape: { rows: 500, columns: 2 }
            })
      };
      return {
        kind: "page",
        revision: request.revision,
        viewRequestId: request.viewRequestId,
        metadata,
        page: hasMore
          ? {
              offset: request.offset,
              limit: request.limit,
              totalRows: null,
              hasMore: true,
              columnIds: schema.map((column) => column.id),
              rows
            }
          : {
              offset: request.offset,
              limit: request.limit,
              totalRows: 500,
              columnIds: schema.map((column) => column.id),
              rows
            }
      };
    };
    let openCount = 0;
    let invalidated = false;
    const reboundOpen = deferred<SessionOpenedResponse>();
    const delegateRequest = vi.fn(
      async (request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (request.kind !== "openSession" && options?.requiredKernelSessionId !== undefined) {
          throw new Error("Exact-kernel recovery provenance leaked past the replacement open.");
        }
        if (request.kind === "openSession") {
          openCount += 1;
          return openCount === 1 ? sparkOpened("spark-runtime-1") : reboundOpen.promise;
        }
        if (request.kind === "getPage") {
          if (request.viewRequestId === "pyspark-rebind" && request.sessionId === "spark-runtime-1" && !invalidated) {
            invalidated = true;
            return {
              kind: "error",
              code: "live_source_invalidated",
              message: "The live PySpark variable was replaced. Rerun its defining cell, then retry.",
              recoverable: true,
              sessionId: request.sessionId,
              viewRequestId: request.viewRequestId
            };
          }
          return sparkPage(request);
        }
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`Unexpected PySpark recovery request: ${request.kind}`);
      }
    );
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request({
      ...openRequest,
      source,
      backend: "pyspark",
      mode: "viewing"
    });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the PySpark variable to open.");

    for (const offset of [0, 100, 200]) {
      await expect(
        bridge.request({
          kind: "getPage",
          sessionId: opened.metadata.sessionId,
          revision: opened.metadata.revision,
          viewRequestId: `pyspark-confirm-view-${offset}`,
          offset,
          limit: 100,
          ...columnWindow,
          filterModel
        })
      ).resolves.toMatchObject({ kind: "page", metadata: { filterModel } });
    }
    await bridge.updateViewState?.(opened.metadata.sessionId, {
      selectedColumnId: "c:sales",
      columnWidths: new Map([
        ["c:region", 210],
        ["c:sales", 180]
      ]),
      viewport: { firstVisibleRow: 240, scrollLeft: 160 }
    });
    const confirmedView = coordinator.activeSession()?.viewState;

    const recovery = bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "pyspark-rebind",
      offset: 200,
      limit: 100,
      ...columnWindow,
      filterModel
    });
    await vi.waitFor(() => expect(openCount).toBe(2));
    await bridge.updateViewState?.(opened.metadata.sessionId, {
      selectedColumnId: "c:region",
      columnWidths: new Map([
        ["c:region", 260],
        ["c:sales", 150]
      ]),
      viewport: { firstVisibleRow: 310, scrollLeft: 240 }
    });
    const latestView = coordinator.activeSession()?.viewState;
    expect(latestView).not.toEqual(confirmedView);
    reboundOpen.resolve(sparkOpened("spark-runtime-2"));
    const recovered = await recovery;

    expect(recovered).toMatchObject({
      kind: "page",
      metadata: {
        sessionId: opened.metadata.sessionId,
        backend: "pyspark",
        filterModel
      }
    });
    expect(openCount).toBe(2);
    expect(coordinator.activeSession()?.viewState).toEqual(latestView);
    expect(delegateRequest.mock.calls.filter(([request]) => request.kind === "openSession")[1]?.[1]).toMatchObject({
      requiredKernelSessionId: "spark-runtime-1"
    });
    expect(
      delegateRequest.mock.calls
        .map(([request]) => request)
        .filter((request): request is Extract<OpenWranglerRequest, { kind: "getPage" }> => request.kind === "getPage")
        .filter((request) => request.sessionId === "spark-runtime-2")
        .map((request) => ({ offset: request.offset, filterModel: request.filterModel }))
    ).toEqual([
      { offset: 0, filterModel },
      { offset: 100, filterModel },
      { offset: 200, filterModel },
      { offset: 200, filterModel }
    ]);
    await vi.waitFor(() => {
      expect(delegateRequest).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "closeSession", sessionId: "spark-runtime-1" }),
        expect.any(Object)
      );
    });
  });

  it.each([
    {
      label: "resets an over-cap PySpark recovery viewport without unbounded page replay",
      firstVisibleRow: Number.MAX_SAFE_INTEGER,
      replacementRows: null
    },
    {
      label: "starts exact-total PySpark recovery at zero when the replacement source shrank",
      firstVisibleRow: 240,
      replacementRows: 20
    }
  ])("$label", async ({ firstVisibleRow, replacementRows }) => {
    const source = {
      kind: "notebookVariable" as const,
      label: "bounded_spark_frame",
      variableName: "bounded_spark_frame",
      uri: "file:///workspace/bounded-spark-recovery.ipynb"
    };
    const schema = [
      { id: "c:value", name: "value", position: 0, rawType: "bigint", type: "integer" as const, nullable: false }
    ];
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "value", direction: "desc", nulls: "last" }]
    };
    const rows = (offset: number, limit: number, totalRows: number | null) =>
      Array.from(
        {
          length: totalRows === null ? limit : Math.min(limit, Math.max(0, totalRows - offset))
        },
        (_, position) => {
          const rowNumber = offset + position;
          return {
            id: `r:bounded-spark:${rowNumber}`,
            rowNumber,
            values: [
              {
                raw: String(rowNumber),
                display: String(rowNumber),
                kind: "integer" as const,
                isNull: false,
                isNaN: false
              }
            ]
          };
        }
      );
    const metadataFor = (runtimeId: string, totalRows: number | null, model: FilterModel): SessionMetadata => ({
      ...openedResponse(runtimeId, "pyspark").metadata,
      sessionId: runtimeId,
      backend: "pyspark",
      mode: "viewing",
      source,
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: totalRows, columns: 1 },
      filteredShape: { rows: totalRows, columns: 1 },
      schema,
      filterModel: model,
      steps: []
    });
    const pageFor = (offset: number, limit: number, totalRows: number | null): SessionOpenedResponse["page"] => {
      const pageRows = rows(offset, limit, totalRows);
      return totalRows === null
        ? {
            offset,
            limit,
            totalRows: null,
            hasMore: true,
            columnIds: ["c:value"],
            rows: pageRows
          }
        : {
            offset,
            limit,
            totalRows,
            columnIds: ["c:value"],
            rows: pageRows
          };
    };
    const openedFor = (runtimeId: string, totalRows: number | null): SessionOpenedResponse => ({
      kind: "sessionOpened",
      metadata: metadataFor(runtimeId, totalRows, { filters: [], sort: [] }),
      page: pageFor(0, 100, totalRows),
      summaries: []
    });
    let openCount = 0;
    let invalidated = false;
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        return openedFor(
          openCount === 1 ? "bounded-spark-runtime-1" : "bounded-spark-runtime-2",
          openCount === 1 ? null : replacementRows
        );
      }
      if (request.kind === "getPage") {
        if (
          request.sessionId === "bounded-spark-runtime-1" &&
          request.viewRequestId === "bounded-spark-rebind" &&
          !invalidated
        ) {
          invalidated = true;
          return {
            kind: "error",
            code: "live_source_invalidated",
            message: "The live PySpark variable was replaced.",
            recoverable: true,
            sessionId: request.sessionId,
            viewRequestId: request.viewRequestId
          };
        }
        const totalRows = request.sessionId === "bounded-spark-runtime-2" ? replacementRows : null;
        return {
          kind: "page",
          revision: request.revision,
          viewRequestId: request.viewRequestId,
          metadata: metadataFor(request.sessionId, totalRows, request.filterModel),
          page: pageFor(request.offset, request.limit, totalRows)
        };
      }
      if (request.kind === "closeSession") {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected bounded PySpark recovery request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request({
      ...openRequest,
      source,
      backend: "pyspark",
      mode: "viewing"
    });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the bounded PySpark variable to open.");

    await bridge.request({
      kind: "getPage",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "bounded-spark-confirm-view",
      offset: 0,
      limit: 100,
      ...columnWindow,
      filterModel
    });
    await bridge.updateViewState?.(opened.metadata.sessionId, {
      selectedColumnId: "c:value",
      columnWidths: new Map([["c:value", 260]]),
      viewport: { firstVisibleRow, scrollLeft: 77 }
    });

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "bounded-spark-rebind",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel
      })
    ).resolves.toMatchObject({ kind: "page", metadata: { filterModel } });

    const replacementPages = delegateRequest.mock.calls
      .map(([request]) => request)
      .filter(
        (request): request is Extract<OpenWranglerRequest, { kind: "getPage" }> =>
          request.kind === "getPage" && request.sessionId === "bounded-spark-runtime-2"
      );
    expect(replacementPages.map((request) => request.offset)).toEqual([0, 0]);
    expect(replacementPages.map((request) => request.filterModel)).toEqual([filterModel, filterModel]);
    expect(coordinator.activeSession()).toMatchObject({
      metadata: { filterModel },
      viewState: {
        selectedColumnId: "c:value",
        columnWidths: new Map([["c:value", 260]]),
        viewport: { firstVisibleRow: 0, scrollLeft: 77 }
      }
    });
  });

  it("keeps an invalidated PySpark session retryable when the rebound schema changed", async () => {
    const source = {
      kind: "notebookVariable" as const,
      label: "spark_frame",
      variableName: "spark_frame",
      uri: "file:///workspace/spark-schema.ipynb"
    };
    const original = openedResponse("spark-runtime-1", "pyspark");
    original.metadata = {
      ...original.metadata,
      source,
      mode: "viewing",
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "bigint", type: "integer", nullable: false }],
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 }
    };
    original.page = { ...original.page, totalRows: 1, columnIds: ["c:value"] };
    const changed = openedResponse("spark-runtime-2", "pyspark");
    changed.metadata = {
      ...original.metadata,
      sessionId: "spark-runtime-2",
      schema: [{ id: "c:value", name: "renamed", position: 0, rawType: "bigint", type: "integer", nullable: false }]
    };
    changed.page = { ...original.page, columnIds: ["c:value"] };
    let openCount = 0;
    const closed: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return ++openCount === 1 ? original : changed;
      if (request.kind === "getPage") {
        return {
          kind: "error",
          code: "live_source_invalidated",
          message: "The live PySpark variable changed. Rerun it, then retry or reopen after a schema change.",
          recoverable: true,
          sessionId: request.sessionId,
          viewRequestId: request.viewRequestId
        };
      }
      if (request.kind === "closeSession") {
        closed.push(request.sessionId);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected PySpark schema recovery request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request({ ...openRequest, source, backend: "pyspark", mode: "viewing" });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the PySpark variable to open.");

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "pyspark-schema-change",
        offset: 0,
        limit: 100,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "live_source_invalidated",
      sessionId: opened.metadata.sessionId,
      recoverable: true,
      message: expect.stringContaining("reopen after a schema change")
    });
    expect(openCount).toBe(2);
    expect(coordinator.activeSession()?.metadata.schema).toEqual(original.metadata.schema);
    expect(closed).toEqual(["spark-runtime-2"]);
  });

  it("rejects a same-schema PySpark rebound when the exact confirmed view cannot be restored", async () => {
    const source = {
      kind: "notebookVariable" as const,
      label: "spark_frame",
      variableName: "spark_frame",
      uri: "file:///workspace/spark-view-recovery.ipynb"
    };
    const filterModel: FilterModel = {
      filters: [],
      sort: [{ column: "value", direction: "desc", nulls: "last" }]
    };
    const openedFor = (sessionId: string): SessionOpenedResponse => {
      const response = openedResponse(sessionId, "pyspark");
      response.metadata = {
        ...response.metadata,
        source,
        mode: "viewing",
        shape: { rows: 10, columns: 1 },
        filteredShape: { rows: 10, columns: 1 },
        schema: [{ id: "c:value", name: "value", position: 0, rawType: "bigint", type: "integer", nullable: false }]
      };
      response.page = { ...response.page, totalRows: 10, columnIds: ["c:value"] };
      return response;
    };
    let openCount = 0;
    let restoreAttempts = 0;
    const closed: string[] = [];
    const delegateRequest = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") return openedFor(`spark-runtime-${++openCount}`);
      if (request.kind === "getPage") {
        if (request.sessionId === "spark-runtime-1" && request.viewRequestId === "strict-spark-rebind") {
          return {
            kind: "error",
            code: "live_source_invalidated",
            message: "The live PySpark dataframe was replaced. Recreate it, then retry.",
            recoverable: true,
            sessionId: request.sessionId,
            viewRequestId: request.viewRequestId
          };
        }
        if (request.sessionId === "spark-runtime-2" && request.viewRequestId.startsWith("restore:")) {
          restoreAttempts += 1;
          if (restoreAttempts === 1) {
            return {
              kind: "error",
              code: "engine_error",
              message: "Transient Spark read failure while restoring the saved view.",
              recoverable: true,
              sessionId: request.sessionId,
              viewRequestId: request.viewRequestId
            };
          }
        }
        return pageResponseForMetadata(request, openedFor(request.sessionId).metadata);
      }
      if (request.kind === "closeSession") {
        closed.push(request.sessionId);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected strict PySpark recovery request: ${request.kind}`);
    });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: delegateRequest });
    const opened = await bridge.request({ ...openRequest, source, backend: "pyspark", mode: "viewing" });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the PySpark variable to open.");

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "confirm-strict-spark-view",
        offset: 0,
        limit: 10,
        ...columnWindow,
        filterModel
      })
    ).resolves.toMatchObject({ kind: "page", metadata: { filterModel } });

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "strict-spark-rebind",
        offset: 0,
        limit: 10,
        ...columnWindow,
        filterModel
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "live_source_invalidated",
      sessionId: opened.metadata.sessionId
    });
    expect(restoreAttempts).toBe(1);
    expect(coordinator.activeSession()?.metadata.filterModel).toEqual(filterModel);
    expect(closed).toEqual(["spark-runtime-2"]);
  });
});
