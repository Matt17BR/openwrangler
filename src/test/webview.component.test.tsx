import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnSummary, GridPage, LiveGridPage, SessionMetadata, TransformStep } from "../shared/protocol";
import { DataGrid, requestedGridPageOffset } from "../webviews/grid/DataGrid";
import { maximumGridScrollCanvasHeight } from "../webviews/grid/rowScrollModel";

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
  filterModel: { filters: [], sort: [] },
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
  columnIds: metadata.schema.map((column) => column.id),
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [
        { kind: "string", raw: "Milan", display: "Milan", isNull: false, isNaN: false },
        { kind: "number", raw: 10.5, display: "10.5", isNull: false, isNaN: false }
      ]
    },
    {
      id: "r:1",
      rowNumber: 1,
      values: [
        { kind: "string", raw: "Paris", display: "Paris", isNull: false, isNaN: false },
        { kind: "null", raw: null, display: "", isNull: true, isNaN: false }
      ]
    }
  ]
};

const chromiumMaximumLayoutHeight = 33_554_428;
const largeGridRowCount = 3_012_020;
const largeGridPageSize = 200;

function pageAt(offset: number, totalRows = largeGridRowCount): GridPage {
  const rowCount = Math.min(largeGridPageSize, Math.max(0, totalRows - offset));
  return {
    offset,
    limit: largeGridPageSize,
    totalRows,
    columnIds: page.columnIds,
    rows: Array.from({ length: rowCount }, (_, index) => {
      const rowNumber = offset + index;
      return {
        id: `r:${rowNumber}`,
        rowNumber,
        values: [
          {
            kind: "string" as const,
            raw: `row-${rowNumber}`,
            display: `row-${rowNumber}`,
            isNull: false,
            isNaN: false
          },
          {
            kind: "number" as const,
            raw: rowNumber,
            display: String(rowNumber),
            isNull: false,
            isNaN: false
          }
        ]
      };
    })
  };
}

describe("DataGrid", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders schema headers and cell values", () => {
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.getByText("city")).toBeTruthy();
    expect(screen.getByText("sales")).toBeTruthy();
    expect(screen.getByText("Milan")).toBeTruthy();
    expect(screen.getByText("Paris")).toBeTruthy();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "3");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "3");
    expect(screen.getByRole("grid").querySelector("col")).toHaveStyle({ width: "58px" });
  });

  it("filters a cell through its exact typed value without changing ordinary cell selection", async () => {
    const onApplyCellFilter = vi.fn();
    const onViewStateChange = vi.fn();
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onApplyCellFilter={onApplyCellFilter}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
        onViewStateChange={onViewStateChange}
      />
    );

    const city = screen.getByRole("cell", { name: "Milan" });
    act(() => city.focus());
    expect(onViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedColumnId: "c:0" }));
    expect(onApplyCellFilter).not.toHaveBeenCalled();

    const funnel = within(city).getByRole("button", { name: "Filter city by this cell" });
    expect(funnel).toHaveAttribute("tabindex", "-1");
    fireEvent.click(funnel);
    const menu = await screen.findByRole("menu", { name: "Filter city by this cell" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Keep only this value" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Keep only this value" }));

    expect(onApplyCellFilter).toHaveBeenCalledWith({
      column: "city",
      type: "string",
      logic: "and",
      valueFilter: {
        kind: "values",
        selectedValues: [
          {
            kind: "typedSelection",
            version: 1,
            columnType: "string",
            cell: { kind: "string", raw: "Milan", display: "Milan", isNull: false, isNaN: false }
          }
        ],
        includeNulls: false,
        includeNaN: false
      },
      predicates: []
    });
  });

  it("opens cell filters from the keyboard and context menu with null and NaN actions", async () => {
    const nanPage: GridPage = {
      ...page,
      rows: [
        { ...page.rows[1]!, id: "r:null", rowNumber: 0 },
        {
          ...page.rows[0]!,
          id: "r:nan",
          rowNumber: 1,
          values: [page.rows[0]!.values[0]!, { kind: "nan", raw: null, display: "NaN", isNull: false, isNaN: true }]
        }
      ]
    };
    const onApplyCellFilter = vi.fn();
    render(
      <DataGrid
        metadata={metadata}
        page={nanPage}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onApplyCellFilter={onApplyCellFilter}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const nullCell = document.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="1"]');
    if (!nullCell) throw new Error("Expected the null cell.");
    act(() => nullCell.focus());
    fireEvent.keyDown(nullCell, { key: "F10", shiftKey: true });
    let menu = await screen.findByRole("menu", { name: "Filter sales by this cell" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    const excludeNull = within(menu).getByRole("menuitem", { name: "Exclude null values" });
    expect(document.activeElement).toBe(excludeNull);
    fireEvent.click(excludeNull);
    expect(onApplyCellFilter).toHaveBeenLastCalledWith({
      column: "sales",
      type: "float",
      logic: "and",
      predicates: [{ kind: "predicate", operator: "isNotNull" }]
    });

    const nanCell = document.querySelector<HTMLElement>('[data-grid-row="1"][data-grid-column="1"]');
    if (!nanCell) throw new Error("Expected the NaN cell.");
    fireEvent.contextMenu(nanCell);
    menu = await screen.findByRole("menu", { name: "Filter sales by this cell" });
    expect(within(menu).getByRole("menuitem", { name: "Keep only NaN values" })).toBeEnabled();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Filter sales by this cell" })).toBeNull();
    expect(document.activeElement).toBe(nanCell);
  });

  it.each([
    [
      "duplicate column labels",
      {
        metadata: {
          ...metadata,
          schema: [{ ...metadata.schema[0]! }, { ...metadata.schema[1]!, name: "city" }]
        } satisfies SessionMetadata
      },
      "2 columns share the displayed name"
    ],
    ["a projected cell", { projecting: true }, "Wait for this cell to finish loading"],
    ["a backend without filters", { filterControlsDisabled: true }, "Filtering is unavailable for this dataframe"],
    [
      "a nested value",
      {
        metadata: {
          ...metadata,
          schema: [{ ...metadata.schema[0]!, rawType: "List(String)", type: "list" }]
        } satisfies SessionMetadata,
        page: {
          ...page,
          columnIds: ["c:0"],
          rows: page.rows.map((row) => ({
            ...row,
            values: [{ kind: "list" as const, raw: ["x"], display: '["x"]', isNull: false, isNaN: false }]
          }))
        } satisfies GridPage
      },
      "Filtering by individual List(String) values is unavailable"
    ]
  ])("explains why direct filtering is disabled for %s", async (_label, overrides, reason) => {
    const resolvedMetadata = "metadata" in overrides ? overrides.metadata : metadata;
    const resolvedPage = "page" in overrides ? overrides.page : page;
    render(
      <DataGrid
        metadata={resolvedMetadata}
        page={resolvedPage}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        projecting={"projecting" in overrides ? overrides.projecting : false}
        filterControlsDisabled={"filterControlsDisabled" in overrides ? overrides.filterControlsDisabled : false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onApplyCellFilter={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const cell = document.querySelector<HTMLElement>('td[data-grid-column="0"]');
    if (!cell) throw new Error("Expected a grid cell.");
    fireEvent.contextMenu(cell);
    const menu = await screen.findByRole("menu", { name: /Filter .* by this cell/u });
    expect(menu).toHaveTextContent(reason);
    expect(within(menu).getByRole("menuitem", { name: /Keep only/u })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Exclude/u })).toBeDisabled();
  });

  it("selects a profile column from the header without stealing column controls", () => {
    const onViewStateChange = vi.fn();
    const salesSummary: ColumnSummary = {
      columnId: "c:1",
      column: "sales",
      type: "float",
      rawType: "Float64",
      totalCount: 2,
      nullCount: 1,
      nanCount: 0,
      distinctCount: 1,
      topValues: [],
      numeric: { min: 10.5, max: 10.5 }
    };
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[salesSummary]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
        onViewStateChange={onViewStateChange}
      />
    );
    onViewStateChange.mockClear();

    const salesHeader = screen.getByRole("columnheader", { name: /^sales/u });
    fireEvent.click(within(salesHeader).getByText("Missing 1"));
    expect(onViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedColumnId: "c:1" }));

    onViewStateChange.mockClear();
    const cityMenu = screen.getByLabelText("Column actions for city");
    fireEvent.click(cityMenu);
    expect(onViewStateChange).not.toHaveBeenCalled();

    const cityHeader = screen.getByRole("columnheader", { name: /^city/u });
    fireEvent.keyDown(cityHeader, { key: "Enter" });
    expect(onViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedColumnId: "c:0" }));
  });

  it("switches compact header profiles between counts and percentages from the status bar", () => {
    const salesSummary: ColumnSummary = {
      columnId: "c:1",
      column: "sales",
      type: "float",
      rawType: "Float64",
      totalCount: 2,
      nullCount: 1,
      nanCount: 0,
      distinctCount: 1,
      topValues: [],
      numeric: { min: 10.5, max: 10.5 }
    };
    const Harness = () => {
      const [mode, setMode] = useState<"count" | "percent">("count");
      return (
        <DataGrid
          metadata={metadata}
          page={page}
          summaries={[salesSummary]}
          pageSize={2}
          defaultColumnWidth={190}
          insightsOnOpen={true}
          profileValueMode={mode}
          onProfileValueModeChange={setMode}
          onPage={() => undefined}
          onSortColumn={() => undefined}
          onOpenFilter={() => undefined}
          onVisibleSummaryColumnsChange={() => undefined}
        />
      );
    };
    render(<Harness />);

    const statusBar = document.querySelector<HTMLElement>(".gridStatusBar");
    if (!statusBar) throw new Error("Expected the grid status bar.");
    const profileValues = within(statusBar).getByRole("group", { name: "Header profile values" });
    const counts = within(profileValues).getByRole("button", { name: "Show header profile counts" });
    const percentages = within(profileValues).getByRole("button", { name: "Show header profile percentages" });
    const salesHeader = screen.getByRole("columnheader", { name: /^sales/u });

    expect(counts).toHaveAttribute("aria-pressed", "true");
    expect(within(salesHeader).getByText("Missing 1")).toHaveAttribute("title", "Missing: 1 (50%)");
    fireEvent.click(percentages);
    expect(percentages).toHaveAttribute("aria-pressed", "true");
    expect(within(salesHeader).getByText("Missing 50%")).toHaveAttribute("title", "Missing: 1 (50%)");
    fireEvent.click(counts);
    expect(within(salesHeader).getByText("Missing 1")).toBeVisible();
  });

  it("temporarily compacts header distributions when they would hide every body row", async () => {
    const resizeObservers = new Map<object, ResizeObserverCallback>();
    class ControlledResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeObservers.set(this, callback);
      }

      observe(): void {}
      unobserve(): void {}

      disconnect(): void {
        resizeObservers.delete(this);
      }
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    const signalResize = () => {
      act(() => {
        for (const [observer, callback] of [...resizeObservers]) callback([], observer as ResizeObserver);
      });
    };
    const salesSummary: ColumnSummary = {
      columnId: "c:1",
      column: "sales",
      type: "float",
      rawType: "Float64",
      totalCount: 2,
      nullCount: 1,
      nanCount: 0,
      distinctCount: 1,
      topValues: [],
      numeric: { min: 10.5, max: 10.5 },
      visualization: { kind: "numeric", bins: [{ min: 10.5, max: 10.5, count: 1 }] }
    };
    const onVisibleSummaryColumnsChange = vi.fn();
    let unmount: (() => void) | undefined;

    const grid = (currentMetadata: SessionMetadata, summaries: ColumnSummary[]) => (
      <DataGrid
        metadata={currentMetadata}
        page={page}
        summaries={summaries}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onApplyProfileFilter={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={onVisibleSummaryColumnsChange}
      />
    );

    try {
      const rendered = render(grid(metadata, []));
      const { rerender } = rendered;
      unmount = rendered.unmount;
      const scroller = screen.getByTestId("data-grid-scroller");
      const tableHeader = screen.getByRole("grid").querySelector("thead");
      if (!tableHeader) throw new Error("Expected the data-grid header.");
      const fitStatus = document.querySelector<HTMLElement>(".headerProfilesFitStatus");
      expect(fitStatus).toBeInTheDocument();
      expect(fitStatus).toHaveAccessibleName("Header profile layout");
      expect(fitStatus).toBeEmptyDOMElement();
      let scrollerHeight = 124;
      let expandedNaturalHeight = 166;
      Object.defineProperty(scroller, "clientHeight", {
        configurable: true,
        get: () => scrollerHeight
      });
      Object.defineProperty(tableHeader, "offsetHeight", {
        configurable: true,
        get: () => {
          const completeSummary = tableHeader.querySelector(".columnInsight:not(.emptyInsight)");
          return completeSummary
            ? tableHeader.querySelector(".columnInsight.compact")
              ? 68
              : expandedNaturalHeight
            : 68;
        }
      });

      signalResize();
      expect(document.querySelector(".columnInsight.compact")).not.toBeInTheDocument();
      rerender(grid(metadata, [salesSummary]));
      await waitFor(() => expect(document.querySelector(".columnInsight.compact")).toBeInTheDocument());
      const headerProfiles = screen.getByRole("button", { name: "Header profiles" });
      expect(headerProfiles).toHaveAttribute("aria-pressed", "true");
      expect(headerProfiles).toHaveAttribute(
        "title",
        "Header profile distributions are temporarily hidden until the grid has enough room."
      );
      expect(headerProfiles).toHaveAccessibleDescription(
        "Header profile distributions are temporarily hidden until the grid has enough room."
      );
      expect(fitStatus).toHaveAttribute("aria-live", "polite");
      expect(fitStatus).toHaveAttribute("aria-atomic", "true");
      expect(fitStatus).toHaveTextContent(
        "Header profile distributions are temporarily hidden until the grid has enough room."
      );
      expect(screen.getByRole("columnheader", { name: /^sales/u })).toHaveTextContent("Missing 1");
      expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1"]);

      // A one-pixel restoration margin keeps the two layouts from oscillating.
      scrollerHeight = 150;
      signalResize();
      expect(document.querySelector(".columnInsight.compact")).toBeInTheDocument();
      scrollerHeight = 196;
      signalResize();
      await waitFor(() => expect(document.querySelector(".columnInsight.compact")).not.toBeInTheDocument());
      expect(document.querySelector(".columnInsight .summaryDistribution")).toBeInTheDocument();
      expect(fitStatus).toHaveTextContent("Header profile distributions are visible again.");
      signalResize();
      expect(document.querySelector(".columnInsight.compact")).not.toBeInTheDocument();
      expect(headerProfiles).toHaveAttribute("aria-pressed", "true");

      const distributionControl = document.querySelector<HTMLButtonElement>(".numericHistogramHitTarget");
      if (!distributionControl) throw new Error("Expected an interactive header distribution.");
      distributionControl.focus();
      expect(distributionControl).toHaveFocus();
      scrollerHeight = 124;
      signalResize();
      await waitFor(() => expect(document.querySelector(".columnInsight.compact")).toBeInTheDocument());
      expect(headerProfiles).toHaveFocus();

      // A same-session profile-layout change is measured afresh rather than
      // retaining the height of the now-absent distribution.
      scrollerHeight = 150;
      rerender(grid(metadata, []));
      await waitFor(() => expect(document.querySelector(".columnInsight.compact")).not.toBeInTheDocument());
      expect(fitStatus).toBeEmptyDOMElement();

      scrollerHeight = 124;
      rerender(grid(metadata, [salesSummary]));
      await waitFor(() => expect(document.querySelector(".columnInsight.compact")).toBeInTheDocument());
      fireEvent.click(headerProfiles);
      expect(headerProfiles).toHaveAttribute("aria-pressed", "false");
      expect(document.querySelector(".columnInsight")).not.toBeInTheDocument();
      expect(fitStatus).toBeEmptyDOMElement();
      scrollerHeight = 240;
      signalResize();
      expect(document.querySelector(".columnInsight")).not.toBeInTheDocument();
      fireEvent.click(headerProfiles);
      await waitFor(() => expect(document.querySelector(".columnInsight:not(.compact)")).toBeInTheDocument());
      expect(headerProfiles).toHaveAttribute("aria-pressed", "true");

      expandedNaturalHeight = 190;
      scrollerHeight = 196;
      rerender(grid({ ...metadata, sessionId: "replacement-session" }, [salesSummary]));
      await waitFor(() => expect(document.querySelector(".columnInsight.compact")).toBeInTheDocument());
      expect(headerProfiles).toHaveAttribute("aria-pressed", "true");
      unmount();
      unmount = undefined;
      expect(resizeObservers.size).toBe(0);
    } finally {
      unmount?.();
      vi.unstubAllGlobals();
    }
  });

  it("hides the compact profile value switch when header profiles are unavailable", () => {
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        profilesDisabled
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.queryByRole("group", { name: "Header profile values" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Profiles unavailable" })).toBeDisabled();
  });

  it("keeps explicit row labels readable without hiding keyboard-focused columns in a narrow grid", async () => {
    const labeledPage: GridPage = {
      ...page,
      rows: page.rows.map((row, index) => ({
        ...row,
        rowLabel: index === 0 ? "Mazda RX4" : "Hornet Sportabout"
      }))
    };

    render(
      <DataGrid
        metadata={metadata}
        page={labeledPage}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const firstLabel = screen.getByRole("rowheader", { name: "Row 1, label Mazda RX4" });
    expect(firstLabel).toHaveTextContent("Mazda RX4");
    expect(firstLabel).toHaveAttribute("title", "Mazda RX4 (row 1)");
    expect(screen.getByRole("columnheader", { name: "Row label" })).toHaveTextContent("Row");
    expect(screen.getByRole("grid").querySelector("col")).toHaveStyle({ width: "156px" });

    const scroller = screen.getByTestId("data-grid-scroller");
    let physicalScrollLeft = 0;
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 300 },
      scrollLeft: {
        configurable: true,
        get: () => physicalScrollLeft,
        set: (value: number) => {
          physicalScrollLeft = value;
        }
      }
    });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.getByRole("grid").querySelector("col")).toHaveStyle({ width: "156px" }));

    const city = screen.getByRole("cell", { name: "Milan" });
    const sales = screen.getByRole("cell", { name: "10.5" });
    act(() => city.focus());
    fireEvent.keyDown(city, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(sales));
    expect(scroller.scrollLeft).toBe(190);
  });

  it("keeps the row-label gutter compact and stable while paging", () => {
    const labeledPage = (labels: readonly string[]): GridPage => ({
      ...page,
      rows: page.rows.map((row, index) => ({ ...row, rowLabel: labels[index] ?? "" }))
    });
    const props = {
      metadata,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage: () => undefined,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} page={labeledPage(["1", "2"])} />);

    expect(screen.getByRole("columnheader", { name: "Row label" })).toBeVisible();
    expect(screen.getByRole("grid").querySelector("col")).toHaveStyle({ width: "58px" });

    rerender(<DataGrid {...props} page={labeledPage(["Mazda RX4", "Hornet Sportabout"])} />);
    expect(screen.getByRole("grid").querySelector("col")).toHaveStyle({ width: "156px" });

    rerender(<DataGrid {...props} page={labeledPage(["3", "4"])} />);
    expect(screen.getByRole("grid").querySelector("col")).toHaveStyle({ width: "156px" });
  });

  it("hides floating-point noise in grid text while preserving the exact value on hover", () => {
    const noisyValue = 4201.559999999995;
    const onApplyCellFilter = vi.fn();
    const noisyPage: GridPage = {
      ...page,
      limit: 1,
      totalRows: 1,
      rows: [
        {
          id: "r:noisy-float",
          rowNumber: 0,
          values: [
            { kind: "string", raw: "DACH", display: "DACH", isNull: false, isNaN: false },
            {
              kind: "number",
              raw: noisyValue,
              display: String(noisyValue),
              isNull: false,
              isNaN: false
            }
          ]
        }
      ]
    };

    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 1, columns: 2 }, filteredShape: { rows: 1, columns: 2 } }}
        page={noisyPage}
        summaries={[]}
        pageSize={1}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onApplyCellFilter={onApplyCellFilter}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const rendered = screen.getByText("4201.56");
    expect(rendered).toHaveAttribute("title", String(noisyValue));
    expect(screen.queryByText(String(noisyValue))).toBeNull();
    const cell = rendered.closest("td");
    if (!cell) throw new Error("Expected the formatted number cell.");
    fireEvent.click(within(cell).getByRole("button", { name: "Filter sales by this cell" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Keep only this value" }));
    expect(onApplyCellFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        valueFilter: expect.objectContaining({
          selectedValues: [expect.objectContaining({ cell: expect.objectContaining({ raw: noisyValue }) })]
        })
      })
    );
  });

  it("keeps block navigation and the exact live range in a status bar after the scroller", () => {
    const onPage = vi.fn();
    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 100_000, columns: 2 }, filteredShape: { rows: 100_000, columns: 2 } }}
        page={pageAt(0, 100_000)}
        summaries={[]}
        pageSize={200}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={onPage}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const scroller = screen.getByTestId("data-grid-scroller");
    const statusBar = document.querySelector<HTMLElement>(".gridStatusBar");
    if (!statusBar) throw new Error("Expected the grid status bar.");
    expect(scroller.nextElementSibling).toBe(statusBar);
    expect(statusBar).not.toHaveAttribute("role");
    expect(statusBar).not.toHaveAttribute("aria-live");

    const visibleRows = within(statusBar).getByRole("status", { name: "Visible rows" });
    expect(visibleRows).toHaveTextContent("Rows 1\u2013200 of 100,000");
    expect(visibleRows).toHaveAttribute("aria-live", "polite");
    expect(visibleRows).toHaveAttribute("aria-atomic", "true");

    const previous = within(statusBar).getByRole("button", { name: "Previous block" });
    const next = within(statusBar).getByRole("button", { name: "Next block" });
    expect(previous.firstElementChild).toHaveClass("codicon", "codicon-chevron-left");
    expect(next.firstElementChild).toHaveClass("codicon", "codicon-chevron-right");
    expect(previous).toBeDisabled();
    expect(previous).not.toHaveAttribute("aria-disabled");
    expect(next).toBeEnabled();
    expect(next).not.toHaveAttribute("aria-disabled");
    fireEvent.click(next);
    expect(onPage).toHaveBeenCalledWith(200);
  });

  it("keeps progressive PySpark paging honest until the terminal block confirms a total", () => {
    const onPage = vi.fn();
    const progressivePage: LiveGridPage = { ...page, totalRows: null, hasMore: true };
    const sparkMetadata: SessionMetadata = {
      ...metadata,
      backend: "pyspark",
      mode: "viewing",
      source: { kind: "notebookVariable", label: "spark_df", variableName: "spark_df" },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: null, columns: 2 },
      filteredShape: { rows: null, columns: 2 }
    };
    render(
      <DataGrid
        metadata={sparkMetadata}
        page={progressivePage}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={onPage}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "-1");
    expect(screen.getByRole("status", { name: "Visible rows" })).toHaveTextContent(
      "Rows 1\u20132 · total appears after the last page"
    );
    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it("keeps exact PySpark scroll demand contiguous after terminal total promotion", () => {
    expect(requestedGridPageOffset(8_000, 400, 200, true)).toBe(600);
    expect(requestedGridPageOffset(0, 400, 200, true)).toBe(200);
    expect(requestedGridPageOffset(8_000, 400, 200, false)).toBe(8_000);
  });

  it("turns an exact-total PySpark Ctrl+End jump into the next contiguous block", () => {
    const onPage = vi.fn();
    const totalRows = 10_000;
    const currentOffset = 400;
    render(
      <DataGrid
        metadata={{
          ...metadata,
          backend: "pyspark",
          mode: "viewing",
          shape: { rows: totalRows, columns: 2 },
          filteredShape: { rows: totalRows, columns: 2 }
        }}
        page={pageAt(currentOffset, totalRows)}
        viewState={{ columnWidths: {}, viewport: { firstVisibleRow: currentOffset, scrollLeft: 0 } }}
        viewStateRestoreVersion={1}
        summaries={[]}
        pageSize={largeGridPageSize}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={onPage}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const firstCell = document.querySelector<HTMLTableCellElement>(
      `[data-grid-row="${currentOffset}"][data-grid-column="0"]`
    );
    expect(firstCell).not.toBeNull();
    expect(screen.getByRole("status", { name: "Visible rows" })).toHaveTextContent("Rows 401\u2013600 of 10,000");
    expect(screen.getByRole("status", { name: "Visible rows" })).not.toHaveTextContent("Spark");
    fireEvent.keyDown(firstCell!, { key: "End", ctrlKey: true });
    expect(onPage).toHaveBeenCalledWith(currentOffset + largeGridPageSize);
  });

  it("keeps an exact terminal range and both status-bar actions available for very large datasets", () => {
    const totalRows = 100_000_000;
    const offset = totalRows - largeGridPageSize;
    const onPage = vi.fn();
    render(
      <DataGrid
        metadata={{
          ...metadata,
          shape: { rows: totalRows, columns: 2 },
          filteredShape: { rows: totalRows, columns: 2 }
        }}
        page={pageAt(offset, totalRows)}
        summaries={[]}
        pageSize={largeGridPageSize}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        viewState={{ columnWidths: {}, viewport: { firstVisibleRow: offset, scrollLeft: 0 } }}
        onPage={onPage}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const statusBar = document.querySelector<HTMLElement>(".gridStatusBar");
    if (!statusBar) throw new Error("Expected the grid status bar.");
    expect(within(statusBar).getByRole("status", { name: "Visible rows" })).toHaveTextContent(
      "Rows 99,999,801\u2013100,000,000 of 100,000,000"
    );
    const previous = within(statusBar).getByRole("button", { name: "Previous block" });
    const next = within(statusBar).getByRole("button", { name: "Next block" });
    expect(previous).toBeEnabled();
    expect(next).toBeDisabled();
    expect(within(statusBar).getByRole("button", { name: "Header profiles" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(previous);
    expect(onPage).toHaveBeenCalledWith(99_999_600);
    next.click();
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it("keeps the column name on its own row above compact metadata and actions", () => {
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        sortRules={[{ column: "city", direction: "asc", nulls: "last" }]}
        pageSize={2}
        defaultColumnWidth={140}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onClearSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const header = document.querySelector<HTMLElement>('th[data-column="city"]');
    if (!header) throw new Error("Expected the city header.");
    const layout = header.querySelector<HTMLElement>(".columnHeader");
    const title = header.querySelector<HTMLElement>(".columnTitle");
    const metadataRow = header.querySelector<HTMLElement>(".columnMetaRow");
    const actions = header.querySelector<HTMLElement>(".columnHeaderActions");
    const resize = header.querySelector<HTMLElement>(".columnResizeHandle");
    const menu = within(header).getByLabelText("Column actions for city").closest("details");
    if (!(menu instanceof HTMLDetailsElement)) throw new Error("Expected the city details menu.");

    expect(layout?.firstElementChild).toBe(title);
    expect(title).toHaveTextContent("city");
    expect(title).toHaveAttribute("title", "city");
    expect(metadataRow).toContainElement(header.querySelector<HTMLElement>(".columnType"));
    expect(metadataRow).toContainElement(actions);
    expect(actions).toContainElement(menu);
    expect(actions).toContainElement(
      within(header).getByRole("button", { name: /Clear sort for city; currently ascending/u })
    );
    expect(resize).toHaveAccessibleName("Resize city column");
  });

  it("closes header sort menus and exposes the active primary sort as a clearable accessible state", () => {
    const onSortColumn = vi.fn();
    const onClearSortColumn = vi.fn();
    const props = {
      metadata,
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage: () => undefined,
      onSortColumn,
      onClearSortColumn,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} />);
    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    if (!cityHeader) throw new Error("Expected the city header.");
    const city = within(cityHeader);
    const menu = city.getByLabelText("Column actions for city").closest("details");
    if (!(menu instanceof HTMLDetailsElement)) throw new Error("Expected the city details menu.");

    menu.open = true;
    fireEvent.click(city.getByRole("button", { name: "Sort ascending" }));
    expect(menu.open).toBe(false);
    expect(onSortColumn).toHaveBeenLastCalledWith("city", "asc");

    rerender(<DataGrid {...props} sortRules={[{ column: "city", direction: "asc", nulls: "last" }]} />);
    expect(cityHeader).toHaveAttribute("aria-sort", "ascending");
    expect(city.getByRole("button", { name: /Clear sort for city; currently ascending/u })).toBeVisible();

    menu.open = true;
    fireEvent.click(city.getByRole("button", { name: "Sort descending" }));
    expect(menu.open).toBe(false);
    expect(onSortColumn).toHaveBeenLastCalledWith("city", "desc");

    rerender(<DataGrid {...props} sortRules={[{ column: "city", direction: "desc", nulls: "last" }]} />);
    expect(cityHeader).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(city.getByRole("button", { name: /Clear sort for city; currently descending/u }));
    expect(onClearSortColumn).toHaveBeenCalledWith("city");
  });

  it("exposes aria-sort only on the primary header while labeling secondary sort priority", () => {
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        sortRules={[
          { column: "city", direction: "asc", nulls: "last" },
          { column: "sales", direction: "desc", nulls: "first" }
        ]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onClearSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    const salesHeader = document.querySelector<HTMLElement>('th[data-column="sales"]');
    if (!cityHeader || !salesHeader) throw new Error("Expected both sorted column headers.");
    expect(cityHeader).toHaveAttribute("aria-sort", "ascending");
    expect(cityHeader).toHaveAccessibleName("city, sorted ascending, priority 1 of 2");
    expect(salesHeader).not.toHaveAttribute("aria-sort");
    expect(salesHeader).toHaveAccessibleName("sales, sorted descending, priority 2 of 2");
    expect(
      within(salesHeader).getByRole("button", {
        name: "Clear sort for sales; currently descending, priority 2 of 2"
      })
    ).toBeVisible();
  });

  it("renders exact min/max separately from accessible non-color-only summary visuals", async () => {
    const schema: SessionMetadata["schema"] = [
      { id: "c:number", name: "value", position: 0, rawType: "Float64", type: "float", nullable: false },
      { id: "c:boolean", name: "flag", position: 1, rawType: "Boolean", type: "boolean", nullable: false },
      { id: "c:category", name: "group", position: 2, rawType: "String", type: "string", nullable: false },
      { id: "c:datetime", name: "when", position: 3, rawType: "Datetime", type: "datetime", nullable: false }
    ];
    const familyMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 4 },
      filteredShape: { rows: 4, columns: 4 },
      schema
    };
    const familyPage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 4,
      columnIds: schema.map((column) => column.id),
      rows: [
        {
          id: "r:families",
          rowNumber: 0,
          values: [
            { kind: "number", raw: 1, display: "1", isNull: false, isNaN: false },
            { kind: "boolean", raw: true, display: "true", isNull: false, isNaN: false },
            { kind: "string", raw: "alpha", display: "alpha", isNull: false, isNaN: false },
            {
              kind: "datetime",
              raw: "2024-01-01T00:00:00",
              display: "2024-01-01",
              isNull: false,
              isNaN: false
            }
          ]
        }
      ]
    };
    const baseSummary = {
      totalCount: 4,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 2,
      topValues: []
    };
    const summaries: ColumnSummary[] = [
      {
        ...baseSummary,
        columnId: "c:number",
        column: "value",
        type: "float",
        rawType: "Float64",
        numeric: { min: 1, max: 4, mean: 2.5, median: 2.5, std: 1.29 },
        visualization: {
          kind: "numeric",
          bins: [
            { min: 1, max: 2.5, count: 100 },
            { min: 2.5, max: 4, count: 1 }
          ],
          sampled: true
        }
      },
      {
        ...baseSummary,
        columnId: "c:boolean",
        column: "flag",
        type: "boolean",
        rawType: "Boolean",
        visualization: { kind: "boolean", trueCount: 3, falseCount: 1 }
      },
      {
        ...baseSummary,
        columnId: "c:category",
        column: "group",
        type: "string",
        rawType: "String",
        visualization: {
          kind: "categorical",
          categories: [
            { value: "alpha", count: 3 },
            { value: "beta", count: 1 }
          ],
          otherCount: 0
        }
      },
      {
        ...baseSummary,
        columnId: "c:datetime",
        column: "when",
        type: "datetime",
        rawType: "Datetime",
        visualization: { kind: "datetime", min: "2024-01-01", max: "2024-04-01" }
      }
    ];
    render(
      <DataGrid
        metadata={familyMetadata}
        page={familyPage}
        summaries={summaries}
        pageSize={1}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        profileValueMode="count"
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 1_000 });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.getByRole("img", { name: /categorical distribution/u })).toBeVisible());

    const numericHeader = document.querySelector<HTMLElement>('th[data-column="value"]');
    if (!numericHeader) throw new Error("Expected the numeric header.");
    expect(within(numericHeader).getByText("Min 1")).toBeVisible();
    expect(within(numericHeader).getByText("Max 4")).toBeVisible();
    expect(within(numericHeader).getByText("Distribution sampled").closest(".summaryDistribution")).not.toBeNull();
    expect(
      within(numericHeader).getByRole("img", {
        name: "Sampled numeric distribution with 2 bins; range 1 to 4."
      })
    ).toBeVisible();
    const distribution = within(numericHeader).getByRole("img", {
      name: "Sampled numeric distribution with 2 bins; range 1 to 4."
    });
    expect(distribution.querySelectorAll(".numericHistogramBar")).toHaveLength(2);
    expect(numericHeader.querySelector(".numericHistogramHitTarget")).toBeNull();
    expect(numericHeader.querySelectorAll(".numericHistogramBar")[1]).toHaveAttribute("height", "2");
    Object.defineProperty(distribution, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 160, top: 0, bottom: 36, width: 160, height: 36, x: 0, y: 0 })
    });
    fireEvent.pointerMove(distribution, { clientX: 40 });
    expect(within(numericHeader).getByRole("tooltip")).toHaveTextContent("1-2.5: 100 rows");
    fireEvent.pointerMove(distribution, { clientX: 120 });
    expect(within(numericHeader).getByRole("tooltip")).toHaveTextContent("2.5-4: 1 row");
    fireEvent.pointerLeave(distribution);
    expect(within(numericHeader).queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "boolean distribution: True: 3 (75%), False: 1 (25%)." })).toHaveTextContent(
      "True 3False 1"
    );
    const categoricalChart = screen.getByRole("img", {
      name: "categorical distribution: alpha: 3 (75%), beta: 1 (25%)."
    });
    expect(categoricalChart).toHaveTextContent("alpha3beta1");
    expect(within(categoricalChart).getByText("alpha")).toHaveAttribute("title", "alpha");
    expect(
      screen.getByRole("img", {
        name: "datetime distribution: minimum 2024-01-01, maximum 2024-04-01."
      })
    ).toHaveTextContent("Min 2024-01-01Max 2024-04-01");
  });

  it("applies compact categorical and numeric profile filters through the shared filter model", () => {
    const onApplyProfileFilter = vi.fn();
    const onViewStateChange = vi.fn();
    const summaries: ColumnSummary[] = [
      {
        columnId: "c:0",
        column: "city",
        type: "string",
        rawType: "String",
        totalCount: 2,
        nullCount: 0,
        nanCount: 0,
        distinctCount: 2,
        topValues: [],
        visualization: {
          kind: "categorical",
          categories: [
            { value: "Milan", count: 1 },
            { value: "Paris", count: 1 }
          ],
          otherCount: 0
        }
      },
      {
        columnId: "c:1",
        column: "sales",
        type: "float",
        rawType: "Float64",
        totalCount: 2,
        nullCount: 0,
        nanCount: 0,
        distinctCount: 2,
        topValues: [],
        numeric: { min: 0, max: 20 },
        visualization: {
          kind: "numeric",
          bins: [
            { min: 0, max: 10, count: 1 },
            { min: 10, max: 20, count: 1 }
          ]
        }
      }
    ];
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={summaries}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        profileValueMode="count"
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onApplyProfileFilter={onApplyProfileFilter}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
        onViewStateChange={onViewStateChange}
      />
    );
    onViewStateChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Filter city to Milan; Milan: 1 (50%)" }));
    expect(onApplyProfileFilter).toHaveBeenLastCalledWith({
      column: "city",
      type: "string",
      logic: "and",
      valueFilter: {
        kind: "values",
        selectedValues: ["Milan"],
        includeNulls: false,
        includeNaN: false
      },
      predicates: []
    });
    expect(onViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedColumnId: "c:0" }));

    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "0-10: 1 row (50%); lower bound included, upper bound excluded"
      }),
      { key: "Enter" }
    );
    expect(onApplyProfileFilter).toHaveBeenLastCalledWith({
      column: "sales",
      type: "float",
      logic: "and",
      predicates: [
        { kind: "predicate", operator: "gte", value: 0 },
        { kind: "predicate", operator: "lt", value: 10 }
      ]
    });
    expect(onViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedColumnId: "c:1" }));
  });

  it("filters Boolean values from the compact header with native buttons", () => {
    const booleanMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 1 },
      filteredShape: { rows: 4, columns: 1 },
      schema: [{ id: "c:flag", name: "flag", position: 0, rawType: "Boolean", type: "boolean", nullable: false }]
    };
    const booleanPage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 4,
      columnIds: ["c:flag"],
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [{ kind: "boolean", raw: true, display: "true", isNull: false, isNaN: false }]
        }
      ]
    };
    const onApplyProfileFilter = vi.fn();
    const onViewStateChange = vi.fn();
    render(
      <DataGrid
        metadata={booleanMetadata}
        page={booleanPage}
        summaries={[
          {
            columnId: "c:flag",
            column: "flag",
            type: "boolean",
            rawType: "Boolean",
            totalCount: 4,
            nullCount: 0,
            nanCount: 0,
            distinctCount: 2,
            topValues: [],
            visualization: { kind: "boolean", trueCount: 3, falseCount: 1 }
          }
        ]}
        pageSize={1}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        profileValueMode="count"
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onApplyProfileFilter={onApplyProfileFilter}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
        onViewStateChange={onViewStateChange}
      />
    );
    onViewStateChange.mockClear();

    const distribution = screen.getByRole("group", {
      name: "boolean distribution: True: 3 (75%), False: 1 (25%)."
    });
    const trueButton = within(distribution).getByRole("button", {
      name: "Filter flag to True; True: 3 (75%)"
    });
    const falseButton = within(distribution).getByRole("button", {
      name: "Filter flag to False; False: 1 (25%)"
    });
    trueButton.focus();
    expect(trueButton).toHaveFocus();

    fireEvent.click(trueButton);
    expect(onApplyProfileFilter).toHaveBeenLastCalledWith({
      column: "flag",
      type: "boolean",
      logic: "and",
      valueFilter: {
        kind: "values",
        selectedValues: [true],
        includeNulls: false,
        includeNaN: false
      },
      predicates: []
    });
    expect(onViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedColumnId: "c:flag" }));

    fireEvent.click(falseButton);
    expect(onApplyProfileFilter).toHaveBeenLastCalledWith({
      column: "flag",
      type: "boolean",
      logic: "and",
      valueFilter: {
        kind: "values",
        selectedValues: [false],
        includeNulls: false,
        includeNaN: false
      },
      predicates: []
    });
  });

  it("bounds very long cell text before it reaches the DOM", () => {
    const longValue = "x".repeat(10_000);
    const longPage: GridPage = {
      ...page,
      rows: [
        {
          ...page.rows[0]!,
          values: [
            { kind: "string", raw: longValue, display: longValue, isNull: false, isNaN: false },
            page.rows[0]!.values[1]!
          ]
        }
      ],
      totalRows: 1,
      limit: 1
    };
    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 1, columns: 2 }, filteredShape: { rows: 1, columns: 2 } }}
        page={longPage}
        summaries={[]}
        pageSize={1}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const cell = document.querySelector<HTMLElement>('[data-grid-row="0"][data-grid-column="0"]');
    expect(cell?.textContent).toHaveLength(4_097);
    expect(cell?.textContent).toMatch(/…$/u);
    expect(cell).toHaveAttribute("title", cell?.textContent);
    expect(cell?.textContent).not.toContain(longValue);
  });

  it("supports roving keyboard focus across typed cells", async () => {
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const city = screen.getByRole("cell", { name: "Milan" });
    const sales = screen.getByRole("cell", { name: "10.5" });
    expect(city).toHaveAttribute("tabindex", "0");
    act(() => city.focus());
    expect(document.activeElement).toBe(city);
    fireEvent.keyDown(city, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(sales));
    expect(screen.queryByText("Profiling…")).toBeNull();
  });

  it("does not reclaim host focus when scrolling virtualizes a remembered iframe cell", async () => {
    const rows = Array.from({ length: 40 }, (_, rowNumber) => ({
      id: `r:${rowNumber}`,
      rowNumber,
      values: page.rows[0].values
    }));
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 40, columns: 2 }, filteredShape: { rows: 40, columns: 2 } }}
        page={{ offset: 0, limit: 200, totalRows: 40, columnIds: page.columnIds, rows }}
        summaries={[]}
        pageSize={200}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 58 });
    fireEvent(window, new Event("resize"));
    const initialCell = document.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
    expect(initialCell).not.toBeNull();
    act(() => initialCell?.focus());
    expect(document.activeElement).toBe(initialCell);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();

    hasFocus.mockReturnValue(false);
    scroller.scrollTop = 20 * 29;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const rovingCell = document.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
      expect(Number(rovingCell?.dataset.gridRow)).toBeGreaterThan(0);
    });
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
    hasFocus.mockRestore();
  });

  it("restores stable column widths, selection, and both viewport axes", async () => {
    const onViewStateChange = vi.fn();
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        viewState={{
          columnWidths: { "c:1": 280 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 1, scrollLeft: 95 }
        }}
        viewStateRestoreVersion={1}
        onViewStateChange={onViewStateChange}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const scroller = screen.getByTestId("data-grid-scroller");
    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(95);
    expect(document.querySelectorAll("col")[2]).toHaveStyle({ width: "280px" });
    expect(screen.getByRole("columnheader", { name: /sales/u })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("cell", { name: "" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector('[data-grid-row="1"][data-grid-column="1"]')).toHaveAttribute("tabindex", "0");
    expect(onViewStateChange).not.toHaveBeenCalled();
  });

  it("requests a restored row block when the initial page still belongs to the previous viewport", async () => {
    const onPage = vi.fn();
    const initialViewState = {
      columnWidths: {},
      selectedColumnId: "c:1",
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    };
    const restoredViewState = {
      columnWidths: {},
      selectedColumnId: "c:1",
      viewport: { firstVisibleRow: 400, scrollLeft: 95 }
    };
    const props = {
      metadata: {
        ...metadata,
        shape: { rows: 1_000, columns: 2 },
        filteredShape: { rows: 1_000, columns: 2 }
      },
      summaries: [],
      pageSize: 200,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(
      <DataGrid
        {...props}
        page={pageAt(0, 1_000)}
        viewState={initialViewState}
        viewStateRestoreVersion={0}
        busy={false}
      />
    );

    expect(onPage).not.toHaveBeenCalled();
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 58 },
      scrollHeight: { configurable: true, value: 58 },
      scrollTop: {
        configurable: true,
        get: () => 0,
        set: () => undefined
      }
    });

    rerender(
      <DataGrid
        {...props}
        page={pageAt(0, 1_000)}
        viewState={restoredViewState}
        viewStateRestoreVersion={1}
        busy={false}
      />
    );

    await waitFor(() => expect(onPage).toHaveBeenCalledTimes(1));
    expect(onPage).toHaveBeenCalledWith(400);

    rerender(
      <DataGrid
        {...props}
        page={pageAt(400, 1_000)}
        viewState={restoredViewState}
        viewStateRestoreVersion={1}
        busy={false}
      />
    );
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it("preserves a restored logical viewport across device-pixel scroll quantization", async () => {
    const onViewStateChange = vi.fn();
    const onPage = vi.fn();
    const props = {
      metadata,
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onViewStateChange,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    let physicalScrollTop = scroller.scrollTop;
    let physicalScrollLeft = scroller.scrollLeft;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => physicalScrollTop,
      set: (value: number) => {
        physicalScrollTop = value === 29 ? 28.8 : value;
      }
    });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => physicalScrollLeft,
      set: (value: number) => {
        physicalScrollLeft = value === 35 ? 35.2000007629 : value;
      }
    });

    rerender(
      <DataGrid
        {...props}
        viewState={{
          columnWidths: {},
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 1, scrollLeft: 35 }
        }}
        viewStateRestoreVersion={1}
      />
    );
    fireEvent.scroll(scroller);

    expect(scroller.scrollTop).toBe(28.8);
    expect(scroller.scrollLeft).toBe(35.2000007629);
    expect(onViewStateChange).not.toHaveBeenCalled();
    expect(onPage).not.toHaveBeenCalled();
    expect(document.querySelector('[data-grid-row="1"][data-grid-column="1"]')).toHaveAttribute("tabindex", "0");

    fireEvent.wheel(scroller);
    scroller.scrollTop = 28.8;
    scroller.scrollLeft = 80;
    fireEvent.scroll(scroller);

    expect(onViewStateChange).toHaveBeenLastCalledWith({
      columnWidths: {},
      selectedColumnId: "c:1",
      viewport: { firstVisibleRow: 1, scrollLeft: 80 }
    });
    expect(onPage).not.toHaveBeenCalled();
  });

  it("preserves the confirmed viewport while a native modal owns workbench focus", () => {
    const onViewStateChange = vi.fn();
    const onPage = vi.fn();
    const props = {
      metadata,
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      viewState: {
        columnWidths: {},
        selectedColumnId: "c:1",
        viewport: { firstVisibleRow: 1, scrollLeft: 23 }
      },
      viewStateRestoreVersion: 1,
      onViewStateChange,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(23);
    onViewStateChange.mockClear();

    fireEvent(window, new Event("blur"));
    rerender(<DataGrid {...props} busy />);
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
    fireEvent.scroll(scroller);

    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(23);
    expect(onViewStateChange).not.toHaveBeenCalled();
    expect(onPage).not.toHaveBeenCalled();

    rerender(<DataGrid {...props} busy={false} />);
    fireEvent(window, new Event("focus"));

    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(23);
    expect(onViewStateChange).not.toHaveBeenCalled();
    expect(onPage).not.toHaveBeenCalled();
  });

  it("does not replace authoritative restored state from synchronous programmatic scroll events", () => {
    const onViewStateChange = vi.fn();
    const props = {
      metadata,
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onViewStateChange,
      onPage: vi.fn(),
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => {
        scroller.dispatchEvent(new Event("scroll"));
      }
    });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set: () => {
        scroller.dispatchEvent(new Event("scroll"));
      }
    });
    onViewStateChange.mockClear();

    rerender(
      <DataGrid
        {...props}
        viewState={{
          columnWidths: { "c:1": 280 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 1, scrollLeft: 35 }
        }}
        viewStateRestoreVersion={1}
      />
    );

    expect(onViewStateChange).not.toHaveBeenCalled();
    expect(document.querySelector('[data-grid-row="1"][data-grid-column="1"]')).toHaveAttribute("tabindex", "0");
    expect(props.onPage).not.toHaveBeenCalled();
  });

  it("does not publish a stale page offset when a logical view and authoritative restore commit together", () => {
    const onViewStateChange = vi.fn();
    const props = {
      metadata,
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onViewStateChange,
      onPage: vi.fn(),
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} viewContextId="initial-view" />);
    const scroller = screen.getByTestId("data-grid-scroller");
    onViewStateChange.mockClear();

    rerender(
      <DataGrid
        {...props}
        viewContextId="restored-view"
        viewState={{
          columnWidths: { "c:1": 280 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 1, scrollLeft: 23 }
        }}
        viewStateRestoreVersion={1}
      />
    );

    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(23);
    expect(document.querySelector('[data-grid-row="1"][data-grid-column="1"]')).toHaveAttribute("tabindex", "0");
    expect(onViewStateChange).not.toHaveBeenCalled();
    expect(props.onPage).not.toHaveBeenCalled();
  });

  it("reapplies an authoritative viewport after an asynchronous layout scroll collapse", () => {
    const onViewStateChange = vi.fn();
    const onPage = vi.fn();
    const props = {
      metadata,
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onViewStateChange,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    let physicalScrollTop = 0;
    let physicalScrollLeft = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 58 },
      clientWidth: { configurable: true, value: 320 },
      scrollHeight: { configurable: true, value: 232 },
      scrollWidth: { configurable: true, value: 900 },
      scrollTop: {
        configurable: true,
        get: () => physicalScrollTop,
        set: (value: number) => {
          physicalScrollTop = value;
        }
      },
      scrollLeft: {
        configurable: true,
        get: () => physicalScrollLeft,
        set: (value: number) => {
          physicalScrollLeft = value;
        }
      }
    });

    rerender(
      <DataGrid
        {...props}
        viewState={{
          columnWidths: { "c:1": 280 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 1, scrollLeft: 23 }
        }}
        viewStateRestoreVersion={1}
      />
    );
    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(23);
    onViewStateChange.mockClear();

    physicalScrollTop = 0;
    physicalScrollLeft = 0;
    fireEvent.scroll(scroller);

    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(23);
    expect(onViewStateChange).not.toHaveBeenCalled();
    expect(onPage).not.toHaveBeenCalled();

    physicalScrollTop = 0;
    physicalScrollLeft = 0;
    fireEvent.scroll(scroller);

    expect(scroller.scrollTop).toBe(0);
    expect(scroller.scrollLeft).toBe(0);
    expect(onViewStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { firstVisibleRow: 0, scrollLeft: 0 } })
    );
    expect(onPage).not.toHaveBeenCalled();
  });

  it("ignores a teardown scroll collapse but still accepts an explicit user scroll", () => {
    const onViewStateChange = vi.fn();
    const props = {
      metadata,
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onViewStateChange,
      onPage: vi.fn(),
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    let physicalScrollTop = 0;
    let physicalScrollLeft = 0;
    let physicalScrollHeight = 232;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 58 },
      clientWidth: { configurable: true, value: 320 },
      scrollHeight: { configurable: true, get: () => physicalScrollHeight },
      scrollWidth: { configurable: true, value: 900 },
      scrollTop: {
        configurable: true,
        get: () => physicalScrollTop,
        set: (value: number) => {
          physicalScrollTop = value;
        }
      },
      scrollLeft: {
        configurable: true,
        get: () => physicalScrollLeft,
        set: (value: number) => {
          physicalScrollLeft = value;
        }
      }
    });

    rerender(
      <DataGrid
        {...props}
        viewState={{
          columnWidths: { "c:1": 280 },
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 1, scrollLeft: 23 }
        }}
        viewStateRestoreVersion={1}
      />
    );
    expect(scroller.scrollTop).toBe(29);
    expect(scroller.scrollLeft).toBe(23);
    onViewStateChange.mockClear();

    physicalScrollHeight = 58;
    physicalScrollTop = 0;
    fireEvent.scroll(scroller);

    expect(onViewStateChange).not.toHaveBeenCalled();
    expect(document.querySelector('[data-grid-row="1"][data-grid-column="1"]')).toHaveAttribute("tabindex", "0");

    physicalScrollHeight = 232;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);

    expect(onViewStateChange).toHaveBeenLastCalledWith({
      columnWidths: { "c:1": 280 },
      selectedColumnId: "c:1",
      viewport: { firstVisibleRow: 0, scrollLeft: 23 }
    });
  });

  it("reaches the first, middle, and final rows beyond Chromium's layout ceiling", async () => {
    const largeMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: largeGridRowCount, columns: 2 },
      filteredShape: { rows: largeGridRowCount, columns: 2 }
    };
    const props = {
      metadata: largeMetadata,
      summaries: [],
      pageSize: largeGridPageSize,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage: vi.fn(),
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} page={pageAt(0)} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 580 });
    let physicalScrollTop = scroller.scrollTop;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => physicalScrollTop,
      set: (value: number) => {
        physicalScrollTop = Math.min(value, chromiumMaximumLayoutHeight);
      }
    });
    fireEvent(window, new Event("resize"));

    expect(document.querySelector('[data-grid-row="0"]')).not.toBeNull();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", String(largeGridRowCount + 1));

    const middleRow = 1_506_053;
    const middleOffset = Math.floor(middleRow / largeGridPageSize) * largeGridPageSize;
    scroller.scrollTop =
      (middleRow / (largeGridRowCount - 1)) * (maximumGridScrollCanvasHeight - scroller.clientHeight);
    fireEvent.scroll(scroller);
    await waitFor(() => expect(props.onPage).toHaveBeenLastCalledWith(middleOffset));
    rerender(<DataGrid {...props} page={pageAt(middleOffset)} />);

    await waitFor(() => expect(document.querySelector(`[data-grid-row="${middleRow}"]`)).not.toBeNull());
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBeLessThan(maximumGridScrollCanvasHeight);
    expect(document.querySelector(`[data-grid-row="${middleRow}"]`)?.closest("tr")).toHaveAttribute(
      "aria-rowindex",
      String(middleRow + 2)
    );

    const finalRow = largeGridRowCount - 1;
    const finalOffset = Math.floor(finalRow / largeGridPageSize) * largeGridPageSize;
    scroller.scrollTop = maximumGridScrollCanvasHeight - scroller.clientHeight;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(props.onPage).toHaveBeenLastCalledWith(finalOffset));
    rerender(<DataGrid {...props} page={pageAt(finalOffset)} />);

    await waitFor(() => expect(document.querySelector(`[data-grid-row="${finalRow}"]`)).not.toBeNull());
    expect(scroller.scrollTop).toBeLessThan(maximumGridScrollCanvasHeight);
    expect(scroller.scrollTop).toBeLessThan(chromiumMaximumLayoutHeight);
    expect(document.querySelector(`[data-grid-row="${finalRow}"]`)?.closest("tr")).toHaveAttribute(
      "aria-rowindex",
      String(largeGridRowCount + 1)
    );

    const restoredRow = middleRow + 37;
    const restoredOffset = Math.floor(restoredRow / largeGridPageSize) * largeGridPageSize;
    const pageRequestsBeforeRestore = props.onPage.mock.calls.length;
    rerender(
      <DataGrid
        {...props}
        page={pageAt(restoredOffset)}
        viewState={{ columnWidths: {}, viewport: { firstVisibleRow: restoredRow, scrollLeft: 0 } }}
        viewStateRestoreVersion={1}
      />
    );
    fireEvent.scroll(scroller);
    await waitFor(() => expect(document.querySelector(`[data-grid-row="${restoredRow}"]`)).not.toBeNull());
    expect(props.onPage).toHaveBeenCalledTimes(pageRequestsBeforeRestore);
    expect(scroller.scrollTop).toBeLessThan(maximumGridScrollCanvasHeight);
    expect(document.querySelector(`[data-grid-row="${restoredRow}"]`)?.closest("tr")).toHaveAttribute(
      "aria-rowindex",
      String(restoredRow + 2)
    );
  });

  it("keeps a terminal partial block visible when native scrolling starts before its offset", async () => {
    const totalRows = 1_205;
    const finalOffset = 1_200;
    const viewportHeight = 20 * 29;
    const onPage = vi.fn();
    const props = {
      metadata: {
        ...metadata,
        shape: { rows: totalRows, columns: 2 },
        filteredShape: { rows: totalRows, columns: 2 }
      },
      summaries: [],
      pageSize: largeGridPageSize,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(
      <DataGrid
        {...props}
        page={pageAt(1_000, totalRows)}
        viewState={{ columnWidths: {}, viewport: { firstVisibleRow: 1_000, scrollLeft: 0 } }}
        viewStateRestoreVersion={1}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: viewportHeight });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: totalRows * 29 });
    let physicalScrollTop = scroller.scrollTop;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => physicalScrollTop,
      set: (value: number) => {
        physicalScrollTop = Math.min(value, totalRows * 29 - viewportHeight);
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    expect(onPage).toHaveBeenCalledOnce();
    expect(onPage).toHaveBeenLastCalledWith(finalOffset);
    rerender(
      <DataGrid
        {...props}
        page={pageAt(finalOffset, totalRows)}
        viewState={{ columnWidths: {}, viewport: { firstVisibleRow: finalOffset, scrollLeft: 0 } }}
        viewStateRestoreVersion={1}
      />
    );

    fireEvent.scroll(scroller);

    await waitFor(() => expect(document.querySelector('[data-grid-row="1204"]')).not.toBeNull());
    expect(onPage).toHaveBeenCalledOnce();
    const topSpacer = document.querySelector<HTMLTableCellElement>("tbody > .virtualRowSpacer:first-child > td");
    expect(topSpacer).toHaveStyle({ height: `${finalOffset * 29}px` });
  });

  it("prefers lossless typed extrema in compact headers without hiding the full value from assistive text", async () => {
    const minimum = "-900719925474099312345678901";
    const maximum = "900719925474099312345678902";
    const schema: SessionMetadata["schema"] = [
      { id: "c:wide", name: "wide_value", position: 0, rawType: "Int128", type: "integer", nullable: false }
    ];
    render(
      <DataGrid
        metadata={{
          ...metadata,
          shape: { rows: 2, columns: 1 },
          filteredShape: { rows: 2, columns: 1 },
          schema
        }}
        page={{
          offset: 0,
          limit: 1,
          totalRows: 2,
          columnIds: ["c:wide"],
          rows: [
            {
              id: "r:wide",
              rowNumber: 0,
              values: [{ kind: "integer", raw: minimum, display: minimum, isNull: false, isNaN: false }]
            }
          ]
        }}
        summaries={[
          {
            columnId: "c:wide",
            column: "wide_value",
            type: "integer",
            rawType: "Int128",
            totalCount: 2,
            nullCount: 0,
            nanCount: 0,
            distinctCount: 2,
            numeric: {
              min: Number(minimum),
              max: Number(maximum),
              exactMin: { kind: "integer", raw: minimum, display: minimum, isNull: false, isNaN: false },
              exactMax: { kind: "integer", raw: maximum, display: maximum, isNull: false, isNaN: false }
            },
            visualization: {
              kind: "numeric",
              bins: [{ min: Number(minimum), max: Number(maximum), count: 2 }]
            },
            topValues: []
          }
        ]}
        pageSize={1}
        defaultColumnWidth={140}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 400 });
    fireEvent(window, new Event("resize"));

    const header = document.querySelector<HTMLElement>('th[data-column="wide_value"]');
    if (!header) throw new Error("Expected the wide integer header.");
    const minimumStat = within(header).getByTitle(`Minimum ${minimum}`);
    const maximumStat = within(header).getByTitle(`Maximum ${maximum}`);
    expect(minimumStat).toHaveAccessibleName(`Minimum ${minimum}`);
    expect(maximumStat).toHaveAccessibleName(`Maximum ${maximum}`);
    expect(minimumStat).toHaveTextContent(`Min ${minimum}`);
    expect(maximumStat).toHaveTextContent(`Max ${maximum}`);
    expect(minimumStat).toHaveClass("exactNumericExtremum");
  });

  it("keeps huge-grid Next and Previous block requests stable across correlated scroll events", async () => {
    const initialOffset = 1_506_000;
    const nextOffset = initialOffset + largeGridPageSize;
    const onPage = vi.fn();
    const onViewStateChange = vi.fn();
    const props = {
      metadata: {
        ...metadata,
        shape: { rows: largeGridRowCount, columns: 2 },
        filteredShape: { rows: largeGridRowCount, columns: 2 }
      },
      summaries: [],
      pageSize: largeGridPageSize,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage,
      onViewStateChange,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(
      <DataGrid
        {...props}
        page={pageAt(initialOffset)}
        viewState={{ columnWidths: {}, viewport: { firstVisibleRow: initialOffset, scrollLeft: 0 } }}
        viewStateRestoreVersion={1}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 580 });
    let physicalScrollTop = scroller.scrollTop;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => physicalScrollTop,
      set: (value: number) => {
        physicalScrollTop = Math.min(value, chromiumMaximumLayoutHeight);
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Next block" }));
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenLastCalledWith(nextOffset);
    fireEvent.scroll(scroller);
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onViewStateChange).toHaveBeenLastCalledWith({
      columnWidths: {},
      viewport: { firstVisibleRow: nextOffset, scrollLeft: 0 }
    });

    rerender(
      <DataGrid
        {...props}
        page={pageAt(nextOffset)}
        viewState={{ columnWidths: {}, viewport: { firstVisibleRow: nextOffset, scrollLeft: 0 } }}
        viewStateRestoreVersion={1}
      />
    );
    fireEvent.scroll(scroller);
    expect(onPage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Previous block" }));
    expect(onPage).toHaveBeenCalledTimes(2);
    expect(onPage).toHaveBeenLastCalledWith(initialOffset);
    fireEvent.scroll(scroller);
    expect(onPage).toHaveBeenCalledTimes(2);
    expect(onViewStateChange).toHaveBeenLastCalledWith({
      columnWidths: {},
      viewport: { firstVisibleRow: initialOffset, scrollLeft: 0 }
    });
  });

  it("uses Ctrl+End to reach and focus the final accessible row of a huge grid", async () => {
    const onPage = vi.fn();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const largeMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: largeGridRowCount, columns: 2 },
      filteredShape: { rows: largeGridRowCount, columns: 2 }
    };
    const props = {
      metadata: largeMetadata,
      summaries: [],
      pageSize: largeGridPageSize,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} page={pageAt(0)} />);
    const firstCell = document.querySelector<HTMLTableCellElement>('[data-grid-row="0"][data-grid-column="0"]');
    expect(firstCell).not.toBeNull();
    act(() => firstCell?.focus());
    fireEvent.keyDown(firstCell!, { key: "End", ctrlKey: true });

    const finalRow = largeGridRowCount - 1;
    const finalOffset = Math.floor(finalRow / largeGridPageSize) * largeGridPageSize;
    expect(onPage).toHaveBeenCalledWith(finalOffset);
    rerender(<DataGrid {...props} page={pageAt(finalOffset)} />);

    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute("data-grid-row", String(finalRow));
      expect(document.activeElement).toHaveAttribute("data-grid-column", "1");
    });
    expect(document.activeElement?.closest("tr")).toHaveAttribute("aria-rowindex", String(largeGridRowCount + 1));
    hasFocus.mockRestore();
  });

  it("keeps one scroll listener across busy rerenders and reconciles with the latest page callback", async () => {
    const addEventListener = vi.spyOn(HTMLDivElement.prototype, "addEventListener");
    const removeEventListener = vi.spyOn(HTMLDivElement.prototype, "removeEventListener");
    const firstOnPage = vi.fn();
    const latestOnPage = vi.fn();
    const scrollMetadata = {
      ...metadata,
      shape: { rows: 6, columns: 2 },
      filteredShape: { rows: 6, columns: 2 }
    };
    const scrollPage = { ...page, totalRows: 6 };
    const props = {
      metadata: scrollMetadata,
      page: scrollPage,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} busy={false} onPage={firstOnPage} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    const scrollListenerCalls = () =>
      addEventListener.mock.calls.filter(
        ([type], index) =>
          type === "scroll" && (addEventListener.mock.instances[index] as HTMLDivElement | undefined) === scroller
      ).length;
    const removedScrollListenerCalls = () =>
      removeEventListener.mock.calls.filter(
        ([type], index) =>
          type === "scroll" && (removeEventListener.mock.instances[index] as HTMLDivElement | undefined) === scroller
      ).length;
    const installed = scrollListenerCalls();

    rerender(<DataGrid {...props} summaries={[]} busy onPage={() => undefined} />);
    scroller.scrollTop = 4 * 29;
    fireEvent.scroll(scroller);
    expect(firstOnPage).not.toHaveBeenCalled();

    rerender(<DataGrid {...props} summaries={[]} busy={false} onPage={latestOnPage} />);
    await waitFor(() => expect(latestOnPage).toHaveBeenCalledTimes(1));
    expect(latestOnPage).toHaveBeenCalledWith(4);
    expect(firstOnPage).not.toHaveBeenCalled();
    expect(scrollListenerCalls()).toBe(installed);
    expect(removedScrollListenerCalls()).toBe(0);
  });

  it("does not republish unchanged scroll geometry", () => {
    const onViewStateChange = vi.fn();
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onViewStateChange={onViewStateChange}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    onViewStateChange.mockClear();
    scroller.scrollTop = 29;
    scroller.scrollLeft = 7;
    fireEvent.scroll(scroller);
    expect(onViewStateChange).toHaveBeenCalledTimes(1);

    fireEvent.scroll(scroller);
    expect(onViewStateChange).toHaveBeenCalledTimes(1);
  });

  it("carries the scroll-requested row into the next block's roving focus", async () => {
    const onPage = vi.fn();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const scrollMetadata = {
      ...metadata,
      shape: { rows: 6, columns: 2 },
      filteredShape: { rows: 6, columns: 2 }
    };
    const scrollPage = { ...page, totalRows: 6 };
    const props = {
      metadata: scrollMetadata,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} page={scrollPage} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 58 });
    const initialCell = document.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
    expect(initialCell).not.toBeNull();
    act(() => initialCell?.focus());
    scroller.scrollTop = 4 * 29;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(onPage).toHaveBeenCalledWith(4));

    rerender(
      <DataGrid
        {...props}
        page={{
          ...scrollPage,
          offset: 4,
          rows: scrollPage.rows.map((row, index) => ({ ...row, id: `r:${index + 4}`, rowNumber: index + 4 }))
        }}
      />
    );
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-grid-row", "4"));
    hasFocus.mockRestore();
  });

  it("does not restore a requested block after the host takes focus while the page is loading", async () => {
    const onPage = vi.fn();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const scrollMetadata = {
      ...metadata,
      shape: { rows: 6, columns: 2 },
      filteredShape: { rows: 6, columns: 2 }
    };
    const scrollPage = { ...page, totalRows: 6 };
    const props = {
      metadata: scrollMetadata,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} page={scrollPage} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 58 });
    const initialCell = document.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
    expect(initialCell).not.toBeNull();
    act(() => initialCell?.focus());
    scroller.scrollTop = 4 * 29;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(onPage).toHaveBeenCalledWith(4));

    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();
    hasFocus.mockReturnValue(false);
    rerender(
      <DataGrid
        {...props}
        page={{
          ...scrollPage,
          offset: 4,
          rows: scrollPage.rows.map((row, index) => ({ ...row, id: `r:${index + 4}`, rowNumber: index + 4 }))
        }}
      />
    );

    await waitFor(() =>
      expect(document.querySelector('[data-grid-row="4"][data-grid-column="0"]')).toHaveAttribute("tabindex", "0")
    );
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
    hasFocus.mockRestore();
  });

  it("reports ownership changes when horizontal virtualization replaces visible columns", async () => {
    const columns = Array.from({ length: 8 }, (_, position) => ({
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
      limit: 1,
      totalRows: 1,
      columnIds: columns.map((column) => column.id),
      rows: [
        {
          id: "r:wide",
          rowNumber: 0,
          values: columns.map((column) => ({
            kind: "string" as const,
            raw: column.name,
            display: column.name,
            isNull: false,
            isNaN: false
          }))
        }
      ]
    };
    const onVisibleSummaryColumnsChange = vi.fn();
    const onVisibleColumnRangeChange = vi.fn();
    render(
      <DataGrid
        metadata={wideMetadata}
        page={widePage}
        summaries={[]}
        pageSize={1}
        defaultColumnWidth={100}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleColumnRangeChange={onVisibleColumnRangeChange}
        onVisibleSummaryColumnsChange={onVisibleSummaryColumnsChange}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1", "c:2", "c:3"]));

    scroller.scrollLeft = 700;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:4", "c:5", "c:6", "c:7"]));
    expect(onVisibleColumnRangeChange).toHaveBeenLastCalledWith({ start: 4, end: 8 });
    expect(document.querySelector('th[data-column="column-4"]')).toHaveAttribute("aria-colindex", "6");
    expect(document.querySelector('th[data-column="column-7"]')).toHaveAttribute("aria-colindex", "9");
    await waitFor(() => {
      const rovingCells = document.querySelectorAll<HTMLTableCellElement>('td[tabindex="0"]');
      expect(rovingCells).toHaveLength(1);
      expect(rovingCells[0]).toHaveAttribute("data-grid-column", "4");
    });
  });

  it("keeps one roving tab stop when mouse scrolling virtualizes the focused row", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const rows = Array.from({ length: 40 }, (_, rowNumber) => ({
      id: `r:${rowNumber}`,
      rowNumber,
      values: page.rows[0].values
    }));
    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 40, columns: 2 }, filteredShape: { rows: 40, columns: 2 } }}
        page={{ offset: 0, limit: 200, totalRows: 40, columnIds: page.columnIds, rows }}
        summaries={[]}
        pageSize={200}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 58 });
    fireEvent(window, new Event("resize"));
    const initialRovingCell = document.querySelector<HTMLTableCellElement>('td[tabindex="0"]');
    expect(initialRovingCell).not.toBeNull();
    act(() => initialRovingCell?.focus());
    expect(document.activeElement).toBe(initialRovingCell);
    scroller.scrollTop = 20 * 29;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const rovingCells = document.querySelectorAll<HTMLTableCellElement>('td[tabindex="0"]');
      expect(rovingCells).toHaveLength(1);
      expect(Number(rovingCells[0].dataset.gridRow)).toBeGreaterThan(0);
      expect(document.activeElement).toBe(rovingCells[0]);
    });
    hasFocus.mockRestore();
  });

  it("keeps explicit paging focus ahead of queued scroll-focus preservation", async () => {
    const rows = Array.from({ length: 80 }, (_, rowNumber) => ({
      id: `r:${rowNumber}`,
      rowNumber,
      values: page.rows[0].values
    }));
    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 80, columns: 2 }, filteredShape: { rows: 80, columns: 2 } }}
        page={{ offset: 0, limit: 200, totalRows: 80, columnIds: page.columnIds, rows }}
        summaries={[]}
        pageSize={200}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 616 });
    fireEvent(window, new Event("resize"));
    const firstCell = document.querySelector<HTMLTableCellElement>('[data-grid-row="0"][data-grid-column="0"]');
    expect(firstCell).not.toBeNull();
    act(() => firstCell?.focus());
    fireEvent.keyDown(firstCell!, { key: "PageDown" });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-grid-row", "21"));

    const pageDownCell = document.activeElement as HTMLTableCellElement;
    act(() => {
      fireEvent.scroll(scroller);
      fireEvent.keyDown(pageDownCell, { key: "PageUp" });
    });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute("data-grid-row", "0");
      expect(document.activeElement).toHaveAttribute("data-grid-column", "0");
    });
  });

  it("resets the row position while retaining the horizontal column context for a new logical view", async () => {
    const laterPage: GridPage = {
      ...page,
      offset: 4,
      totalRows: 6,
      rows: page.rows.map((row, index) => ({ ...row, id: `r:${index + 4}`, rowNumber: index + 4 }))
    };
    const props = {
      metadata: { ...metadata, shape: { rows: 6, columns: 2 }, filteredShape: { rows: 6, columns: 2 } },
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      onPage: () => undefined,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const { rerender } = render(<DataGrid {...props} page={laterPage} viewContextId="view-a" />);
    const scroller = screen.getByTestId("data-grid-scroller");
    scroller.scrollTop = 4 * 29;
    scroller.scrollLeft = 200;
    fireEvent.scroll(scroller);

    rerender(<DataGrid {...props} page={page} viewContextId="view-b" />);

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(0);
      expect(scroller.scrollLeft).toBe(200);
      const rovingCells = document.querySelectorAll<HTMLTableCellElement>('td[tabindex="0"]');
      expect(rovingCells).toHaveLength(1);
      expect(rovingCells[0]).toHaveAttribute("data-grid-row", "0");
      expect(rovingCells[0]).toHaveAttribute("data-grid-column", "0");
    });
  });

  it("reports complete visible summary ownership through the Header profiles toggle", async () => {
    const onVisibleSummaryColumnsChange = vi.fn();
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={onVisibleSummaryColumnsChange}
      />
    );

    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith([]));
    onVisibleSummaryColumnsChange.mockClear();
    const headerProfiles = screen.getByRole("button", { name: "Header profiles" });
    expect(headerProfiles).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(headerProfiles);
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1"]));
    expect(headerProfiles).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(headerProfiles);
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith([]));
    expect(headerProfiles).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(headerProfiles);
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1"]));
    expect(headerProfiles).toHaveAttribute("aria-pressed", "true");
    expect(onVisibleSummaryColumnsChange).toHaveBeenCalledTimes(3);
  });

  it("keeps expensive PySpark header profiles explicit even when insights-on-open is configured", async () => {
    const onVisibleSummaryColumnsChange = vi.fn();
    render(
      <DataGrid
        metadata={{ ...metadata, backend: "pyspark" }}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={onVisibleSummaryColumnsChange}
      />
    );

    const headerProfiles = screen.getByRole("button", { name: "Header profiles" });
    expect(headerProfiles).toHaveAttribute("aria-pressed", "false");
    expect(headerProfiles).toHaveAttribute("title", "Runs Spark profiling queries for the visible columns.");
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith([]));

    fireEvent.click(headerProfiles);
    expect(headerProfiles).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1"]));
  });

  it("keeps R header profiles explicit even when insights-on-open is configured", async () => {
    const onVisibleSummaryColumnsChange = vi.fn();
    render(
      <DataGrid
        metadata={{ ...metadata, backend: "r", mode: "viewing", rDataframeFlavor: "r.data.frame" }}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={onVisibleSummaryColumnsChange}
      />
    );

    const headerProfiles = screen.getByRole("button", { name: "Header profiles" });
    expect(headerProfiles).toBeEnabled();
    expect(headerProfiles).toHaveAttribute("aria-pressed", "false");
    expect(headerProfiles).toHaveAttribute("title", "Runs R profiling queries for the visible columns.");
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith([]));

    fireEvent.click(headerProfiles);
    expect(headerProfiles).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1"]));
  });

  it("maps a projected page by stable column ID while preserving full-schema grid coordinates", async () => {
    const projectedPage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: ["c:1"],
      rows: [
        {
          id: "r:projected",
          rowNumber: 0,
          values: [{ kind: "number", raw: 42, display: "42", isNull: false, isNaN: false }]
        }
      ]
    };

    render(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 1, columns: 2 }, filteredShape: { rows: 1, columns: 2 } }}
        page={projectedPage}
        summaries={[]}
        pageSize={1}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        projecting={true}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "3");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector('[data-grid-row="0"][data-grid-column="0"]')).toHaveAccessibleName(
      "Loading city, row 1"
    );
    const projectedCell = screen.getByRole("cell", { name: "42" });
    expect(projectedCell).toHaveAttribute("aria-colindex", "3");

    const loadingCell = screen.getByRole("cell", { name: "Loading city, row 1" });
    act(() => loadingCell.focus());
    fireEvent.keyDown(loadingCell, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(projectedCell));
  });

  it("reprofiles visible columns when the filter scope changes without a revision change", async () => {
    const onVisibleSummaryColumnsChange = vi.fn();
    const props = {
      page,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: true,
      onPage: () => undefined,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange
    };
    const { rerender } = render(<DataGrid {...props} metadata={metadata} />);
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenCalledTimes(1));

    rerender(
      <DataGrid
        {...props}
        metadata={{
          ...metadata,
          filterModel: { filters: [], sort: [{ column: "sales", direction: "asc", nulls: "last" }] }
        }}
      />
    );

    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenCalledTimes(2));
    expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1"]);
  });

  it("resizes columns from the keyboard and clearly labels empty rows and datasets", () => {
    let currentViewState = { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } };
    const onViewStateChange = vi.fn((next) => {
      currentViewState = next;
      rerender(
        <DataGrid
          metadata={metadata}
          page={page}
          summaries={[]}
          pageSize={2}
          defaultColumnWidth={190}
          insightsOnOpen={false}
          viewState={currentViewState}
          onViewStateChange={onViewStateChange}
          onPage={() => undefined}
          onSortColumn={() => undefined}
          onOpenFilter={() => undefined}
          onVisibleSummaryColumnsChange={() => undefined}
        />
      );
    });
    const { rerender } = render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        viewState={currentViewState}
        onViewStateChange={onViewStateChange}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    const resize = screen.getByRole("button", { name: "Resize city column" });
    fireEvent.keyDown(resize, { key: "ArrowRight" });
    expect(document.querySelectorAll("col")[1]).toHaveStyle({ width: "200px" });

    rerender(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 0, columns: 2 }, filteredShape: { rows: 0, columns: 2 } }}
        page={{ offset: 0, limit: 2, totalRows: 0, columnIds: page.columnIds, rows: [] }}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        viewState={currentViewState}
        onViewStateChange={onViewStateChange}
        onPage={vi.fn()}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.getByRole("status", { name: "Visible rows" })).toHaveTextContent("No rows");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");

    rerender(
      <DataGrid
        metadata={{ ...metadata, shape: { rows: 0, columns: 0 }, filteredShape: { rows: 0, columns: 0 }, schema: [] }}
        page={{ offset: 0, limit: 2, totalRows: 0, columnIds: [], rows: [] }}
        summaries={[]}
        pageSize={2}
        defaultColumnWidth={190}
        insightsOnOpen={false}
        viewState={currentViewState}
        onViewStateChange={onViewStateChange}
        onPage={vi.fn()}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
      />
    );

    expect(screen.getByText("Empty dataset")).toBeInTheDocument();
    expect(screen.getByText("This source contains 0 rows × 0 columns.")).toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "1");
  });
});

describe("App toolbar", () => {
  beforeAll(async () => {
    document.body.dataset.canChangeImportOptions = "true";
    ({ App } = await import("../webviews/App"));
  });

  it("keeps the visible dataframe shape compact while exposing its full meaning", async () => {
    const schema = Array.from({ length: 417 }, (_, position) => ({
      id: `c:${position}`,
      name: `column_${position}`,
      position,
      rawType: "String",
      type: "string" as const,
      nullable: false
    }));
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        shape: { rows: 10_000, columns: schema.length },
        filteredShape: { rows: 10_000, columns: schema.length },
        schema
      },
      page: {
        ...page,
        totalRows: 10_000
      },
      summaries: []
    });

    const shape = await screen.findByLabelText("10,000 rows by 417 columns");
    expect(shape).toHaveTextContent("10,000 × 417");
    expect(shape).toHaveAttribute("title", "10,000 rows × 417 columns");
    expect(shape).not.toHaveTextContent("rows");
  });

  it("uses the file backend badge as an engine switch without styling notebook badges as controls", async () => {
    const { rerender } = render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });

    const backend = await screen.findByRole("button", {
      name: "Change dataframe engine. Current engine: Polars"
    });
    expect(backend).toHaveTextContent("Polars");
    expect(backend.querySelector(".codicon-chevron-down")).not.toBeNull();
    fireEvent.click(backend);
    expect(webviewPostMessage).toHaveBeenCalledWith({ kind: "changeBackend" });

    dispatchAppMessage({ kind: "importOptionsState", busy: true });
    expect(backend).toBeDisabled();
    expect(backend).toHaveAttribute("aria-busy", "true");
    dispatchAppMessage({ kind: "importOptionsState", busy: false });

    rerender(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        source: {
          kind: "notebookVariable",
          label: "frame",
          variableName: "frame",
          uri: "file:///workspace/example.ipynb"
        }
      },
      page,
      summaries: []
    });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /change dataframe engine/iu })).not.toBeInTheDocument()
    );
    expect(document.querySelector('[data-session-badge="backend"]')).toHaveTextContent("Polars");
  });
});

describe("App file import options", () => {
  beforeAll(async () => {
    document.body.dataset.canChangeImportOptions = "true";
    ({ App } = await import("../webviews/App"));
  });

  beforeEach(() => {
    webviewPostMessage.mockClear();
  });

  it("announces honest PySpark open stages without offering an unsafe kernel interrupt", async () => {
    render(<App />);

    dispatchAppMessage({ kind: "sessionOpenProgress", stage: "acquiringKernel" });
    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveTextContent("Connecting to the notebook kernel");

    dispatchAppMessage({ kind: "sessionOpenProgress", stage: "bootstrappingRuntime" });
    expect(status).toHaveTextContent("Preparing Open Wrangler in the kernel");

    dispatchAppMessage({ kind: "sessionOpenProgress", stage: "preparingSparkView" });
    expect(status).toHaveTextContent("Preparing PySpark 4.2 (viewing only)");
    expect(status).toHaveTextContent("Loading the first page without counting every row");
    expect(status).toHaveTextContent("The exact total appears after the last page");
    expect(screen.queryByRole("button", { name: /cancel opening/iu })).not.toBeInTheDocument();

    dispatchAppMessage({ kind: "sessionOpenProgress", stage: "untrusted-stage" });
    expect(status).toHaveTextContent("Preparing PySpark 4.2 (viewing only)");

    dispatchAppMessage({ kind: "sessionOpenProgress", stage: null });
    expect(status).toHaveTextContent("Opening session");
    expect(status).not.toHaveTextContent("PySpark");

    dispatchAppMessage({ kind: "sessionOpenProgress", stage: "openingNotebookVariable" });
    expect(status).toHaveTextContent("Opening the live notebook variable");
    expect(status).not.toHaveTextContent("without counting every row");
    expect(screen.queryByRole("button", { name: /cancel opening/iu })).not.toBeInTheDocument();
  });

  it("explains PySpark source order through a keyboard-accessible disclosure", async () => {
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        backend: "pyspark",
        mode: "viewing",
        capabilities: { ...metadata.capabilities, editable: false }
      },
      page,
      summaries: []
    });

    expect(await screen.findByText("PySpark")).toBeVisible();
    expect(screen.queryByText("Experimental")).not.toBeInTheDocument();
    const orderingBadge = screen.getByText("Source order").closest("summary");
    expect(orderingBadge).toHaveAttribute("data-session-badge", "ordering");
    expect(orderingBadge).toHaveAttribute("aria-describedby", "pyspark-ordering-help");
    const help = screen.getByText(
      "Spark does not guarantee source order. Add a sort with a unique final key when you need repeatable rows."
    );
    expect(help).not.toBeVisible();
    fireEvent.click(orderingBadge!);
    expect(help).toBeVisible();
    orderingBadge?.focus();
    expect(orderingBadge).toHaveFocus();
    expect(screen.getByText("Viewing only")).toBeVisible();
    expect(screen.queryByText(/^viewing$/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch to Editing" })).not.toBeInTheDocument();
  });

  it("carries the latest grid state into Editing mode and restores keyboard focus", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      render(<App />);
      const source = {
        kind: "notebookVariable" as const,
        label: "orders_frame",
        variableName: "orders_frame",
        uri: "file:///workspace/orders.ipynb"
      };
      const viewingMetadata: SessionMetadata = {
        ...metadata,
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        mode: "viewing",
        source,
        capabilities: {
          ...metadata.capabilities,
          lazy: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: true,
          supportedOperations: ["sortRows", "fillMissingValues"]
        }
      };
      dispatchAppMessage({ kind: "sessionOpened", metadata: viewingMetadata, page, summaries: [] });

      const action = await screen.findByRole("button", { name: "Switch to Editing" });
      expect(action).toHaveAttribute("title", "Reopen this live dataframe in Editing mode");
      webviewPostMessage.mockClear();
      fireEvent.keyDown(screen.getByRole("button", { name: "Resize city column" }), { key: "ArrowRight" });
      action.focus();
      fireEvent.click(action);
      const stateMessages = webviewPostMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message?.kind === "updateViewState" || message?.kind === "switchSessionToEditing");
      expect(stateMessages).toEqual([
        {
          kind: "switchSessionToEditing",
          state: {
            columnWidths: { "c:0": 200 },
            viewport: { firstVisibleRow: 0, scrollLeft: 0 }
          }
        }
      ]);

      dispatchAppMessage({ kind: "sessionModeChangeState", busy: true });
      expect(action).toBeDisabled();
      expect(screen.getByTestId("app-workspace")).toHaveAttribute("inert");
      expect(screen.getByText("Opening Editing mode…")).toHaveAttribute("role", "status");

      dispatchAppMessage({
        kind: "error",
        code: "editing_mode_open_failed",
        message: "The selected kernel changed.",
        recoverable: true,
        sessionId: viewingMetadata.sessionId
      });
      dispatchAppMessage({ kind: "sessionModeChangeState", busy: false });
      expect(frames).toHaveLength(1);
      act(() => frames.shift()!(performance.now()));
      expect(action).toHaveFocus();

      fireEvent.click(action);
      dispatchAppMessage({ kind: "sessionModeChangeState", busy: true });
      dispatchAppMessage({
        kind: "sessionOpened",
        metadata: { ...viewingMetadata, revision: 1, mode: "editing" },
        page,
        summaries: []
      });
      dispatchAppMessage({ kind: "sessionModeChangeState", busy: false });
      expect(frames).toHaveLength(1);
      act(() => frames.shift()!(performance.now()));
      expect(screen.queryByRole("button", { name: "Switch to Editing" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add step" })).toHaveFocus();
    } finally {
      hasFocus.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("offers Editing mode for a dataframe from the active R terminal", async () => {
    render(<App />);
    const viewingMetadata: SessionMetadata = {
      ...metadata,
      backend: "r",
      rDataframeFlavor: "r.data.frame",
      mode: "viewing",
      source: { kind: "rInteractiveVariable", label: "base_orders", variableName: "base_orders" },
      capabilities: {
        ...metadata.capabilities,
        editable: true,
        lazy: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false,
        documentInsert: false,
        supportedOperations: ["sortRows", "fillMissingValues"]
      }
    };
    dispatchAppMessage({ kind: "sessionOpened", metadata: viewingMetadata, page, summaries: [] });

    const action = await screen.findByRole("button", { name: "Switch to Editing" });
    expect(action).toHaveAttribute("title", "Reopen this live dataframe in Editing mode");
    webviewPostMessage.mockClear();
    fireEvent.click(action);
    expect(webviewPostMessage).toHaveBeenCalledWith({
      kind: "switchSessionToEditing",
      state: { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
    });

    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: { ...viewingMetadata, revision: 1, mode: "editing" },
      page,
      summaries: []
    });
    expect(screen.queryByRole("button", { name: "Switch to Editing" })).not.toBeInTheDocument();
  });

  it("does not issue unsupported viewing requests when capabilities are explicitly disabled", async () => {
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        capabilities: {
          ...metadata.capabilities,
          filter: false,
          sort: false,
          profile: false,
          columnValues: false
        }
      },
      page,
      summaries: []
    });

    expect(await screen.findByRole("cell", { name: "Milan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Profiles and filters unavailable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Profiles unavailable" })).toBeDisabled();

    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    if (!cityHeader) throw new Error("Expected the city header.");
    fireEvent.click(within(cityHeader).getByLabelText("Column actions for city"));
    expect(within(cityHeader).getByRole("button", { name: "Filter…" })).toBeDisabled();
    expect(within(cityHeader).getByRole("button", { name: "Sort ascending" })).toBeDisabled();

    webviewPostMessage.mockClear();
    dispatchAppMessage({ kind: "editorAction", action: "openFilters", column: "city" });
    dispatchAppMessage({ kind: "editorAction", action: "clearFilterColumn", column: "city" });
    expect(screen.queryByRole("complementary", { name: "Column profiles and filters" })).not.toBeInTheDocument();
    expect(
      webviewPostMessage.mock.calls.some(
        ([message]) =>
          message?.kind === "runtimeRequest" &&
          ["getPage", "getSummary", "getDatasetStats", "getColumnValues"].includes(message.request?.kind)
      )
    ).toBe(false);
  });

  it("labels a sort-only dataframe without advertising filters or profiles", async () => {
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        mode: "editing",
        capabilities: {
          ...metadata.capabilities,
          editable: false,
          filter: false,
          sort: true,
          profile: false,
          columnValues: false
        }
      },
      page,
      summaries: []
    });

    expect(await screen.findByRole("cell", { name: "Milan" })).toBeVisible();
    expect(screen.getByText(/^editing$/iu)).toBeVisible();
    expect(screen.queryByText("Viewing only")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sorts" }));

    const drawer = screen.getByRole("complementary", { name: "Sorts" });
    expect(within(drawer).getByRole("tablist", { name: "Sorts view" })).toHaveStyle({
      gridTemplateColumns: "repeat(1, minmax(0, 1fr))"
    });
    expect(within(drawer).getByRole("tab", { name: "Sorts" })).toBeVisible();
    expect(within(drawer).getByRole("heading", { name: "Sorts" })).toBeVisible();
    expect(within(drawer).getByRole("combobox", { name: "Sort column" })).toBeEnabled();
    expect(within(drawer).queryByText("Filtering is unavailable for this dataframe.")).toBeNull();
  });

  it("describes a profiles-and-sorts panel without claiming that filters are available", async () => {
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        capabilities: {
          ...metadata.capabilities,
          filter: false,
          sort: true,
          profile: true,
          columnValues: false
        }
      },
      page,
      summaries: []
    });

    expect(await screen.findByRole("cell", { name: "Milan" })).toBeVisible();
    const toggle = screen.getByRole("button", { name: "Column profiles and sorts" });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    const drawer = screen.getByRole("complementary", { name: "Column profiles and sorts" });
    expect(drawer).toBeVisible();
    expect(within(drawer).getByRole("tablist", { name: "Column profiles and sorts view" })).toBeVisible();
  });

  it("warns that rows tied across every PySpark sort key may move on rerun", async () => {
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        backend: "pyspark",
        mode: "viewing",
        capabilities: { ...metadata.capabilities, editable: false },
        filterModel: {
          ...metadata.filterModel,
          sort: [{ column: "city", direction: "asc", nulls: "last" }]
        }
      },
      page,
      summaries: []
    });

    expect(await screen.findByText("PySpark")).toBeVisible();
    expect(screen.queryByText("Source order")).not.toBeInTheDocument();
    const orderingBadge = screen.getByText("Sorted").closest("summary");
    expect(orderingBadge).toHaveAttribute("data-session-badge", "ordering");
    const help = screen.getByText(
      "Rows tied across every sort key may move when Spark reruns this dataframe. Add a unique final sort key for repeatable rows."
    );
    expect(help).not.toBeVisible();
    fireEvent.click(orderingBadge!);
    expect(help).toBeVisible();
  });

  it("orders repeated direct-cell filters by their latest typed request", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    const milan = await screen.findByRole("cell", { name: "Milan" });
    const paris = screen.getByRole("cell", { name: "Paris" });
    webviewPostMessage.mockClear();

    fireEvent.click(within(milan).getByRole("button", { name: "Filter city by this cell" }));
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Filter city by this cell" })).getByRole("menuitem", {
        name: "Keep only this value"
      })
    );
    fireEvent.click(within(paris).getByRole("button", { name: "Filter city by this cell" }));
    fireEvent.click(
      within(await screen.findByRole("menu", { name: "Filter city by this cell" })).getByRole("menuitem", {
        name: "Exclude this value"
      })
    );

    const requests = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.kind === "runtimeRequest" && message.request?.kind === "getPage")
      .map((message) => message.request);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.viewRequestId).not.toBe(requests[1]?.viewRequestId);
    expect(requests[0]?.filterModel.filters[0]?.valueFilter?.selectedValues[0]).toMatchObject({
      kind: "typedSelection",
      columnType: "string",
      cell: { raw: "Milan" }
    });
    expect(requests[1]?.filterModel.filters).toEqual([
      {
        column: "city",
        type: "string",
        logic: "and",
        predicates: [
          {
            kind: "predicate",
            operator: "notEquals",
            value: {
              kind: "typedSelection",
              version: 1,
              columnType: "string",
              cell: { kind: "string", raw: "Paris", display: "Paris", isNull: false, isNaN: false }
            }
          }
        ]
      }
    ]);
  });

  it("removes one native-tree column filter while preserving sibling filters and all sorts", async () => {
    const filteredMetadata: SessionMetadata = {
      ...metadata,
      filterModel: {
        logic: "and",
        filters: [
          {
            column: "city",
            type: "string",
            predicates: [{ kind: "predicate", operator: "equals", value: "Milan" }]
          },
          {
            column: "sales",
            type: "float",
            predicates: [{ kind: "predicate", operator: "gt", value: 10 }]
          }
        ],
        sort: [
          { column: "city", direction: "asc", nulls: "last" },
          { column: "sales", direction: "desc", nulls: "first" }
        ]
      }
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: filteredMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });
    webviewPostMessage.mockClear();

    dispatchAppMessage({ kind: "editorAction", action: "clearFilterColumn", column: "city" });

    const pageRequest = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.kind === "runtimeRequest" && message.request?.kind === "getPage");
    expect(pageRequest?.request.filterModel).toEqual({
      logic: "and",
      filters: [
        {
          column: "sales",
          type: "float",
          predicates: [{ kind: "predicate", operator: "gt", value: 10 }]
        }
      ],
      sort: filteredMetadata.filterModel.sort
    });
  });

  it("keeps reconciled filters, value selections, predicates, and sort priority after applying a step", async () => {
    const step: TransformStep = {
      id: "round-sales",
      kind: "roundNumber",
      params: { column: { id: "c:1", name: "sales" }, decimals: 0 }
    };
    const filterModel: SessionMetadata["filterModel"] = {
      logic: "and",
      filters: [
        {
          column: "city",
          type: "string",
          valueFilter: {
            kind: "values",
            selectedValues: ["Milan"],
            includeNulls: false,
            includeNaN: false,
            search: "mil"
          },
          predicates: [{ kind: "predicate", operator: "contains", value: "il" }]
        }
      ],
      sort: [
        { column: "sales", direction: "desc", nulls: "last" },
        { column: "city", direction: "asc", nulls: "first" }
      ]
    };
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: { ...metadata, revision: 1, filterModel, draftStep: step },
      page,
      summaries: []
    });
    await screen.findByRole("cell", { name: "Milan" });

    dispatchAppMessage({ kind: "editorAction", action: "applyDraft" });
    dispatchAppMessage({
      kind: "planUpdated",
      action: "apply",
      revision: 2,
      metadata: { ...metadata, revision: 2, filterModel, steps: [step] },
      page,
      code: "frame"
    });

    expect(document.querySelector<HTMLElement>('th[data-column="sales"]')).toHaveAccessibleName(
      "sales, sorted descending, priority 1 of 2"
    );
    expect(document.querySelector<HTMLElement>('th[data-column="city"]')).toHaveAccessibleName(
      "city, sorted ascending, priority 2 of 2"
    );

    dispatchAppMessage({ kind: "editorAction", action: "openFilters", column: "city" });
    expect(await screen.findByRole("tab", { name: "Filters / Sorts" })).toHaveAttribute("aria-selected", "true");
    const filtersPanel = screen.getByRole("complementary", { name: "Column profiles and filters" });
    expect(within(filtersPanel).getByRole("button", { name: 'Remove equals "Milan" filter from city' })).toBeVisible();
    expect(within(filtersPanel).getByRole("button", { name: 'Remove contains "il" filter from city' })).toBeVisible();
    const sortOrder = screen.getByRole("list", { name: "Active sort order" });
    expect(
      within(sortOrder)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual([expect.stringContaining("sales"), expect.stringContaining("city")]);
  });

  it("keeps a user-edited draft view when the runtime confirms discard", async () => {
    const step: TransformStep = {
      id: "round-sales",
      kind: "roundNumber",
      params: { column: { id: "c:1", name: "sales" }, decimals: 0 }
    };
    const editedFilterModel: SessionMetadata["filterModel"] = {
      filters: [
        {
          column: "city",
          type: "string",
          predicates: [{ kind: "predicate", operator: "contains", value: "il" }]
        }
      ],
      sort: [
        { column: "city", direction: "desc", nulls: "last" },
        { column: "sales", direction: "asc", nulls: "first" }
      ]
    };
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: { ...metadata, revision: 1, filterModel: editedFilterModel, draftStep: step },
      page,
      summaries: []
    });
    await screen.findByRole("cell", { name: "Milan" });

    dispatchAppMessage({ kind: "editorAction", action: "discardDraft" });
    dispatchAppMessage({
      kind: "planUpdated",
      action: "discard",
      revision: 2,
      metadata: { ...metadata, revision: 2, filterModel: editedFilterModel },
      page,
      code: "frame"
    });

    expect(document.querySelector<HTMLElement>('th[data-column="city"]')).toHaveAccessibleName(
      "city, sorted descending, priority 1 of 2"
    );
    dispatchAppMessage({ kind: "editorAction", action: "openFilters", column: "city" });
    const filtersPanel = await screen.findByRole("complementary", { name: "Column profiles and filters" });
    expect(within(filtersPanel).getByRole("button", { name: 'Remove contains "il" filter from city' })).toBeVisible();
    const sortOrder = screen.getByRole("list", { name: "Active sort order" });
    expect(
      within(sortOrder)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual([expect.stringContaining("city"), expect.stringContaining("sales")]);
  });

  it("opens the Filters drawer from a native sort node and applies validated priority changes", async () => {
    const sortedMetadata: SessionMetadata = {
      ...metadata,
      filterModel: {
        filters: [],
        sort: [
          { column: "city", direction: "asc", nulls: "last" },
          { column: "sales", direction: "desc", nulls: "first" }
        ]
      }
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: sortedMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    dispatchAppMessage({ kind: "editorAction", action: "openFilters", column: "sales" });

    expect(await screen.findByRole("complementary", { name: "Column profiles and filters" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Filters / Sorts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "Sort column" })).toHaveValue("c:1");

    webviewPostMessage.mockClear();
    dispatchAppMessage({
      kind: "editorAction",
      action: "changeViewSort",
      column: "city",
      sortAction: "moveDown",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(sortedMetadata.filterModel.sort),
      expectedSortIndex: 0
    });

    const pageRequest = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.kind === "runtimeRequest" && message.request?.kind === "getPage")
      .at(-1);
    expect(pageRequest?.request.filterModel.sort).toEqual([
      { column: "sales", direction: "desc", nulls: "first" },
      { column: "city", direction: "asc", nulls: "last" }
    ]);
  });

  it("removes exactly one validated native-tree view sort from the live query", async () => {
    const sortedMetadata: SessionMetadata = {
      ...metadata,
      filterModel: {
        filters: [],
        sort: [
          { column: "city", direction: "asc", nulls: "last" },
          { column: "sales", direction: "desc", nulls: "first" }
        ]
      }
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: sortedMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });
    webviewPostMessage.mockClear();

    dispatchAppMessage({
      kind: "editorAction",
      action: "changeViewSort",
      column: "sales",
      sortAction: "remove",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(sortedMetadata.filterModel.sort),
      expectedSortIndex: 1
    });

    const pageRequest = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.kind === "runtimeRequest" && message.request?.kind === "getPage");
    expect(pageRequest?.request.filterModel.sort).toEqual([{ column: "city", direction: "asc", nulls: "last" }]);

    webviewPostMessage.mockClear();
    dispatchAppMessage({
      kind: "editorAction",
      action: "changeViewSort",
      column: "missing",
      sortAction: "remove",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(sortedMetadata.filterModel.sort),
      expectedSortIndex: 1
    });
    expect(webviewPostMessage).not.toHaveBeenCalled();
  });

  it("ignores a native sort action that became stale behind a pending header quick-sort", async () => {
    const sortedMetadata: SessionMetadata = {
      ...metadata,
      filterModel: {
        filters: [],
        sort: [
          { column: "city", direction: "asc", nulls: "last" },
          { column: "sales", direction: "desc", nulls: "first" }
        ]
      }
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: sortedMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });
    webviewPostMessage.mockClear();

    const salesHeader = document.querySelector<HTMLElement>('th[data-column="sales"]');
    if (!salesHeader) throw new Error("Expected the sales header.");
    const sales = within(salesHeader);
    const menu = sales.getByLabelText("Column actions for sales").closest("details");
    if (!(menu instanceof HTMLDetailsElement)) throw new Error("Expected the sales details menu.");
    menu.open = true;
    fireEvent.click(sales.getByRole("button", { name: "Sort ascending" }));

    dispatchAppMessage({
      kind: "editorAction",
      action: "changeViewSort",
      column: "city",
      sortAction: "moveDown",
      expectedSessionId: "session",
      expectedSortModelSignature: JSON.stringify(sortedMetadata.filterModel.sort),
      expectedSortIndex: 0
    });

    const pageRequests = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.kind === "runtimeRequest" && message.request?.kind === "getPage");
    expect(pageRequests).toHaveLength(1);
    expect(pageRequests[0]?.request.filterModel.sort).toEqual([
      { column: "sales", direction: "asc", nulls: "first" },
      { column: "city", direction: "asc", nulls: "last" }
    ]);
  });

  it("atomically commits the exact rendered snapshot before acknowledging it", () => {
    const previousImplementation = webviewPostMessage.getMockImplementation();
    try {
      render(<App />);
      webviewPostMessage.mockClear();
      webviewPostMessage.mockImplementation((message) => {
        if (message?.kind === "rendererSynchronized") {
          expect(screen.getByRole("cell", { name: "Milan" })).toBeVisible();
        }
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
              kind: "rendererSynchronization",
              syncId: "S".repeat(32),
              sessionId: metadata.sessionId,
              revision: metadata.revision
            },
            origin: window.location.origin
          })
        );
        expect(webviewPostMessage.mock.calls.some(([message]) => message?.kind === "rendererSynchronized")).toBe(true);
      });

      expect(document.querySelector("main.app")).toHaveAttribute("data-session-id", metadata.sessionId);
      expect(document.querySelector("main.app")).toHaveAttribute("data-renderer-sync-id", "S".repeat(32));
      expect(webviewPostMessage).toHaveBeenCalledWith({
        kind: "rendererSynchronized",
        syncId: "S".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision
      });
    } finally {
      webviewPostMessage.mockImplementation(previousImplementation ?? (() => undefined));
    }
  });

  it("acknowledges renderer synchronization before flushing pending grid presentation", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
      fireEvent.keyDown(screen.getByRole("button", { name: "Resize city column" }), { key: "ArrowRight" });
      webviewPostMessage.mockClear();

      dispatchAppMessage({
        kind: "rendererSynchronization",
        syncId: "F".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision
      });

      const synchronizationMessages = webviewPostMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message?.kind === "updateViewState" || message?.kind === "rendererSynchronized");
      expect(synchronizationMessages).toHaveLength(2);
      expect(synchronizationMessages[0]).toEqual({
        kind: "rendererSynchronized",
        syncId: "F".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision
      });
      expect(synchronizationMessages[1]).toMatchObject({
        kind: "updateViewState",
        state: { columnWidths: { "c:0": 200 } }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes one exact retirement receipt after pending presentation state on a non-persisted page exit", () => {
    vi.useFakeTimers();
    try {
      const dispatchPageHide = (persisted: boolean) => {
        const event = new Event("pagehide");
        Object.defineProperty(event, "persisted", { value: persisted });
        act(() => window.dispatchEvent(event));
      };
      render(<App />);
      dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });

      dispatchAppMessage({
        kind: "rendererSynchronization",
        syncId: "U".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision + 1,
        layoutTransitionPending: false
      });
      webviewPostMessage.mockClear();
      dispatchPageHide(false);
      expect(webviewPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "rendererRetiring" }));

      dispatchAppMessage({
        kind: "rendererSynchronization",
        syncId: "R".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision,
        layoutTransitionPending: false
      });
      expect(webviewPostMessage).toHaveBeenCalledWith({
        kind: "rendererSynchronized",
        syncId: "R".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision
      });

      webviewPostMessage.mockClear();
      dispatchPageHide(true);
      expect(webviewPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "rendererRetiring" }));

      fireEvent.keyDown(screen.getByRole("button", { name: "Resize city column" }), { key: "ArrowRight" });
      dispatchPageHide(false);
      dispatchPageHide(false);

      const exitMessages = webviewPostMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message?.kind === "updateViewState" || message?.kind === "rendererRetiring");
      expect(exitMessages).toEqual([
        expect.objectContaining({ kind: "updateViewState" }),
        {
          kind: "rendererRetiring",
          syncId: "R".repeat(32),
          sessionId: metadata.sessionId,
          revision: metadata.revision
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps bounded recovery pulls alive until the matching final marker commits", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      webviewPostMessage.mockClear();
      dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });

      act(() => vi.advanceTimersByTime(250));
      expect(
        webviewPostMessage.mock.calls.filter(([message]) => message?.kind === "requestSessionSnapshot")
      ).toHaveLength(1);

      dispatchAppMessage({
        kind: "rendererSynchronization",
        syncId: "W".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision + 1
      });
      act(() => vi.advanceTimersByTime(500));
      expect(
        webviewPostMessage.mock.calls.filter(([message]) => message?.kind === "requestSessionSnapshot")
      ).toHaveLength(2);

      dispatchAppMessage({
        kind: "rendererSynchronization",
        syncId: "N".repeat(32),
        sessionId: null,
        revision: null
      });
      act(() => vi.advanceTimersByTime(1_000));
      expect(
        webviewPostMessage.mock.calls.filter(([message]) => message?.kind === "requestSessionSnapshot")
      ).toHaveLength(3);

      dispatchAppMessage({
        kind: "rendererSynchronization",
        syncId: "S".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision
      });
      expect(webviewPostMessage).toHaveBeenCalledWith({
        kind: "rendererSynchronized",
        syncId: "S".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision
      });
      const recoveryPullCount = webviewPostMessage.mock.calls.filter(
        ([message]) => message?.kind === "requestSessionSnapshot"
      ).length;

      act(() => vi.advanceTimersByTime(30_000));
      expect(
        webviewPostMessage.mock.calls.filter(([message]) => message?.kind === "requestSessionSnapshot")
      ).toHaveLength(recoveryPullCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds snapshot pulls per visible period and pauses them while the renderer is hidden", () => {
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      const { unmount } = render(<App />);
      webviewPostMessage.mockClear();

      act(() => vi.advanceTimersByTime(30_000));
      expect(
        webviewPostMessage.mock.calls.filter(([message]) => message?.kind === "requestSessionSnapshot")
      ).toHaveLength(0);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(
        webviewPostMessage.mock.calls.filter(([message]) => message?.kind === "requestSessionSnapshot")
      ).toHaveLength(1);

      act(() => vi.advanceTimersByTime(30_000));
      expect(
        webviewPostMessage.mock.calls.filter(([message]) => message?.kind === "requestSessionSnapshot")
      ).toHaveLength(6);

      unmount();
      act(() => vi.advanceTimersByTime(30_000));
      expect(
        webviewPostMessage.mock.calls.filter(([message]) => message?.kind === "requestSessionSnapshot")
      ).toHaveLength(6);
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      vi.useRealTimers();
    }
  });

  it("shows the action for file sessions but not notebook sessions", async () => {
    const { unmount } = render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    expect(await screen.findByRole("button", { name: "Import options" })).toBeEnabled();

    unmount();
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        source: {
          kind: "notebookVariable",
          label: "frame",
          variableName: "frame",
          uri: "file:///tmp/example.ipynb"
        }
      },
      page,
      summaries: []
    });

    await screen.findByText("frame");
    expect(screen.queryByRole("button", { name: "Import options" })).toBeNull();
  });

  it("uses the initial error action to retry import configuration and clears host-driven busy state", async () => {
    render(<App />);
    dispatchAppMessage({
      kind: "error",
      code: "invalid_import_options",
      message: "Choose a valid delimiter.",
      recoverable: true
    });

    const action = await screen.findByRole("button", { name: "Import options" });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a valid delimiter.");
    webviewPostMessage.mockClear();
    fireEvent.click(action);

    expect(outboundImportOptionMessages()).toEqual([{ kind: "changeImportOptions" }]);
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Updating import options");

    dispatchAppMessage({ kind: "cancelled", targetRequestId: "change-import-options" });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a valid delimiter.");

    dispatchAppMessage({ kind: "importOptionsState", busy: false });
    expect(action).toBeEnabled();
    expect(action).not.toHaveAttribute("aria-busy");
  });

  it("offers a direct confirmed dependency install only for a structured missing-dependency error", async () => {
    const { unmount } = render(<App />);
    dispatchAppMessage({
      kind: "error",
      code: "missing_dependencies",
      message: "Polars is missing fastexcel>=0.9.",
      recoverable: true
    });

    const action = await screen.findByRole("button", { name: "Install required dependency" });
    expect(action).toBeEnabled();
    expect(action).not.toHaveAttribute("aria-busy");
    dispatchAppMessage({ kind: "importOptionsState", busy: true });
    expect(action).toBeDisabled();
    dispatchAppMessage({ kind: "importOptionsState", busy: false });
    expect(action).toBeEnabled();
    webviewPostMessage.mockClear();
    fireEvent.click(action);

    expect(webviewPostMessage).toHaveBeenCalledWith({ kind: "installRuntimeDependencies" });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for dependency confirmation");

    dispatchAppMessage({ kind: "runtimeDependencyInstallState", busy: false });
    expect(action).toBeEnabled();
    expect(action).not.toHaveAttribute("aria-busy");

    unmount();
    render(<App />);
    dispatchAppMessage({
      kind: "error",
      code: "invalid_import_options",
      message: "Choose a valid delimiter.",
      recoverable: true
    });
    expect(screen.queryByRole("button", { name: "Install required dependency" })).toBeNull();
  });

  it("commits and blurs a pointer-triggered import action before dispatch, then restores it after completion", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const previousImplementation = webviewPostMessage.getMockImplementation();
    let stateAtDispatch:
      | {
          activeElement: Element | null;
          disabled: boolean;
          ariaBusy: string | null;
        }
      | undefined;
    try {
      render(<App />);
      dispatchAppMessage({
        kind: "error",
        code: "invalid_import_options",
        message: "Choose a valid delimiter.",
        recoverable: true
      });

      const action = await screen.findByRole<HTMLButtonElement>("button", { name: "Import options" });
      act(() => action.focus());
      expect(document.activeElement).toBe(action);
      webviewPostMessage.mockClear();
      webviewPostMessage.mockImplementation((message) => {
        if (message?.kind !== "changeImportOptions") return;
        stateAtDispatch = {
          activeElement: document.activeElement,
          disabled: action.disabled,
          ariaBusy: action.getAttribute("aria-busy")
        };
      });

      fireEvent.click(action);

      expect(stateAtDispatch).toEqual({
        activeElement: document.body,
        disabled: true,
        ariaBusy: "true"
      });
      expect(outboundImportOptionMessages()).toEqual([{ kind: "changeImportOptions" }]);

      dispatchAppMessage({ kind: "importOptionsState", busy: false });
      expect(frames).toHaveLength(1);
      act(() => frames[0](performance.now()));
      expect(document.activeElement).toBe(action);
    } finally {
      webviewPostMessage.mockImplementation(previousImplementation ?? (() => undefined));
      hasFocus.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("does not restore an import action after the host takes focus before the completion frame", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      render(<App />);
      dispatchAppMessage({
        kind: "error",
        code: "invalid_import_options",
        message: "Choose a valid delimiter.",
        recoverable: true
      });

      const action = await screen.findByRole<HTMLButtonElement>("button", { name: "Import options" });
      act(() => action.focus());
      fireEvent.click(action);
      dispatchAppMessage({ kind: "importOptionsState", busy: false });
      expect(frames).toHaveLength(1);

      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      focus.mockClear();
      hasFocus.mockReturnValue(false);
      act(() => frames[0](performance.now()));
      expect(focus).not.toHaveBeenCalled();
      focus.mockRestore();
    } finally {
      hasFocus.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("keeps confirmed data on reconfiguration failure and accepts a later successful replacement", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    expect(await screen.findByRole("cell", { name: "Milan" })).toBeVisible();

    webviewPostMessage.mockClear();
    const action = screen.getByRole("button", { name: "Import options" });
    fireEvent.click(action);
    expect(outboundImportOptionMessages()).toEqual([{ kind: "changeImportOptions" }]);
    expect(action).toBeDisabled();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");

    dispatchAppMessage({
      kind: "error",
      code: "invalid_import_options",
      message: "The selected encoding could not read this file.",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("The selected encoding could not read this file.");
    expect(screen.getByRole("cell", { name: "Milan" })).toBeVisible();

    dispatchAppMessage({ kind: "importOptionsState", busy: false });
    expect(action).toBeEnabled();
    expect(action).not.toHaveAttribute("aria-busy");

    fireEvent.click(action);
    expect(outboundImportOptionMessages()).toEqual([{ kind: "changeImportOptions" }, { kind: "changeImportOptions" }]);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        revision: 1,
        source: {
          ...metadata.source,
          importOptions: {
            delimiter: ";",
            encoding: "utf-8",
            quoteChar: '"',
            hasHeader: true
          }
        }
      },
      page,
      summaries: []
    });

    expect(action).toBeEnabled();
    expect(action).not.toHaveAttribute("aria-busy");
    expect(screen.queryByText("The selected encoding could not read this file.")).toBeNull();
    expect(screen.getByRole("cell", { name: "Milan" })).toBeVisible();
  });

  it("flushes pending grid presentation state before requesting new import options", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });
    webviewPostMessage.mockClear();

    fireEvent.keyDown(screen.getByRole("button", { name: "Resize city column" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Import options" }));

    const presentationAndImport = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.kind === "updateViewState" || message?.kind === "changeImportOptions");
    expect(presentationAndImport).toHaveLength(2);
    expect(presentationAndImport[0]).toMatchObject({
      kind: "updateViewState",
      state: { columnWidths: { "c:0": 200 } }
    });
    expect(presentationAndImport[1]).toEqual({ kind: "changeImportOptions" });
  });

  it("routes a native import request through the renderer flush, cancellation, and busy barrier", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });
    await waitFor(() =>
      expect(
        webviewPostMessage.mock.calls.some(
          ([message]) => message?.kind === "runtimeRequest" && message.request?.kind === "getSummary"
        )
      ).toBe(true)
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Resize city column" }), { key: "ArrowRight" });
    const importAction = screen.getByRole<HTMLButtonElement>("button", { name: "Import options" });
    act(() => importAction.focus());
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    webviewPostMessage.mockClear();
    try {
      dispatchAppMessage({ kind: "requestImportOptionsChange", actionId: "A".repeat(32) });

      expect(document.activeElement).toBe(document.body);
      expect(frames).toHaveLength(1);
      expect(outboundImportOptionMessages()).toEqual([]);
      expect(importAction).toBeDisabled();
      expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");

      act(() => frames[0](performance.now()));
      const orderedMessages = webviewPostMessage.mock.calls
        .map(([message]) => message)
        .filter(
          (message) =>
            message?.kind === "updateViewState" ||
            message?.kind === "cancelViewRequests" ||
            message?.kind === "changeImportOptions"
        );
      expect(orderedMessages).toHaveLength(3);
      expect(orderedMessages[0]).toMatchObject({
        kind: "updateViewState",
        state: { columnWidths: { "c:0": 200 } }
      });
      expect(orderedMessages[1]).toMatchObject({
        kind: "cancelViewRequests",
        viewRequestIds: expect.arrayContaining([expect.any(String)])
      });
      expect(orderedMessages[2]).toEqual({ kind: "changeImportOptions", actionId: "A".repeat(32) });
    } finally {
      requestFrame.mockRestore();
    }
  });

  it("cancels a deferred native import request when the host releases its busy barrier", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frame = nextFrame++;
      frames.set(frame, callback);
      return frame;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });
    webviewPostMessage.mockClear();
    try {
      dispatchAppMessage({ kind: "requestImportOptionsChange", actionId: "C".repeat(32) });
      expect(frames.size).toBe(1);
      expect(outboundImportOptionMessages()).toEqual([]);

      dispatchAppMessage({ kind: "importOptionsState", busy: false });

      expect(cancelFrame).toHaveBeenCalledTimes(1);
      expect(frames.size).toBe(0);
      expect(outboundImportOptionMessages()).toEqual([]);
      expect(screen.getByRole("button", { name: "Import options" })).toBeEnabled();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("flushes pending presentation state before a busy renderer leaves the native request to host fallback", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    fireEvent.keyDown(screen.getByRole("button", { name: "Resize city column" }), { key: "ArrowRight" });
    dispatchAppMessage({ kind: "importOptionsState", busy: true });
    webviewPostMessage.mockClear();
    dispatchAppMessage({ kind: "requestImportOptionsChange", actionId: "B".repeat(32) });

    expect(webviewPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "updateViewState",
        state: expect.objectContaining({ columnWidths: { "c:0": 200 } })
      })
    );
    expect(outboundImportOptionMessages()).toEqual([]);
  });

  it("keeps grid and filter view controls locked for the complete import transaction", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });
    fireEvent.click(screen.getByRole("button", { name: "Column profiles and filters" }));
    fireEvent.click(screen.getByRole("tab", { name: "Filters / Sorts" }));
    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    expect(cityHeader).not.toBeNull();
    const cityControls = within(cityHeader!);
    fireEvent.click(cityControls.getByLabelText("Column actions for city"));

    expect(cityControls.getByRole("button", { name: "Filter…" })).toBeEnabled();
    expect(cityControls.getByRole("button", { name: "Sort ascending" })).toBeEnabled();
    expect(cityControls.getByRole("button", { name: "Resize city column" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Search values for city" })).toBeEnabled();
    const searchValues = screen.getByRole("button", { name: "Search values in city" });
    expect(searchValues).toHaveTextContent("Search");
    expect(searchValues.querySelector(".codicon-search")).not.toBeNull();

    dispatchAppMessage({ kind: "importOptionsState", busy: true });

    expect(screen.getByRole("button", { name: "Column profiles and filters" })).toBeDisabled();
    expect(cityControls.getByRole("button", { name: "Filter…" })).toBeDisabled();
    expect(cityControls.getByRole("button", { name: "Sort ascending" })).toBeDisabled();
    expect(cityControls.getByRole("button", { name: "Resize city column" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Search values for city" })).toBeDisabled();
    expect(cityControls.getByText("View controls are unavailable while import options are changing.")).toBeVisible();

    dispatchAppMessage({ kind: "importOptionsState", busy: false });

    expect(screen.getByRole("button", { name: "Column profiles and filters" })).toBeEnabled();
    expect(cityControls.getByRole("button", { name: "Filter…" })).toBeEnabled();
    expect(cityControls.getByRole("button", { name: "Resize city column" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeEnabled();
  });

  it("promotes a header sort without dropping the remaining view-only sort priorities", async () => {
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: {
        ...metadata,
        filterModel: {
          filters: [],
          sort: [
            { column: "sales", direction: "asc", nulls: "last" },
            { column: "city", direction: "asc", nulls: "last" }
          ]
        }
      },
      page,
      summaries: []
    });
    await screen.findByRole("cell", { name: "Milan" });
    webviewPostMessage.mockClear();

    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    if (!cityHeader) throw new Error("Expected the city header.");
    const city = within(cityHeader);
    const menu = city.getByLabelText("Column actions for city").closest("details");
    if (!(menu instanceof HTMLDetailsElement)) throw new Error("Expected the city details menu.");
    menu.open = true;
    fireEvent.click(city.getByRole("button", { name: "Sort descending" }));

    expect(menu.open).toBe(false);
    expect(webviewPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "runtimeRequest",
        request: expect.objectContaining({
          kind: "getPage",
          filterModel: {
            filters: [],
            sort: [
              { column: "city", direction: "desc", nulls: "last" },
              { column: "sales", direction: "asc", nulls: "last" }
            ]
          }
        })
      })
    );
    expect(
      city.getByRole("button", { name: /Clear sort for city; currently descending, priority 1 of 2/u })
    ).toBeVisible();
  });

  it("keeps the grid loading when a drained cleaning completion lands during import reconfiguration", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    dispatchAppMessage({ kind: "editorAction", action: "applyDraft" });
    dispatchAppMessage({ kind: "importOptionsState", busy: true });
    dispatchAppMessage({
      kind: "planUpdated",
      revision: 1,
      metadata: { ...metadata, revision: 1 },
      page,
      code: "frame"
    });

    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Import options" })).toHaveAttribute("aria-busy", "true");

    dispatchAppMessage({ kind: "importOptionsState", busy: false });

    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("button", { name: "Import options" })).not.toHaveAttribute("aria-busy");
  });

  it("closes operation UI and blocks host mutation actions while import reconfiguration is pending", async () => {
    const step: TransformStep = {
      id: "upper-city",
      kind: "upperText",
      params: { column: { id: "c:0", name: "city" } }
    };
    render(<App />);
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: { ...metadata, steps: [step], revision: 1 },
      page,
      summaries: []
    });
    await screen.findByRole("cell", { name: "Milan" });
    dispatchAppMessage({ kind: "editorAction", action: "openOperation" });
    expect(await screen.findByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();

    dispatchAppMessage({ kind: "importOptionsState", busy: true });
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add step" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit latest" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    webviewPostMessage.mockClear();

    for (const action of ["openOperation", "editLatest", "applyDraft", "discardDraft", "undoStep"] as const) {
      dispatchAppMessage({ kind: "editorAction", action });
    }

    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Edit cleaning step" })).toBeNull();
    expect(
      webviewPostMessage.mock.calls.some(
        ([message]) => message?.kind === "runtimeRequest" && isMutationRequestKind(message.request?.kind)
      )
    ).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent("Wait for the current import-options change to finish.");
  });

  it("ignores unsupported operation actions and opens the advertised catalog", async () => {
    const limitedMetadata: SessionMetadata = {
      ...metadata,
      capabilities: { ...metadata.capabilities, supportedOperations: ["renameColumn"] }
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: limitedMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    dispatchAppMessage({ kind: "editorAction", action: "openOperation", operationKind: "customCode" });
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();

    dispatchAppMessage({
      kind: "editorAction",
      action: "openOperation",
      operationKind: "renameColumn",
      expectedSessionId: limitedMetadata.sessionId,
      expectedRevision: limitedMetadata.revision
    });
    expect(await screen.findByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByText("Rename column", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("Custom code", { selector: "strong" })).toBeNull();
  });

  it("opens native R Custom code with R syntax and forwards the exact edited source", async () => {
    const rMetadata: SessionMetadata = {
      ...metadata,
      backend: "r",
      rDataframeFlavor: "r.data.frame",
      capabilities: { ...metadata.capabilities, supportedOperations: ["customCode"] }
    };
    const customCode = 'result <- df[df$city == "Milan", , drop = FALSE]';
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: rMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    dispatchAppMessage({
      kind: "editorAction",
      action: "openOperation",
      operationKind: "customCode",
      expectedSessionId: rMetadata.sessionId,
      expectedRevision: rMetadata.revision
    });
    const dialog = await screen.findByRole("dialog", { name: "Add cleaning step" });
    const code = within(dialog).getByLabelText("Engine-native R", { exact: true });
    expect(code).toHaveValue("result <- df");
    fireEvent.change(code, { target: { value: customCode } });
    webviewPostMessage.mockClear();
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview changes" }));

    const previewRequest = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.kind === "runtimeRequest" && message.request?.kind === "previewStep")?.request;
    expect(previewRequest).toMatchObject({
      kind: "previewStep",
      step: { kind: "customCode", params: { code: customCode } }
    });
  });

  it("queues a native operation intent until the current grid request finishes", async () => {
    const limitedMetadata: SessionMetadata = {
      ...metadata,
      capabilities: { ...metadata.capabilities, supportedOperations: ["renameColumn"] }
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: limitedMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    if (!cityHeader) throw new Error("Expected the city header.");
    const city = within(cityHeader);
    const menu = city.getByLabelText("Column actions for city").closest("details");
    if (!(menu instanceof HTMLDetailsElement)) throw new Error("Expected the city details menu.");
    menu.open = true;
    webviewPostMessage.mockClear();
    fireEvent.click(city.getByRole("button", { name: "Sort ascending" }));
    const pageRequest = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.kind === "runtimeRequest" && message.request?.kind === "getPage")?.request;
    expect(pageRequest?.viewRequestId).toEqual(expect.any(String));

    dispatchAppMessage({
      kind: "editorAction",
      action: "openOperation",
      operationKind: "renameColumn",
      expectedSessionId: limitedMetadata.sessionId,
      expectedRevision: limitedMetadata.revision
    });
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();

    dispatchAppMessage({
      kind: "page",
      revision: 0,
      viewRequestId: pageRequest.viewRequestId,
      metadata: { ...limitedMetadata, filterModel: pageRequest.filterModel },
      page,
      summaries: []
    });
    const dialog = await screen.findByRole("dialog", { name: "Add cleaning step" });
    const preview = within(dialog).getByRole("button", { name: "Preview changes" });
    expect(preview).toBeEnabled();

    fireEvent.change(within(dialog).getByLabelText("Column"), { target: { value: "c:0" } });
    fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: "location" } });
    webviewPostMessage.mockClear();
    fireEvent.click(preview);
    const previewRequest = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.kind === "runtimeRequest" && message.request?.kind === "previewStep")?.request;
    expect(previewRequest).toMatchObject({
      kind: "previewStep",
      step: {
        kind: "renameColumn",
        params: { column: { id: "c:0", name: "city" }, newName: "location" }
      }
    });
    expect(previewRequest).not.toHaveProperty("replaceStepId");
  });

  it("retains a toolbar operation intent accepted in the same turn as a grid request", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    if (!cityHeader) throw new Error("Expected the city header.");
    const city = within(cityHeader);
    const menu = city.getByLabelText("Column actions for city").closest("details");
    if (!(menu instanceof HTMLDetailsElement)) throw new Error("Expected the city details menu.");
    menu.open = true;
    const sort = city.getByRole("button", { name: "Sort ascending" });
    const addStep = screen.getByRole("button", { name: "Add step" });
    webviewPostMessage.mockClear();

    act(() => {
      sort.click();
      addStep.click();
    });

    const pageRequest = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.kind === "runtimeRequest" && message.request?.kind === "getPage")?.request;
    expect(pageRequest?.viewRequestId).toEqual(expect.any(String));
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();

    dispatchAppMessage({
      kind: "page",
      revision: metadata.revision,
      viewRequestId: pageRequest.viewRequestId,
      metadata: { ...metadata, filterModel: pageRequest.filterModel },
      page,
      summaries: []
    });

    expect(await screen.findByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Choose an operation" })).toBeInTheDocument();
  });

  it("keeps the operation picker open when Cursor repeats the renderer snapshot after undo", async () => {
    const appliedStep: TransformStep = {
      id: "text-length-city",
      kind: "textLength",
      params: { column: { id: "c:0", name: "city" }, newColumn: "city_length" }
    };
    const appliedMetadata: SessionMetadata = { ...metadata, revision: 4, steps: [appliedStep] };
    const restoredMetadata: SessionMetadata = { ...metadata, revision: 5, steps: [] };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: appliedMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    webviewPostMessage.mockClear();
    dispatchAppMessage({ kind: "editorAction", action: "undoStep" });
    expect(webviewPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "runtimeRequest",
        request: expect.objectContaining({ kind: "undoStep" })
      })
    );

    dispatchAppMessage({
      kind: "planUpdated",
      action: "undo",
      revision: restoredMetadata.revision,
      metadata: restoredMetadata,
      page,
      code: ""
    });
    const addStep = screen.getByRole("button", { name: "Add step" });
    expect(addStep).toBeEnabled();
    fireEvent.click(addStep);

    expect(await screen.findByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Choose an operation" })).toBeInTheDocument();

    dispatchAppMessage({ kind: "sessionOpened", metadata: { ...restoredMetadata }, page, summaries: [] });

    expect(screen.getByRole("dialog", { name: "Add cleaning step" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Choose an operation" })).toBeInTheDocument();
  });

  it("drops a queued operation when its session revision is replaced", async () => {
    const limitedMetadata: SessionMetadata = {
      ...metadata,
      capabilities: { ...metadata.capabilities, supportedOperations: ["renameColumn"] }
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: limitedMetadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });

    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    if (!cityHeader) throw new Error("Expected the city header.");
    const city = within(cityHeader);
    const menu = city.getByLabelText("Column actions for city").closest("details");
    if (!(menu instanceof HTMLDetailsElement)) throw new Error("Expected the city details menu.");
    menu.open = true;
    webviewPostMessage.mockClear();
    fireEvent.click(city.getByRole("button", { name: "Sort ascending" }));
    const pageRequest = webviewPostMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.kind === "runtimeRequest" && message.request?.kind === "getPage")?.request;

    dispatchAppMessage({
      kind: "editorAction",
      action: "openOperation",
      operationKind: "renameColumn",
      expectedSessionId: limitedMetadata.sessionId,
      expectedRevision: limitedMetadata.revision
    });
    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: { ...limitedMetadata, revision: 1 },
      page,
      summaries: []
    });
    dispatchAppMessage({
      kind: "page",
      revision: 0,
      viewRequestId: pageRequest.viewRequestId,
      metadata: limitedMetadata,
      page,
      summaries: []
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull());
  });

  it("preserves an open operation form across duplicate hydration but resets it for a new revision", async () => {
    const limitedMetadata: SessionMetadata = {
      ...metadata,
      capabilities: { ...metadata.capabilities, supportedOperations: ["renameColumn"] }
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: limitedMetadata, page, summaries: [] });
    dispatchAppMessage({ kind: "editorAction", action: "openOperation", operationKind: "renameColumn" });

    const dialog = await screen.findByRole("dialog", { name: "Add cleaning step" });
    fireEvent.change(within(dialog).getByLabelText("Column"), { target: { value: "c:1" } });
    fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: "net_sales" } });

    dispatchAppMessage({ kind: "sessionOpened", metadata: { ...limitedMetadata }, page, summaries: [] });

    const hydratedDialog = screen.getByRole("dialog", { name: "Add cleaning step" });
    expect(within(hydratedDialog).getByLabelText("Column")).toHaveValue("c:1");
    expect(within(hydratedDialog).getByLabelText("New name")).toHaveValue("net_sales");

    dispatchAppMessage({
      kind: "sessionOpened",
      metadata: { ...limitedMetadata, revision: 1 },
      page,
      summaries: []
    });
    expect(screen.queryByRole("dialog", { name: "Add cleaning step" })).toBeNull();
  });

  it("restores an accepted mutation without ending the host-owned import transaction", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });
    const action = screen.getByRole("button", { name: "Import options" });

    dispatchAppMessage({ kind: "editorAction", action: "applyDraft" });
    dispatchAppMessage({ kind: "importOptionsState", busy: true });
    dispatchAppMessage({
      kind: "error",
      code: "no_draft",
      message: "There is no draft.",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("There is no draft.");
    expect(screen.getByRole("cell", { name: "Milan" })).toBeVisible();

    dispatchAppMessage({ kind: "cancelled", targetRequestId: "change-import-options" });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("aria-busy", "true");
    dispatchAppMessage({ kind: "importOptionsState", busy: false });
    expect(action).toBeEnabled();
    expect(action).not.toHaveAttribute("aria-busy");
  });

  it("does not attribute an import cancellation to an older cleaning mutation", async () => {
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata, page, summaries: [] });
    await screen.findByRole("cell", { name: "Milan" });
    const action = screen.getByRole("button", { name: "Import options" });

    dispatchAppMessage({ kind: "editorAction", action: "applyDraft" });
    dispatchAppMessage({ kind: "importOptionsState", busy: true });
    dispatchAppMessage({ kind: "cancelled", targetRequestId: "change-import-options" });
    dispatchAppMessage({ kind: "importOptionsState", busy: false });

    expect(action).toBeDisabled();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("The cleaning operation was cancelled.")).toBeNull();

    dispatchAppMessage({
      kind: "error",
      code: "no_draft",
      message: "There is no draft.",
      recoverable: true,
      sessionId: metadata.sessionId
    });

    expect(action).toBeEnabled();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("alert")).toHaveTextContent("There is no draft.");
  });

  it("disables the file action during a cleaning mutation and a column projection", async () => {
    const wideSchema = Array.from({ length: 40 }, (_, position) => ({
      id: `c:${position}`,
      name: `column-${position}`,
      position,
      rawType: "String",
      type: "string" as const,
      nullable: false
    }));
    const wideMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 1, columns: wideSchema.length },
      filteredShape: { rows: 1, columns: wideSchema.length },
      schema: wideSchema
    };
    const widePage: GridPage = {
      offset: 0,
      limit: 200,
      totalRows: 1,
      columnIds: wideSchema.slice(0, 16).map((column) => column.id),
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: wideSchema.slice(0, 16).map((column) => ({
            kind: "string" as const,
            raw: column.name,
            display: column.name,
            isNull: false,
            isNaN: false
          }))
        }
      ]
    };
    render(<App />);
    dispatchAppMessage({ kind: "sessionOpened", metadata: wideMetadata, page: widePage, summaries: [] });
    await screen.findByRole("cell", { name: "column-0" });
    const action = screen.getByRole("button", { name: "Import options" });

    dispatchAppMessage({ kind: "editorAction", action: "applyDraft" });
    expect(action).toBeDisabled();
    dispatchAppMessage({
      kind: "error",
      code: "no_draft",
      message: "There is no draft.",
      recoverable: true,
      sessionId: metadata.sessionId
    });
    expect(action).toBeEnabled();

    webviewPostMessage.mockClear();
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 180 });
    scroller.scrollLeft = 20 * 190;
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(
        webviewPostMessage.mock.calls.some(
          ([message]) =>
            message?.kind === "runtimeRequest" &&
            message.request?.kind === "getPage" &&
            message.request?.columnOffset === 16
        )
      ).toBe(true)
    );
    expect(action).toBeDisabled();

    dispatchAppMessage({ kind: "importOptionsState", busy: true });
    dispatchAppMessage({ kind: "cancelled", targetRequestId: "change-import-options" });
    dispatchAppMessage({ kind: "importOptionsState", busy: false });
    expect(action).toBeDisabled();
  });
});

function dispatchAppMessage(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin })));
}

function outboundImportOptionMessages(): unknown[] {
  return webviewPostMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.kind === "changeImportOptions");
}

function isMutationRequestKind(value: unknown): boolean {
  return value === "previewStep" || value === "applyDraft" || value === "discardDraft" || value === "undoStep";
}
