import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnSchema, GridPage, SessionMetadata, TransformStep } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
const dataGridProps = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));
vi.mock("../webviews/grid/DataGrid", () => ({
  DataGrid: (props: unknown) => {
    dataGridProps(props);
    return null;
  }
}));

import { App } from "../webviews/App";

const originalSchema: ColumnSchema[] = [
  { id: "c:a", name: "a", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:b", name: "b", position: 1, rawType: "Int64", type: "integer", nullable: false },
  { id: "c:c", name: "c", position: 2, rawType: "String", type: "string", nullable: false }
];
const committedSchema: ColumnSchema[] = [
  { ...originalSchema[2], position: 0 },
  { ...originalSchema[0], position: 1 }
];
const selectStep: TransformStep = {
  id: "select-reordered",
  kind: "selectColumns",
  params: {
    columns: [
      { id: "c:c", name: "c" },
      { id: "c:a", name: "a" }
    ]
  }
};
const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 2,
  backend: "pandas",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: false,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 2 },
  filteredShape: { rows: 1, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [selectStep],
  latestStepInputSchema: originalSchema,
  schema: committedSchema
};
const page: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 1,
  columnIds: committedSchema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [
        { kind: "string", raw: "C", display: "C", isNull: false, isNaN: false },
        { kind: "string", raw: "A", display: "A", isNull: false, isNaN: false }
      ]
    }
  ]
};

describe("App draft state boundaries", () => {
  beforeEach(() => {
    postMessage.mockClear();
    dataGridProps.mockClear();
  });

  it("uses the immediately previous committed schema for a newly appended draft", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "castColumn" });
    await screen.findByRole("dialog", { name: "Add cleaning step" });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const previewRequest = onlyPreviewRequest();
    expect(previewRequest.replaceStepId).toBeUndefined();

    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: { ...metadata, revision: 3, draftStep: previewRequest.step },
      page,
      diff: emptyDiff(),
      code: "def clean_data(df):\n    return df"
    });

    await waitFor(() => {
      const props = latestGridProps();
      expect(props.beforeSchema).toEqual(committedSchema);
      expect(props.beforePage).toEqual(page);
    });
  });

  it("keeps an empty cleaning plan out of the way and exposes cleaned-data export", async () => {
    render(<App />);
    dispatch({
      kind: "sessionOpened",
      metadata: { ...metadata, revision: 0, steps: [], latestStepInputSchema: undefined },
      page,
      summaries: []
    });

    expect(screen.queryByRole("region", { name: "Cleaning plan" })).toBeNull();
    const exportButton = await screen.findByRole("button", { name: "Export" });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    expect(postMessage).toHaveBeenCalledWith({ kind: "exportData" });
  });

  it("retains the compact cleaning-plan controls when applied steps exist without a draft", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });

    const plan = await screen.findByRole("region", { name: "Cleaning plan" });
    expect(within(plan).getByText("1 applied step")).toBeVisible();
    expect(within(plan).getByRole("button", { name: "Edit latest" })).toBeEnabled();
    expect(within(plan).getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Draft review" })).toBeNull();
  });

  it("uses the latest applied-step input schema for a replacement draft", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Edit latest" }));
    await screen.findByRole("dialog", { name: "Edit cleaning step" });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const previewRequest = onlyPreviewRequest();
    expect(previewRequest.replaceStepId).toBe(selectStep.id);

    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: {
        ...metadata,
        revision: 3,
        draftStep: previewRequest.step,
        draftReplacesStepId: selectStep.id
      },
      page,
      diff: emptyDiff(),
      code: "def clean_data(df):\n    return df"
    });

    await waitFor(() => {
      const props = latestGridProps();
      expect(props.beforeSchema).toEqual(originalSchema);
      expect(props.beforePage).toBeUndefined();
    });
  });

  it("replaces warnings and diff after a backend-changing session replacement without rendering inline code", async () => {
    const draft: TransformStep = {
      id: "cast-c",
      kind: "castColumn",
      params: { column: { id: "c:c", name: "c" }, dtype: "string" }
    };
    render(<App />);
    dispatch({
      kind: "sessionOpened",
      metadata: { ...metadata, backend: "polars", revision: 3, draftStep: draft },
      page,
      summaries: []
    });
    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: { ...metadata, backend: "polars", revision: 3, draftStep: draft },
      page,
      diff: emptyDiff(),
      code: "# stale polars code",
      warnings: ["stale warning"]
    });
    expect(await screen.findByText("stale warning")).toBeInTheDocument();
    expect(screen.queryByText("# stale polars code")).toBeNull();

    dispatch({
      kind: "sessionOpened",
      metadata: { ...metadata, backend: "pandas", revision: 4, draftStep: draft },
      page,
      summaries: []
    });
    dispatch({
      kind: "sessionPresentation",
      presentation: {
        sessionId: "session",
        revision: 4,
        code: "# restored pandas code",
        draft: {
          diff: { ...emptyDiff(), changedCells: 1 },
          warnings: ["candidate backend warning"],
          beforeSchema: committedSchema
        }
      }
    });

    const review = await screen.findByRole("region", { name: "Draft review" });
    expect(within(review).getByText("Convert type")).toBeVisible();
    expect(screen.queryByText("# stale polars code")).toBeNull();
    expect(screen.queryByText("# restored pandas code")).toBeNull();
    expect(screen.getByText("candidate backend warning")).toBeInTheDocument();
    expect(screen.queryByText("stale warning")).toBeNull();
    expect(screen.getByText("1 existing cell changed")).toBeInTheDocument();
    expect(document.querySelector(".draftCode")).toBeNull();
    expect(screen.queryByLabelText("Generated Python code preview")).toBeNull();
    await waitFor(() => expect(latestGridProps().beforeSchema).toEqual(committedSchema));

    dispatch({
      kind: "sessionPresentation",
      presentation: { sessionId: "session", revision: 3, code: "# stale late code" }
    });
    expect(screen.queryByText("# stale late code")).toBeNull();
    expect(screen.getByText("candidate backend warning")).toBeInTheDocument();
  });

  it("uses human draft labels, reports added values, and reveals a new output column", async () => {
    const addedColumn: ColumnSchema = {
      id: "c:upper",
      name: "c_upper",
      position: committedSchema.length,
      rawType: "String",
      type: "string",
      nullable: false
    };
    const draft: TransformStep = {
      id: "upper-c",
      kind: "upperText",
      params: { column: { id: "c:c", name: "c" }, newColumn: "c_upper" }
    };
    const previewPage: GridPage = {
      ...page,
      columnIds: [...page.columnIds, addedColumn.id],
      rows: page.rows.map((row) => ({
        ...row,
        values: [...row.values, { kind: "string", raw: "C", display: "C", isNull: false, isNaN: false }]
      }))
    };

    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: {
        ...metadata,
        revision: 3,
        shape: { rows: 1, columns: 3 },
        filteredShape: { rows: 1, columns: 3 },
        schema: [...committedSchema, addedColumn],
        draftStep: draft
      },
      page: previewPage,
      diff: { ...emptyDiff(), addedColumns: ["c_upper"] },
      code: "def clean_data(df):\n    return df"
    });

    const review = await screen.findByRole("region", { name: "Draft review" });
    expect(within(review).getByText("Uppercase")).toBeVisible();
    expect(within(review).getByText("+1 column")).toBeVisible();
    expect(within(review).getByText("1 value added in this block")).toBeVisible();
    expect(within(review).queryByText(/0 changed cells/u)).toBeNull();
    expect(within(review).queryByRole("alert")).toBeNull();
    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe(addedColumn.id);
      expect(latestGridProps().goToColumnRequestId).toBe(1);
    });
    act(() => latestGridProps().onGoToColumnHandled?.(1));
    expect(latestGridProps().goToColumnRequestId).toBe(1);

    dispatch({
      kind: "viewState",
      state: {
        columnWidths: {},
        selectedColumnId: committedSchema[0].id,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });
    expect(latestGridProps().goToColumnRequestId).toBe(1);

    dispatch({
      kind: "rendererSynchronization",
      syncId: "R".repeat(32),
      sessionId: metadata.sessionId,
      revision: 3
    });
    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe(addedColumn.id);
      expect(latestGridProps().goToColumnRequestId).toBe(2);
    });
    act(() => latestGridProps().onGoToColumnHandled?.(2));
    await waitFor(() => expect(latestGridProps().goToColumnId).toBeUndefined());

    dispatch({
      kind: "planUpdated",
      revision: 4,
      metadata: { ...metadata, revision: 4 },
      page,
      code: "def clean_data(df):\n    return df"
    });
    await waitFor(() => expect(latestGridProps().goToColumnId).toBeUndefined());

    dispatch({
      kind: "stepPreview",
      revision: 5,
      metadata: {
        ...metadata,
        revision: 5,
        shape: { rows: 1, columns: 3 },
        filteredShape: { rows: 1, columns: 3 },
        schema: [...committedSchema, addedColumn],
        draftStep: draft
      },
      page: previewPage,
      diff: { ...emptyDiff(), addedColumns: ["c_upper"] },
      code: "def clean_data(df):\n    return df"
    });
    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe(addedColumn.id);
      expect(latestGridProps().goToColumnRequestId).toBe(3);
    });
    act(() => latestGridProps().onGoToColumnHandled?.(3, "interrupted"));
    await waitFor(() => expect(latestGridProps().goToColumnId).toBeUndefined());
    dispatch({
      kind: "rendererSynchronization",
      syncId: "S".repeat(32),
      sessionId: metadata.sessionId,
      revision: 5
    });
    await waitFor(() => expect(latestGridProps().goToColumnId).toBeUndefined());
  });

  it("does not let an older renderer snapshot erase a confirmed draft", async () => {
    const draft: TransformStep = {
      id: "upper-c",
      kind: "upperText",
      params: { column: { id: "c:c", name: "c" } }
    };

    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: { ...metadata, revision: 3, draftStep: draft },
      page,
      diff: { ...emptyDiff(), changedCells: 1 },
      code: "def clean_data(df):\n    return df"
    });

    expect(within(await screen.findByRole("region", { name: "Draft review" })).getByText("Uppercase")).toBeVisible();

    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    dispatch({
      kind: "rendererSynchronization",
      syncId: "T".repeat(32),
      sessionId: metadata.sessionId,
      revision: metadata.revision
    });

    expect(within(screen.getByRole("region", { name: "Draft review" })).getByText("Uppercase")).toBeVisible();
    expect(screen.getByText("1 existing cell changed")).toBeVisible();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rendererSynchronized", syncId: "T".repeat(32) })
    );

    dispatch({
      kind: "rendererSynchronization",
      syncId: "U".repeat(32),
      sessionId: metadata.sessionId,
      revision: 3
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        kind: "rendererSynchronized",
        syncId: "U".repeat(32),
        sessionId: metadata.sessionId,
        revision: 3
      })
    );
    expect(within(screen.getByRole("region", { name: "Draft review" })).getByText("Uppercase")).toBeVisible();
  });

  it("commits a draft before its synchronization acknowledgement and suppresses the pending recovery pull", () => {
    const draft: TransformStep = {
      id: "upper-c-publication",
      kind: "upperText",
      params: { column: { id: "c:c", name: "c" } }
    };
    const previousImplementation = postMessage.getMockImplementation();
    vi.useFakeTimers();
    try {
      render(<App />);
      postMessage.mockClear();
      postMessage.mockImplementation((message) => {
        if (message?.kind !== "rendererSynchronized") return;
        expect(within(screen.getByRole("region", { name: "Draft review" })).getByText("Uppercase")).toBeVisible();
      });

      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { kind: "sessionOpened", metadata, page, summaries: [] },
            origin: window.location.origin
          })
        );
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              kind: "stepPreview",
              revision: 3,
              metadata: { ...metadata, revision: 3, draftStep: draft },
              page,
              diff: { ...emptyDiff(), changedCells: 1 },
              code: "def clean_data(df):\n    return df"
            },
            origin: window.location.origin
          })
        );
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              kind: "rendererSynchronization",
              syncId: "V".repeat(32),
              sessionId: metadata.sessionId,
              revision: 3
            },
            origin: window.location.origin
          })
        );
        vi.advanceTimersByTime(250);
      });

      expect(postMessage).toHaveBeenCalledWith({
        kind: "rendererSynchronized",
        syncId: "V".repeat(32),
        sessionId: metadata.sessionId,
        revision: 3
      });
      expect(postMessage.mock.calls.some(([message]) => message?.kind === "requestSessionSnapshot")).toBe(false);
    } finally {
      postMessage.mockImplementation(previousImplementation ?? (() => undefined));
      vi.useRealTimers();
    }
  });

  it("consumes a search reveal and preserves a later manual viewport through an in-place preview", async () => {
    const inPlaceDraft: TransformStep = {
      id: "upper-c-in-place",
      kind: "upperText",
      params: { column: { id: "c:c", name: "c" } }
    };
    const revealedViewState = {
      columnWidths: {},
      selectedColumnId: "c:a",
      viewport: { firstVisibleRow: 0, scrollLeft: 900 }
    };
    const manuallyScrolledViewState = {
      ...revealedViewState,
      viewport: { firstVisibleRow: 0, scrollLeft: 120 }
    };

    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });

    const columnSearch = screen.getByRole("combobox", { name: "Column" });
    fireEvent.change(columnSearch, { target: { value: "a" } });
    fireEvent.keyDown(columnSearch, { key: "Enter" });
    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe("c:a");
      expect(latestGridProps().goToColumnRequestId).toBe(1);
    });

    act(() => latestGridProps().onViewStateChange?.(revealedViewState));
    act(() => latestGridProps().onGoToColumnHandled?.(1));
    await waitFor(() => expect(latestGridProps().goToColumnId).toBeUndefined());
    expect(latestGridProps().viewState?.selectedColumnId).toBe("c:a");

    act(() => latestGridProps().onViewStateChange?.(manuallyScrolledViewState));
    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: { ...metadata, revision: 3, draftStep: inPlaceDraft },
      page,
      diff: emptyDiff(),
      code: "def clean_data(df):\n    return df"
    });
    dispatch({ kind: "viewState", state: manuallyScrolledViewState });

    await waitFor(() => {
      const props = latestGridProps();
      expect(props.goToColumnId).toBeUndefined();
      expect(props.viewState?.viewport.scrollLeft).toBe(120);
      expect(props.viewState?.selectedColumnId).toBe("c:a");
    });
  });

  it("opens the generic operation picker for a host action without an operation kind", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });

    dispatch({ kind: "editorAction", action: "openOperation" });

    expect(await screen.findByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Choose an operation" })).toBeInTheDocument();
  });

  it("blocks toolbar and host add-operation entry points while preserving draft actions", async () => {
    const draftStep: TransformStep = {
      id: "cast-c",
      kind: "castColumn",
      params: { column: { id: "c:c", name: "c" }, dtype: "string" }
    };
    render(<App />);
    dispatch({
      kind: "sessionOpened",
      metadata: { ...metadata, revision: 3, draftStep },
      page,
      summaries: []
    });

    expect(await screen.findByRole("button", { name: "Add step" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    const review = screen.getByRole("region", { name: "Draft review" });
    expect(within(review).getByText("Convert type")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Cleaning plan" })).toBeNull();
    expect(within(review).getByRole("button", { name: "Apply step" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "Discard" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "Apply step" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Discard" })).toHaveLength(1);

    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "formula" });
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();

    dispatch({ kind: "editorAction", action: "editLatest" });
    expect(screen.queryByRole("dialog", { name: "Edit cleaning step" })).toBeNull();
  });
});

function dispatch(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

function onlyPreviewRequest(): { step: TransformStep; replaceStepId?: string } {
  const requests = postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.kind === "runtimeRequest" && message.request.kind === "previewStep")
    .map((message) => message.request);
  expect(requests).toHaveLength(1);
  return requests[0] as { step: TransformStep; replaceStepId?: string };
}

function latestGridProps(): {
  beforeSchema?: ColumnSchema[];
  beforePage?: GridPage;
  goToColumnId?: string;
  goToColumnRequestId?: number;
  onGoToColumnHandled?(requestId: number, outcome?: "revealed" | "interrupted"): void;
  onViewStateChange?(state: {
    columnWidths: Record<string, number>;
    selectedColumnId?: string;
    viewport: { firstVisibleRow: number; scrollLeft: number };
  }): void;
  viewState?: {
    columnWidths: Record<string, number>;
    selectedColumnId?: string;
    viewport: { firstVisibleRow: number; scrollLeft: number };
  };
} {
  const call = dataGridProps.mock.calls.at(-1);
  if (!call) throw new Error("Expected DataGrid to render.");
  return call[0] as {
    beforeSchema?: ColumnSchema[];
    beforePage?: GridPage;
    goToColumnId?: string;
    goToColumnRequestId?: number;
    onGoToColumnHandled?(requestId: number, outcome?: "revealed" | "interrupted"): void;
    onViewStateChange?(state: {
      columnWidths: Record<string, number>;
      selectedColumnId?: string;
      viewport: { firstVisibleRow: number; scrollLeft: number };
    }): void;
    viewState?: {
      columnWidths: Record<string, number>;
      selectedColumnId?: string;
      viewport: { firstVisibleRow: number; scrollLeft: number };
    };
  };
}

function emptyDiff() {
  return {
    addedRows: 0,
    removedRows: 0,
    addedColumns: [],
    removedColumns: [],
    changedCells: 0,
    cells: [],
    truncated: false
  };
}
