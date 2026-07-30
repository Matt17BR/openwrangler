import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnSchema, GridPage, SessionMetadata } from "../shared/protocol";
import { ColumnSearch } from "../webviews/ColumnSearch";
import { DataGrid } from "../webviews/grid/DataGrid";

const columns: ColumnSchema[] = [
  { id: "c:text", name: "label", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:int", name: "amount", position: 1, rawType: "Int64", type: "integer", nullable: false },
  { id: "c:float", name: "amount", position: 2, rawType: "Float64", type: "float", nullable: true },
  { id: "c:decimal", name: "price", position: 3, rawType: "Decimal(12,2)", type: "decimal", nullable: false },
  { id: "c:bool", name: "active", position: 4, rawType: "Boolean", type: "boolean", nullable: false },
  { id: "c:date", name: "day", position: 5, rawType: "Date", type: "date", nullable: false },
  {
    id: "c:datetime",
    name: "created_at",
    position: 6,
    rawType: "Datetime",
    type: "datetime",
    nullable: false
  },
  { id: "c:time", name: "opening_time", position: 7, rawType: "Time", type: "datetime", nullable: false },
  { id: "c:duration", name: "elapsed", position: 8, rawType: "Duration", type: "duration", nullable: false },
  { id: "c:binary", name: "payload", position: 9, rawType: "Binary", type: "binary", nullable: false },
  { id: "c:list", name: "tags", position: 10, rawType: "List(String)", type: "list", nullable: false },
  { id: "c:struct", name: "address", position: 11, rawType: "Struct", type: "struct", nullable: false },
  { id: "c:category", name: "segment", position: 12, rawType: "Categorical", type: "string", nullable: false },
  { id: "c:unknown", name: "opaque", position: 13, rawType: "Extension", type: "unknown", nullable: true }
];

describe("ColumnSearch", () => {
  it("presents distinct accessible datatype icons and text labels", () => {
    render(<ColumnSearch columns={columns} onSelect={() => undefined} />);

    fireEvent.focus(screen.getByRole("combobox", { name: "Column" }));

    const expectedTypes = [
      "Text",
      "Integer",
      "Number",
      "Decimal",
      "Boolean",
      "Date",
      "Date and time",
      "Time",
      "Duration",
      "Binary",
      "List",
      "Struct",
      "Category",
      "Unknown"
    ];
    for (const label of expectedTypes) {
      expect(screen.getByRole("img", { name: `${label} column type` })).toHaveAttribute(
        "title",
        `${label} column type`
      );
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it("filters on semantic and native types", () => {
    render(<ColumnSearch columns={columns} onSelect={() => undefined} />);
    const input = screen.getByRole("combobox", { name: "Column" });

    fireEvent.change(input, { target: { value: "category" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "segment, Category column" })).toBeVisible();

    fireEvent.change(input, { target: { value: "Float64" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "amount, Number column, column 3" })).toBeVisible();
  });

  it("keeps the controlled listbox available when no column matches", () => {
    render(<ColumnSearch columns={columns} onSelect={() => undefined} />);
    const input = screen.getByRole("combobox", { name: "Column" });

    fireEvent.change(input, { target: { value: "not-a-real-column" } });

    const listbox = screen.getByRole("listbox", { name: "Matching columns" });
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(listbox).toBeEmptyDOMElement();
    expect(screen.getByRole("status")).toHaveTextContent("No matching columns");
  });

  it("disambiguates duplicate labels and selects their stable identities with the keyboard", () => {
    const onSelect = vi.fn();
    render(<ColumnSearch columns={columns} onSelect={onSelect} />);
    const input = screen.getByRole("combobox", { name: "Column" });

    fireEvent.change(input, { target: { value: "amount" } });
    const duplicateOptions = screen.getAllByRole("option");
    expect(duplicateOptions).toHaveLength(2);
    expect(within(duplicateOptions[0]).getByText("Column 2")).toBeVisible();
    expect(within(duplicateOptions[1]).getByText("Column 3")).toBeVisible();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", duplicateOptions[1].id);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("c:float");
    expect(input).toHaveValue("amount");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the keyboard-active option visible in a long result list", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });

    try {
      render(<ColumnSearch columns={columns} onSelect={() => undefined} />);
      const input = screen.getByRole("combobox", { name: "Column" });
      fireEvent.focus(input);
      scrollIntoView.mockClear();
      fireEvent.keyDown(input, { key: "End" });

      const options = screen.getAllByRole("option");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(input).toHaveAttribute("aria-activedescendant", options.at(-1)?.id);
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });
});

describe("DataGrid column search target", () => {
  it("navigates duplicate column names by stable column ID", async () => {
    const duplicateColumns = columns.slice(1, 3).map((column, position) => ({ ...column, position }));
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
      shape: { rows: 1, columns: 2 },
      filteredShape: { rows: 1, columns: 2 },
      filterModel: { filters: [], sort: [] },
      steps: [],
      schema: duplicateColumns
    };
    const page: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: duplicateColumns.map((column) => column.id),
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [
            { kind: "number", raw: 1, display: "1", isNull: false, isNaN: false },
            { kind: "number", raw: 2.5, display: "2.5", isNull: false, isNaN: false }
          ]
        }
      ]
    };
    const onViewStateChange = vi.fn();

    const renderGrid = (goToColumnRequestId?: number, defaultColumnWidth = 190) => (
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={1}
        defaultColumnWidth={defaultColumnWidth}
        insightsOnOpen={false}
        goToColumnId={goToColumnRequestId === undefined ? undefined : "c:float"}
        goToColumnRequestId={goToColumnRequestId}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
        onVisibleSummaryColumnsChange={() => undefined}
        onViewStateChange={onViewStateChange}
      />
    );
    const { rerender } = render(renderGrid());
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 760 },
      clientHeight: { configurable: true, value: 400 }
    });
    rerender(renderGrid(1));

    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedColumnId: "c:float"
        })
      )
    );

    onViewStateChange.mockClear();
    rerender(renderGrid(2));
    await waitFor(() =>
      expect(onViewStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedColumnId: "c:float"
        })
      )
    );

    onViewStateChange.mockClear();
    rerender(renderGrid(2, 210));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(onViewStateChange).not.toHaveBeenCalled();
  });

  it("renders and completely reveals a newly appended virtualized column", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      const schema = Array.from({ length: 16 }, (_, position): ColumnSchema => ({
        id: `c:${position}`,
        name: position === 15 ? "market_upper" : `column_${position}`,
        position,
        rawType: "String",
        type: "string",
        nullable: false
      }));
      const metadata: SessionMetadata = {
        protocolVersion: 2,
        sessionId: "session",
        revision: 1,
        backend: "polars",
        mode: "editing",
        source: { kind: "file", label: "orders.csv", path: "orders.csv" },
        capabilities: {
          editable: true,
          lazy: true,
          cancel: true,
          exportCsv: true,
          exportParquet: true,
          notebookInsert: false
        },
        shape: { rows: 1, columns: schema.length },
        filteredShape: { rows: 1, columns: schema.length },
        filterModel: { filters: [], sort: [] },
        steps: [],
        schema
      };
      const pageFor = (projectedColumns: ColumnSchema[]): GridPage => ({
        offset: 0,
        limit: 1,
        totalRows: 1,
        columnIds: projectedColumns.map((column) => column.id),
        rows: [
          {
            id: "r:0",
            rowNumber: 0,
            values: projectedColumns.map((column) => ({
              kind: "string",
              raw: column.name,
              display: column.name,
              isNull: false,
              isNaN: false
            }))
          }
        ]
      });
      const initialPage = pageFor(schema.slice(0, 8));
      const targetPage = pageFor(schema.slice(11));
      const onViewStateChange = vi.fn();
      const onGoToColumnHandled = vi.fn();
      const renderGrid = (
        goToColumnRequestId?: number,
        viewStateRestoreVersion = 0,
        scrollLeft = 0,
        page = initialPage,
        currentMetadata = metadata
      ) => (
        <DataGrid
          metadata={currentMetadata}
          page={page}
          summaries={[]}
          pageSize={1}
          defaultColumnWidth={190}
          insightsOnOpen={false}
          goToColumnId={goToColumnRequestId === undefined ? undefined : "c:15"}
          goToColumnRequestId={goToColumnRequestId}
          viewState={{
            columnWidths: {},
            viewport: { firstVisibleRow: 0, scrollLeft }
          }}
          viewStateRestoreVersion={viewStateRestoreVersion}
          onPage={() => undefined}
          onSortColumn={() => undefined}
          onOpenFilter={() => undefined}
          onGoToColumnHandled={onGoToColumnHandled}
          onVisibleSummaryColumnsChange={() => undefined}
          onViewStateChange={onViewStateChange}
        />
      );
      const { rerender } = render(renderGrid());
      const scroller = screen.getByTestId("data-grid-scroller");
      let layoutReady = false;
      let scrollLeft = 0;
      Object.defineProperties(scroller, {
        clientWidth: { configurable: true, value: 760 },
        clientHeight: { configurable: true, value: 400 },
        scrollWidth: {
          configurable: true,
          get: () => (layoutReady ? 3_098 : 1_084)
        },
        scrollLeft: {
          configurable: true,
          get: () => scrollLeft,
          set: (value: number) => {
            scrollLeft = Math.min(value, layoutReady ? 2_338 : 324);
          }
        }
      });
      expect(screen.queryByRole("columnheader", { name: /market_upper/u })).not.toBeInTheDocument();

      rerender(renderGrid(1));
      await waitFor(() => expect(frames).toHaveLength(1));
      expect(scroller.scrollLeft).toBe(324);
      expect(screen.queryByRole("columnheader", { name: /market_upper/u })).not.toBeInTheDocument();
      expect(onViewStateChange).not.toHaveBeenCalled();

      rerender(renderGrid(1, 0, 0, initialPage, { ...metadata, schema: [...schema] }));
      await waitFor(() => expect(frames).toHaveLength(2));
      const resumedReveal = frames.at(-1);
      frames.length = 0;
      layoutReady = true;
      act(() => resumedReveal?.(performance.now()));

      const target = await screen.findByRole("columnheader", { name: /market_upper/u });
      expect(target).toBeVisible();
      expect(scroller.scrollLeft).toBe(2_338);
      expect(onViewStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selectedColumnId: "c:15",
          viewport: expect.objectContaining({ scrollLeft: 2_338 })
        })
      );
      expect(onGoToColumnHandled).not.toHaveBeenCalled();

      rerender(renderGrid(1, 0, 0, targetPage));
      await waitFor(() => expect(onGoToColumnHandled).toHaveBeenLastCalledWith(1, "revealed"));

      const persistedOldScrollLeft = 162;
      rerender(renderGrid(1, 1, persistedOldScrollLeft, targetPage));
      await waitFor(() => expect(scroller.scrollLeft).toBeGreaterThan(persistedOldScrollLeft));
      expect(screen.getByRole("columnheader", { name: /market_upper/u })).toBeVisible();
      expect(onGoToColumnHandled.mock.calls.filter(([requestId]) => requestId === 1)).toHaveLength(2);

      rerender(renderGrid());
      rerender(renderGrid(2, 0, 0, targetPage));
      await waitFor(() =>
        expect(onViewStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ selectedColumnId: "c:15" }))
      );
      expect(onGoToColumnHandled).toHaveBeenLastCalledWith(2, "revealed");

      rerender(renderGrid());
      rerender(renderGrid(3));
      await screen.findByRole("columnheader", { name: /market_upper/u });
      fireEvent.wheel(scroller);
      expect(onGoToColumnHandled).toHaveBeenLastCalledWith(3, "interrupted");
      const handledCount = onGoToColumnHandled.mock.calls.length;
      rerender(renderGrid(3, 0, 0, targetPage));
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      expect(onGoToColumnHandled).toHaveBeenCalledTimes(handledCount);

      rerender(renderGrid());
      layoutReady = false;
      scrollLeft = 0;
      onViewStateChange.mockClear();
      rerender(renderGrid(4));
      await waitFor(() => expect(frames).toHaveLength(1));
      expect(scroller.scrollLeft).toBe(324);
      expect(onViewStateChange).not.toHaveBeenCalled();
      fireEvent.wheel(scroller);
      expect(onGoToColumnHandled).toHaveBeenLastCalledWith(4, "interrupted");
      layoutReady = true;
      act(() => frames.shift()?.(performance.now()));
      expect(scroller.scrollLeft).toBe(324);
      expect(onViewStateChange).not.toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
    }
  });
});
