import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { ColumnSummary, GridPage, OpenWranglerResponse, SessionMetadata } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { App } from "../webviews/App";

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
  shape: { rows: 500, columns: 2 },
  filteredShape: { rows: 500, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false }
  ]
};

const page = pageWithCity("Berlin");

const citySummary: ColumnSummary = {
  columnId: "c:0",
  column: "city",
  type: "string",
  rawType: "String",
  totalCount: 500,
  nullCount: 0,
  nanCount: 0,
  distinctCount: 500,
  topValues: [{ value: "Berlin", count: 1 }]
};

describe("App progressive profiling and view correlation", () => {
  beforeEach(() => postMessage.mockClear());

  it("ignores messages from another origin", () => {
    render(<App />);
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { kind: "sessionOpened", metadata, page, summaries: [] },
          origin: "https://untrusted.invalid"
        })
      )
    );

    expect(screen.getByText("Loading dataframe...")).toBeInTheDocument();
    expect(screen.queryByText("Berlin")).toBeNull();
  });

  it("opens without exact stats and profiles each visible column independently", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });

    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const summaries = requestsOfKind("getSummary");
    expect(summaries.map((request) => request.columnIds)).toEqual([["c:0"], ["c:1"]]);
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);
    expect(viewSequence(summaries[1]) > viewSequence(summaries[0])).toBe(true);

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const nextPage = onlyRequest("getPage");
    expect(nextPage).toMatchObject({ offset: 200, limit: 200, filterModel: metadata.filterModel });
    expect(nextPage.viewRequestId).toMatch(/^view-.+-\d+$/);
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);
  });

  it("promotes a pending header profile when its column opens in the drawer", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });

    await waitFor(() => expect(runtimeEnvelopes("getSummary")).toHaveLength(2));
    const initialEnvelopes = runtimeEnvelopes("getSummary");
    expect(initialEnvelopes.every((envelope) => envelope.priority === "background")).toBe(true);
    const cityEnvelope = initialEnvelopes.find((envelope) => envelope.request.columnIds?.[0] === "c:0");
    const oldSalesEnvelope = initialEnvelopes.find((envelope) => envelope.request.columnIds?.[0] === "c:1");
    if (!cityEnvelope || !oldSalesEnvelope) throw new Error("Expected both initial header profile requests.");

    const salesCell = document.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="1"]');
    if (!salesCell) throw new Error("Expected the sales grid cell.");
    act(() => salesCell.focus());
    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));

    await waitFor(() => expect(prioritizationMessages()).toEqual([viewId(oldSalesEnvelope.request)]));
    expect(runtimeEnvelopes("getSummary")).toHaveLength(2);
    expect(cancellationMessages()).toHaveLength(0);

    const salesSummary: ColumnSummary = {
      columnId: "c:1",
      column: "sales",
      type: "float",
      rawType: "Float64",
      totalCount: 500,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 1,
      numeric: { min: 12, max: 12, mean: 12, median: 12, std: 0 },
      topValues: [{ value: "12", count: 500 }]
    };
    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(oldSalesEnvelope.request),
      summaries: [salesSummary]
    });
    const columnPanel = screen.getByRole("tabpanel", { name: "Column" });
    await waitFor(() => expect(within(columnPanel).getByText("Min").nextElementSibling).toHaveTextContent("12"));
    expect(prioritizationMessages()).not.toContain(viewId(cityEnvelope.request));
  });

  it("keeps duplicate labels distinct through out-of-order profiles and selected-column state", async () => {
    const duplicateMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 2 },
      filteredShape: { rows: 2, columns: 2 },
      schema: [
        { id: "c:left", name: "duplicate", position: 0, rawType: "Int64", type: "integer", nullable: false },
        { id: "c:right", name: "duplicate", position: 1, rawType: "Float64", type: "float", nullable: false }
      ]
    };
    const duplicatePage: GridPage = {
      offset: 0,
      limit: 2,
      totalRows: 2,
      columnIds: ["c:left", "c:right"],
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [
            { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false },
            { kind: "number", raw: 10, display: "10", isNull: false, isNaN: false }
          ]
        },
        {
          id: "r:1",
          rowNumber: 1,
          values: [
            { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false },
            { kind: "number", raw: 20, display: "20", isNull: false, isNaN: false }
          ]
        }
      ]
    };
    const leftSummary: ColumnSummary = {
      columnId: "c:left",
      column: "duplicate",
      type: "integer",
      rawType: "Int64",
      totalCount: 2,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 1,
      numeric: { min: 1, max: 1, mean: 1, median: 1, std: 0 },
      topValues: [{ value: "1", count: 2 }]
    };
    const rightSummary: ColumnSummary = {
      columnId: "c:right",
      column: "duplicate",
      type: "float",
      rawType: "Float64",
      totalCount: 2,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 2,
      numeric: { min: 10, max: 20, mean: 15, median: 15, std: 7.0711 },
      topValues: [
        { value: "10", count: 1 },
        { value: "20", count: 1 }
      ]
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: duplicateMetadata, page: duplicatePage, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const leftRequest = requestsOfKind("getSummary").find((request) => request.columnIds?.[0] === "c:left");
    const rightRequest = requestsOfKind("getSummary").find((request) => request.columnIds?.[0] === "c:right");
    if (!leftRequest || !rightRequest) throw new Error("Expected both duplicate-label summary requests.");

    dispatch({
      kind: "summary",
      revision: duplicateMetadata.revision,
      viewRequestId: viewId(rightRequest),
      summaries: [rightSummary]
    });
    dispatch({
      kind: "summary",
      revision: duplicateMetadata.revision,
      viewRequestId: viewId(leftRequest),
      summaries: [leftSummary]
    });

    const headers = [...document.querySelectorAll<HTMLElement>('th[data-column="duplicate"]')];
    expect(headers).toHaveLength(2);
    expect(within(headers[0]!).getByText("Distinct 50%")).toBeVisible();
    expect(within(headers[0]!).getByText("Min 1")).toBeVisible();
    expect(within(headers[1]!).getByText("Distinct 100%")).toBeVisible();
    expect(within(headers[1]!).getByText("Max 20")).toBeVisible();
    const duplicateRestriction =
      'View filters, sorts, and values are unavailable because 2 columns share the displayed name "duplicate". Rename one column in a cleaning step first.';
    for (const header of headers) {
      fireEvent.click(within(header).getByLabelText("Column actions for duplicate"));
      for (const action of ["Filter…", "Sort ascending", "Sort descending"]) {
        const button = within(header).getByRole("button", { name: action });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", duplicateRestriction);
      }
      expect(within(header).getByRole("button", { name: "Resize duplicate column" })).toBeEnabled();
    }

    postMessage.mockClear();
    const secondDuplicateCell = document.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="1"]');
    if (!secondDuplicateCell) throw new Error("Expected the second duplicate-label cell.");
    act(() => secondDuplicateCell.focus());
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "updateViewState",
          state: expect.objectContaining({ selectedColumnId: "c:right" })
        })
      )
    );

    const profileToggle = screen.getByRole("button", { name: "Column profiles and filters" });
    expect(profileToggle).toHaveTextContent(/^Column profiles$/u);
    fireEvent.click(profileToggle);
    const drawer = screen.getByRole("complementary", { name: "Column profiles and filters" });
    expect(within(drawer).getByText("Column profiles", { selector: ".drawerHeader strong" })).toBeVisible();
    expect(within(drawer).getByRole("tab", { name: "Column" })).toHaveAttribute("aria-selected", "true");
    expect(within(drawer).getByRole("heading", { name: "duplicate (column 2)" })).toBeVisible();
    expect(within(drawer).getByText("Min").nextElementSibling).toHaveTextContent("10");
    expect(within(drawer).getByText("Max").nextElementSibling).toHaveTextContent("20");
    expect(within(drawer).queryByRole("heading", { name: "duplicate (column 1)" })).toBeNull();

    fireEvent.click(within(drawer).getByRole("tab", { name: "Filters / Sorts" }));
    expect(within(drawer).getAllByText(duplicateRestriction).length).toBeGreaterThan(0);
    expect(within(drawer).getByRole("button", { name: "Search values in duplicate" })).toBeDisabled();
    expect(within(drawer).getByRole("button", { name: "Add to sort" })).toBeDisabled();
    expect(requestsOfKind("getColumnValues")).toHaveLength(0);
  });

  it.each(["mouse", "keyboard"] as const)(
    "moves focus into the non-modal drawer on %s entry, closes on Escape, and restores its opener",
    async (activation) => {
      const frames: FrameRequestCallback[] = [];
      const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      try {
        render(<App />);
        dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
        const toggle = await screen.findByRole("button", { name: "Column profiles and filters" });
        expect(toggle).toHaveAttribute("aria-controls", "openwrangler-insights-panel");
        if (activation === "keyboard") {
          toggle.focus();
          fireEvent.keyDown(toggle, { key: "Enter" });
          fireEvent.click(toggle, { detail: 0 });
        } else {
          fireEvent.click(toggle, { detail: 1 });
        }
        const panel = screen.getByRole("complementary", { name: "Column profiles and filters" });
        expect(panel).toHaveAttribute("id", "openwrangler-insights-panel");
        expect(panel).not.toHaveAttribute("aria-modal");
        const close = screen.getByRole("button", { name: "Close panel" });
        act(() => frames.shift()?.(performance.now()));
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: "Escape" });
        expect(screen.queryByRole("complementary", { name: "Column profiles and filters" })).toBeNull();
        act(() => frames.shift()?.(performance.now()));
        expect(toggle).toHaveFocus();
      } finally {
        hasFocus.mockRestore();
        requestFrame.mockRestore();
      }
    }
  );

  it("returns drawer focus to the toolbar when the column-filter opener is hidden", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      render(<App />);
      dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
      const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
      if (!cityHeader) throw new Error("Expected the city header.");
      fireEvent.click(within(cityHeader).getByLabelText("Column actions for city"));
      const filter = within(cityHeader).getByRole("button", { name: "Filter…" });
      filter.focus();
      fireEvent.click(filter);
      const close = screen.getByRole("button", { name: "Close panel" });
      act(() => frames.shift()?.(performance.now()));
      expect(close).toHaveFocus();

      fireEvent.keyDown(close, { key: "Escape" });
      act(() => frames.shift()?.(performance.now()));
      expect(screen.getByRole("button", { name: "Column profiles and filters" })).toHaveFocus();
    } finally {
      hasFocus.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("keeps one renderer handshake while opening and accepting progressive profiles", async () => {
    render(<App />);
    expect(messagesOfKind("ready")).toHaveLength(1);

    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    expect(messagesOfKind("ready")).toHaveLength(1);

    for (const request of requestsOfKind("getSummary")) {
      const columnId = request.columnIds?.[0];
      if (!columnId) throw new Error("Expected a column-scoped summary request.");
      const column = metadata.schema.find((candidate) => candidate.id === columnId);
      if (!column) throw new Error("Expected a known summary column identity.");
      dispatch({
        kind: "summary",
        revision: metadata.revision,
        viewRequestId: viewId(request),
        summaries: [
          columnId === "c:0"
            ? citySummary
            : {
                ...citySummary,
                columnId,
                column: column.name,
                type: "float",
                rawType: "Float64",
                topValues: []
              }
        ]
      });
    }

    expect(await screen.findAllByText("Distinct 100%")).toHaveLength(2);
    expect(screen.queryByText("Profiling…")).not.toBeInTheDocument();
    expect(messagesOfKind("ready")).toHaveLength(1);
  });

  it("restores host-owned grid presentation and publishes bounded changes independently from runtime requests", async () => {
    render(<App />);
    const restoredPage = {
      ...page,
      offset: 200,
      rows: page.rows.map((row, index) => ({ ...row, id: `r:${index + 200}`, rowNumber: index + 200 }))
    };
    dispatch({ kind: "sessionOpened", metadata, page: restoredPage, summaries: [] });
    dispatch({
      kind: "viewState",
      state: {
        columnWidths: { "c:1": 275 },
        selectedColumnId: "c:1",
        viewport: { firstVisibleRow: 200, scrollLeft: 90 }
      }
    });

    const scroller = screen.getByTestId("data-grid-scroller");
    expect(scroller.scrollTop).toBe(200 * 29);
    expect(scroller.scrollLeft).toBe(90);
    expect(document.querySelectorAll("col")[2]).toHaveStyle({ width: "275px" });
    expect(document.querySelector('th[data-column="sales"]')).toHaveAttribute("aria-selected", "true");

    postMessage.mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize sales column" }), { key: "ArrowRight" });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        kind: "updateViewState",
        state: {
          columnWidths: { "c:1": 285 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 200, scrollLeft: 90 }
        }
      })
    );
    expect(requestsOfKind("getPage")).toHaveLength(0);
  });

  it("trailing-debounces presentation persistence until scrolling and resizing settle", () => {
    vi.useFakeTimers();
    const view = render(<App />);
    try {
      dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
      dispatch({
        kind: "viewState",
        state: {
          columnWidths: { "c:1": 275 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        }
      });
      postMessage.mockClear();
      const resize = screen.getByRole("button", { name: "Resize sales column" });

      fireEvent.keyDown(resize, { key: "ArrowRight" });
      act(() => vi.advanceTimersByTime(75));
      fireEvent.keyDown(resize, { key: "ArrowRight" });
      act(() => vi.advanceTimersByTime(75));
      expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "updateViewState" }));

      act(() => vi.advanceTimersByTime(25));
      expect(
        postMessage.mock.calls.map(([message]) => message).filter((message) => message.kind === "updateViewState")
      ).toEqual([
        {
          kind: "updateViewState",
          state: {
            columnWidths: { "c:1": 295 },
            selectedColumnId: "c:1",
            viewport: { firstVisibleRow: 0, scrollLeft: 0 }
          }
        }
      ]);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it.each(["pagehide", "beforeunload"])("flushes the final pending grid presentation on %s", (eventName) => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    dispatch({
      kind: "viewState",
      state: {
        columnWidths: { "c:1": 275 },
        selectedColumnId: "c:1",
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });
    postMessage.mockClear();

    fireEvent.keyDown(screen.getByRole("button", { name: "Resize sales column" }), { key: "ArrowRight" });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "updateViewState" }));

    act(() => window.dispatchEvent(new Event(eventName)));

    expect(postMessage).toHaveBeenCalledWith({
      kind: "updateViewState",
      state: {
        columnWidths: { "c:1": 285 },
        selectedColumnId: "c:1",
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });
  });

  it("clears host-invalidated applied-step inspection locally without echoing the clear", () => {
    const step = {
      id: "round-sales",
      kind: "roundNumber",
      params: { column: { id: "c:1", name: "sales" }, decimals: 0 }
    } as const;
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: { ...metadata, steps: [step] }, page, summaries: [] });
    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "selectStep", stepId: step.id });
    expect(screen.getByLabelText("Selected applied-step inspection")).toBeInTheDocument();
    expect(requestsOfKind("inspectStep")).toHaveLength(1);

    postMessage.mockClear();
    dispatch({ kind: "stepInspectionCleared", resumeProfiling: true });

    expect(screen.queryByLabelText("Selected applied-step inspection")).not.toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalledWith({ kind: "clearStepInspection" });
  });

  it("accepts only the newest page across A to B to A and out-of-order completion", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    postMessage.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    selectInsightsView("Filters / Sorts");
    sortCityAscending();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    const pages = requestsOfKind("getPage");
    expect(pages).toHaveLength(2);
    const [requestB, requestA] = pages;
    expect(viewSequence(requestA) > viewSequence(requestB)).toBe(true);

    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(requestA),
      metadata,
      page: pageWithCity("Latest A")
    });
    expect(await screen.findByText("Latest A")).toBeInTheDocument();

    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(requestB),
      metadata: { ...metadata, filterModel: requestB.filterModel as FilterModel },
      page: pageWithCity("Stale B")
    });
    expect(screen.queryByText("Stale B")).not.toBeInTheDocument();
    expect(screen.getByText("Latest A")).toBeInTheDocument();
  });

  it("keeps foreground loading through stale background failures and retries an unchanged failed filter", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const oldSummary = requestsOfKind("getSummary")[0];
    postMessage.mockClear();

    sortCityAscending();
    const firstPage = onlyRequest("getPage");
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    dispatch({
      kind: "error",
      code: "profile_failed",
      message: "Old profile failed",
      recoverable: true,
      viewRequestId: viewId(oldSummary)
    });
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Page failed",
      recoverable: true,
      viewRequestId: viewId(firstPage)
    });
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.getByText("Page failed")).toBeInTheDocument();

    postMessage.mockClear();
    sortCityAscending();
    const retry = onlyRequest("getPage");
    expect(viewId(retry)).not.toBe(viewId(firstPage));
  });

  it("restores the confirmed view context and restarts profiling when a new view fails", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    openCityFilter();
    const values = onlyRequest("getColumnValues");
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(values),
      column: "city",
      values: [{ value: "Restored value", count: 7 }],
      hasMore: false
    });
    expect(await screen.findByText("Restored value")).toBeInTheDocument();
    selectInsightsView("Dataset");
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const confirmedContext = setViewContextMessages().at(-1)?.viewContextId;
    if (!confirmedContext) throw new Error("Expected the opened view context.");

    postMessage.mockClear();
    sortCityAscending();
    const failedPage = onlyRequest("getPage");
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "The sorted view failed",
      recoverable: true,
      viewRequestId: viewId(failedPage)
    });

    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    expect(setViewContextMessages().at(-1)?.viewContextId).toBe(confirmedContext);
    for (const envelope of [...runtimeEnvelopes("getSummary"), ...runtimeEnvelopes("getDatasetStats")]) {
      expect(envelope.viewContextId).toBe(confirmedContext);
    }
    expect(screen.getByText("Berlin")).toBeInTheDocument();
    selectInsightsView("Filters / Sorts");
    expect(screen.getByText("Restored value")).toBeInTheDocument();
    expect(screen.getByText("The sorted view failed")).toBeInTheDocument();
  });

  it("releases failed summary work and retries the column with a fresh correlation ID", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const firstCity = requestsOfKind("getSummary").find((request) => request.columnIds?.[0] === "c:0");
    if (!firstCity) throw new Error("Expected the initial city summary request.");

    dispatch({
      kind: "error",
      code: "profile_failed",
      message: "Profile failed once",
      recoverable: true,
      viewRequestId: viewId(firstCity)
    });

    await waitFor(() => {
      const cityRequests = requestsOfKind("getSummary").filter((request) => request.columnIds?.[0] === "c:0");
      expect(cityRequests).toHaveLength(2);
    });
    const retry = requestsOfKind("getSummary").filter((request) => request.columnIds?.[0] === "c:0")[1];
    expect(viewSequence(retry) > viewSequence(firstCity)).toBe(true);

    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(retry),
      summaries: [citySummary]
    });
    expect(await screen.findByText("Distinct 100%")).toBeInTheDocument();
  });

  it("restores confirmed profile and value state after mutation errors and cancellation", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const cityRequest = requestsOfKind("getSummary").find((request) => request.columnIds?.[0] === "c:0");
    if (!cityRequest) throw new Error("Expected the city summary request.");
    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(cityRequest),
      summaries: [citySummary]
    });

    openCityFilter();
    const valuesRequest = onlyRequest("getColumnValues");
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(valuesRequest),
      column: "city",
      values: [{ value: "Owned value", count: 4 }],
      hasMore: false
    });
    expect(await screen.findByText("Distinct 100%")).toBeInTheDocument();
    expect(await screen.findByText("Owned value")).toBeInTheDocument();
    const confirmedContext = setViewContextMessages().at(-1)?.viewContextId;

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    expect(onlyRequest("undoStep")).toBeDefined();
    dispatch({
      kind: "error",
      code: "mutation_failed",
      message: "The mutation failed",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(await screen.findByText("Owned value")).toBeInTheDocument();
    expect(screen.getByText("Distinct 100%")).toBeInTheDocument();
    expect(screen.getByText("The mutation failed")).toBeInTheDocument();
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(1));
    expect(onlyRequest("getSummary").columnIds).toEqual(["c:1"]);
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);
    expect(setViewContextMessages().at(-1)?.viewContextId).toBe(confirmedContext);

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    expect(onlyRequest("undoStep")).toBeDefined();
    dispatch({ kind: "cancelled", targetRequestId: "mutation" });

    expect(await screen.findByText("Owned value")).toBeInTheDocument();
    expect(screen.getByText("Distinct 100%")).toBeInTheDocument();
    expect(screen.getByText("The cleaning operation was cancelled.")).toBeInTheDocument();
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(1));
    expect(onlyRequest("getSummary").columnIds).toEqual(["c:1"]);
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);
  });

  it("requests exact stats only for an open drawer and never accepts stale stats", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    selectInsightsView("Dataset");
    expect(screen.getByText("Profiling exact dataset statistics...")).toBeInTheDocument();
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const oldStats = requestsOfKind("getDatasetStats")[0];

    sortCityAscending();
    const sortedPage = requestsOfKind("getPage").at(-1);
    if (!sortedPage) throw new Error("Expected the sorted page request.");
    dispatch({
      kind: "datasetStats",
      revision: metadata.revision,
      viewRequestId: viewId(oldStats),
      stats: emptyStats()
    });
    expect(screen.getByText("Profiling exact dataset statistics...")).toBeInTheDocument();

    const sortedFilter = sortedPage.filterModel as FilterModel;
    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(sortedPage),
      metadata: { ...metadata, filterModel: sortedFilter },
      page
    });
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(2));
    const currentStats = requestsOfKind("getDatasetStats")[1];
    dispatch({
      kind: "datasetStats",
      revision: metadata.revision,
      viewRequestId: viewId(currentStats),
      stats: emptyStats()
    });
    expect(await screen.findByText("No missing values.")).toBeInTheDocument();
  });

  it("accepts only the latest values search for a column", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");

    fireEvent.click(screen.getByLabelText("Column actions for city"));
    const cityHeader = document.querySelector<HTMLTableCellElement>('th[data-column="city"]');
    if (!cityHeader) throw new Error("Expected the city column header.");
    fireEvent.click(within(cityHeader).getByRole("button", { name: "Filter…" }));
    const firstValues = requestsOfKind("getColumnValues").at(-1);
    if (!firstValues) throw new Error("Expected the initial values request.");

    const search = screen.getByPlaceholderText("Search values");
    fireEvent.change(search, { target: { value: "mil" } });
    fireEvent.keyDown(search, { key: "Enter" });
    const latestValues = requestsOfKind("getColumnValues").at(-1);
    if (!latestValues) throw new Error("Expected the searched values request.");
    expect(viewId(latestValues)).not.toBe(viewId(firstValues));
    expect(latestValues.search).toBe("mil");
    await waitFor(() =>
      expect(cancellationMessages().flatMap((message) => message.viewRequestIds)).toContain(viewId(firstValues))
    );

    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(firstValues),
      column: "city",
      values: [{ value: "Berlin", count: 10 }],
      hasMore: false
    });
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(latestValues),
      column: "city",
      values: [{ value: "Milan", count: 3 }],
      hasMore: false
    });
    expect(await screen.findByText("Milan")).toBeInTheDocument();
    expect(screen.queryByText("Berlin", { selector: ".valueList span" })).not.toBeInTheDocument();
  });

  it("cancels filter-value work and ignores its late diagnostic after leaving Filters", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    openCityFilter();
    const valuesRequest = onlyRequest("getColumnValues");

    postMessage.mockClear();
    selectInsightsView("Column");

    await waitFor(() =>
      expect(cancellationMessages().flatMap((message) => message.viewRequestIds)).toContain(viewId(valuesRequest))
    );
    dispatch({
      kind: "error",
      code: "profile_failed",
      message: "A stale values warning",
      recoverable: true,
      viewRequestId: viewId(valuesRequest)
    });
    expect(screen.queryByText(/A stale values warning/)).not.toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Column" })).toBeInTheDocument();
  });

  it("keeps foreground page failures separate from successful profiling work", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const cityProfile = requestsOfKind("getSummary").find((request) => request.columnIds?.[0] === "c:0");
    if (!cityProfile) throw new Error("Expected a city summary request.");

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const failedPage = onlyRequest("getPage");
    dispatch({ kind: "cancelled", targetRequestId: "unrelated-request" });
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Page fetch failed",
      recoverable: true,
      viewRequestId: viewId(failedPage)
    });
    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(cityProfile),
      summaries: [citySummary]
    });

    expect(await screen.findByText("Distinct 100%")).toBeInTheDocument();
    expect(screen.getByText("Page fetch failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry page" })).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("keeps profiling diagnostics until that profiling request succeeds", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const cityProfile = requestsOfKind("getSummary").find((request) => request.columnIds?.[0] === "c:0");
    if (!cityProfile) throw new Error("Expected a city summary request.");

    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    selectInsightsView("Dataset");
    const stats = onlyRequest("getDatasetStats");
    dispatch({
      kind: "error",
      code: "stats_failed",
      message: "Exact stats failed",
      recoverable: true,
      viewRequestId: viewId(stats)
    });
    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(cityProfile),
      summaries: [citySummary]
    });

    expect(await screen.findByText(/Profile warning: Exact stats failed/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByText(/Profile warning: Exact stats failed/)).not.toBeInTheDocument();
  });

  it("restores confirmed profiling diagnostics after a foreground mutation fails", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    selectInsightsView("Dataset");
    const firstStats = onlyRequest("getDatasetStats");
    dispatch({
      kind: "error",
      code: "stats_failed",
      message: "Keep this exact-stats warning",
      recoverable: true,
      viewRequestId: viewId(firstStats)
    });
    expect(await screen.findByText(/Keep this exact-stats warning/)).toBeInTheDocument();
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(2));

    postMessage.mockClear();
    dispatch({ kind: "editorAction", action: "undoStep" });
    expect(onlyRequest("undoStep")).toBeDefined();
    expect(screen.queryByText(/Keep this exact-stats warning/)).not.toBeInTheDocument();
    dispatch({
      kind: "error",
      code: "mutation_failed",
      message: "Undo failed",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(await screen.findByText(/Keep this exact-stats warning/)).toBeInTheDocument();
    expect(screen.getByText("Undo failed")).toBeInTheDocument();
  });

  it("transfers open selected-column profile ownership when the selected grid column changes", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Header profiles" }));
    await waitFor(() => expect(cancellationMessages().length).toBeGreaterThan(0));

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(1));
    const cityRequest = onlyRequest("getSummary");
    expect(cityRequest.columnIds).toEqual(["c:0"]);
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);

    const salesCell = document.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="1"]');
    if (!salesCell) throw new Error("Expected the sales grid cell.");
    act(() => salesCell.focus());

    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const salesRequest = requestsOfKind("getSummary").at(-1);
    if (!salesRequest) throw new Error("Expected the selected sales-column summary request.");
    expect(salesRequest.columnIds).toEqual(["c:1"]);
    expect(cancellationMessages().flatMap((message) => message.viewRequestIds)).toContain(viewId(cityRequest));
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);

    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(cityRequest),
      summaries: [citySummary]
    });
    const columnPanel = screen.getByRole("tabpanel", { name: "Column" });
    expect(within(columnPanel).getByRole("heading", { name: "sales" })).toBeVisible();
    expect(within(columnPanel).getByText("Profiling selected column...")).toBeVisible();

    const salesSummary: ColumnSummary = {
      columnId: "c:1",
      column: "sales",
      type: "float",
      rawType: "Float64",
      totalCount: 500,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 1,
      numeric: { min: 12, max: 12, mean: 12, median: 12, std: 0 },
      topValues: [{ value: "12", count: 500 }]
    };
    dispatch({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: viewId(salesRequest),
      summaries: [salesSummary]
    });

    await waitFor(() => expect(within(columnPanel).getByText("Min").nextElementSibling).toHaveTextContent("12"));
    expect(within(columnPanel).queryByRole("heading", { name: "city" })).not.toBeInTheDocument();
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);
  });

  it("profiles only the selected drawer column and cancels view-specific ownership", async () => {
    const columns = Array.from({ length: 20 }, (_, position) => ({
      id: `c:${position}`,
      name: `column-${position}`,
      position,
      rawType: "String",
      type: "string" as const,
      nullable: false
    }));
    const wideMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 1, columns: columns.length },
      filteredShape: { rows: 1, columns: columns.length },
      schema: columns
    };
    const widePage: GridPage = {
      offset: 0,
      limit: 200,
      totalRows: 1,
      columnIds: columns.map((column) => column.id),
      rows: [
        {
          id: "r:wide",
          rowNumber: 0,
          values: columns.map(({ name }) => ({
            kind: "string" as const,
            raw: name,
            display: name,
            isNull: false,
            isNaN: false
          }))
        }
      ]
    };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: wideMetadata, page: widePage, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Header profiles" }));
    await waitFor(() => expect(cancellationMessages().length).toBeGreaterThan(0));

    postMessage.mockClear();
    const secondColumnCell = document.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="1"]');
    if (!secondColumnCell) throw new Error("Expected the second visible wide-grid cell.");
    act(() => secondColumnCell.focus());
    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(1));
    const selectedSummaryEnvelope = onlyRuntimeEnvelope("getSummary");
    const selectedSummary = selectedSummaryEnvelope.request;
    expect(selectedSummary.columnIds).toEqual(["c:1"]);
    expect(selectedSummaryEnvelope.priority).toBe("interactive");
    expect(requestsOfKind("getDatasetStats")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "column-1" })).toBeVisible();

    selectInsightsView("Dataset");
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const statsId = viewId(onlyRequest("getDatasetStats"));
    expect(cancellationMessages().flatMap((message) => message.viewRequestIds)).toContain(viewId(selectedSummary));

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(cancellationMessages().flatMap((message) => message.viewRequestIds)).toContain(statsId);
  });

  it("cancels obsolete background work on view changes and drawer close", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const initialSummaryIds = requestsOfKind("getSummary").map(viewId);

    sortCityAscending();
    const viewCancellation = cancellationMessages().at(-1);
    expect(viewCancellation?.viewRequestIds).toEqual(expect.arrayContaining(initialSummaryIds));

    const sortedPage = requestsOfKind("getPage").at(-1);
    if (!sortedPage) throw new Error("Expected a sorted page request.");
    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(sortedPage),
      metadata: { ...metadata, filterModel: sortedPage.filterModel as FilterModel },
      page
    });

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    selectInsightsView("Dataset");
    await waitFor(() => expect(requestsOfKind("getDatasetStats")).toHaveLength(1));
    const statsId = viewId(onlyRequest("getDatasetStats"));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));

    expect(cancellationMessages().at(-1)?.viewRequestIds).toContain(statsId);
  });

  it("keeps a drawer-started summary when the visible grid also claims it", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    for (const request of requestsOfKind("getSummary")) {
      dispatch({
        kind: "summary",
        revision: metadata.revision,
        viewRequestId: viewId(request),
        summaries:
          request.columnIds?.[0] === "c:0"
            ? [citySummary]
            : [{ ...citySummary, columnId: "c:1", column: "sales", type: "float", rawType: "Float64" }]
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Header profiles" }));

    postMessage.mockClear();
    sortCityAscending();
    const sortedPage = onlyRequest("getPage");
    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(sortedPage),
      metadata: { ...metadata, filterModel: sortedPage.filterModel as FilterModel },
      page
    });
    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(1));
    const drawerSummaryId = viewId(onlyRequest("getSummary"));
    expect(onlyRequest("getSummary").columnIds).toEqual(["c:0"]);

    fireEvent.click(screen.getByRole("button", { name: "Header profiles" }));
    await waitFor(() => expect(requestsOfKind("getSummary")).toHaveLength(2));
    const gridOnlySummary = requestsOfKind("getSummary").find((request) => request.columnIds?.[0] === "c:1");
    if (!gridOnlySummary) throw new Error("Expected the visible grid to request the other column.");
    fireEvent.click(screen.getByRole("button", { name: "Header profiles" }));
    await waitFor(() => {
      const cancelledIds = cancellationMessages().flatMap((message) => message.viewRequestIds);
      expect(cancelledIds).toContain(viewId(gridOnlySummary));
      expect(cancelledIds).not.toContain(drawerSummaryId);
    });
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await waitFor(() => {
      const cancelledIds = cancellationMessages().flatMap((message) => message.viewRequestIds);
      expect(cancelledIds).toContain(drawerSummaryId);
    });
  });

  it("retries the same failed page block with a fresh request ID and the same logical view", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    expect(screen.getByRole("columnheader", { name: "city" })).toHaveAttribute("tabindex", "0");
    postMessage.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const first = onlyRuntimeEnvelope("getPage");
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Block failed",
      recoverable: true,
      viewRequestId: viewId(first.request)
    });

    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    const retry = onlyRuntimeEnvelope("getPage");
    expect(retry.request.offset).toBe(200);
    expect(viewId(retry.request)).not.toBe(viewId(first.request));
    expect(retry.viewContextId).toBe(first.viewContextId);

    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      dispatch({
        kind: "page",
        revision: metadata.revision,
        viewRequestId: viewId(retry.request),
        metadata,
        page: { ...page, offset: 200, rows: [{ ...page.rows[0], rowNumber: 200, id: "r:200" }] }
      });
      await waitFor(() => expect(document.activeElement).toHaveAttribute("data-grid-row", "200"));
    } finally {
      hasFocus.mockRestore();
    }
  });

  it("does not restore retry focus after the host takes focus before the page response commits", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    postMessage.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    const first = onlyRuntimeEnvelope("getPage");
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Block failed",
      recoverable: true,
      viewRequestId: viewId(first.request)
    });
    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
    const retry = onlyRuntimeEnvelope("getPage");

    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      dispatch({
        kind: "page",
        revision: metadata.revision,
        viewRequestId: viewId(retry.request),
        metadata,
        page: { ...page, offset: 200, rows: [{ ...page.rows[0], rowNumber: 200, id: "r:200" }] }
      });
      expect(frames).toHaveLength(1);
      focus.mockClear();
      hasFocus.mockReturnValue(false);
      act(() => {
        for (const frame of frames) frame(performance.now());
      });
      expect(focus).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
      hasFocus.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("does not restore drawer focus after the host takes focus before the close frame runs", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    expect(screen.getByRole("complementary", { name: "Column profiles and filters" })).toBeInTheDocument();

    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
      expect(frames).toHaveLength(1);
      focus.mockClear();
      hasFocus.mockReturnValue(false);
      act(() => {
        for (const frame of frames) frame(performance.now());
      });
      expect(focus).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
      hasFocus.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("uses a new opaque view context for A to B to A even when filters and revisions match again", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    postMessage.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    selectInsightsView("Filters / Sorts");
    sortCityAscending();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const [viewB, viewAAgain] = runtimeEnvelopes("getPage");

    expect(viewB.viewContextId).toBe(viewId(viewB.request));
    expect(viewAAgain.viewContextId).toBe(viewId(viewAAgain.request));
    expect(viewAAgain.viewContextId).not.toBe(viewB.viewContextId);
  });

  it("keeps value candidates available for multi-select filters and facets values outside their own filter", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByText("Berlin");
    openCityFilter();
    const valuesRequest = onlyRequest("getColumnValues");
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(valuesRequest),
      column: "city",
      values: [
        { value: "Berlin", count: 7 },
        { value: "Milan", count: 5 }
      ],
      hasMore: false
    });

    fireEvent.click(await screen.findByRole("checkbox", { name: /Berlin/ }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Berlin/ })).toBeChecked());
    expect(screen.getByRole("checkbox", { name: /Milan/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Milan/ }));

    const pageRequests = requestsOfKind("getPage");
    expect(pageRequests).toHaveLength(2);
    const latestPage = pageRequests.at(-1);
    if (!latestPage) throw new Error("Expected the combined value-filter request.");
    const latestModel = latestPage.filterModel as FilterModel;
    expect(latestModel.filters[0]?.valueFilter?.selectedValues).toEqual(["Berlin", "Milan"]);

    dispatch({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: viewId(latestPage),
      metadata: { ...metadata, filterModel: latestModel },
      page
    });
    postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Search values/iu }));
    expect((onlyRequest("getColumnValues").filterModel as FilterModel).filters).toEqual([]);
  });

  it("rolls overlapping view failures back to the original confirmed profiles and values", async () => {
    const profiledMetadata = { ...metadata, stats: emptyStats() };
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata: profiledMetadata, page, summaries: [citySummary] });
    await screen.findByText("Distinct 100%");
    openCityFilter();
    const valuesRequest = onlyRequest("getColumnValues");
    dispatch({
      kind: "columnValues",
      revision: metadata.revision,
      viewRequestId: viewId(valuesRequest),
      column: "city",
      values: [{ value: "Confirmed candidate", count: 7 }],
      hasMore: false
    });
    expect(await screen.findByText("Confirmed candidate")).toBeInTheDocument();
    selectInsightsView("Dataset");
    expect(screen.getByText("No missing values.")).toBeInTheDocument();
    selectInsightsView("Filters / Sorts");
    const originalContext = setViewContextMessages().at(-1)?.viewContextId;

    postMessage.mockClear();
    sortCityAscending();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const pageRequests = requestsOfKind("getPage");
    expect(pageRequests).toHaveLength(2);
    const newest = pageRequests[1];
    dispatch({
      kind: "error",
      code: "page_failed",
      message: "Newest view failed",
      recoverable: true,
      viewRequestId: viewId(newest)
    });

    expect(await screen.findByText("Distinct 100%")).toBeInTheDocument();
    expect(screen.getByText("Confirmed candidate")).toBeInTheDocument();
    selectInsightsView("Dataset");
    expect(screen.getByText("No missing values.")).toBeInTheDocument();
    expect(setViewContextMessages().at(-1)?.viewContextId).toBe(originalContext);
  });

  it("keeps authored operation input mounted when preview fails", async () => {
    render(<App />);
    dispatch({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("button", { name: "Add step" });
    openCityFilter();
    const clearAll = screen.getByRole("button", { name: "Clear all" });
    const values = screen.getByRole("button", { name: /Search values/iu });
    dispatch({ kind: "editorAction", action: "openOperation", operationKind: "customCode" });
    await screen.findByRole("dialog", { name: "Add cleaning step" });
    const code = await screen.findByLabelText(/Engine-native Python/);
    fireEvent.change(code, { target: { value: "result = df.filter(pl.col('sales') > 10)" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(onlyRequest("previewStep")).toMatchObject({
      step: { kind: "customCode", params: { code: "result = df.filter(pl.col('sales') > 10)" } }
    });

    const dialog = screen.getByRole("dialog", { name: "Add cleaning step" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(code).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close operation picker" })).toBeDisabled();
    expect(screen.getByTestId("app-workspace")).toHaveAttribute("inert");
    expect(screen.getByTestId("app-workspace")).toHaveAttribute("aria-hidden", "true");
    expect(clearAll).toBeDisabled();
    expect(values).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close operation picker" }));
    expect(screen.getByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    dispatch({
      kind: "error",
      code: "custom_code_failed",
      message: "Custom code failed",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(screen.getByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Engine-native Python/)).toHaveValue("result = df.filter(pl.col('sales') > 10)");
    expect(clearAll).toBeEnabled();
    expect(values).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close operation picker" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull());
  });
});

function sortCityAscending(): void {
  fireEvent.click(screen.getByLabelText("Column actions for city"));
  const cityHeader = document.querySelector<HTMLTableCellElement>('th[data-column="city"]');
  if (!cityHeader) throw new Error("Expected the city column header.");
  fireEvent.click(within(cityHeader).getByRole("button", { name: "Sort ascending" }));
}

function openCityFilter(): void {
  fireEvent.click(screen.getByLabelText("Column actions for city"));
  const cityHeader = document.querySelector<HTMLTableCellElement>('th[data-column="city"]');
  if (!cityHeader) throw new Error("Expected the city column header.");
  fireEvent.click(within(cityHeader).getByRole("button", { name: "Filter…" }));
}

function selectInsightsView(view: "Column" | "Dataset" | "Filters / Sorts"): void {
  fireEvent.click(screen.getByRole("tab", { name: view }));
}

function dispatch(
  data: OpenWranglerResponse | EditorActionMessage | ViewStateMessage | StepInspectionClearedMessage
): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

interface EditorActionMessage {
  kind: "editorAction";
  action: "undoStep" | "openOperation" | "selectStep";
  operationKind?: "customCode";
  stepId?: string;
}

interface ViewStateMessage {
  kind: "viewState";
  state: unknown;
}

interface StepInspectionClearedMessage {
  kind: "stepInspectionCleared";
  resumeProfiling: boolean;
}

interface RuntimeRequest {
  kind: string;
  viewRequestId?: string;
  columnIds?: string[];
  filterModel?: unknown;
  [key: string]: unknown;
}

interface RuntimeEnvelope {
  kind: "runtimeRequest";
  viewContextId?: string;
  priority?: "interactive" | "background";
  request: RuntimeRequest;
}

interface CancellationMessage {
  kind: "cancelViewRequests";
  viewRequestIds: string[];
}

interface PrioritizationMessage {
  kind: "prioritizeViewRequest";
  viewRequestId: string;
}

interface SetViewContextMessage {
  kind: "setViewContext";
  viewContextId: string;
}

function runtimeEnvelopes(kind?: string): RuntimeEnvelope[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as Partial<RuntimeEnvelope>;
    if (
      candidate.kind !== "runtimeRequest" ||
      !isRuntimeRequest(candidate.request) ||
      (kind !== undefined && candidate.request.kind !== kind)
    )
      return [];
    return [candidate as RuntimeEnvelope];
  });
}

function onlyRuntimeEnvelope(kind: string): RuntimeEnvelope {
  const matches = runtimeEnvelopes(kind);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function cancellationMessages(): CancellationMessage[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as Partial<CancellationMessage>;
    return candidate.kind === "cancelViewRequests" && Array.isArray(candidate.viewRequestIds)
      ? [candidate as CancellationMessage]
      : [];
  });
}

function prioritizationMessages(): string[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as Partial<PrioritizationMessage>;
    return candidate.kind === "prioritizeViewRequest" && typeof candidate.viewRequestId === "string"
      ? [candidate.viewRequestId]
      : [];
  });
}

function setViewContextMessages(): SetViewContextMessage[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as Partial<SetViewContextMessage>;
    return candidate.kind === "setViewContext" && typeof candidate.viewContextId === "string"
      ? [candidate as SetViewContextMessage]
      : [];
  });
}

function runtimeRequests(): RuntimeRequest[] {
  return postMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as { kind?: unknown; request?: unknown };
    if (candidate.kind !== "runtimeRequest" || !isRuntimeRequest(candidate.request)) return [];
    return [candidate.request];
  });
}

function requestsOfKind(kind: string): RuntimeRequest[] {
  return runtimeRequests().filter((request) => request.kind === kind);
}

function messagesOfKind(kind: string): unknown[] {
  return postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => typeof message === "object" && message !== null && "kind" in message && message.kind === kind);
}

function onlyRequest(kind: string): RuntimeRequest {
  const matches = requestsOfKind(kind);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function viewId(request: RuntimeRequest): string {
  if (!request.viewRequestId) throw new Error(`Request ${request.kind} has no viewRequestId.`);
  return request.viewRequestId;
}

function viewSequence(request: RuntimeRequest): number {
  return Number(viewId(request).split("-").at(-1));
}

function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  return typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string";
}

function pageWithCity(city: string): GridPage {
  return {
    offset: 0,
    limit: 200,
    totalRows: 500,
    columnIds: metadata.schema.map((column) => column.id),
    rows: [
      {
        id: "r:0",
        rowNumber: 0,
        values: [
          { kind: "string", raw: city, display: city, isNull: false, isNaN: false },
          { kind: "number", raw: 12, display: "12", isNull: false, isNaN: false }
        ]
      }
    ]
  };
}

function emptyStats() {
  return { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] };
}
