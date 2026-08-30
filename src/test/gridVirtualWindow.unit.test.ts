import { describe, expect, it } from "vitest";
import type { ColumnSchema, GridPage } from "../shared/protocol";
import {
  createGridVirtualWindow,
  gridColumnWidths,
  requestedGridPageOffset,
  terminalPageOverlapsViewport
} from "../webviews/grid/gridVirtualWindow";

const heterogeneousWidths = [80, 120, 160, 200, 90, 130, 170, 110, 140, 180, 100, 150];
const wideSchema: ColumnSchema[] = heterogeneousWidths.map((_, position) => ({
  id: `c:${position}`,
  name: `column_${position}`,
  position,
  rawType: "String",
  type: "string",
  nullable: false
}));
const widePage = pageAt(
  0,
  4,
  wideSchema.map((column) => column.id),
  100
);
const columnWidths = new Map(wideSchema.map((column, position) => [column.id, heterogeneousWidths[position]]));
const wideColumnCases: Array<
  [
    position: string,
    scrollLeft: number,
    expectedRange: { start: number; end: number },
    expectedLeft: number,
    expectedRight: number,
    expectedRenderedCount: number
  ]
> = [
  ["start", 0, { start: 0, end: 5 }, 0, 980, 7],
  ["middle", 700, { start: 2, end: 10 }, 200, 250, 11],
  ["end", 1_350, { start: 7, end: 12 }, 950, 0, 7]
];

describe("grid virtual window", () => {
  it.each(wideColumnCases)(
    "bounds a heterogeneous wide-column window at the %s",
    (_position, scrollLeft, expectedRange, expectedLeft, expectedRight, expectedRenderedCount) => {
      const window = createGridVirtualWindow({
        logicalRowExtent: 100,
        page: widePage,
        rowHeaderWidth: 60,
        viewport: { firstVisibleRow: 0, scrollLeft, scrollTop: 0, width: 260, height: 58 },
        widths: gridColumnWidths(wideSchema, columnWidths, 190)
      });

      expect(gridColumnWidths(wideSchema, columnWidths, 190)).toEqual(heterogeneousWidths);
      expect(window.totalColumnWidth).toBe(1_630);
      expect(window.visibleColumnRange).toEqual(expectedRange);
      expect(window.leftSpacerWidth).toBe(expectedLeft);
      expect(window.rightSpacerWidth).toBe(expectedRight);
      expect(window.renderedColumnCount).toBe(expectedRenderedCount);
    }
  );

  it("maps reordered and partial projected values only through stable column IDs", () => {
    const schema = wideSchema.slice(0, 3);
    const page = pageAt(0, 1, ["c:2", "c:0"]);
    const window = createGridVirtualWindow({
      logicalRowExtent: 1,
      page,
      rowHeaderWidth: 58,
      viewport: { firstVisibleRow: 0, scrollLeft: 0, scrollTop: 0, width: 400, height: 58 },
      widths: gridColumnWidths(schema, new Map(), 100)
    });

    expect(window.pageColumnPositionById.get("c:2")).toBe(0);
    expect(window.pageColumnPositionById.get("c:0")).toBe(1);
    expect(window.pageColumnPositionById.has("c:1")).toBe(false);
  });

  it("renders no rows when the loaded page does not intersect the viewport", () => {
    const page = pageAt(100, 10, ["c:0"], 1_000);
    const window = createGridVirtualWindow({
      logicalRowExtent: 1_000,
      page,
      rowHeaderWidth: 58,
      viewport: { firstVisibleRow: 0, scrollLeft: 0, scrollTop: 0, width: 400, height: 58 },
      widths: [100]
    });

    expect(window.localRowStart).toBe(0);
    expect(window.visibleRows).toEqual([]);
    expect(window.topSpacerHeight).toBe(2_900);
    expect(window.bottomSpacerHeight).toBe(26_100);
  });

  it("retains a terminal partial page and suppresses a redundant earlier block request", () => {
    const page = pageAt(1_200, 5, ["c:0"]);
    const window = createGridVirtualWindow({
      logicalRowExtent: 1_205,
      page,
      rowHeaderWidth: 58,
      viewport: { firstVisibleRow: 1_200, scrollLeft: 0, scrollTop: 1_200 * 29, width: 400, height: 580 },
      widths: [100]
    });

    expect(window.visibleRows.map((row) => row.rowNumber)).toEqual([1_200, 1_201, 1_202, 1_203, 1_204]);
    expect(window.topSpacerHeight).toBe(1_200 * 29);
    expect(window.bottomSpacerHeight).toBe(0);
    expect(terminalPageOverlapsViewport(1_200, 5, 1_205, 1_190, 580)).toBe(true);
    expect(terminalPageOverlapsViewport(1_200, 5, 1_205, 1_179, 580)).toBe(false);
    expect(terminalPageOverlapsViewport(1_200, 5, 1_206, 1_190, 580)).toBe(false);
  });

  it("keeps exact PySpark page demand contiguous without constraining eager backends", () => {
    expect(requestedGridPageOffset(8_000, 400, 200, true)).toBe(600);
    expect(requestedGridPageOffset(0, 400, 200, true)).toBe(200);
    expect(requestedGridPageOffset(8_000, 400, 200, false)).toBe(8_000);
  });
});

function pageAt(offset: number, rowCount: number, columnIds: string[], totalRows = offset + rowCount): GridPage {
  return {
    offset,
    limit: 200,
    totalRows,
    columnIds,
    rows: Array.from({ length: rowCount }, (_, localRow) => ({
      id: `r:${offset + localRow}`,
      rowNumber: offset + localRow,
      values: columnIds.map((columnId) => ({
        kind: "string" as const,
        raw: `${columnId}:${offset + localRow}`,
        display: `${columnId}:${offset + localRow}`,
        isNull: false,
        isNaN: false
      }))
    }))
  };
}
