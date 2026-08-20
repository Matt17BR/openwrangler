import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
const capabilityOverrides = vi.hoisted(() => new Map<string, boolean>());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));
vi.mock("../shared/cleaningHistoryCapabilities", async () => {
  const actual = await vi.importActual<typeof import("../shared/cleaningHistoryCapabilities")>(
    "../shared/cleaningHistoryCapabilities"
  );
  return {
    ...actual,
    cleaningHistoryActionAvailable: (
      capabilityId: Parameters<typeof actual.cleaningHistoryActionAvailable>[0],
      context: Parameters<typeof actual.cleaningHistoryActionAvailable>[1]
    ) =>
      capabilityOverrides.has(capabilityId)
        ? capabilityOverrides.get(capabilityId)
        : actual.cleaningHistoryActionAvailable(capabilityId, context)
  };
});

import { App } from "../webviews/App";

const step: TransformStep = {
  id: "round-sales",
  kind: "roundNumber",
  params: { column: { id: "c:sales", name: "sales" }, decimals: 0 }
};

const metadata: SessionMetadata = {
  protocolVersion: 2,
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
  schema: [
    { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:sales", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false }
  ]
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
  beforeEach(() => {
    postMessage.mockClear();
    capabilityOverrides.clear();
  });

  it("uses the production capability authority before inspecting a selected step", async () => {
    capabilityOverrides.set("inspect", false);
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });
    postMessage.mockClear();

    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    expect(runtimeRequests("inspectStep")).toHaveLength(0);
    expect(screen.queryByLabelText("Selected applied-step inspection")).toBeNull();
  });

  it("keeps Edit visible when the authority disables Undo and blocks every Undo entry point", async () => {
    capabilityOverrides.set("undo", false);
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });

    expect(screen.getByRole("button", { name: "Edit latest" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: /reorder/iu })).toBeNull();

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    fireEvent.keyDown(screen.getByRole("main"), { key: "z", ctrlKey: true, altKey: true });
    expect(runtimeRequests("undoStep")).toHaveLength(0);
  });

  it("keeps Undo visible when the authority disables Edit and blocks native and keyboard Edit", async () => {
    capabilityOverrides.set("edit", false);
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });

    expect(screen.queryByRole("button", { name: "Edit latest" })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();

    dispatch({
      kind: "editorAction",
      action: "editLatest",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision
    });
    fireEvent.keyDown(screen.getByRole("main"), { key: "e", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("button", { name: "Preview changes" })).toBeNull();
  });

  it("rejects a delayed native Undo after the public session is replaced", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });

    const replacement = { ...metadata, sessionId: "replacement-session" };
    dispatch({ kind: "sessionOpened", metadata: replacement, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });
    postMessage.mockClear();

    dispatch({
      kind: "editorAction",
      action: "undoStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision
    });
    expect(runtimeRequests("undoStep")).toHaveLength(0);

    dispatch({
      kind: "editorAction",
      action: "undoStep",
      expectedSessionId: replacement.sessionId,
      expectedRevision: replacement.revision
    });
    expect(runtimeRequests("undoStep")).toHaveLength(1);
  });

  it("rejects a queued native Undo after the public revision advances", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });

    const advanced = { ...metadata, revision: metadata.revision + 1 };
    dispatch({ kind: "sessionOpened", metadata: advanced, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });
    postMessage.mockClear();

    dispatch({
      kind: "editorAction",
      action: "undoStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision
    });
    expect(runtimeRequests("undoStep")).toHaveLength(0);

    dispatch({
      kind: "editorAction",
      action: "undoStep",
      expectedSessionId: advanced.sessionId,
      expectedRevision: advanced.revision
    });
    expect(runtimeRequests("undoStep")).toHaveLength(1);
  });

  it("governs inspected-step Edit and Delete visibility independently", async () => {
    capabilityOverrides.set("delete", false);
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    dispatch(inspectionResult(step.id, 0, inspection()));
    await screen.findByLabelText("Selected applied-step inspection");

    expect(screen.getByRole("button", { name: "Edit step" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete step" })).toBeNull();
    postMessage.mockClear();
    dispatch({
      kind: "editorAction",
      action: "deleteStep",
      expectedSessionId: metadata.sessionId,
      expectedRevision: metadata.revision,
      stepId: step.id
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("keeps inspected-step Delete visible when the authority disables Edit", async () => {
    capabilityOverrides.set("edit", false);
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    dispatch(inspectionResult(step.id, 0, inspection()));
    await screen.findByLabelText("Selected applied-step inspection");

    expect(screen.queryByRole("button", { name: "Edit step" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete step" })).toBeVisible();
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
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });
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

    postMessage.mockClear();
    fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" });
    expect(postMessage).toHaveBeenCalledWith({ kind: "clearStepInspection" });
    expect(screen.queryByLabelText("Selected applied-step inspection")).toBeNull();
    expect(screen.getByRole("cell", { name: "10.5" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Column profiles and filters" })).toBeEnabled();
    expect(runtimeRequests("getPage")).toHaveLength(0);
  });

  it("keeps inspection failures local and ignores a superseded result", async () => {
    const secondStep: TransformStep = {
      id: "drop-city",
      kind: "dropColumns",
      params: { columns: [{ id: "c:city", name: "city" }] }
    };
    const withTwoSteps = { ...metadata, steps: [step, secondStep] };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: withTwoSteps, page: confirmedPage, summaries: [] });
    await screen.findByRole("cell", { name: "10.5" });

    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    dispatch({ kind: "editorAction", action: "selectStep", stepId: secondStep.id });
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

    fireEvent.click(screen.getByRole("button", { name: "Show confirmed data" }));
    expect(screen.getByRole("cell", { name: "10.5" })).toBeVisible();
  });

  it("edits an inspected earlier step against its inspected input schema and stable ID", async () => {
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
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    dispatch(inspectionResult(step.id, 0, inspection()));
    await screen.findByLabelText("Selected applied-step inspection");

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Edit step" }));
    expect(postMessage).toHaveBeenCalledWith({ kind: "clearStepInspection" });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    expect(onlyRuntimeRequest("previewStep")).toMatchObject({
      replaceStepId: step.id,
      step: { id: step.id, kind: step.kind }
    });
  });

  it("requires confirmation before deleting one inspected stable-ID step", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page: confirmedPage, summaries: [] });
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    dispatch(inspectionResult(step.id, 0, inspection()));
    await screen.findByLabelText("Selected applied-step inspection");

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Delete step" }));
    expect(postMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this step and replay every later step?")).toBeVisible();
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
      action: "selectStep" | "editLatest" | "editStep" | "deleteStep" | "undoStep";
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
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
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
