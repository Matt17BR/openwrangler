import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CellValue,
  GridPage,
  OpenWranglerResponse,
  SessionMetadata,
  StepInspectionResponse,
  TransformStep
} from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { App } from "../webviews/App";

const step: TransformStep = {
  id: "round-sales",
  kind: "roundNumber",
  params: { column: { id: "c:sales", name: "sales" }, decimals: 0 }
};

const schema: SessionMetadata["schema"] = [
  { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:sales", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false }
];

const metadata: SessionMetadata = {
  protocolVersion: 4,
  sessionId: "session",
  revision: 0,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 400, columns: 2 },
  filteredShape: { rows: 400, columns: 2 },
  filterModel: {
    filters: [],
    sort: [{ column: "city", direction: "asc", nulls: "last" }]
  },
  steps: [step],
  latestStepInputSchema: schema,
  schema
};

const stringCell = (value: string): CellValue => ({
  kind: "string",
  raw: value,
  display: value,
  isNull: false,
  isNaN: false
});

const numberCell = (value: number): CellValue => ({
  kind: "number",
  raw: value,
  display: String(value),
  isNull: false,
  isNaN: false
});

const confirmedPage: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 400,
  columnIds: metadata.schema.map((column) => column.id),
  rows: [{ id: "r:0", rowNumber: 0, values: [stringCell("Milan"), numberCell(10.5)] }]
};

function inspection(offset = 0): StepInspectionResponse {
  const inputPage: GridPage = {
    ...confirmedPage,
    offset,
    rows: [{ id: `r:${offset}`, rowNumber: offset, values: [stringCell("Milan"), numberCell(10.5)] }]
  };
  const outputPage: GridPage = {
    ...inputPage,
    rows: [{ id: `r:${offset}`, rowNumber: offset, values: [stringCell("Milan"), numberCell(11)] }]
  };
  return {
    kind: "stepInspection",
    revision: 0,
    stepId: step.id,
    stepIndex: 0,
    inputPage,
    outputPage,
    inputRowAxis: { kind: "positional", levelNames: [] },
    outputRowAxis: { kind: "positional", levelNames: [] },
    inputSchema: metadata.schema,
    outputSchema: metadata.schema,
    diff: {
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 1,
      cells: [
        {
          rowNumber: offset,
          columnId: "c:sales",
          column: "sales",
          before: numberCell(10.5),
          after: numberCell(11)
        }
      ],
      truncated: true
    },
    code: "# code through round-sales"
  };
}

describe("App applied-step inspection", () => {
  beforeEach(() => postMessage.mockClear());

  it("closes a surviving editor after predecessor deletion and reinspects before reopening", async () => {
    const first: TransformStep = {
      id: "rename-sales",
      kind: "renameColumn",
      params: { column: { id: "c:sales", name: "sales" }, newName: "revenue" }
    };
    const edited: TransformStep = {
      id: "rename-city",
      kind: "renameColumn",
      params: { column: { id: "c:city", name: "city" }, newName: "location" }
    };
    const suffix: TransformStep = {
      id: "lower-location",
      kind: "lowerText",
      params: { column: { id: "c:city", name: "location" } }
    };
    const input = schema.map((column) => (column.id === "c:sales" ? { ...column, name: "revenue" } : column));
    const output = input.map((column) => (column.id === "c:city" ? { ...column, name: "location" } : column));
    const opened = {
      ...metadata,
      schema: output,
      latestStepInputSchema: output,
      filterModel: { filters: [], sort: [] },
      steps: [first, edited, suffix]
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: opened, page: confirmedPage, summaries: [] });
    dispatch({ kind: "editorAction", action: "selectStep", stepId: edited.id });
    dispatch(
      inspectionResult(edited.id, 0, {
        ...inspection(),
        stepId: edited.id,
        stepIndex: 1,
        inputSchema: input,
        outputSchema: output,
        diff: {
          addedRows: 0,
          removedRows: 0,
          addedColumns: [],
          removedColumns: [],
          changedCells: 0,
          cells: [],
          truncated: false
        }
      })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit step" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit cleaning step" });
    postMessage.mockClear();
    dispatch({
      kind: "editorAction",
      action: "deleteStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: 0,
      stepId: first.id
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rewriteCleaningPlan",
        action: "deleteStep",
        stepId: first.id
      })
    );
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    const nextSchema = output.map((column) => (column.id === "c:sales" ? { ...column, name: "sales" } : column));
    dispatch({
      kind: "planUpdated",
      action: "apply",
      revision: 1,
      metadata: {
        ...opened,
        revision: 1,
        steps: [edited, suffix],
        schema: nextSchema,
        latestStepInputSchema: nextSchema
      },
      page: confirmedPage,
      code: "# remaining plan"
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    postMessage.mockClear();
    dispatch({
      kind: "editorAction",
      action: "editStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: 1,
      stepId: edited.id
    });
    expect(onlyRuntimeRequest("inspectStep")).toMatchObject({ stepId: edited.id });
    dispatch(
      inspectionResult(edited.id, 0, {
        ...inspection(),
        revision: 1,
        stepId: edited.id,
        stepIndex: 0,
        inputSchema: schema,
        outputSchema: nextSchema
      })
    );
    await screen.findByRole("dialog", { name: "Edit cleaning step" });
    const picker = screen.getByRole("combobox", { name: "Column" });
    expect(screen.queryByRole("option", { name: "revenue" })).toBeNull();
    fireEvent.change(picker, { target: { value: "c:sales" } });
    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onlyRuntimeRequest("previewStep")).toMatchObject({
      replaceStepId: edited.id,
      step: { kind: "renameColumn", params: { column: { id: "c:sales", name: "sales" } } }
    });
  });

  it("resumes a native earlier edit after paging and supersedes an older queued selection", async () => {
    const later: TransformStep = {
      id: "lower-city",
      kind: "lowerText",
      params: { column: { id: "c:city", name: "city" } }
    };
    const opened = { ...metadata, steps: [step, later] };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: opened, page: confirmedPage, summaries: [] });
    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const request = onlyRuntimeRequest("getPage");
    dispatch({ kind: "editorAction", action: "selectStep" });
    dispatch(nativeEdit());
    expect(runtimeRequests("inspectStep")).toHaveLength(0);
    acceptPage(request, opened);
    await waitFor(() => expect(onlyRuntimeRequest("inspectStep")).toMatchObject({ stepId: step.id }));
    expect(screen.queryByRole("dialog")).toBeNull();
    dispatch(
      inspectionResult("superseded-step", 0, {
        kind: "error",
        code: "engine_error",
        message: "Old inspection failed",
        recoverable: true
      })
    );
    dispatch(inspectionResult(step.id, 0, inspection()));
    await screen.findByRole("dialog", { name: "Edit cleaning step" });
    expect(runtimeRequests("inspectStep")).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Numeric column" })).toHaveValue("c:sales");
  });

  it.each(["error", "cancelled", "clear", "escape"] as const)(
    "does not restart a deferred edit inspection after %s",
    async (outcome) => {
      render(<App />);
      dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
      postMessage.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Next block" }));
      const request = onlyRuntimeRequest("getPage");
      dispatch(nativeEdit());
      acceptPage(request);
      await waitFor(() => expect(runtimeRequests("inspectStep")).toHaveLength(1));
      if (outcome === "clear" || outcome === "escape") {
        if (outcome === "clear") fireEvent.click(screen.getByRole("button", { name: "Show confirmed data" }));
        else fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" });
        dispatch(inspectionResult(step.id, 0, inspection()));
      } else {
        dispatch(
          inspectionResult(
            step.id,
            0,
            outcome === "error"
              ? { kind: "error", code: "engine_error", message: "Inspection failed", recoverable: true }
              : { kind: "cancelled", targetRequestId: "inspect" }
          )
        );
      }
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(runtimeRequests("inspectStep")).toHaveLength(1);
      expect(screen.queryByRole("dialog")).toBeNull();
      if (outcome === "error" || outcome === "cancelled") {
        dispatch(nativeEdit());
        expect(runtimeRequests("inspectStep")).toHaveLength(2);
        dispatch(inspectionResult(step.id, 0, inspection()));
        await screen.findByRole("dialog", { name: "Edit cleaning step" });
      }
    }
  );

  it.each(["session", "new selection", "new edit"] as const)(
    "rechecks a queued edit after %s replaces its context",
    async (change) => {
      const other: TransformStep = {
        id: "lower-city",
        kind: "lowerText",
        params: { column: { id: "c:city", name: "city" } }
      };
      const opened = { ...metadata, steps: [step, other] };
      render(<App />);
      dispatch({ kind: "sessionOpened", metadata: opened, page: confirmedPage, summaries: [] });
      postMessage.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Next block" }));
      const request = onlyRuntimeRequest("getPage");
      dispatch(nativeEdit());
      if (change === "session") {
        dispatch({
          kind: "sessionOpened",
          metadata: { ...opened, sessionId: "replacement" },
          page: confirmedPage,
          summaries: []
        });
      } else if (change === "new selection") {
        dispatch({ kind: "editorAction", action: "selectStep" });
      } else if (change === "new edit") {
        dispatch({ ...nativeEdit(), stepId: other.id });
      }
      acceptPage(request, opened);
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      if (change === "new edit") {
        expect(onlyRuntimeRequest("inspectStep")).toMatchObject({ stepId: other.id });
        dispatch(inspectionResult(other.id, 0, { ...inspection(), stepId: other.id, stepIndex: 1 }));
        await screen.findByRole("dialog", { name: "Edit cleaning step" });
        expect(screen.getByRole("combobox", { name: "Text column" })).toHaveValue("c:city");
      } else {
        expect(runtimeRequests("inspectStep")).toHaveLength(0);
        expect(screen.queryByRole("dialog")).toBeNull();
      }
    }
  );

  it("refuses native edit during mutation without opening it after failure", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    expect(onlyRuntimeRequest("undoStep")).toMatchObject({ kind: "undoStep" });
    dispatch(nativeEdit());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Wait for the current cleaning operation to finish before editing a step."
    );
    dispatch({ kind: "error", code: "engine_error", message: "Undo failed", recoverable: true });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(runtimeRequests("inspectStep")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores an applied-step selection addressed to a different session", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });
    postMessage.mockClear();

    dispatch({
      kind: "editorAction",
      action: "selectStep",
      expectedSessionId: "stale-session",
      expectedRevision: metadata.revision,
      stepId: step.id
    });
    expect(runtimeRequests("inspectStep")).toHaveLength(0);

    dispatch({
      kind: "editorAction",
      action: "selectStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision + 1,
      stepId: step.id
    });
    expect(runtimeRequests("inspectStep")).toHaveLength(0);

    dispatch({
      kind: "editorAction",
      action: "selectStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision,
      stepId: step.id
    });
    expect(onlyRuntimeRequest("inspectStep")).toMatchObject({ stepId: step.id });
  });

  it("keeps the confirmed view untouched while selecting, paging, and clearing an applied step", async () => {
    const filteredMetadata: SessionMetadata = {
      ...metadata,
      filterModel: {
        ...metadata.filterModel,
        filters: [
          { column: "city", type: "string", predicates: [{ kind: "predicate", operator: "contains", value: "i" }] }
        ]
      }
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: filteredMetadata, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });
    const filterRegion = screen.getByRole("region", { name: "Viewing filters" });
    const filterRule = screen.getByRole("button", { name: 'Remove contains "i" filter from city' });
    postMessage.mockClear();

    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });

    expect(onlyRuntimeRequest("inspectStep")).toMatchObject({
      stepId: step.id,
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 2
    });
    expect(screen.getByText("Loading selected-step inspection…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Filters paused during inspection" })).toBeDisabled();
    expect(screen.queryByRole("cell", { name: "10.5" })).toBeNull();
    const disclosure = screen.getByText("Viewing filters paused").closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText("Viewing filters paused"));
    expect(filterRegion).toBeVisible();
    expect(filterRule).toBeDisabled();

    dispatch({
      kind: "editorAction",
      action: "changeViewSort",
      column: "city",
      sortAction: "remove",
      expectedSessionId: metadata.sessionId,
      expectedSortModelSignature: JSON.stringify(metadata.filterModel.sort),
      expectedSortIndex: 0
    });
    expect(runtimeRequests("getPage")).toHaveLength(0);

    dispatch(inspectionResult(step.id, 0, inspection()));

    expect(await screen.findByLabelText("Selected applied-step inspection")).toBeVisible();
    expect(disclosure.open).toBe(true);
    expect(screen.getByRole("region", { name: "Viewing filters" })).toBe(filterRegion);
    expect(screen.getByRole("cell", { name: "sales, row 1: changed from 10.5 to 11" })).toHaveAttribute(
      "data-diff-state",
      "changed"
    );
    fireEvent.click(screen.getByLabelText("Column actions for city"));
    for (const sortButton of screen.getAllByRole("button", { name: "Sort ascending" })) {
      expect(sortButton).toBeDisabled();
    }
    expect(screen.getByText(/confirmed dataframe view and filters are unchanged/u)).toBeVisible();
    expect(screen.queryByLabelText("Selected step generated Python code")).toBeNull();
    expect(document.querySelector(".draftCode")).toBeNull();

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    expect(onlyRuntimeRequest("inspectStep")).toMatchObject({
      stepId: step.id,
      offset: 200,
      limit: 200,
      columnOffset: 0,
      columnLimit: 2
    });
    expect(screen.getByText("Loading selected-step inspection…")).toBeVisible();
    dispatch(inspectionResult(step.id, 200, inspection(200)));
    expect(await screen.findByRole("cell", { name: "sales, row 201: changed from 10.5 to 11" })).toBeVisible();
    expect(disclosure.open).toBe(true);

    postMessage.mockClear();
    fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" });
    expect(postMessage).toHaveBeenCalledWith({ kind: "clearStepInspection" });
    expect(screen.queryByLabelText("Selected applied-step inspection")).toBeNull();
    expect(screen.getByRole("cell", { name: "10.5" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Column profiles and filters" })).toBeEnabled();
    expect(runtimeRequests("getPage")).toHaveLength(0);
    expect(screen.getByText("Viewing filters paused")).not.toBeVisible();
    expect(screen.getByRole("region", { name: "Viewing filters" })).toBe(filterRegion);
    expect(filterRule).toBeEnabled();
    fireEvent.click(filterRule);
    expect(onlyRuntimeRequest("getPage")).toMatchObject({
      filterModel: { ...filteredMetadata.filterModel, filters: [] }
    });
  });

  it("keeps inspection failures local and ignores a superseded result", async () => {
    const secondStep: TransformStep = {
      id: "drop-city",
      kind: "dropColumns",
      params: { columns: [{ id: "c:city", name: "city" }] }
    };
    const withTwoSteps: SessionMetadata = {
      ...metadata,
      steps: [step, secondStep],
      filterModel: {
        ...metadata.filterModel,
        filters: [
          { column: "city", type: "string", predicates: [{ kind: "predicate", operator: "contains", value: "i" }] }
        ]
      }
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: withTwoSteps, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });

    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    const disclosure = screen.getByText("Viewing filters paused").closest("details")!;
    fireEvent.click(screen.getByText("Viewing filters paused"));
    dispatch({ kind: "editorAction", action: "selectStep", stepId: secondStep.id });
    expect(disclosure.open).toBe(true);
    dispatch(inspectionResult(step.id, 0, inspection()));
    expect(screen.getByText(/Loading Drop columns/u)).toBeVisible();

    const failure: OpenWranglerResponse = {
      kind: "error",
      code: "engine_error",
      message: "Could not inspect this step.",
      recoverable: true
    };
    dispatch(inspectionResult(secondStep.id, 0, failure));

    expect(screen.getByRole("alert")).toHaveTextContent("Could not inspect this step.");
    expect(screen.queryByText("Opening session...")).toBeNull();
    expect(screen.queryByRole("cell", { name: "10.5" })).toBeNull();
    expect(screen.getByRole("button", { name: "Filters paused during inspection" })).toBeDisabled();
    expect(disclosure.open).toBe(true);
    expect(screen.getByRole("button", { name: 'Remove contains "i" filter from city' })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Show confirmed data" }));
    expect(screen.getByRole("cell", { name: "10.5" })).toBeVisible();
    expect(screen.getByRole("button", { name: 'Remove contains "i" filter from city' })).toBeEnabled();
  });

  it("edits an inspected earlier step against its inspected input schema and stable ID", async () => {
    const earlierStep: TransformStep = {
      id: "rename-sales",
      kind: "renameColumn",
      params: { column: { id: "c:sales", name: "sales" }, newName: "revenue" }
    };
    const suffix: TransformStep = {
      id: "rename-city",
      kind: "renameColumn",
      params: { column: { id: "c:city", name: "city" }, newName: "location" }
    };
    const renamedSchema = schema.map((column) => (column.id === "c:sales" ? { ...column, name: "revenue" } : column));
    const currentSchema = renamedSchema.map((column) =>
      column.id === "c:city" ? { ...column, name: "location" } : column
    );
    render(<App />);
    dispatch({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        schema: currentSchema,
        latestStepInputSchema: renamedSchema,
        filterModel: { filters: [], sort: [] },
        steps: [earlierStep, suffix]
      },
      page: confirmedPage,
      summaries: []
    });
    dispatch({ kind: "editorAction", action: "selectStep", stepId: earlierStep.id });
    dispatch(
      inspectionResult(earlierStep.id, 0, {
        ...inspection(),
        stepId: earlierStep.id,
        inputSchema: schema,
        outputSchema: renamedSchema,
        outputPage: confirmedPage,
        diff: {
          addedRows: 0,
          removedRows: 0,
          addedColumns: [],
          removedColumns: [],
          changedCells: 0,
          cells: [],
          truncated: false
        },
        code: 'def clean_data(df):\n    return df.rename({"sales": "revenue"})\n'
      })
    );
    await screen.findByLabelText("Selected applied-step inspection");

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Edit step" }));
    expect(postMessage).toHaveBeenCalledWith({ kind: "clearStepInspection" });
    const preview = screen.getByRole("button", { name: "Preview changes" });
    expect(preview).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Column" })).toHaveValue("c:sales");
    expect(screen.getByRole("option", { name: "sales" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New name" })).toHaveValue("revenue");
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), {
      target: { value: "total_revenue" }
    });
    fireEvent.click(preview);

    expect(onlyRuntimeRequest("previewStep")).toEqual({
      kind: "previewStep",
      replaceStepId: earlierStep.id,
      step: {
        id: earlierStep.id,
        kind: "renameColumn",
        params: { column: { id: "c:sales", name: "sales" }, newName: "total_revenue" }
      },
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 2
    });
  });

  it("requires confirmation before deleting one inspected stable-ID step", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    dispatch(inspectionResult(step.id, 0, inspection()));
    await screen.findByLabelText("Selected applied-step inspection");

    postMessage.mockClear();
    const deleteStep = screen.getByRole("button", { name: "Delete step" });
    deleteStep.focus();
    fireEvent.click(deleteStep);
    expect(screen.getByRole("button", { name: "Cancel" })).toBe(deleteStep);
    expect(deleteStep).toHaveFocus();
    expect(postMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this step and replay every later step?")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    expect(onlyRuntimeRequest("inspectStep")).toMatchObject({ stepId: step.id, offset: 200 });
    dispatch(inspectionResult(step.id, 200, inspection(200)));
    expect(screen.getByRole("group", { name: "Confirm step deletion" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "sales, row 201: changed from 10.5 to 11" })).toBeVisible();

    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);
    expect(screen.getByRole("button", { name: "Delete step" })).toBe(cancel);
    expect(cancel).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Confirm step deletion" })).toBeNull();
    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Delete step" }));
    expect(postMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(postMessage).toHaveBeenCalledWith({
      kind: "rewriteCleaningPlan",
      action: "deleteStep",
      stepId: step.id,
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 2
    });
  });

  it("requires a fresh delete confirmation when selecting another step with the same operation", async () => {
    const secondStep: TransformStep = { ...step, id: "round-again" };
    render(<App />);
    dispatch({
      kind: "sessionOpened",
      metadata: { ...metadata, steps: [step, secondStep] },
      page: confirmedPage,
      summaries: []
    });
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    dispatch(inspectionResult(step.id, 0, inspection()));
    await screen.findByRole("button", { name: "Delete step" });

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Delete step" }));
    expect(screen.getByRole("group", { name: "Confirm step deletion" })).toBeVisible();
    expect(postMessage).not.toHaveBeenCalled();

    dispatch({ kind: "editorAction", action: "selectStep", stepId: secondStep.id });
    expect(onlyRuntimeRequest("inspectStep")).toMatchObject({ stepId: secondStep.id });
    expect(screen.getByText("Loading Round")).toBeVisible();
    expect(screen.queryByRole("group", { name: "Confirm step deletion" })).toBeNull();
    dispatch(inspectionResult(step.id, 0, inspection()));
    expect(screen.getByText("Loading Round")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    const firstInspection = inspection();
    dispatch(
      inspectionResult(secondStep.id, 0, {
        ...firstInspection,
        stepId: secondStep.id,
        stepIndex: 1,
        inputPage: firstInspection.outputPage,
        diff: { ...firstInspection.diff, changedCells: 0, cells: [] }
      })
    );
    expect(screen.getByText("Inspecting Round")).toBeVisible();
    expect(screen.queryByRole("group", { name: "Confirm step deletion" })).toBeNull();
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "rewriteCleaningPlan" }));

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Delete step" }));
    expect(screen.getByRole("group", { name: "Confirm step deletion" })).toBeVisible();
    expect(postMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      kind: "rewriteCleaningPlan",
      action: "deleteStep",
      stepId: secondStep.id,
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 2
    });
  });

  it("shares the stable-ID edit and delete transaction with host entry points", async () => {
    const suffix: TransformStep = {
      id: "clone-sales",
      kind: "cloneColumn",
      params: { column: { id: "c:sales", name: "sales" }, newName: "sales copy" }
    };
    render(<App />);
    dispatch({
      kind: "sessionOpened",
      metadata: { ...metadata, steps: [step, suffix] },
      page: confirmedPage,
      summaries: []
    });
    postMessage.mockClear();

    dispatch({
      kind: "editorAction",
      action: "editStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision,
      stepId: step.id
    });
    expect(onlyRuntimeRequest("inspectStep")).toMatchObject({ stepId: step.id });
    dispatch(inspectionResult(step.id, 0, inspection()));
    expect(await screen.findByRole("button", { name: "Preview changes" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close operation picker" }));
    postMessage.mockClear();
    dispatch({
      kind: "editorAction",
      action: "deleteStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision + 1,
      stepId: step.id
    });
    expect(postMessage).not.toHaveBeenCalled();
    dispatch({
      kind: "editorAction",
      action: "deleteStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision,
      stepId: step.id
    });
    expect(postMessage).toHaveBeenCalledWith({
      kind: "rewriteCleaningPlan",
      action: "deleteStep",
      stepId: step.id,
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 2
    });
  });
});

type HostMessage =
  | OpenWranglerResponse
  | {
      kind: "editorAction";
      action: "selectStep" | "editStep" | "deleteStep" | "undoStep";
      expectedSessionId?: string;
      expectedRevision?: number;
      stepId?: string;
    }
  | {
      kind: "editorAction";
      action: "changeViewSort";
      column: string;
      sortAction: "moveUp" | "moveDown" | "remove";
      expectedSessionId: string;
      expectedSortModelSignature: string;
      expectedSortIndex: number;
    }
  | {
      kind: "stepInspectionResult";
      stepId: string;
      offset: number;
      limit: number;
      columnOffset: number;
      columnLimit: number;
      response: OpenWranglerResponse;
    };

function nativeEdit() {
  return {
    kind: "editorAction" as const,
    action: "editStep" as const,
    expectedSessionId: metadata.sessionId,
    expectedRevision: metadata.revision,
    stepId: step.id
  };
}

function acceptPage(request: Record<string, unknown>, currentMetadata = metadata): void {
  dispatch({
    kind: "page",
    revision: currentMetadata.revision,
    viewRequestId: String(request.viewRequestId),
    metadata: currentMetadata,
    page: { ...confirmedPage, offset: 200, rows: [{ ...confirmedPage.rows[0], id: "r:200", rowNumber: 200 }] }
  });
}

function inspectionResult(stepId: string, offset: number, response: OpenWranglerResponse): HostMessage {
  return {
    kind: "stepInspectionResult",
    stepId,
    offset,
    limit: 200,
    columnOffset: 0,
    columnLimit: 2,
    response
  };
}

function dispatch(data: HostMessage): void {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data:
          data && typeof data === "object" && "kind" in data && data.kind === "sessionOpened"
            ? { ...data, offeredViewContextId: `snapshot:${crypto.randomUUID()}` }
            : data,
        origin: window.location.origin
      })
    )
  );
}

function runtimeRequests(kind: string): Record<string, unknown>[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as { kind?: unknown; request?: Record<string, unknown> };
    return candidate.kind === "runtimeRequest" && candidate.request?.kind === kind ? [candidate.request] : [];
  });
}

function onlyRuntimeRequest(kind: string): Record<string, unknown> {
  const matches = runtimeRequests(kind);
  expect(matches).toHaveLength(1);
  return matches[0];
}
