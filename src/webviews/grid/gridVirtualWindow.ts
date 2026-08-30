import type { ColumnSchema, DataRow, LiveGridPage } from "../../shared/protocol";
import type { GridViewState } from "../../shared/viewState";
import { createRowScrollModel, gridRowHeight, renderedRowSegmentSpacers } from "./rowScrollModel";

const overscanRows = 8;
const overscanColumns = 2;

export interface VisibleColumnRange {
  readonly start: number;
  readonly end: number;
}

export interface GridVirtualViewport {
  readonly firstVisibleRow: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly width: number;
  readonly height: number;
}

interface GridVirtualWindowOptions {
  readonly logicalRowExtent: number;
  readonly page: LiveGridPage;
  readonly rowHeaderWidth: number;
  readonly viewport: GridVirtualViewport;
  readonly widths: readonly number[];
}

export interface GridVirtualWindow {
  readonly bottomSpacerHeight: number;
  readonly leftSpacerWidth: number;
  readonly localRowStart: number;
  readonly pageColumnPositionById: ReadonlyMap<string, number>;
  readonly renderedColumnCount: number;
  readonly rightSpacerWidth: number;
  readonly topSpacerHeight: number;
  readonly totalColumnWidth: number;
  readonly visibleColumnRange: VisibleColumnRange;
  readonly visibleRows: readonly DataRow[];
}

export function gridColumnWidths(
  schema: readonly ColumnSchema[],
  columnWidths: GridViewState["columnWidths"],
  defaultColumnWidth: number
): readonly number[] {
  return schema.map((column) => columnWidths.get(column.id) ?? defaultColumnWidth);
}

/** Builds the immutable row and column window rendered by one grid viewport. */
export function createGridVirtualWindow({
  logicalRowExtent,
  page,
  rowHeaderWidth,
  viewport,
  widths
}: GridVirtualWindowOptions): GridVirtualWindow {
  const totalColumnWidth = sum(widths);
  const visibleColumnRange = columnRange(widths, viewport.scrollLeft, viewport.width, rowHeaderWidth);
  const pageColumnPositionById = new Map(page.columnIds.map((columnId, position) => [columnId, position]));
  const leftSpacerWidth = sum(widths.slice(0, visibleColumnRange.start));
  const rightSpacerWidth = sum(widths.slice(visibleColumnRange.end));
  const renderedColumnCount =
    1 +
    (visibleColumnRange.end - visibleColumnRange.start) +
    Number(leftSpacerWidth > 0) +
    Number(rightSpacerWidth > 0);

  const globalFirstRow = viewport.firstVisibleRow;
  const physicallyAvailableOverscanRows = Math.floor(viewport.scrollTop / gridRowHeight);
  const localRowStart = Math.max(
    0,
    globalFirstRow - page.offset - Math.min(overscanRows, physicallyAvailableOverscanRows)
  );
  const visibleRowCount = Math.ceil(viewport.height / gridRowHeight) + overscanRows * 2;
  const localRowEnd = Math.min(page.rows.length, localRowStart + visibleRowCount);
  const pageIsVisible = pageIntersectsViewport(page.offset, page.rows.length, globalFirstRow, viewport.height);
  const visibleRows = pageIsVisible ? page.rows.slice(localRowStart, localRowEnd) : [];
  const rowSegmentSpacers = renderedRowSegmentSpacers(
    createRowScrollModel(logicalRowExtent, viewport.height),
    viewport.scrollTop,
    globalFirstRow,
    page.offset + localRowStart,
    visibleRows.length
  );

  return {
    bottomSpacerHeight: rowSegmentSpacers.bottom,
    leftSpacerWidth,
    localRowStart,
    pageColumnPositionById,
    renderedColumnCount,
    rightSpacerWidth,
    topSpacerHeight: rowSegmentSpacers.top,
    totalColumnWidth,
    visibleColumnRange,
    visibleRows
  };
}

export function requestedGridPageOffset(
  desiredOffset: number,
  currentOffset: number,
  pageSize: number,
  contiguousOnly: boolean
): number {
  if (!contiguousOnly) return desiredOffset;
  return Math.max(0, Math.max(currentOffset - pageSize, Math.min(desiredOffset, currentOffset + pageSize)));
}

export function terminalPageOverlapsViewport(
  pageOffset: number,
  pageRowCount: number,
  totalRows: number,
  firstVisibleRow: number,
  viewportHeight: number
): boolean {
  return (
    pageOffset + pageRowCount === totalRows &&
    firstVisibleRow < pageOffset &&
    pageIntersectsViewport(pageOffset, pageRowCount, firstVisibleRow, viewportHeight)
  );
}

function pageIntersectsViewport(
  pageOffset: number,
  pageRowCount: number,
  firstVisibleRow: number,
  viewportHeight: number
): boolean {
  const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / gridRowHeight));
  return (
    pageRowCount > 0 && pageOffset < firstVisibleRow + visibleRowCount && pageOffset + pageRowCount > firstVisibleRow
  );
}

function columnRange(
  widths: readonly number[],
  scrollLeft: number,
  viewportWidth: number,
  rowHeaderWidth: number
): VisibleColumnRange {
  let position = 0;
  let start = 0;
  while (start < widths.length && position + widths[start] < Math.max(0, scrollLeft - rowHeaderWidth)) {
    position += widths[start];
    start += 1;
  }
  let end = start;
  let visibleWidth = position;
  while (end < widths.length && visibleWidth < scrollLeft + viewportWidth) {
    visibleWidth += widths[end];
    end += 1;
  }
  return {
    start: Math.max(0, start - overscanColumns),
    end: Math.min(widths.length, end + overscanColumns)
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
