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
  rowAxis: { kind: "positional", levelNames: [] },
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
const { latestStepInputSchema: _latestStepInputSchema, ...metadataWithoutLatestStepInputSchema } = metadata;
const { rowAxis: _rowAxis, ...polarsMetadata } = metadata;
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

  it("retains Redo after ordinary failures and clears only its correlated unavailable history", async () => {
    const confirmed = { ...metadata, canRedo: true };
    const mounted = render(<App />);
    dispatch({ kind: "sessionOpened", metadata: confirmed, page, summaries: [] });
    const redo = await screen.findByRole("button", { name: "Redo" });
    fireEvent.click(redo);
    const first = latestRedoRequestId();
    fireEvent.click(redo);
    expect(redoRequestIds()).toEqual([first]);
    dispatch({
      kind: "error",
      code: "engine_error",
      message: "The saved command failed.",
      recoverable: true,
      sessionId: metadata.sessionId,
      viewRequestId: first
    });
    expect(redo).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("The saved command failed.");
    expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject({ metadata: confirmed, page });

    fireEvent.click(redo);
    const second = latestRedoRequestId();
    expect(second).not.toBe(first);
    dispatch({ kind: "error", code: "engine_error", message: "Uncorrelated old error.", recoverable: true });
    dispatch({
      kind: "error",
      code: "redo_unavailable",
      message: "Another session has no history.",
      recoverable: true,
      sessionId: "other-session",
      viewRequestId: second
    });
    dispatch({
      kind: "error",
      code: "redo_unavailable",
      message: "Obsolete attempt has no history.",
      recoverable: true,
      sessionId: metadata.sessionId,
      viewRequestId: first
    });
    expect(redo).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    dispatch({ kind: "cancelled", targetRequestId: "redo", viewRequestId: second });
    expect(redo).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("The cleaning operation was cancelled.");

    fireEvent.click(redo);
    const third = latestRedoRequestId();
    dispatch({
      kind: "error",
      code: "redo_unavailable",
      message: "Redo is no longer available in this runtime.",
      recoverable: true,
      sessionId: metadata.sessionId,
      viewRequestId: third
    });
    expect(redo).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Redo is no longer available in this runtime.");
    const unavailable = { ...confirmed, canRedo: false };
    expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject({ metadata: unavailable, page });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    dispatch({ kind: "error", code: "engine_error", message: "Undo failed.", recoverable: true });
    expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject({ metadata: unavailable, page });
    expect(redo).toBeDisabled();
    mounted.unmount();
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: unavailable, page, summaries: [] });
    expect(await screen.findByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it.each(["session", "revision"])("ignores stale Redo errors after a newer %s starts another Redo", async (change) => {
    const confirmed = { ...metadata, canRedo: true };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: confirmed, page, summaries: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Redo" }));
    const obsolete = latestRedoRequestId();
    const next = {
      ...confirmed,
      ...(change === "session" ? { sessionId: "replacement" } : { revision: metadata.revision + 1 })
    };
    dispatch({ kind: "sessionOpened", metadata: next, page, summaries: [] });
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    const current = latestRedoRequestId();
    expect(current).not.toBe(obsolete);
    dispatch({
      kind: "error",
      code: "redo_unavailable",
      message: "Old history was unavailable.",
      recoverable: true,
      sessionId: metadata.sessionId,
      viewRequestId: obsolete
    });
    dispatch({ kind: "cancelled", targetRequestId: "old-redo", viewRequestId: obsolete });
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject({ metadata: next, page });
    dispatch({ kind: "cancelled", targetRequestId: "current-redo", viewRequestId: current });
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
  });

  it("accepts a Redo result only for its pending attempt, session and next revision", async () => {
    const confirmed = { ...metadata, canRedo: true };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: confirmed, page, summaries: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Redo" }));
    const viewRequestId = latestRedoRequestId();
    const completed = { ...confirmed, revision: metadata.revision + 1, canRedo: false };
    const result = {
      kind: "planUpdated",
      action: "redo",
      revision: completed.revision,
      metadata: completed,
      page,
      code: "def clean_data(df):\n    return df",
      viewRequestId
    };
    for (const stale of [
      { ...result, viewRequestId: "obsolete-attempt" },
      { ...result, metadata: { ...completed, sessionId: "other-session" } },
      { ...result, metadata: { ...completed, revision: metadata.revision } },
      { ...result, revision: completed.revision + 1, metadata: { ...completed, revision: completed.revision + 1 } }
    ]) {
      dispatch(stale);
      expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
      expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject({ metadata: confirmed, page });
    }
    dispatch(result);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject({ metadata: completed, page });
  });

  it("waits for the current column projection before dispatching Redo", async () => {
    const confirmed = { ...metadata, canRedo: true };
    const partialPage = {
      ...page,
      columnIds: page.columnIds.slice(0, 1),
      rows: page.rows.map((row) => ({ ...row, values: row.values.slice(0, 1) }))
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: confirmed, page: partialPage, summaries: [] });
    const redo = await screen.findByRole("button", { name: "Redo" });
    const grid = dataGridProps.mock.calls.at(-1)?.[0] as {
      onVisibleColumnRangeChange(range: { start: number; end: number }): void;
    };
    act(() => grid.onVisibleColumnRangeChange({ start: 0, end: 1 }));
    const projection = postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.kind === "runtimeRequest" && message.request.kind === "getPage")
      .at(-1)?.request;
    expect(projection).toBeDefined();
    expect(redo).toBeDisabled();
    dispatch({ kind: "editorAction", action: "redoStep" });
    expect(redoRequestIds()).toEqual([]);
    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: projection.viewRequestId,
      metadata: confirmed,
      page
    });
    expect(redo).toBeEnabled();
    fireEvent.click(redo);
    expect(redoRequestIds()).toHaveLength(1);
  });

  it.each([
    {
      backend: "r" as const,
      editing: false,
      literal: "9007199254740993",
      message: "The Formula integer literal cannot be represented exactly as an R numeric scalar"
    },
    {
      backend: "polars" as const,
      editing: false,
      literal: "340282366920938463463374607431768211456",
      message: "Formula literal exceeds Polars native integer capacity."
    },
    {
      backend: "polars" as const,
      editing: true,
      literal: "340282366920938463463374607431768211456",
      message: "Formula literal exceeds Polars native integer capacity."
    }
  ])(
    "keeps $backend preview refusal accessible in its retained form (editing=$editing)",
    async ({ backend, editing, literal, message }) => {
      const fixture = formulaPreviewFixture(backend, editing);
      render(<App />);
      dispatch({ kind: "sessionOpened", ...fixture, summaries: [] });
      dispatch({ kind: "editorAction", action: editing ? "editLatest" : "openOperation", operationKind: "formula" });
      const dialog = await screen.findByRole("dialog");
      const value = within(dialog).getByLabelText("Numeric value", { exact: true });
      const output = within(dialog).getByLabelText("New column", { exact: true });
      fireEvent.change(value, { target: { value: literal } });
      fireEvent.change(output, { target: { value: "exact_result" } });
      postMessage.mockClear();
      fireEvent.click(within(dialog).getByRole("button", { name: "Preview changes" }));
      const request = onlyPreviewRequest();
      expect(request.step).toMatchObject({ kind: "formula", params: { value: literal, newColumn: "exact_result" } });
      expect(request.replaceStepId).toBe(editing ? "saved" : undefined);
      expect(dialog).toHaveAttribute("aria-busy", "true");
      dispatch({
        kind: "error",
        code: backend === "r" ? "invalid_request" : "engine_error",
        message,
        recoverable: true
      });
      expect(within(dialog).getByRole("alert")).toHaveTextContent(message);
      expect(dialog).toHaveAttribute("aria-busy", "false");
      expect(value).toHaveDisplayValue(literal);
      expect(output).toHaveValue("exact_result");
      expect(value).toBeEnabled();
      expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject(fixture);
      expect(screen.queryByRole("region", { name: "Draft review" })).toBeNull();

      fireEvent.change(value, { target: { value: "2" } });
      postMessage.mockClear();
      fireEvent.click(within(dialog).getByRole("button", { name: "Preview changes" }));
      expect(onlyPreviewRequest().step).toMatchObject({ kind: "formula", params: { value: 2 } });
      expect(within(dialog).queryByRole("alert")).toBeNull();
      dispatch({ kind: "cancelled", targetRequestId: "preview" });
      expect(within(dialog).getByRole("alert")).toHaveTextContent("The cleaning operation was cancelled.");
      expect(value).toHaveDisplayValue("2");
      expect(dialog).toHaveAttribute("aria-busy", "false");

      fireEvent.click(within(dialog).getByRole("button", { name: /^Uppercase/ }));
      expect(within(dialog).queryByRole("alert")).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: /^Formula column/ }));
      expect(within(dialog).queryByRole("alert")).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      dispatch({ kind: "editorAction", action: "openOperation", operationKind: "formula" });
      expect(within(await screen.findByRole("dialog")).queryByRole("alert")).toBeNull();
    }
  );

  it("keeps prior viewer and host Undo errors out of an open preview form", async () => {
    const fixture = formulaPreviewFixture("polars", true);
    render(<App />);
    dispatch({ kind: "sessionOpened", ...fixture, summaries: [] });
    dispatch({ kind: "error", code: "engine_error", message: "Earlier viewer failure", recoverable: true });
    dispatch({ kind: "editorAction", action: "editLatest" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(document.querySelector(".appWorkspace [role=alert]")).toHaveTextContent("Earlier viewer failure");
    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "runtimeRequest", request: expect.objectContaining({ kind: "undoStep" }) })
    );
    dispatch({ kind: "error", code: "engine_error", message: "The requested Undo failed", recoverable: true });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByLabelText("Numeric value", { exact: true })).toHaveDisplayValue("2");
    expect(dialog).toHaveAttribute("aria-busy", "false");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The requested Undo failed");
    expect(dataGridProps.mock.calls.at(-1)?.[0]).toMatchObject(fixture);
  });

  it("clears a refused form on session replacement without carrying its error", async () => {
    const fixture = formulaPreviewFixture("polars", false);
    render(<App />);
    dispatch({ kind: "sessionOpened", ...fixture, summaries: [] });
    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "formula" });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New column", { exact: true }), { target: { value: "result" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview changes" }));
    dispatch({ kind: "error", code: "engine_error", message: "Refused previous preview", recoverable: true });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Refused previous preview");
    dispatch({
      kind: "sessionOpened",
      ...fixture,
      metadata: { ...fixture.metadata, sessionId: "replacement" },
      summaries: []
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "formula" });
    expect(within(await screen.findByRole("dialog")).queryByRole("alert")).toBeNull();
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

  it("shows the exact missing-value result for a fill draft and restores it with the session presentation", async () => {
    const draft: TransformStep = {
      id: "fill-a",
      kind: "fillMissingValues",
      params: { column: { id: "c:a", name: "a" }, replacement: { kind: "string", value: "unknown" } }
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: { ...metadata, revision: 3, draftStep: draft },
      page,
      diff: emptyDiff(),
      code: "def clean_data(df):\n    return df",
      remainingMissingCells: 1
    });

    const review = await screen.findByRole("region", { name: "Draft review" });
    expect(within(review).getByRole("status")).toHaveTextContent("1 missing value remains in a");

    dispatch({
      kind: "sessionPresentation",
      presentation: {
        sessionId: "session",
        revision: 3,
        code: "def clean_data(df):\n    return df",
        draft: {
          diff: emptyDiff(),
          remainingMissingCells: 0,
          warnings: [],
          beforeSchema: committedSchema
        }
      }
    });

    expect(within(review).getByRole("status")).toHaveTextContent("No missing values remain in a");
    expect(within(review).queryByText("1 missing value remains in a")).toBeNull();

    dispatch({
      kind: "planUpdated",
      action: "discard",
      revision: 4,
      metadata: { ...metadata, revision: 4 },
      page,
      code: "def clean_data(df):\n    return df"
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps an empty cleaning plan out of the way and exposes cleaned-data export", async () => {
    render(<App />);
    dispatch({
      kind: "sessionOpened",
      metadata: { ...metadataWithoutLatestStepInputSchema, revision: 0, steps: [] },
      page,
      summaries: []
    });

    expect(screen.queryByRole("group", { name: "Cleaning plan" })).toBeNull();
    const exportButton = await screen.findByRole("button", { name: "Export" });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    expect(postMessage).toHaveBeenCalledWith({ kind: "exportData" });
  });

  it("retains the compact cleaning-plan controls when applied steps exist without a draft", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });

    const plan = await screen.findByRole("group", { name: "Cleaning plan" });
    expect(plan.closest(".toolbar")).not.toBeNull();
    expect(document.querySelector(".cleaningBar")).toBeNull();
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
      metadata: { ...polarsMetadata, backend: "polars", revision: 3, draftStep: draft },
      page,
      summaries: []
    });
    dispatch({
      kind: "stepPreview",
      revision: 3,
      metadata: { ...polarsMetadata, backend: "polars", revision: 3, draftStep: draft },
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
        columnWidths: [],
        selectedColumnId: committedSchema[0].id,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });
    expect(latestGridProps().goToColumnRequestId).toBe(1);

    dispatch({
      kind: "rendererSynchronization",
      syncId: "R".repeat(32),
      sessionId: metadata.sessionId,
      revision: 3,
      layoutTransitionPending: false
    });
    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe(addedColumn.id);
      expect(latestGridProps().goToColumnRequestId).toBe(2);
    });
    act(() => latestGridProps().onGoToColumnHandled?.(2));
    await waitFor(() => expect(latestGridProps().goToColumnId).toBeUndefined());

    dispatch({
      kind: "planUpdated",
      action: "discard",
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
      revision: 5,
      layoutTransitionPending: false
    });
    await waitFor(() => expect(latestGridProps().goToColumnId).toBeUndefined());
  });

  it("reissues a pending generated-column reveal across renderer synchronization barriers", async () => {
    const addedColumn: ColumnSchema = {
      id: "c:upper-pending",
      name: "c_upper_pending",
      position: committedSchema.length,
      rawType: "String",
      type: "string",
      nullable: false
    };
    const draft: TransformStep = {
      id: "upper-c-pending",
      kind: "upperText",
      params: { column: { id: "c:c", name: "c" }, newColumn: addedColumn.name }
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
      diff: { ...emptyDiff(), addedColumns: [addedColumn.name] },
      code: "def clean_data(df):\n    return df"
    });

    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe(addedColumn.id);
      expect(latestGridProps().goToColumnRequestId).toBe(1);
    });

    // The initial DataGrid attempt can remain pending while Code Preview
    // changes the final layout. The publication marker must give that same
    // logical reveal a fresh identity instead of leaving it dormant.
    dispatch({
      kind: "rendererSynchronization",
      syncId: "W".repeat(32),
      sessionId: metadata.sessionId,
      revision: 3,
      layoutTransitionPending: true
    });
    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe(addedColumn.id);
      expect(latestGridProps().goToColumnRequestId).toBe(2);
    });

    // Cursor may claim the target is visible before Code Preview has changed
    // the workbench geometry. The pending transition keeps the logical reveal
    // alive despite that premature completion.
    act(() => latestGridProps().onGoToColumnHandled?.(2));
    expect(latestGridProps().goToColumnRequestId).toBe(2);

    // Cursor can finish the Code Preview layout after the first synchronized
    // retry has gone dormant. A later barrier must rearm the still-pending
    // navigation instead of treating it as completed.
    dispatch({
      kind: "rendererSynchronization",
      syncId: "X".repeat(32),
      sessionId: metadata.sessionId,
      revision: 3,
      layoutTransitionPending: false
    });
    await waitFor(() => {
      expect(latestGridProps().goToColumnId).toBe(addedColumn.id);
      expect(latestGridProps().goToColumnRequestId).toBe(3);
    });

    act(() => latestGridProps().onGoToColumnHandled?.(3));
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
      revision: metadata.revision,
      layoutTransitionPending: false
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
      revision: 3,
      layoutTransitionPending: false
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
              revision: 3,
              layoutTransitionPending: false
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
      columnWidths: new Map(),
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
    expect(screen.queryByRole("group", { name: "Cleaning plan" })).toBeNull();
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
    columnWidths: ReadonlyMap<string, number>;
    selectedColumnId?: string;
    viewport: { firstVisibleRow: number; scrollLeft: number };
  }): void;
  viewState?: {
    columnWidths: ReadonlyMap<string, number>;
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
      columnWidths: ReadonlyMap<string, number>;
      selectedColumnId?: string;
      viewport: { firstVisibleRow: number; scrollLeft: number };
    }): void;
    viewState?: {
      columnWidths: ReadonlyMap<string, number>;
      selectedColumnId?: string;
      viewport: { firstVisibleRow: number; scrollLeft: number };
    };
  };
}

function redoRequestIds(): string[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    if (message?.kind !== "runtimeRequest" || message.request.kind !== "redoStep") return [];
    expect(message.request.viewRequestId).toEqual(expect.any(String));
    expect(message.request.viewRequestId).not.toBe("");
    return [String(message.request.viewRequestId)];
  });
}

function latestRedoRequestId(): string {
  const id = redoRequestIds().at(-1);
  if (!id) throw new Error("Expected a correlated Redo request.");
  return id;
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

function formulaPreviewFixture(
  backend: "r" | "polars",
  editing: boolean
): { metadata: SessionMetadata; page: GridPage } {
  const input: ColumnSchema = {
    id: "c:source:0",
    name: "input",
    position: 0,
    type: "integer",
    rawType: backend === "r" ? "integer" : "Int64",
    nullable: false
  };
  const step: TransformStep = {
    id: "saved",
    kind: "formula",
    params: { leftColumn: { id: input.id, name: input.name }, operator: "add", value: 2, newColumn: "saved_result" }
  };
  const schema = editing ? [input, { ...input, id: "c:step:saved:0", name: "saved_result", position: 1 }] : [input];
  return {
    metadata: {
      ...polarsMetadata,
      sessionId: "preview-owner",
      revision: editing ? 1 : 0,
      backend,
      ...(backend === "r" ? { rDataframeFlavor: "r.data.frame" as const } : {}),
      source: { kind: "notebookVariable", label: "synthetic", variableName: "synthetic" },
      schema,
      shape: { rows: 1, columns: schema.length },
      filteredShape: { rows: 1, columns: schema.length },
      steps: editing ? [step] : [],
      latestStepInputSchema: [input]
    },
    page: {
      offset: 0,
      limit: 200,
      totalRows: 1,
      columnIds: schema.map((column) => column.id),
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: (editing ? [3, 5] : [3]).map((raw) => ({
            kind: "integer" as const,
            raw,
            display: String(raw),
            isNull: false,
            isNaN: false
          }))
        }
      ]
    }
  };
}
