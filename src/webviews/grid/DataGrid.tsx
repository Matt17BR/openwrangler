import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type {
  ColumnSchema,
  ColumnSummary,
  ColumnVisualization,
  GridPage,
  SessionMetadata
} from "../../shared/protocol";
import type { SortDirection } from "../../shared/filterModel";

interface DataGridProps {
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
  pageSize: number;
  defaultColumnWidth: number;
  insightsOnOpen: boolean;
  goToColumn?: string;
  onPage(offset: number): void;
  onSortColumn(column: string, direction: SortDirection): void;
  onOpenFilter(column: string): void;
  onRequestSummary(columns: string[]): void;
}

const rowHeight = 29;
const rowHeaderWidth = 58;
const overscanRows = 8;
const overscanColumns = 2;

export function DataGrid({
  metadata,
  page,
  summaries,
  pageSize,
  defaultColumnWidth,
  insightsOnOpen,
  goToColumn,
  onPage,
  onSortColumn,
  onOpenFilter,
  onRequestSummary
}: DataGridProps) {
  const summaryByColumn = useMemo(() => new Map(summaries.map((summary) => [summary.column, summary])), [summaries]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const requestedOffset = useRef(page.offset);
  const requestedSummaries = useRef(new Set<string>());
  const [showInsights, setShowInsights] = useState(insightsOnOpen);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [viewport, setViewport] = useState({ scrollLeft: 0, scrollTop: 0, width: 1200, height: 600 });
  const [focusedCell, setFocusedCell] = useState({ row: page.offset, column: 0 });

  useEffect(() => {
    requestedOffset.current = page.offset;
  }, [page.offset]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      const next = {
        scrollLeft: scroller.scrollLeft,
        scrollTop: scroller.scrollTop,
        width: scroller.clientWidth,
        height: scroller.clientHeight
      };
      setViewport(next);
      const row = Math.max(0, Math.floor(next.scrollTop / rowHeight));
      const offset = Math.floor(row / pageSize) * pageSize;
      if (offset !== requestedOffset.current && offset < page.totalRows) {
        requestedOffset.current = offset;
        onPage(offset);
      }
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [onPage, page.totalRows, pageSize]);

  const widths = useMemo(
    () => metadata.schema.map((column) => columnWidths[column.id] ?? defaultColumnWidth),
    [columnWidths, defaultColumnWidth, metadata.schema]
  );
  const visibleColumnRange = columnRange(widths, viewport.scrollLeft, viewport.width);
  const visibleColumns = metadata.schema.slice(visibleColumnRange.start, visibleColumnRange.end);
  const leftSpacerWidth = sum(widths.slice(0, visibleColumnRange.start));
  const rightSpacerWidth = sum(widths.slice(visibleColumnRange.end));
  const renderedColumnCount = 1 + visibleColumns.length + Number(leftSpacerWidth > 0) + Number(rightSpacerWidth > 0);

  const globalFirstRow = Math.max(0, Math.floor(viewport.scrollTop / rowHeight));
  const localStart = Math.max(0, globalFirstRow - page.offset - overscanRows);
  const visibleRowCount = Math.ceil(viewport.height / rowHeight) + overscanRows * 2;
  const localEnd = Math.min(page.rows.length, localStart + visibleRowCount);
  const visibleRows = page.rows.slice(localStart, localEnd);
  const topSpacerHeight = (page.offset + localStart) * rowHeight;
  const bottomSpacerHeight = Math.max(0, page.totalRows - (page.offset + localEnd)) * rowHeight;

  useEffect(() => {
    const missing = visibleColumns
      .filter((column) => !summaryByColumn.has(column.name) && !requestedSummaries.current.has(column.name))
      .map((column) => column.name);
    if (missing.length > 0) {
      for (const column of missing) requestedSummaries.current.add(column);
      onRequestSummary(missing);
    }
  }, [onRequestSummary, summaryByColumn, visibleColumns]);

  useEffect(() => {
    if (!goToColumn) return;
    const index = metadata.schema.findIndex((column) => column.name === goToColumn);
    if (index < 0) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollLeft = Math.max(0, sum(widths.slice(0, index)) - scroller.clientWidth / 3);
      setFocusedCell((current) => ({ ...current, column: index }));
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [goToColumn, metadata.schema, widths]);

  useEffect(() => {
    const selector = `[data-grid-row="${focusedCell.row}"][data-grid-column="${focusedCell.column}"]`;
    scrollerRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [focusedCell, page.offset, visibleColumnRange.start, localStart]);

  const goToPage = (offset: number) => {
    const bounded = Math.max(0, Math.min(offset, Math.max(0, page.totalRows - 1)));
    const block = Math.floor(bounded / pageSize) * pageSize;
    requestedOffset.current = block;
    if (scrollerRef.current) scrollerRef.current.scrollTop = bounded * rowHeight;
    onPage(block);
  };

  return (
    <div className="dataGrid">
      <div className="gridControls" aria-live="polite">
        <button type="button" disabled={page.offset === 0} onClick={() => goToPage(page.offset - pageSize)}>
          Previous block
        </button>
        <span>
          Loaded rows {page.offset + 1}–{Math.min(page.offset + page.rows.length, page.totalRows)} of{" "}
          {page.totalRows.toLocaleString()}
        </span>
        <button
          type="button"
          disabled={page.offset + pageSize >= page.totalRows}
          onClick={() => goToPage(page.offset + pageSize)}
        >
          Next block
        </button>
        <button type="button" className="secondaryButton" onClick={() => setShowInsights((current) => !current)}>
          {showInsights ? "Hide" : "Show"} insights
        </button>
      </div>

      <div className="tableScroller" ref={scrollerRef} data-testid="data-grid-scroller">
        <table
          role="grid"
          aria-label={`Data grid for ${metadata.source.label}`}
          aria-rowcount={page.totalRows + 1}
          aria-colcount={metadata.schema.length + 1}
        >
          <colgroup>
            <col style={{ width: rowHeaderWidth }} />
            {leftSpacerWidth > 0 && <col style={{ width: leftSpacerWidth }} />}
            {visibleColumns.map((column) => (
              <col key={column.id} style={{ width: widths[column.position] }} />
            ))}
            {rightSpacerWidth > 0 && <col style={{ width: rightSpacerWidth }} />}
          </colgroup>
          <thead>
            <tr>
              <th className="rowHeader" aria-label="Row number">
                #
              </th>
              {leftSpacerWidth > 0 && <th className="virtualSpacer" aria-hidden="true" />}
              {visibleColumns.map((column) => (
                <ColumnHeader
                  key={column.id}
                  column={column}
                  width={widths[column.position]}
                  showInsights={showInsights}
                  summary={summaryByColumn.get(column.name)}
                  onOpenFilter={onOpenFilter}
                  onSortColumn={onSortColumn}
                  onResize={(width) => setColumnWidths((current) => ({ ...current, [column.id]: width }))}
                />
              ))}
              {rightSpacerWidth > 0 && <th className="virtualSpacer" aria-hidden="true" />}
            </tr>
          </thead>
          <tbody>
            {topSpacerHeight > 0 && (
              <tr className="virtualRowSpacer" aria-hidden="true">
                <td colSpan={renderedColumnCount} style={{ height: topSpacerHeight }} />
              </tr>
            )}
            {visibleRows.map((row) => (
              <tr key={row.id} aria-rowindex={row.rowNumber + 2} style={{ height: rowHeight }}>
                <td className="rowHeader">{row.rowNumber + 1}</td>
                {leftSpacerWidth > 0 && <td className="virtualSpacer" aria-hidden="true" />}
                {visibleColumns.map((column) => {
                  const cell = row.values[column.position];
                  return (
                    <td
                      key={`${row.id}-${column.id}`}
                      data-grid-row={row.rowNumber}
                      data-grid-column={column.position}
                      aria-colindex={column.position + 2}
                      tabIndex={focusedCell.row === row.rowNumber && focusedCell.column === column.position ? 0 : -1}
                      className={cell?.isNull || cell?.isNaN ? "missingCell" : undefined}
                      title={cell?.display}
                      onFocus={() => setFocusedCell({ row: row.rowNumber, column: column.position })}
                      onKeyDown={(event) =>
                        navigateGrid(event, row.rowNumber, column.position, metadata.schema.length, page.totalRows)
                      }
                    >
                      {cell?.display}
                    </td>
                  );
                })}
                {rightSpacerWidth > 0 && <td className="virtualSpacer" aria-hidden="true" />}
              </tr>
            ))}
            {bottomSpacerHeight > 0 && (
              <tr className="virtualRowSpacer" aria-hidden="true">
                <td colSpan={renderedColumnCount} style={{ height: bottomSpacerHeight }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  function navigateGrid(
    event: ReactKeyboardEvent<HTMLTableCellElement>,
    row: number,
    column: number,
    columnCount: number,
    rowCount: number
  ): void {
    let nextRow = row;
    let nextColumn = column;
    if (event.key === "ArrowRight") nextColumn += 1;
    else if (event.key === "ArrowLeft") nextColumn -= 1;
    else if (event.key === "ArrowDown") nextRow += 1;
    else if (event.key === "ArrowUp") nextRow -= 1;
    else if (event.key === "Home") nextColumn = 0;
    else if (event.key === "End") nextColumn = columnCount - 1;
    else if (event.key === "PageDown") nextRow += Math.max(1, Math.floor(viewport.height / rowHeight));
    else if (event.key === "PageUp") nextRow -= Math.max(1, Math.floor(viewport.height / rowHeight));
    else return;
    event.preventDefault();
    nextRow = Math.max(0, Math.min(nextRow, rowCount - 1));
    nextColumn = Math.max(0, Math.min(nextColumn, columnCount - 1));
    setFocusedCell({ row: nextRow, column: nextColumn });
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTop = Math.max(0, nextRow * rowHeight - scroller.clientHeight / 2);
      scroller.scrollLeft = Math.max(0, sum(widths.slice(0, nextColumn)) - scroller.clientWidth / 3);
    }
    const block = Math.floor(nextRow / pageSize) * pageSize;
    if (block !== page.offset) goToPage(nextRow);
  }
}

function ColumnHeader({
  column,
  width,
  showInsights,
  summary,
  onOpenFilter,
  onSortColumn,
  onResize
}: {
  column: ColumnSchema;
  width: number;
  showInsights: boolean;
  summary: ColumnSummary | undefined;
  onOpenFilter(column: string): void;
  onSortColumn(column: string, direction: SortDirection): void;
  onResize(width: number): void;
}) {
  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const start = event.clientX;
    const move = (moveEvent: PointerEvent) => onResize(Math.max(80, Math.min(640, width + moveEvent.clientX - start)));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  return (
    <th data-column={column.name} title={`${column.rawType}${column.nullable ? " nullable" : ""}`}>
      <div className="columnHeader">
        <span className={`typeIcon codicon ${typeIcon(column.type)}`} aria-hidden="true" />
        <span className="columnTitle">{column.name}</span>
        <details className="columnMenu">
          <summary aria-label={`Column actions for ${column.name}`} className="codicon codicon-ellipsis" />
          <div className="columnMenuContent">
            <button type="button" onClick={() => onOpenFilter(column.name)}>
              Filter…
            </button>
            <button type="button" onClick={() => onSortColumn(column.name, "asc")}>
              Sort ascending
            </button>
            <button type="button" onClick={() => onSortColumn(column.name, "desc")}>
              Sort descending
            </button>
          </div>
        </details>
        <button
          type="button"
          className="columnResizeHandle"
          aria-label={`Resize ${column.name} column`}
          onPointerDown={beginResize}
        />
      </div>
      <small>{column.rawType}</small>
      {showInsights &&
        (summary ? (
          <div className="columnInsight">
            <span>Missing {formatPercent(summary.nullCount + summary.nanCount, summary.totalCount)}</span>
            <span>Distinct {formatPercent(summary.distinctCount ?? 0, summary.totalCount)}</span>
            {summary.sampled && <span className="sampledLabel">Sampled</span>}
            <MiniChart visualization={summary.visualization} />
          </div>
        ) : (
          <span className="columnInsight emptyInsight">Profiling…</span>
        ))}
    </th>
  );
}

function MiniChart({ visualization }: { visualization: ColumnVisualization | undefined }) {
  if (!visualization) return <span className="miniChart emptyInsight">No chart</span>;
  if (visualization.kind === "numeric") {
    const max = Math.max(1, ...visualization.bins.map((bin) => bin.count));
    const width = 96;
    const height = 28;
    const barWidth = visualization.bins.length ? width / visualization.bins.length : width;
    return (
      <svg className="miniChart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Numeric histogram">
        {visualization.bins.map((bin, index) => {
          const barHeight = Math.max(2, (bin.count / max) * height);
          return (
            <rect
              key={`${bin.min}-${bin.max}-${index}`}
              x={index * barWidth}
              y={height - barHeight}
              width={Math.max(1, barWidth - 1)}
              height={barHeight}
            />
          );
        })}
      </svg>
    );
  }
  if (visualization.kind === "boolean") {
    const total = Math.max(1, visualization.trueCount + visualization.falseCount);
    return (
      <span className="stackedMiniChart" title={`True ${visualization.trueCount}, False ${visualization.falseCount}`}>
        <i style={{ width: `${(visualization.trueCount / total) * 100}%` }} />
        <b style={{ width: `${(visualization.falseCount / total) * 100}%` }} />
      </span>
    );
  }
  if (visualization.kind === "categorical") {
    const max = Math.max(1, ...visualization.categories.map((category) => category.count), visualization.otherCount);
    return (
      <span className="categoryMiniChart">
        {visualization.categories.slice(0, 4).map((category) => (
          <i
            key={category.value}
            title={`${category.value}: ${category.count}`}
            style={{ width: `${(category.count / max) * 100}%` }}
          />
        ))}
      </span>
    );
  }
  return (
    <span className="datetimeMiniChart" title={`${visualization.min ?? "n/a"} – ${visualization.max ?? "n/a"}`}>
      {visualization.min ?? "n/a"} – {visualization.max ?? "n/a"}
    </span>
  );
}

function columnRange(widths: number[], scrollLeft: number, viewportWidth: number): { start: number; end: number } {
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

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function typeIcon(type: string): string {
  if (["integer", "float", "decimal"].includes(type)) return "codicon-symbol-numeric";
  if (type === "boolean") return "codicon-symbol-boolean";
  if (type === "datetime" || type === "date") return "codicon-calendar";
  if (type === "list" || type === "struct") return "codicon-json";
  return "codicon-symbol-string";
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) return "0%";
  const percentage = (value / total) * 100;
  return `${percentage < 1 && percentage > 0 ? "<1" : Math.round(percentage).toLocaleString()}%`;
}
