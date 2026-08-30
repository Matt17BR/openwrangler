import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnSchema, GridPage, SessionMetadata } from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
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

  it.each(["factor", "ordered factor"])("presents R %s columns as categories", (rawType) => {
    render(
      <ColumnSearch
        columns={[{ id: "r:c:0", name: "segment", position: 0, rawType, type: "string", nullable: true }]}
        onSelect={() => undefined}
      />
    );

    fireEvent.focus(screen.getByRole("combobox", { name: "Column" }));
    expect(screen.getByRole("option", { name: "segment, Category column" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Category column type" })).toHaveClass("codicon-symbol-enum");
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

  it("makes every column in a wide schema reachable without a 100-result cap", async () => {
    const wideColumns = Array.from({ length: 417 }, (_, position): ColumnSchema => ({
      id: `c:${position}`,
      name: `column_${position.toString().padStart(3, "0")}`,
      position,
      rawType: "String",
      type: "string",
      nullable: false
    }));
    const onSelect = vi.fn();
    render(<ColumnSearch columns={wideColumns} onSelect={onSelect} />);
    const input = screen.getByRole("combobox", { name: "Column" });

    fireEvent.focus(input);
    const listbox = screen.getByRole("listbox", { name: "Matching columns" });
    expect(listbox).toHaveStyle({ "--column-search-viewport-height": "352px" });
    Object.defineProperty(listbox, "clientHeight", { configurable: true, value: 352 });
    expect(screen.queryByText(/Showing 100 of/u)).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "column_000, Text column" })).toHaveAttribute("aria-setsize", "417");

    fireEvent.keyDown(input, { key: "End" });
    const finalOption = await screen.findByRole("option", { name: "column_416, Text column" });
    expect(input).toHaveAttribute("aria-activedescendant", finalOption.id);
    expect(finalOption).toHaveAttribute("aria-posinset", "417");
    await waitFor(() => expect(listbox.scrollTop).toBeGreaterThan(0));

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("c:416");

    fireEvent.change(input, { target: { value: "column_237" } });
    expect(screen.getByRole("option", { name: "column_237, Text column" })).toHaveAttribute("aria-setsize", "1");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("keeps a wide column list bounded in the DOM while scrolling through every result", () => {
    const wideColumns = Array.from({ length: 1_000 }, (_, position): ColumnSchema => ({
      id: `c:${position}`,
      name: `field_${position}`,
      position,
      rawType: "Int64",
      type: "integer",
      nullable: false
    }));
    render(<ColumnSearch columns={wideColumns} onSelect={() => undefined} />);
    const input = screen.getByRole("combobox", { name: "Column" });

    fireEvent.focus(input);
    const listbox = screen.getByRole("listbox", { name: "Matching columns" });
    expect(screen.getAllByRole("option").length).toBeLessThan(25);

    Object.defineProperty(listbox, "scrollTop", {
      configurable: true,
      writable: true,
      value: 31_640
    });
    fireEvent.scroll(listbox);

    expect(screen.getByRole("option", { name: "field_999, Integer column" })).toHaveAttribute("aria-posinset", "1000");
    expect(screen.getAllByRole("option").length).toBeLessThan(25);
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

  it("reveals a newly appended column across silent layout changes and bounded retries", async () => {
    let nextFrameId = 0;
    let frameTime = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
      frames.delete(frameId);
    });
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
    const advanceFrame = () => {
      const pending = [...frames.entries()];
      frames.clear();
      frameTime += 16;
      act(() => {
        for (const [, callback] of pending) callback(frameTime);
      });
    };
    const signalResize = () => {
      act(() => {
        for (const [observer, callback] of [...resizeObservers]) {
          callback([], observer as ResizeObserver);
        }
      });
    };
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
            columnWidths: new Map(),
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
      const { rerender, unmount } = render(renderGrid());
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
      await waitFor(() => expect(frames.size).toBe(1));
      expect(scroller.scrollLeft).toBe(324);
      advanceFrame();
      expect(screen.queryByRole("columnheader", { name: /market_upper/u })).not.toBeInTheDocument();
      expect(onViewStateChange).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);

      // Cursor can keep the dataframe webview on its previous layout while it
      // reveals Code Preview without delivering a ResizeObserver callback.
      // The bounded post-layout monitor must notice the silent geometry change.
      layoutReady = true;
      advanceFrame();
      expect(frames.size).toBe(0);
      expect(resizeObservers.size).toBe(0);

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
      layoutReady = false;
      scrollLeft = 0;
      onViewStateChange.mockClear();
      rerender(renderGrid(3));
      await waitFor(() => expect(frames.size).toBe(1));
      advanceFrame();
      expect(scroller.scrollLeft).toBe(324);
      expect(frames.size).toBe(1);
      fireEvent.wheel(scroller);
      expect(onGoToColumnHandled).toHaveBeenLastCalledWith(3, "interrupted");
      expect(resizeObservers.size).toBe(0);
      layoutReady = true;
      signalResize();
      fireEvent(window, new Event("resize"));
      expect(frames.size).toBe(0);
      expect(scroller.scrollLeft).toBe(324);

      rerender(renderGrid());
      layoutReady = false;
      scrollLeft = 0;
      onViewStateChange.mockClear();
      rerender(renderGrid(4));
      await waitFor(() => expect(frames.size).toBe(1));
      advanceFrame();
      expect(scroller.scrollLeft).toBe(324);
      expect(onViewStateChange).not.toHaveBeenCalled();
      expect(frames.size).toBe(1);
      const keyboardCell = scroller.querySelector<HTMLElement>('td[data-grid-row="0"][data-grid-column="3"]');
      expect(keyboardCell).not.toBeNull();
      fireEvent.keyDown(keyboardCell!, { key: "ArrowLeft" });
      expect(onGoToColumnHandled).toHaveBeenLastCalledWith(4, "interrupted");
      expect(resizeObservers.size).toBe(0);
      const keyboardScrollLeft = scroller.scrollLeft;
      expect(keyboardScrollLeft).toBeLessThan(324);

      layoutReady = true;
      signalResize();
      fireEvent(window, new Event("resize"));
      rerender(renderGrid(4, 0, 0, targetPage));
      for (let frame = 0; frame < 20; frame += 1) {
        advanceFrame();
      }
      expect(frames.size).toBe(0);
      expect(scroller.scrollLeft).toBe(keyboardScrollLeft);
      expect(onViewStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selectedColumnId: "c:2",
          viewport: expect.objectContaining({ scrollLeft: keyboardScrollLeft })
        })
      );
      expect(screen.queryByRole("columnheader", { name: /market_upper/u })).not.toBeInTheDocument();

      rerender(renderGrid());
      layoutReady = false;
      scrollLeft = 0;
      const navigablePage = { ...initialPage, totalRows: 2 };
      rerender(renderGrid(5, 0, 0, navigablePage));
      await waitFor(() => expect(frames.size).toBe(1));
      advanceFrame();
      expect(frames.size).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Next block" }));
      expect(onGoToColumnHandled).toHaveBeenLastCalledWith(5, "interrupted");
      expect(resizeObservers.size).toBe(0);
      layoutReady = true;
      signalResize();
      fireEvent(window, new Event("resize"));
      expect(frames.size).toBe(0);
      expect(scroller.scrollLeft).toBe(324);

      rerender(renderGrid());
      layoutReady = false;
      scrollLeft = 0;
      onViewStateChange.mockClear();
      rerender(renderGrid(6));
      await waitFor(() => expect(frames.size).toBe(1));
      let exhaustedFrameCount = 0;
      while (frames.size > 0 && exhaustedFrameCount < 500) {
        advanceFrame();
        exhaustedFrameCount += 1;
      }
      expect(exhaustedFrameCount).toBe(120);
      expect(frames.size).toBe(0);
      expect(scroller.scrollLeft).toBe(324);
      expect(onViewStateChange).not.toHaveBeenCalled();
      expect(onGoToColumnHandled.mock.calls.some(([requestId]) => requestId === 6)).toBe(false);
      expect(resizeObservers.size).toBe(1);

      // Exhausting animation frames leaves concrete wake sources available.
      layoutReady = true;
      signalResize();
      expect(frames.size).toBe(1);
      advanceFrame();
      expect(scroller.scrollLeft).toBe(2_338);
      expect(frames.size).toBe(0);
      rerender(renderGrid(6, 0, 0, targetPage));
      await waitFor(() => expect(onGoToColumnHandled).toHaveBeenLastCalledWith(6, "revealed"));

      rerender(renderGrid());
      layoutReady = false;
      scrollLeft = 0;
      rerender(renderGrid(7));
      await waitFor(() => expect(frames.size).toBe(1));
      fireEvent.pointerDown(scroller);
      expect(onGoToColumnHandled).toHaveBeenLastCalledWith(7, "interrupted");
      expect(frames.size).toBe(0);
      expect(resizeObservers.size).toBe(0);
      const pointerInterruptedScrollLeft = scroller.scrollLeft;
      layoutReady = true;
      signalResize();
      fireEvent(window, new Event("resize"));
      for (let frame = 0; frame < 20; frame += 1) advanceFrame();
      expect(frames.size).toBe(0);
      expect(scroller.scrollLeft).toBe(pointerInterruptedScrollLeft);

      rerender(renderGrid());
      layoutReady = false;
      scrollLeft = 0;
      rerender(renderGrid(8));
      await waitFor(() => expect(frames.size).toBe(1));
      expect(resizeObservers.size).toBe(1);
      unmount();
      expect(frames.size).toBe(0);
      expect(resizeObservers.size).toBe(0);
      layoutReady = true;
      signalResize();
      fireEvent(window, new Event("resize"));
      for (let frame = 0; frame < 20; frame += 1) advanceFrame();
      expect(frames.size).toBe(0);
      expect(onGoToColumnHandled.mock.calls.some(([requestId]) => requestId === 8)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      cancelFrame.mockRestore();
      requestFrame.mockRestore();
    }
  });

  it("reveals one newly added far-right column without republishing the same request", async () => {
    const schema = Array.from({ length: 24 }, (_, position): ColumnSchema => ({
      id: `c:${position}`,
      name: position === 23 ? "new_preview_column" : `column_${position}`,
      position,
      rawType: "String",
      type: "string",
      nullable: false
    }));
    const metadata: SessionMetadata = {
      protocolVersion: 2,
      sessionId: "preview-session",
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
    const page: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: schema.map((column) => column.id),
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: schema.map((column) => ({
            kind: "string",
            raw: column.name,
            display: column.name,
            isNull: false,
            isNaN: false
          }))
        }
      ]
    };
    const onViewStateChange = vi.fn();
    const onGoToColumnHandled = vi.fn();

    function PreviewGrid({ requestId }: { requestId?: number }) {
      const [viewState, setViewState] = useState<GridViewState>({
        columnWidths: new Map(),
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      });
      return (
        <DataGrid
          metadata={{ ...metadata, schema: [...schema] }}
          page={page}
          summaries={[]}
          pageSize={1}
          defaultColumnWidth={190}
          insightsOnOpen={false}
          goToColumnId={requestId === undefined ? undefined : "c:23"}
          goToColumnRequestId={requestId}
          viewState={viewState}
          onPage={() => undefined}
          onSortColumn={() => undefined}
          onOpenFilter={() => undefined}
          onGoToColumnHandled={onGoToColumnHandled}
          onVisibleSummaryColumnsChange={() => undefined}
          onViewStateChange={(next) => {
            onViewStateChange(next);
            setViewState({ ...next, columnWidths: new Map(next.columnWidths) });
          }}
        />
      );
    }

    const { rerender } = render(<PreviewGrid />);
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 760 },
      clientHeight: { configurable: true, value: 400 }
    });

    rerender(<PreviewGrid requestId={1} />);

    await waitFor(() => expect(onGoToColumnHandled).toHaveBeenLastCalledWith(1, "revealed"));
    expect(screen.getByRole("columnheader", { name: /new_preview_column/u })).toBeVisible();
    expect(onViewStateChange).toHaveBeenCalledTimes(1);
  });
});
