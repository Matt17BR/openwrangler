import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("replaces generated code, warnings, and diff after a backend-changing session replacement", async () => {
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
    expect(await screen.findByText("# stale polars code")).toBeInTheDocument();

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

    expect(await screen.findByText("# restored pandas code")).toBeInTheDocument();
    expect(screen.queryByText("# stale polars code")).toBeNull();
    expect(screen.getByText("candidate backend warning")).toBeInTheDocument();
    expect(screen.queryByText("stale warning")).toBeNull();
    expect(screen.getByText("1 existing cell changed")).toBeInTheDocument();
    const draftCode = document.querySelector(".draftCode");
    expect(draftCode?.querySelector("summary")).toHaveTextContent(/Generated\s+Pandas\s*code/u);
    expect(draftCode).not.toHaveAttribute("open");
    await waitFor(() => expect(latestGridProps().beforeSchema).toEqual(committedSchema));

    dispatch({
      kind: "sessionPresentation",
      presentation: { sessionId: "session", revision: 3, code: "# stale late code" }
    });
    expect(screen.queryByText("# stale late code")).toBeNull();
    expect(screen.getByText("# restored pandas code")).toBeInTheDocument();
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

    expect(await screen.findByText("Draft: Uppercase")).toBeVisible();
    expect(screen.getByText("Previewing Uppercase")).toBeVisible();
    expect(screen.getByText("+1 column")).toBeVisible();
    expect(screen.getByText("1 value added in this block")).toBeVisible();
    expect(screen.queryByText(/0 changed cells/u)).toBeNull();
    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe(addedColumn.id);
      expect(latestGridProps().goToColumnRequestId).toBe(1);
    });

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
      expect(latestGridProps().goToColumnRequestId).toBe(2);
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
    expect(screen.getByText("Draft: Convert type")).toBeVisible();
    expect(screen.getByText("Previewing Convert type")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply step" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();

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
} {
  const call = dataGridProps.mock.calls.at(-1);
  if (!call) throw new Error("Expected DataGrid to render.");
  return call[0] as {
    beforeSchema?: ColumnSchema[];
    beforePage?: GridPage;
    goToColumnId?: string;
    goToColumnRequestId?: number;
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
