import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata, TransformStep } from "../shared/protocol";

const webviewPostMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: {
    postMessage: webviewPostMessage,
    getState: () => undefined,
    setState: () => undefined
  }
}));

let App: (typeof import("../webviews/App"))["App"];

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
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  filterModel: {
    filters: [],
    sort: [{ column: "sales", direction: "desc", nulls: "last" }]
  },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 2,
  totalRows: 2,
  columnIds: ["c:0", "c:1"],
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [
        { kind: "string", raw: "Milan", display: "Milan", isNull: false, isNaN: false },
        { kind: "number", raw: 10, display: "10", isNull: false, isNaN: false }
      ]
    },
    {
      id: "r:1",
      rowNumber: 1,
      values: [
        { kind: "string", raw: "Paris", display: "Paris", isNull: false, isNaN: false },
        { kind: "number", raw: 20, display: "20", isNull: false, isNaN: false }
      ]
    }
  ]
};

describe("App confirmed viewing-filter history", () => {
  beforeAll(async () => {
    ({ App } = await import("../webviews/App"));
  });

  beforeEach(() => webviewPostMessage.mockClear());
  afterEach(() => cleanup());

  it("records only correlated successful filters and retains history through failed undo", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    expect(screen.queryByRole("region", { name: "Viewing filters" })).not.toBeInTheDocument();

    await applyCellFilter("Milan", "Keep only this value");
    let bar = await screen.findByRole("region", { name: "Viewing filters" });
    const failedFilter = lastPageRequest();
    expect(failedFilter.filterModel.sort).toEqual(metadata.filterModel.sort);
    expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toBeDisabled();

    dispatchAppMessage({
      kind: "error",
      code: "filter_failed",
      message: "The filter failed.",
      recoverable: true,
      sessionId: metadata.sessionId,
      viewRequestId: failedFilter.viewRequestId
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Viewing filters" })).not.toBeInTheDocument());

    webviewPostMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    const cancelledFilter = lastPageRequest();
    dispatchAppMessage({
      kind: "cancelled",
      targetRequestId: cancelledFilter.viewRequestId,
      viewRequestId: cancelledFilter.viewRequestId
    });
    expect(screen.queryByRole("region", { name: "Viewing filters" })).not.toBeInTheDocument();

    webviewPostMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    const confirmedFilter = lastPageRequest();
    confirmPage(confirmedFilter);
    bar = await screen.findByRole("region", { name: "Viewing filters" });
    expect(
      await within(bar).findByRole("button", { name: 'Remove equals "Milan" (string) filter from city' })
    ).toBeVisible();
    expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toBeEnabled();

    webviewPostMessage.mockClear();
    fireEvent.click(within(bar).getByRole("button", { name: "Undo latest filter" }));
    const failedUndo = lastPageRequest();
    expect(failedUndo.filterModel).toEqual({ filters: [], sort: metadata.filterModel.sort });
    dispatchAppMessage({
      kind: "error",
      code: "undo_filter_failed",
      message: "The filter undo failed.",
      recoverable: true,
      sessionId: metadata.sessionId,
      viewRequestId: failedUndo.viewRequestId
    });
    expect(
      await within(bar).findByRole("button", { name: 'Remove equals "Milan" (string) filter from city' })
    ).toBeVisible();
    expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toBeEnabled();

    webviewPostMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    const confirmedUndo = lastPageRequest();
    confirmPage(confirmedUndo);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Viewing filters" })).not.toBeInTheDocument());
    expect(confirmedUndo.filterModel.sort).toEqual(metadata.filterModel.sort);
  });

  it("ignores a superseded filter response instead of adding it to history", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    webviewPostMessage.mockClear();

    await applyCellFilter("Milan", "Keep only this value");
    const bar = await screen.findByRole("region", { name: "Viewing filters" });
    const first = lastPageRequest();
    await applyCellFilter("Paris", "Exclude this value");
    const second = lastPageRequest();
    expect(second.viewRequestId).not.toBe(first.viewRequestId);

    confirmPage(first);
    expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toBeDisabled();
    expect(
      within(bar).getByRole("button", { name: 'Remove does not equal "Paris" (string) filter from city' })
    ).toBeVisible();

    confirmPage(second);
    expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toBeEnabled();
    webviewPostMessage.mockClear();
    fireEvent.click(within(bar).getByRole("button", { name: "Undo latest filter" }));
    const undo = lastPageRequest();
    confirmPage(undo);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Viewing filters" })).not.toBeInTheDocument());
  });

  it("carries a pending filter undo through a superseding sort request", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await applyCellFilter("Milan", "Keep only this value");
    confirmPage(lastPageRequest());

    const bar = await screen.findByRole("region", { name: "Viewing filters" });
    webviewPostMessage.mockClear();
    fireEvent.click(within(bar).getByRole("button", { name: "Undo latest filter" }));
    const undo = lastPageRequest();

    const salesHeader = document.querySelector<HTMLElement>('th[data-column="sales"]');
    if (!salesHeader) throw new Error("Expected the sales header.");
    fireEvent.click(within(salesHeader).getByLabelText("Column actions for sales"));
    fireEvent.click(within(salesHeader).getByRole("button", { name: "Sort ascending" }));
    const sortedUndo = lastPageRequest();

    expect(sortedUndo.viewRequestId).not.toBe(undo.viewRequestId);
    expect(sortedUndo.filterModel).toEqual({
      filters: [],
      sort: [{ column: "sales", direction: "asc", nulls: "last" }]
    });
    confirmPage(undo);
    expect(screen.getByRole("region", { name: "Viewing filters" })).toBeInTheDocument();
    confirmPage(sortedUndo);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Viewing filters" })).not.toBeInTheDocument());
    expect(document.querySelector<HTMLElement>('th[data-column="sales"]')).toHaveAccessibleName(
      "sales, sorted ascending"
    );
  });

  it("keeps a stable focus target while the final filter removal is confirmed or restored", async () => {
    const restoredFilterModel: SessionMetadata["filterModel"] = {
      filters: [
        {
          column: "city",
          type: "string",
          predicates: [{ kind: "predicate", operator: "equals", value: "Milan" }]
        }
      ],
      sort: metadata.filterModel.sort
    };
    const restoredMetadata = { ...metadata, filterModel: restoredFilterModel } satisfies SessionMetadata;
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: restoredMetadata, page, summaries: [] });

    const bar = await screen.findByRole("region", { name: "Viewing filters" });
    let chip = within(bar).getByRole("button", { name: 'Remove equals "Milan" filter from city' });
    chip.focus();
    fireEvent.click(chip);
    const failedRemoval = lastPageRequest();
    expect(bar).toHaveFocus();
    expect(within(bar).getByText("No active filters")).toBeVisible();

    dispatchAppMessage({
      kind: "error",
      code: "filter_failed",
      message: "The filter failed.",
      recoverable: true,
      sessionId: restoredMetadata.sessionId,
      viewRequestId: failedRemoval.viewRequestId
    });
    chip = await within(bar).findByRole("button", { name: 'Remove equals "Milan" filter from city' });
    expect(chip).toHaveFocus();

    fireEvent.click(chip);
    confirmPage(lastPageRequest(), restoredMetadata);
    expect(await within(bar).findByText("No active filters")).toBeVisible();
    expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toHaveFocus();
  });

  it("keeps cleaning Undo distinct and resets filter history after a confirmed mutation or session replacement", async () => {
    const step: TransformStep = {
      id: "rename-city",
      kind: "renameColumn",
      params: { column: { id: "c:0", name: "city" }, newName: "location" }
    };
    const withStep = {
      ...metadata,
      steps: [step],
      latestStepInputSchema: metadata.schema
    } satisfies SessionMetadata;
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: withStep, page, summaries: [] });

    await applyCellFilter("Milan", "Keep only this value");
    const bar = await screen.findByRole("region", { name: "Viewing filters" });
    const filter = lastPageRequest();
    confirmPage(filter, withStep);
    expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toBeEnabled();
    expect(screen.getByRole("group", { name: "Cleaning plan" })).toContainElement(
      screen.getByRole("button", { name: "Undo" })
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    dispatchAppMessage({
      kind: "planUpdated",
      action: "undo",
      revision: 1,
      metadata: { ...withStep, revision: 1, filterModel: filter.filterModel, steps: [] },
      page,
      code: ""
    });
    expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toBeDisabled();

    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        backend: "pandas",
        rowAxis: { kind: "positional", levelNames: [] },
        revision: 2,
        filterModel: filter.filterModel
      },
      page,
      summaries: []
    });
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Undo latest filter" })).toBeDisabled());
  });
});

async function applyCellFilter(value: "Milan" | "Paris", action: "Keep only this value" | "Exclude this value") {
  const cell = screen.getByRole("cell", { name: value });
  fireEvent.click(within(cell).getByRole("button", { name: "Filter city by this cell" }));
  fireEvent.click(
    within(await screen.findByRole("menu", { name: "Filter city by this cell" })).getByRole("menuitem", {
      name: action
    })
  );
}

function lastPageRequest(): { viewRequestId: string; filterModel: SessionMetadata["filterModel"] } {
  const message = webviewPostMessage.mock.calls
    .map(([candidate]) => candidate)
    .filter((candidate) => candidate?.kind === "runtimeRequest" && candidate.request?.kind === "getPage")
    .at(-1);
  if (!message) throw new Error("Expected a page request.");
  return message.request;
}

function confirmPage(
  request: { viewRequestId: string; filterModel: SessionMetadata["filterModel"] },
  sourceMetadata: SessionMetadata = metadata
): void {
  dispatchAppMessage({
    kind: "page",
    revision: sourceMetadata.revision,
    viewRequestId: request.viewRequestId,
    metadata: { ...sourceMetadata, filterModel: request.filterModel },
    page
  });
}

function dispatchAppMessage(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}
