import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnSummary, GridPage, OpenWranglerResponse, SessionMetadata, TransformStep } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { App } from "../webviews/App";
import { alignedColumnWindow } from "../webviews/appState";

const step: TransformStep = {
  id: "round-column",
  kind: "roundNumber",
  params: { column: { id: "c:20", name: "column-20" }, decimals: 0 }
};

const schema = Array.from({ length: 40 }, (_, position) => ({
  id: `c:${position}`,
  name: `column-${position}`,
  position,
  rawType: "String",
  type: "string" as const,
  nullable: false
}));

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "wide-session",
  revision: 0,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "wide.csv", path: "wide.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 400, columns: schema.length },
  filteredShape: { rows: 400, columns: schema.length },
  filterModel: { filters: [], sort: [] },
  steps: [step],
  schema
};

describe("App column projection", () => {
  beforeEach(() => postMessage.mockClear());

  it("shifts a maximum-size window so a visible range crossing an alignment boundary stays covered", () => {
    const window = alignedColumnWindow({ start: 250, end: 270 }, 1_000, 256);
    expect(window).toEqual({ offset: 250, limit: 256 });
    expect(window.offset).toBeLessThanOrEqual(250);
    expect(window.offset + window.limit).toBeGreaterThanOrEqual(270);

    expect(alignedColumnWindow({ start: 250, end: 270 }, 300, 256)).toEqual({ offset: 44, limit: 256 });
  });

  it("preserves one aligned column window across rows, filters, mutations, and inspection", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);

    const projectionRequest = await onlyRuntimeRequest("getPage");
    expect(projectionRequest).toMatchObject({ offset: 0, limit: 200, columnOffset: 16, columnLimit: 16 });
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Next block" })).toBeEnabled();
    dispatch({
      kind: "error",
      code: "engine_error",
      message: "Projection failed once",
      recoverable: true,
      viewRequestId: String(projectionRequest.viewRequestId)
    });
    expect(await screen.findByRole("button", { name: "Retry page" })).toBeVisible();

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    const projectionRetry = await onlyRuntimeRequest("getPage");
    expect(projectionRetry).toMatchObject({ offset: 0, limit: 200, columnOffset: 16, columnLimit: 16 });
    expect(projectionRetry.viewRequestId).not.toBe(projectionRequest.viewRequestId);
    dispatch(pageResponse(projectionRetry, metadata, projectedPage(0, 16)));

    const projectedCell = await screen.findByRole("cell", { name: "value-20-row-0" });
    expect(projectedCell).toHaveAttribute("aria-colindex", "22");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "41");

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const rowRequest = await onlyRuntimeRequest("getPage");
    expect(rowRequest).toMatchObject({ offset: 200, columnOffset: 16, columnLimit: 16 });
    dispatch(pageResponse(rowRequest, metadata, projectedPage(200, 16)));
    await screen.findByRole("cell", { name: "value-20-row-200" });

    postMessage.mockClear();
    fireEvent.click(screen.getByLabelText("Column actions for column-20"));
    const menu = screen.getByLabelText("Column actions for column-20").closest("details");
    expect(menu).not.toBeNull();
    fireEvent.click(within(menu!).getByRole("button", { name: "Sort ascending" }));
    const filterRequest = await onlyRuntimeRequest("getPage");
    expect(filterRequest).toMatchObject({ offset: 0, columnOffset: 16, columnLimit: 16 });
    const sortedMetadata = {
      ...metadata,
      filterModel: { filters: [], sort: [{ column: "column-20", direction: "asc" as const, nulls: "last" as const }] }
    };
    dispatch(pageResponse(filterRequest, sortedMetadata, projectedPage(0, 16)));
    await screen.findByRole("cell", { name: "value-20-row-0" });

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "applyDraft" });
    const mutationRequest = await onlyRuntimeRequest("applyDraft");
    expect(mutationRequest).toMatchObject({ columnOffset: 16, columnLimit: 16 });
    dispatch({ kind: "error", code: "engine_error", message: "Expected test failure", recoverable: true });

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    const inspectionRequest = await onlyRuntimeRequest("inspectStep");
    expect(inspectionRequest).toMatchObject({ offset: 0, columnOffset: 16, columnLimit: 16 });
  });

  it("keeps successful integer profiles across horizontal projections out of warning diagnostics", async () => {
    const integerMetadata: SessionMetadata = {
      ...metadata,
      schema: schema.map((column) => ({ ...column, rawType: "Int64", type: "integer" as const }))
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: integerMetadata, page: integerProjectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "0" });
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 760 });
    fireEvent.scroll(scroller);

    await waitFor(() => expect(runtimeRequests("getSummary").length).toBeGreaterThan(0));
    const profiledColumnIds = new Set<string>();
    for (const request of runtimeRequests("getSummary")) {
      const columnId = String((request.columnIds as string[])[0]);
      profiledColumnIds.add(columnId);
      dispatch({
        kind: "summary",
        revision: integerMetadata.revision,
        viewRequestId: String(request.viewRequestId),
        summaries: [integerSummary(columnId)]
      });
    }
    expect(screen.queryByRole("status", { name: "Profiling diagnostics" })).not.toBeInTheDocument();

    postMessage.mockClear();
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    const projectionRequest = await onlyRuntimeRequest("getPage");
    dispatch(pageResponse(projectionRequest, integerMetadata, integerProjectedPage(0, 16)));

    await waitFor(() => expect(runtimeRequests("getSummary").length).toBeGreaterThan(0));
    const projectedRequests = runtimeRequests("getSummary");
    for (const request of projectedRequests.slice(0, -1)) {
      const columnId = String((request.columnIds as string[])[0]);
      profiledColumnIds.add(columnId);
      dispatch({
        kind: "summary",
        revision: integerMetadata.revision,
        viewRequestId: String(request.viewRequestId),
        summaries: [integerSummary(columnId)]
      });
    }
    const genuineFailure = projectedRequests.at(-1);
    if (!genuineFailure) throw new Error("Expected a projected integer summary request.");
    profiledColumnIds.add(String((genuineFailure.columnIds as string[])[0]));
    dispatch({
      kind: "error",
      code: "engine_error",
      message: "Genuine projected profile failure",
      recoverable: true,
      viewRequestId: String(genuineFailure.viewRequestId)
    });

    expect(profiledColumnIds.size).toBeGreaterThanOrEqual(8);
    const diagnostic = await screen.findByRole("status", { name: "Profiling diagnostics" });
    expect(diagnostic).toHaveTextContent("Profile warning: Genuine projected profile failure");
    expect(diagnostic.textContent?.match(/Genuine projected profile failure/gu)).toHaveLength(1);
  });

  it("reconciles a horizontal scroll that arrives while the next row block is pending", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const rowRequest = await onlyRuntimeRequest("getPage");
    expect(rowRequest).toMatchObject({ offset: 200, columnOffset: 0, columnLimit: 16 });

    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    expect(runtimeRequests("getPage")).toHaveLength(1);

    dispatch(pageResponse(rowRequest, metadata, projectedPage(200, 0)));
    await waitFor(() => expect(runtimeRequests("getPage")).toHaveLength(2));
    const projectionRequest = runtimeRequests("getPage")[1];
    expect(projectionRequest).toMatchObject({ offset: 200, columnOffset: 16, columnLimit: 16 });

    dispatch(pageResponse(projectionRequest, metadata, projectedPage(200, 16)));
    expect(await screen.findByRole("cell", { name: "value-20-row-200" })).toBeVisible();
  });

  it("reconciles the current page after a pending mutation fails during horizontal scrolling", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "applyDraft" });
    await onlyRuntimeRequest("applyDraft");

    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    dispatch({
      kind: "error",
      code: "engine_error",
      message: "Mutation failed",
      recoverable: true
    });

    await waitFor(() => expect(runtimeRequests("getPage")).toHaveLength(1));
    const projectionRequest = runtimeRequests("getPage")[0];
    expect(projectionRequest).toMatchObject({ offset: 0, columnOffset: 16, columnLimit: 16 });
    dispatch(pageResponse(projectionRequest, metadata, projectedPage(0, 16)));

    expect(await screen.findByRole("cell", { name: "value-20-row-0" })).toBeVisible();
  });

  it("lets the latest queued operation replace inspection while projection loading disables mutations", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    const projectionRequest = await onlyRuntimeRequest("getPage");

    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(
      "Loading visible columns… Cleaning actions are temporarily unavailable."
    );
    expect(screen.getByRole("button", { name: "Add step" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit latest" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

    dispatch({ kind: "editorAction", action: "applyDraft" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wait for the visible columns to finish loading before changing the cleaning plan."
    );
    expect(runtimeRequests("applyDraft")).toHaveLength(0);

    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    expect(runtimeRequests("inspectStep")).toHaveLength(0);

    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "castColumn" });
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();

    dispatch(pageResponse(projectionRequest, metadata, projectedPage(0, 16)));
    expect(await screen.findByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByText("Convert type", { selector: "strong" })).toBeInTheDocument();
    expect(runtimeRequests("inspectStep")).toHaveLength(0);
  });

  it("queues Edit latest during projection and hydrates the exact applied step after the page settles", async () => {
    const latestStep: TransformStep = {
      id: "lower-column-20",
      kind: "lowerText",
      params: { column: { id: "c:20", name: "column-20" }, newColumn: "normalized" }
    };
    const editingMetadata: SessionMetadata = {
      ...metadata,
      steps: [latestStep],
      latestStepInputSchema: schema
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: editingMetadata, page: projectedPage(0, 0), summaries: [] });
    await screen.findByRole("cell", { name: "value-0-row-0" });

    postMessage.mockClear();
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    const projectionRequest = await onlyRuntimeRequest("getPage");

    dispatch({
      kind: "editorAction",
      action: "editLatest",
      expectedSessionId: editingMetadata.sessionId,
      expectedRevision: editingMetadata.revision
    });
    expect(screen.queryByRole("dialog", { name: "Edit cleaning step" })).toBeNull();

    dispatch(pageResponse(projectionRequest, editingMetadata, projectedPage(0, 16)));

    const dialog = await screen.findByRole("dialog", { name: "Edit cleaning step" });
    expect(within(dialog).getByText("Lowercase", { selector: "strong" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Text column")).toHaveValue("c:20");
    expect(within(dialog).getByLabelText("Output column (blank replaces in place)")).toHaveValue("normalized");
  });

  it("reissues an added-column reveal after host view restoration wins the first render", async () => {
    const addedColumn = {
      id: "c:40",
      name: "column-40",
      position: 40,
      rawType: "String",
      type: "string" as const,
      nullable: false
    };
    const draft: TransformStep = {
      id: "upper-column",
      kind: "upperText",
      params: { column: { id: "c:0", name: "column-0" }, newColumn: addedColumn.name }
    };
    const previewMetadata: SessionMetadata = {
      ...metadata,
      revision: 1,
      shape: { rows: 400, columns: 41 },
      filteredShape: { rows: 400, columns: 41 },
      schema: [...schema, addedColumn],
      draftStep: draft
    };

    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: projectedPage(0, 0), summaries: [] });
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 760 },
      clientHeight: { configurable: true, value: 400 }
    });
    postMessage.mockClear();

    dispatch({
      kind: "stepPreview",
      revision: 1,
      metadata: previewMetadata,
      page: completePreviewPage(0, addedColumn),
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: [addedColumn.name],
        removedColumns: [],
        changedCells: 0,
        cells: [],
        truncated: false
      },
      code: "def clean_data(df):\n    return df"
    });
    await waitFor(() => expect(scroller.scrollLeft).toBeGreaterThan(0));
    expect(await screen.findByRole("columnheader", { name: /column-40/u })).toBeVisible();

    dispatchMany([
      {
        kind: "viewState",
        state: { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
      },
      {
        kind: "rendererSynchronization",
        syncId: "S".repeat(32),
        sessionId: previewMetadata.sessionId,
        revision: previewMetadata.revision
      }
    ]);

    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: /column-40/u })).toBeVisible();
  });

  it("offers Reconnect instead of retrying a lost Spark Connect dataframe", async () => {
    const pysparkMetadata: SessionMetadata = {
      ...metadata,
      backend: "pyspark",
      mode: "viewing",
      source: {
        kind: "notebookVariable",
        label: "spark_orders",
        variableName: "spark_orders",
        uri: "file:///workspace/orders.ipynb"
      },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      }
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: pysparkMetadata, page: projectedPage(0, 0), summaries: [] });
    const confirmedCell = await screen.findByRole("cell", { name: "value-0-row-0" });
    expect(confirmedCell).toBeVisible();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      confirmedCell.focus();
      postMessage.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Next block" }));
      const request = await onlyRuntimeRequest("getPage");
      dispatch({
        kind: "error",
        code: "pyspark_connect_state_lost",
        message: "Run the cell that creates spark_orders, then choose Reconnect.",
        recoverable: true,
        sessionId: pysparkMetadata.sessionId,
        viewRequestId: String(request.viewRequestId)
      });

      expect(await screen.findByRole("alert")).toHaveTextContent("choose Reconnect");
      expect(screen.getByRole("cell", { name: "value-0-row-0" })).toBeVisible();
      await act(async () => {
        await animationFrame();
        await animationFrame();
      });
      expect(document.activeElement).toHaveAttribute("data-grid-row", "0");
      expect(document.activeElement).toHaveAttribute("data-grid-column", "0");
    } finally {
      hasFocus.mockRestore();
    }
    expect(screen.queryByRole("button", { name: "Retry page" })).toBeNull();

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(postMessage).toHaveBeenCalledWith({ kind: "reconnectLiveSource" });
    expect(screen.getByRole("button", { name: "Reconnecting…" })).toBeDisabled();

    dispatch({ kind: "sessionOpened", metadata: pysparkMetadata, page: projectedPage(0, 0), summaries: [] });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByRole("cell", { name: "value-0-row-0" })).toBeVisible();
  });

  it("keeps ordinary page retry for a temporary Spark Connect outage", async () => {
    const pysparkMetadata: SessionMetadata = {
      ...metadata,
      backend: "pyspark",
      mode: "viewing",
      source: {
        kind: "notebookVariable",
        label: "spark_orders",
        variableName: "spark_orders",
        uri: "file:///workspace/orders.ipynb"
      },
      capabilities: { ...metadata.capabilities, editable: false, cancel: false }
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: pysparkMetadata, page: projectedPage(0, 0), summaries: [] });
    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const request = await onlyRuntimeRequest("getPage");
    dispatch({
      kind: "error",
      code: "pyspark_connect_unavailable",
      message: "Spark Connect is temporarily unavailable.",
      recoverable: true,
      sessionId: pysparkMetadata.sessionId,
      viewRequestId: String(request.viewRequestId)
    });

    expect(await screen.findByRole("button", { name: "Retry page" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});

function projectedPage(offset: number, columnOffset: number): GridPage {
  const columns = schema.slice(columnOffset, columnOffset + 16);
  return {
    offset,
    limit: 200,
    totalRows: 400,
    columnIds: columns.map((column) => column.id),
    rows: [
      {
        id: `r:${offset}`,
        rowNumber: offset,
        values: columns.map((column) => ({
          kind: "string" as const,
          raw: `value-${column.position}-row-${offset}`,
          display: `value-${column.position}-row-${offset}`,
          isNull: false,
          isNaN: false
        }))
      }
    ]
  };
}

function integerProjectedPage(offset: number, columnOffset: number): GridPage {
  const columns = schema.slice(columnOffset, columnOffset + 16);
  return {
    offset,
    limit: 200,
    totalRows: 400,
    columnIds: columns.map((column) => column.id),
    rows: [
      {
        id: `r:${offset}`,
        rowNumber: offset,
        values: columns.map((column) => ({
          kind: "integer" as const,
          raw: column.position,
          display: String(column.position),
          isNull: false,
          isNaN: false
        }))
      }
    ]
  };
}

function integerSummary(columnId: string): ColumnSummary {
  const column = schema.find((candidate) => candidate.id === columnId);
  if (!column) throw new Error(`Unknown integer summary column: ${columnId}`);
  const sum = column.position * 400;
  return {
    columnId,
    column: column.name,
    type: "integer",
    rawType: "Int64",
    totalCount: 400,
    nullCount: 0,
    nanCount: 0,
    distinctCount: 1,
    topValues: [{ value: String(column.position), count: 400 }],
    numeric: {
      min: column.position,
      max: column.position,
      mean: column.position,
      median: column.position,
      std: 0,
      sum,
      exactSum: {
        kind: "integer",
        raw: sum,
        display: String(sum),
        isNull: false,
        isNaN: false
      }
    },
    visualization: {
      kind: "numeric",
      bins: [{ min: column.position, max: column.position, count: 400 }]
    }
  };
}

function completePreviewPage(offset: number, addedColumn: SessionMetadata["schema"][number]): GridPage {
  const columns = [...schema, addedColumn];
  return {
    offset,
    limit: 200,
    totalRows: 400,
    columnIds: columns.map((column) => column.id),
    rows: [
      {
        id: `r:${offset}`,
        rowNumber: offset,
        values: columns.map((column) => ({
          kind: "string" as const,
          raw: `value-${column.position}-row-${offset}`,
          display: `value-${column.position}-row-${offset}`,
          isNull: false,
          isNaN: false
        }))
      }
    ]
  };
}

function pageResponse(
  request: Record<string, unknown>,
  responseMetadata: SessionMetadata,
  page: GridPage
): OpenWranglerResponse {
  return {
    kind: "page",
    revision: responseMetadata.revision,
    viewRequestId: String(request.viewRequestId),
    metadata: responseMetadata,
    page
  };
}

type HostMessage =
  | OpenWranglerResponse
  | {
      kind: "viewState";
      state: { columnWidths: Record<string, number>; viewport: { firstVisibleRow: number; scrollLeft: number } };
    }
  | { kind: "rendererSynchronization"; syncId: string; sessionId: string; revision: number }
  | { kind: "editorAction"; action: "applyDraft" }
  | { kind: "editorAction"; action: "selectStep"; stepId: string }
  | {
      kind: "editorAction";
      action: "openOperation" | "editLatest";
      operationKind?: "castColumn";
      expectedSessionId?: string;
      expectedRevision?: number;
    };

function dispatch(data: HostMessage): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

function dispatchMany(messages: HostMessage[]): void {
  act(() => {
    for (const data of messages) {
      window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
    }
  });
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function onlyRuntimeRequest(kind: string): Promise<Record<string, unknown>> {
  await waitFor(() => expect(runtimeRequests(kind)).toHaveLength(1));
  return runtimeRequests(kind)[0];
}

function runtimeRequests(kind: string): Record<string, unknown>[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as { kind?: unknown; request?: Record<string, unknown> };
    return candidate.kind === "runtimeRequest" && candidate.request?.kind === kind ? [candidate.request] : [];
  });
}
