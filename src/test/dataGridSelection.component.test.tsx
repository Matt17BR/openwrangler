import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
import { DataGrid } from "../webviews/grid/DataGrid";
import { gridRowHeight } from "../webviews/grid/rowScrollModel";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "selection-session",
  revision: 3,
  backend: "pandas",
  mode: "editing",
  source: { kind: "file", label: "selection.csv", path: "selection.csv" },
  capabilities: {
    editable: true,
    lazy: false,
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
    { id: "c:0", name: "city", position: 0, rawType: "object", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "float64", type: "float", nullable: true }
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
      values: [cell("Milan"), numberCell(10.5)]
    },
    {
      id: "r:1",
      rowNumber: 1,
      values: [cell("Paris"), { kind: "null", raw: null, display: "", isNull: true, isNaN: false }]
    }
  ]
};

const secondPage: GridPage = {
  offset: 2,
  limit: 2,
  totalRows: 4,
  columnIds: ["c:0", "c:1"],
  rows: [
    {
      id: "r:2",
      rowNumber: 2,
      values: [cell("Rome"), numberCell(20.5)]
    },
    {
      id: "r:3",
      rowNumber: 3,
      values: [cell("Berlin"), numberCell(30.5)]
    }
  ]
};

let setPointerCaptureDescriptor: PropertyDescriptor | undefined;
let releasePointerCaptureDescriptor: PropertyDescriptor | undefined;
let setPointerCapture: ReturnType<typeof vi.fn>;
let releasePointerCapture: ReturnType<typeof vi.fn>;

describe("DataGrid rectangular selection", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setPointerCaptureDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "setPointerCapture");
    releasePointerCaptureDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "releasePointerCapture");
    setPointerCapture = vi.fn();
    releasePointerCapture = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: setPointerCapture
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: releasePointerCapture
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restorePrototypeProperty("setPointerCapture", setPointerCaptureDescriptor);
    restorePrototypeProperty("releasePointerCapture", releasePointerCaptureDescriptor);
  });

  it("selects a rectangular mouse drag without native text selection and restores focus to its endpoint", () => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });

    const pointerDownAllowed = fireEvent.pointerDown(city, pointerEvent(7));
    fireEvent.pointerMove(emptySales, pointerEvent(7));
    fireEvent.pointerUp(emptySales, pointerEvent(7, { buttons: 0 }));

    expect(pointerDownAllowed).toBe(false);
    expect(screen.getByText("2 rows by 2 columns selected")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    expect(document.activeElement).toBe(emptySales);
    expect(emptySales).toHaveAttribute("tabindex", "0");
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);

    const grid = screen.getByRole("grid", { name: "Data grid for selection.csv" });
    expect(grid).toHaveStyle({ userSelect: "none" });
    const instructionsId = grid.getAttribute("aria-describedby");
    expect(instructionsId).toBeTruthy();
    expect(document.getElementById(instructionsId ?? "")).toHaveTextContent(
      "Ctrl/Cmd+click starts a new selection; non-contiguous selections are not supported."
    );
  });

  it("exposes only the clipboard rectangle as an ARIA multiselection and announces its dimensions once", () => {
    renderGrid({
      viewState: {
        selectedColumnId: "c:1",
        columnWidths: {},
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });
    const city = screen.getByRole("cell", { name: "Milan" });
    const sales = screen.getByRole("cell", { name: "10.5" });
    const paris = screen.getByRole("cell", { name: "Paris" });
    const emptySales = screen.getByRole("cell", { name: "" });

    pointerDrag(city, sales, 9);

    expect(screen.getByRole("grid", { name: "Data grid for selection.csv" })).toHaveAttribute(
      "aria-multiselectable",
      "true"
    );
    expect(city).toHaveAttribute("aria-selected", "true");
    expect(sales).toHaveAttribute("aria-selected", "true");
    expect(paris).toHaveAttribute("aria-selected", "false");
    expect(emptySales).toHaveClass("selectedColumn");
    expect(emptySales).toHaveAttribute("aria-selected", "false");
    const status = screen.getByRole("status", { name: "Grid selection" });
    expect(status).toHaveTextContent("1 row by 2 columns selected");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(document.querySelectorAll('[role="status"][aria-label="Grid selection"]')).toHaveLength(1);
    expect(screen.queryByRole("status", { name: "Grid selection result" })).not.toBeInTheDocument();
  });

  it("keeps Shift+Arrow range extension and its roving focus behavior", async () => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    const sales = screen.getByRole("cell", { name: "10.5" });
    pointerDrag(city, city, 11);

    fireEvent.keyDown(city, { key: "ArrowRight", shiftKey: true });

    expect(screen.getByText("1 row by 2 columns selected")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(sales));
    expect(sales).toHaveAttribute("tabindex", "0");
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }]
  ])("makes %s+click start a new rectangle instead of implying a non-contiguous selection", (_label, modifier) => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    const paris = screen.getByRole("cell", { name: "Paris" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(city, emptySales, 13);
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);

    pointerDrag(paris, paris, 14, modifier);

    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(1);
    expect(paris).toHaveAttribute("data-clipboard-selected", "true");
    expect(screen.getByRole("status", { name: "Grid selection" })).toHaveTextContent("1 cell selected");
  });

  it("preserves the original anchor and final rectangle across a drag-triggered page transition", async () => {
    const onPage = vi.fn();
    const pagedMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 2 },
      filteredShape: { rows: 4, columns: 2 }
    };
    const firstPage = { ...page, totalRows: 4 };
    const view = renderGrid({ metadata: pagedMetadata, page: firstPage, onPage });
    const city = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    const scroller = screen.getByTestId("data-grid-scroller");
    defineDimension(scroller, "clientWidth", 400);
    defineDimension(scroller, "clientHeight", gridRowHeight);
    defineDimension(scroller, "scrollWidth", 400);
    defineDimension(scroller, "scrollHeight", gridRowHeight * 4);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });

    fireEvent.pointerDown(city, pointerEvent(15, { clientX: 200, clientY: 50 }));
    fireEvent.pointerMove(emptySales, pointerEvent(15, { clientX: 200, clientY: 99 }));
    fireEvent.scroll(scroller);
    fireEvent.pointerMove(emptySales, pointerEvent(15, { clientX: 200, clientY: 99 }));
    fireEvent.scroll(scroller);

    await waitFor(() => expect(onPage).toHaveBeenCalledWith(2));
    view.rerender(gridElement({ metadata: pagedMetadata, page: secondPage, onPage }));
    const endpoint = await screen.findByRole("cell", { name: "20.5" });
    fireEvent.pointerMove(endpoint, pointerEvent(15, { clientX: 200, clientY: 50 }));
    fireEvent.pointerUp(endpoint, pointerEvent(15, { buttons: 0, clientX: 200, clientY: 50 }));

    expect(screen.getByRole("status", { name: "Grid selection" })).toHaveTextContent("3 rows by 2 columns selected");
    expect(screen.getByRole("cell", { name: "Rome" })).toHaveAttribute("aria-selected", "true");
    expect(endpoint).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("cell", { name: "Berlin" })).toHaveAttribute("aria-selected", "false");
    expect(document.activeElement).toBe(endpoint);
    expect(endpoint).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Copy range" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy range" })).toHaveAttribute(
      "title",
      "Wait for every selected row to load before copying."
    );
  });

  it("does not collapse a dragged rectangle when the pointer is released before the next page arrives", async () => {
    const onPage = vi.fn();
    const pagedMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 2 },
      filteredShape: { rows: 4, columns: 2 }
    };
    const firstPage = { ...page, totalRows: 4 };
    const view = renderGrid({ metadata: pagedMetadata, page: firstPage, onPage });
    const city = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    const scroller = screen.getByTestId("data-grid-scroller");
    defineDimension(scroller, "clientWidth", 400);
    defineDimension(scroller, "clientHeight", gridRowHeight);
    defineDimension(scroller, "scrollWidth", 400);
    defineDimension(scroller, "scrollHeight", gridRowHeight * 4);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });

    fireEvent.pointerDown(city, pointerEvent(16, { clientX: 200, clientY: 50 }));
    fireEvent.pointerMove(emptySales, pointerEvent(16, { clientX: 200, clientY: 99 }));
    fireEvent.scroll(scroller);
    fireEvent.pointerMove(emptySales, pointerEvent(16, { clientX: 200, clientY: 99 }));
    fireEvent.scroll(scroller);
    await waitFor(() => expect(onPage).toHaveBeenCalledWith(2));

    fireEvent.pointerUp(emptySales, pointerEvent(16, { buttons: 0, clientX: 200, clientY: 99 }));
    expect(screen.getByRole("status", { name: "Grid selection" })).toHaveTextContent("3 rows by 2 columns selected");

    view.rerender(gridElement({ metadata: pagedMetadata, page: secondPage, onPage }));
    const restoredFocus = await screen.findByRole("cell", { name: "20.5" });
    await waitFor(() => expect(document.activeElement).toBe(restoredFocus));

    expect(screen.getByRole("status", { name: "Grid selection" })).toHaveTextContent("3 rows by 2 columns selected");
    expect(screen.getByRole("cell", { name: "Rome" })).toHaveAttribute("aria-selected", "true");
    expect(restoredFocus).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("cell", { name: "Berlin" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Copy cell" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy row" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy range" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy range" })).toHaveAttribute(
      "title",
      "Wait for every selected row to load before copying."
    );
  });

  it("bounds edge autoscroll to one row-height step per pointer event", () => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    const scroller = screen.getByTestId("data-grid-scroller");
    defineDimension(scroller, "clientWidth", 400);
    defineDimension(scroller, "clientHeight", 200);
    defineDimension(scroller, "scrollWidth", 800);
    defineDimension(scroller, "scrollHeight", 600);
    scroller.scrollLeft = 100;
    scroller.scrollTop = 100;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });

    fireEvent.pointerDown(city, pointerEvent(17));
    fireEvent.pointerMove(emptySales, pointerEvent(17, { clientX: 399, clientY: 199 }));

    expect(scroller.scrollLeft).toBeGreaterThan(100);
    expect(scroller.scrollLeft).toBeLessThanOrEqual(100 + gridRowHeight);
    expect(scroller.scrollTop).toBeGreaterThan(100);
    expect(scroller.scrollTop).toBeLessThanOrEqual(100 + gridRowHeight);
    fireEvent.pointerUp(emptySales, pointerEvent(17, { buttons: 0 }));
  });

  it("leaves touch pointer movement available for native scrolling", () => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });

    const pointerDownAllowed = fireEvent.pointerDown(city, pointerEvent(19, { pointerType: "touch" }));
    fireEvent.pointerMove(emptySales, pointerEvent(19, { pointerType: "touch" }));

    expect(pointerDownAllowed).toBe(true);
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(1);
    expect(setPointerCapture).not.toHaveBeenCalled();
  });
});

interface GridRenderOptions {
  metadata?: SessionMetadata;
  page?: GridPage;
  onPage?(offset: number): void;
  viewState?: GridViewState;
}

function gridElement(options: GridRenderOptions = {}) {
  return (
    <DataGrid
      metadata={options.metadata ?? metadata}
      page={options.page ?? page}
      summaries={[]}
      pageSize={2}
      defaultColumnWidth={190}
      insightsOnOpen={false}
      viewContextId="selection-view"
      viewState={options.viewState}
      onPage={options.onPage ?? (() => undefined)}
      onSortColumn={() => undefined}
      onOpenFilter={() => undefined}
      onVisibleSummaryColumnsChange={() => undefined}
    />
  );
}

function renderGrid(options: GridRenderOptions = {}) {
  return render(gridElement(options));
}

function pointerDrag(
  start: HTMLElement,
  end: HTMLElement,
  pointerId: number,
  modifier: { ctrlKey?: boolean; metaKey?: boolean } = {}
): void {
  fireEvent.pointerDown(start, pointerEvent(pointerId, modifier));
  fireEvent.pointerMove(end, pointerEvent(pointerId, modifier));
  fireEvent.pointerUp(end, pointerEvent(pointerId, { ...modifier, buttons: 0 }));
}

function pointerEvent(
  pointerId: number,
  overrides: Partial<{
    buttons: number;
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    pointerType: string;
  }> = {}
) {
  return { button: 0, buttons: 1, pointerId, pointerType: "mouse", ...overrides };
}

function defineDimension(target: HTMLElement, property: string, value: number): void {
  Object.defineProperty(target, property, { configurable: true, value });
}

function restorePrototypeProperty(property: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, property);
}

function cell(display: string) {
  return { kind: "string" as const, raw: display, display, isNull: false, isNaN: false };
}

function numberCell(raw: number) {
  return { kind: "number" as const, raw, display: String(raw), isNull: false, isNaN: false };
}
