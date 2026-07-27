import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnSummary, GridPage, SessionMetadata, TransformStep } from "../shared/protocol";
import { DataGrid } from "../webviews/grid/DataGrid";

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
            { min: 1, max: 2.5, count: 2 },
            { min: 2.5, max: 4, count: 2 }
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
    expect(screen.getByRole("img", { name: "boolean distribution: true 3, false 1." })).toHaveTextContent(
      "True 3False 1"
    );
    expect(screen.getByRole("img", { name: /categorical distribution: alpha: 3, beta: 1/u })).toHaveTextContent(
      "alpha3beta1"
    );
    expect(
      screen.getByRole("img", {
        name: "datetime distribution: minimum 2024-01-01, maximum 2024-04-01."
      })
    ).toHaveTextContent("Min 2024-01-01Max 2024-04-01");
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

  it("publishes the physical viewport when the browser clamps impossible restored offsets", () => {
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
      set: () => undefined
    });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set: () => undefined
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
    fireEvent.scroll(scroller);

    expect(onViewStateChange).toHaveBeenLastCalledWith({
      columnWidths: { "c:1": 280 },
      selectedColumnId: "c:1",
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    expect(props.onPage).not.toHaveBeenCalled();
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

  it("reports the complete visible summary ownership as insights and visibility change", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Show insights" }));
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1"]));

    fireEvent.click(screen.getByRole("button", { name: "Hide insights" }));
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith([]));
    fireEvent.click(screen.getByRole("button", { name: "Show insights" }));
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith(["c:0", "c:1"]));
    expect(onVisibleSummaryColumnsChange).toHaveBeenCalledTimes(3);
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

  it("resizes columns from the keyboard and labels an empty grid", () => {
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

    expect(screen.getByText("No rows")).toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
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

  it("acknowledges the exact rendered snapshot only after React commits it", () => {
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
        expect(webviewPostMessage.mock.calls.some(([message]) => message?.kind === "rendererSynchronized")).toBe(false);
      });

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

  it("flushes pending grid presentation before acknowledging renderer synchronization", () => {
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
      expect(synchronizationMessages[0]).toMatchObject({
        kind: "updateViewState",
        state: { columnWidths: { "c:0": 200 } }
      });
      expect(synchronizationMessages[1]).toEqual({
        kind: "rendererSynchronized",
        syncId: "F".repeat(32),
        sessionId: metadata.sessionId,
        revision: metadata.revision
      });
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
    webviewPostMessage.mockClear();
    dispatchAppMessage({ kind: "requestImportOptionsChange", actionId: "A".repeat(32) });

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
    expect(screen.getByRole("button", { name: "Import options" })).toBeDisabled();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
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
    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    const cityHeader = document.querySelector<HTMLElement>('th[data-column="city"]');
    expect(cityHeader).not.toBeNull();
    const cityControls = within(cityHeader!);
    fireEvent.click(cityControls.getByLabelText("Column actions for city"));

    expect(cityControls.getByRole("button", { name: "Filter…" })).toBeEnabled();
    expect(cityControls.getByRole("button", { name: "Sort ascending" })).toBeEnabled();
    expect(cityControls.getByRole("button", { name: "Resize city column" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Search values for city" })).toBeEnabled();

    dispatchAppMessage({ kind: "importOptionsState", busy: true });

    expect(screen.getByRole("button", { name: "Insights & filters" })).toBeDisabled();
    expect(cityControls.getByRole("button", { name: "Filter…" })).toBeDisabled();
    expect(cityControls.getByRole("button", { name: "Sort ascending" })).toBeDisabled();
    expect(cityControls.getByRole("button", { name: "Resize city column" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Search values for city" })).toBeDisabled();
    expect(cityControls.getByText("View controls are unavailable while import options are changing.")).toBeVisible();

    dispatchAppMessage({ kind: "importOptionsState", busy: false });

    expect(screen.getByRole("button", { name: "Insights & filters" })).toBeEnabled();
    expect(cityControls.getByRole("button", { name: "Filter…" })).toBeEnabled();
    expect(cityControls.getByRole("button", { name: "Resize city column" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeEnabled();
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
