import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnSummary, GridPage, SessionMetadata, TransformStep } from "../shared/protocol";
import { DataGrid } from "../webviews/grid/DataGrid";
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
    const bins = within(numericHeader).getAllByRole("graphics-symbol");
    expect(bins).toHaveLength(2);
    expect(bins[0]).toHaveAccessibleName("1-2.5: 2 rows");
    expect(bins[1]).toHaveAccessibleName("2.5-4: 2 rows");
    expect(bins[1]).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("img", { name: "boolean distribution: true 3, false 1." })).toHaveTextContent(
      "True 3False 1"
    );
    const categoricalChart = screen.getByRole("img", {
      name: /categorical distribution: alpha: 3, beta: 1/u
    });
    expect(categoricalChart).toHaveTextContent("alpha3beta1");
    expect(within(categoricalChart).getByText("alpha")).toHaveAttribute("title", "alpha");
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

  it("keeps expensive PySpark insights explicit even when insights-on-open is configured", async () => {
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

    const showInsights = screen.getByRole("button", { name: "Show insights" });
    expect(showInsights).toHaveAttribute("title", "Runs Spark profiling queries for the visible columns.");
    await waitFor(() => expect(onVisibleSummaryColumnsChange).toHaveBeenLastCalledWith([]));

    fireEvent.click(showInsights);
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

    expect(screen.getByText("No rows")).toBeInTheDocument();
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

describe("App file import options", () => {
  beforeAll(async () => {
    document.body.dataset.canChangeImportOptions = "true";
    ({ App } = await import("../webviews/App"));
  });

  beforeEach(() => {
    webviewPostMessage.mockClear();
  });

  it("labels PySpark sessions as experimental and viewing-only", async () => {
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

    expect(await screen.findByText("Experimental")).toHaveAttribute("title", "PySpark support is experimental.");
    expect(screen.getByText("Viewing only")).toBeVisible();
    expect(screen.getByText("PySpark")).toBeVisible();
    expect(screen.queryByText(/^viewing$/iu)).not.toBeInTheDocument();
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

    expect(await screen.findByRole("complementary", { name: "Insights and filters" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Filters" })).toHaveAttribute("aria-selected", "true");
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
    fireEvent.click(screen.getByRole("button", { name: "Insights & filters" }));
    fireEvent.click(screen.getByRole("tab", { name: "Filters" }));
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
