export const gridRowHeight = 29;

// Chromium clamps layout dimensions at roughly 33.5 million CSS pixels. Keep
// the complete virtual canvas comfortably below that ceiling so the final row
// remains addressable across Chromium versions and device scales.
export const maximumGridScrollCanvasHeight = 16_000_000;

export interface RowScrollModel {
  canvasHeight: number;
  compressed: boolean;
  maximumScrollTop: number;
  totalRows: number;
}

export function createRowScrollModel(totalRows: number, viewportHeight: number): RowScrollModel {
  const boundedRows = Math.max(0, Math.floor(totalRows));
  const logicalHeight = boundedRows * gridRowHeight;
  if (logicalHeight <= maximumGridScrollCanvasHeight) {
    return {
      canvasHeight: logicalHeight,
      compressed: false,
      maximumScrollTop: logicalHeight,
      totalRows: boundedRows
    };
  }

  const boundedViewportHeight = Math.max(gridRowHeight, Math.min(viewportHeight, maximumGridScrollCanvasHeight / 2));
  return {
    canvasHeight: maximumGridScrollCanvasHeight,
    compressed: true,
    maximumScrollTop: maximumGridScrollCanvasHeight - boundedViewportHeight,
    totalRows: boundedRows
  };
}

export function scrollTopForLogicalRow(model: RowScrollModel, row: number): number {
  const boundedRow = Math.max(0, Math.min(Math.floor(row), Math.max(0, model.totalRows - 1)));
  if (!model.compressed) return boundedRow * gridRowHeight;
  if (model.totalRows <= 1) return 0;
  return (boundedRow / (model.totalRows - 1)) * model.maximumScrollTop;
}

export function logicalRowForScrollTop(model: RowScrollModel, scrollTop: number): number {
  if (model.totalRows === 0) return 0;
  const boundedScrollTop = Math.max(0, Math.min(scrollTop, model.maximumScrollTop));
  if (!model.compressed) return quantizedLogicalRow(boundedScrollTop, model.totalRows);
  if (model.maximumScrollTop === 0) return 0;
  return Math.max(
    0,
    Math.min(Math.round((boundedScrollTop / model.maximumScrollTop) * (model.totalRows - 1)), model.totalRows - 1)
  );
}

export function renderedRowSegmentSpacers(
  model: RowScrollModel,
  scrollTop: number,
  firstVisibleRow: number,
  renderedStartRow: number,
  renderedRowCount: number
): { bottom: number; top: number } {
  const renderedHeight = renderedRowCount * gridRowHeight;
  const desiredTop = scrollTop + (renderedStartRow - firstVisibleRow) * gridRowHeight;
  const maximumTop = Math.max(0, model.canvasHeight - renderedHeight);
  const top = Math.max(0, Math.min(desiredTop, maximumTop));
  return {
    top,
    bottom: Math.max(0, model.canvasHeight - top - renderedHeight)
  };
}

function quantizedLogicalRow(scrollTop: number, totalRows: number): number {
  const unboundedRow = scrollTop / gridRowHeight;
  const nearestRow = Math.round(unboundedRow);
  const row = Math.abs(scrollTop - nearestRow * gridRowHeight) <= 1 ? nearestRow : Math.floor(unboundedRow);
  return Math.max(0, Math.min(row, Math.max(0, totalRows - 1)));
}
