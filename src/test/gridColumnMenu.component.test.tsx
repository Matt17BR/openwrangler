import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellValue, ColumnSchema, GridPage, SessionMetadata } from "../shared/protocol";
import { DataGrid } from "../webviews/grid/DataGrid";

const schema: ColumnSchema[] = [
  { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:sales", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false }
];

const metadata: SessionMetadata = {
  protocolVersion: 4,
  sessionId: "session",
  revision: 1,
  backend: "polars",
  mode: "viewing",
  source: { kind: "file", label: "large.parquet", path: "large.parquet" },
  capabilities: {
    editable: false,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 11_674_495, columns: 2 },
  filteredShape: { rows: 11_674_495, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema
};

const cell = (display: string): CellValue => ({ kind: "string", raw: display, display, isNull: false, isNaN: false });

const pageAt = (offset: number): GridPage => ({
  offset,
  limit: 3,
  totalRows: 11_674_495,
  columnIds: schema.map((column) => column.id),
  rows: [0, 1, 2].map((index) => ({
    id: `r:${offset + index}`,
    rowNumber: offset + index,
    values: [cell(`city-${offset + index}`), cell(String(offset + index))]
  }))
});

const grid = (page: GridPage) => (
  <DataGrid
    metadata={metadata}
    page={page}
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

const bounds = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  }) as DOMRect;

const placeElement = (element: Element, place: () => DOMRect) =>
  Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: place });

function openableSalesMenu() {
  let anchor = bounds(300, 90, 30, 30);
  const scroller = screen.getByTestId("data-grid-scroller");
  const summary = screen.getByLabelText("Column actions for sales");
  const menu = summary.closest("details")!;
  const content = menu.querySelector<HTMLElement>(".columnMenuContent")!;
  placeElement(scroller, () => bounds(0, 40, 1000, 660));
  placeElement(summary, () => anchor);
  placeElement(content, () => bounds(0, 0, 170, 150));
  return {
    content,
    menu,
    scroller,
    summary,
    moveAnchor(left: number, top = 90) {
      anchor = bounds(left, top, 30, 30);
    }
  };
}

describe("column menu placement", () => {
  beforeEach(() => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 700 });
  });

  afterEach(() => {
    Reflect.deleteProperty(document.documentElement, "clientWidth");
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });

  it("keeps the open menu under its actions button after vertical and horizontal scrolling", () => {
    render(grid(pageAt(5_000_000)));
    const { content, menu, moveAnchor, scroller, summary } = openableSalesMenu();
    scroller.scrollTop = 4_000_000;
    fireEvent.scroll(scroller);

    fireEvent.click(summary);
    expect(menu.open).toBe(true);
    expect(content.style).toMatchObject({ left: "300px", top: "120px", visibility: "" });

    moveAnchor(120);
    scroller.scrollLeft = 180;
    fireEvent.scroll(scroller);
    expect(content.style).toMatchObject({ left: "120px", top: "120px", visibility: "" });

    moveAnchor(-40);
    fireEvent.scroll(scroller);
    expect(menu.open).toBe(true);
    expect(content.style.visibility).toBe("hidden");

    moveAnchor(120);
    fireEvent.scroll(scroller);
    expect(content.style.visibility).toBe("");

    fireEvent.click(summary);
    expect(menu.open).toBe(false);
    expect(content.style).toMatchObject({ left: "", top: "", visibility: "" });
    moveAnchor(500);
    fireEvent.scroll(scroller);
    expect(content.style.left).toBe("");
  });

  it("keeps tracking across page re-renders and stops when the header unmounts", () => {
    const { rerender, unmount } = render(grid(pageAt(0)));
    const { content, menu, moveAnchor, summary } = openableSalesMenu();
    fireEvent.click(summary);
    expect(content.style.left).toBe("300px");

    rerender(grid(pageAt(4_000_000)));
    expect(screen.getByLabelText("Column actions for sales")).toBe(summary);
    expect(menu.open).toBe(true);
    moveAnchor(260);
    fireEvent(window, new Event("resize"));
    expect(content.style.left).toBe("260px");

    unmount();
    expect(content.style.left).toBe("");
    moveAnchor(500);
    fireEvent(window, new Event("resize"));
    expect(content.style.left).toBe("");
  });

  it("writes insets in the menu's own zoomed coordinate space", () => {
    render(grid(pageAt(0)));
    const { content, summary } = openableSalesMenu();
    placeElement(content, () => bounds(0, 0, 340, 300));
    Object.defineProperty(content, "offsetWidth", { configurable: true, value: 170 });

    fireEvent.click(summary);
    expect(content.style).toMatchObject({ left: "150px", top: "60px" });
  });
});
