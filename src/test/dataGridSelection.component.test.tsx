import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
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
    expect(screen.getByRole("status", { name: "Grid selection result" })).toHaveTextContent(
      "Ctrl/Cmd+click started a new selection."
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

function renderGrid() {
  return render(
    <DataGrid
      metadata={metadata}
      page={page}
      summaries={[]}
      pageSize={2}
      defaultColumnWidth={190}
      insightsOnOpen={false}
      viewContextId="selection-view"
      onPage={() => undefined}
      onSortColumn={() => undefined}
      onOpenFilter={() => undefined}
      onVisibleSummaryColumnsChange={() => undefined}
    />
  );
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
