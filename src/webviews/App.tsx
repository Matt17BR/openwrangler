import { useEffect, useMemo, useState } from "react";
import type {
  CellValue,
  ColumnSummary,
  DataRow,
  DataExplorerResponse,
  GridPage,
  SessionMetadata,
  ValueCount,
  ValuesResponse
} from "../shared/protocol";
import { emptyFilterModel, type ColumnFilter, type FilterModel, type PredicateFilter } from "../shared/filterModel";
import { FilterPanel } from "./filters/FilterPanel";
import { DataGrid } from "./grid/DataGrid";
import { SummaryPanel } from "./summary/SummaryPanel";
import { vscode } from "./vscodeApi";

const webviewConfig = readWebviewConfig();
const pageSize = webviewConfig.fetchBlockSize;

export function App() {
  const [metadata, setMetadata] = useState<SessionMetadata | undefined>();
  const [page, setPage] = useState<GridPage | undefined>();
  const [summaries, setSummaries] = useState<ColumnSummary[]>([]);
  const [filterModel, setFilterModel] = useState<FilterModel>(emptyFilterModel);
  const [columnValues, setColumnValues] = useState<Record<string, ValuesResponse>>({});
  const [snapshotRows, setSnapshotRows] = useState<DataRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [goToColumn, setGoToColumn] = useState("");
  const [filterColumn, setFilterColumn] = useState("");
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  useEffect(() => {
    const listener = (event: MessageEvent<DataExplorerResponse>) => {
      const response = event.data;
      setLoading(false);
      if (response.kind === "error") {
        setError(response.message);
        return;
      }
      setError(undefined);
      if (response.kind === "sessionOpened") {
        setMetadata(response.metadata);
        setFilterModel(response.metadata.filterModel);
        setPage(response.page);
        setSummaries(response.summaries);
        setSnapshotRows(response.metadata.source.kind === "notebookOutput" ? response.page.rows : undefined);
        if (response.metadata.source.kind !== "notebookOutput") {
          vscode.postMessage({
            kind: "runtimeRequest",
            request: {
              kind: "getDatasetStats",
              filterModel: response.metadata.filterModel
            }
          });
        }
      }
      if (response.kind === "page") {
        setMetadata(response.metadata);
        setFilterModel(response.metadata.filterModel);
        setPage(response.page);
        setSnapshotRows(undefined);
      }
      if (response.kind === "summary") {
        setSummaries((current) => {
          const merged = new Map(current.map((summary) => [summary.column, summary]));
          for (const summary of response.summaries) merged.set(summary.column, summary);
          return [...merged.values()];
        });
      }
      if (response.kind === "columnValues") {
        setColumnValues((current) => ({ ...current, [response.column]: response }));
      }
      if (response.kind === "datasetStats") {
        setMetadata((current) =>
          current && current.revision === response.revision ? { ...current, stats: response.stats } : current
        );
      }
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ kind: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const schemaByName = useMemo(
    () => new Map(metadata?.schema.map((column) => [column.name, column]) ?? []),
    [metadata]
  );
  const snapshotMode = metadata?.source.kind === "notebookOutput" && snapshotRows !== undefined;

  const requestPage = (offset: number, model = filterModel) => {
    if (metadata && snapshotRows) {
      applySnapshotModel(metadata, snapshotRows, model, offset);
      return;
    }

    setLoading(true);
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "getPage",
        offset,
        limit: pageSize,
        filterModel: model
      }
    });
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "getDatasetStats",
        filterModel: model
      }
    });
  };

  const requestValues = (column: string, search?: string) => {
    if (metadata && snapshotRows) {
      const values = snapshotColumnValues(metadata, snapshotRows, filterModel, column, search);
      setColumnValues((current) => ({ ...current, [column]: values }));
      return;
    }

    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "getColumnValues",
        column,
        search,
        limit: 100,
        filterModel
      }
    });
  };

  const applyFilters = (model: FilterModel) => {
    setFilterModel(model);
    if (metadata && snapshotRows) {
      applySnapshotModel(metadata, snapshotRows, model, 0);
      return;
    }

    requestPage(0, model);
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "getSummary",
        filterModel: model
      }
    });
  };

  const requestSummaries = (columns: string[]) => {
    if (snapshotRows) return;
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "getSummary",
        filterModel,
        columns
      }
    });
  };

  if (error && !metadata) {
    return (
      <main className="app app-error">
        <h1>Data Explorer</h1>
        <p>{error}</p>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="toolbar">
        <div className="toolbarIdentity">
          <strong>{metadata?.source.label ?? "Loading dataframe..."}</strong>
          <span>
            {metadata
              ? `${metadata.filteredShape.rows.toLocaleString()} rows x ${metadata.filteredShape.columns.toLocaleString()} columns`
              : "Preparing session"}
          </span>
        </div>
        {metadata && (
          <div className="toolbarActions">
            <button
              type="button"
              className="toolbarButton"
              aria-expanded={sidePanelOpen}
              onClick={() => setSidePanelOpen((current) => !current)}
            >
              Insights & filters
            </button>
            <label className="goToColumn">
              <span>Column</span>
              <input
                list="data-explorer-columns"
                value={goToColumn}
                placeholder="Search columns"
                onChange={(event) => setGoToColumn(event.target.value)}
              />
              <datalist id="data-explorer-columns">
                {metadata.schema.map((column) => (
                  <option key={column.id} value={column.name} />
                ))}
              </datalist>
            </label>
            <span className="modeBadge">{metadata.mode}</span>
            <span className="backendBadge">{metadata.backend}</span>
            {snapshotMode && <span className="modeBadge">Snapshot</span>}
          </div>
        )}
      </header>

      <section className={`layout${sidePanelOpen ? " sidePanelOpen" : ""}`}>
        <section className="gridShell">
          {error && <div className="errorBanner">{error}</div>}
          {loading && <div className="loading">Loading...</div>}
          {metadata && page ? (
            <DataGrid
              metadata={metadata}
              page={page}
              summaries={summaries}
              onPage={requestPage}
              pageSize={pageSize}
              defaultColumnWidth={webviewConfig.defaultColumnWidth}
              insightsOnOpen={webviewConfig.insightsOnOpen}
              goToColumn={goToColumn}
              onSortColumn={(column, direction) =>
                applyFilters({
                  ...filterModel,
                  sort: [
                    ...filterModel.sort.filter((rule) => rule.column !== column),
                    { column, direction, nulls: "last" }
                  ]
                })
              }
              onOpenFilter={(column) => {
                setFilterColumn(column);
                setSidePanelOpen(true);
                requestValues(column);
              }}
              onRequestSummary={requestSummaries}
            />
          ) : (
            <div className="emptyState">Opening session...</div>
          )}
        </section>
        {sidePanelOpen && (
          <aside className="sidebar" aria-label="Insights and filters">
            <div className="drawerHeader">
              <strong>Insights & filters</strong>
              <button
                type="button"
                className="iconButton codicon codicon-close"
                aria-label="Close panel"
                onClick={() => setSidePanelOpen(false)}
              />
            </div>
            <SummaryPanel metadata={metadata} summaries={summaries} schemaByName={schemaByName} />
            <FilterPanel
              key={filterColumn}
              metadata={metadata}
              model={filterModel}
              values={columnValues}
              activeColumn={filterColumn}
              defaultAdvanced={webviewConfig.filterMode === "advanced"}
              onApply={applyFilters}
              onRequestValues={requestValues}
            />
          </aside>
        )}
      </section>
    </main>
  );

  function applySnapshotModel(metadata: SessionMetadata, rows: DataRow[], model: FilterModel, offset: number): void {
    const filteredRows = applySnapshotFilters(metadata, rows, model);
    const nextMetadata: SessionMetadata = {
      ...metadata,
      filteredShape: {
        rows: filteredRows.length,
        columns: metadata.shape.columns
      },
      filterModel: model
    };

    setMetadata(nextMetadata);
    setPage({
      offset,
      limit: pageSize,
      totalRows: filteredRows.length,
      rows: filteredRows.slice(offset, offset + pageSize)
    });
    setSummaries(snapshotSummaries(nextMetadata, filteredRows));
    setLoading(false);
    setError(undefined);
  }
}

function readWebviewConfig(): {
  fetchBlockSize: number;
  defaultColumnWidth: number;
  insightsOnOpen: boolean;
  filterMode: "basic" | "advanced";
} {
  const fetchBlockSize = Number(document.body.dataset.fetchBlockSize ?? 200);
  const defaultColumnWidth = Number(document.body.dataset.defaultColumnWidth ?? 190);
  return {
    fetchBlockSize: Number.isFinite(fetchBlockSize) ? Math.max(25, Math.min(2000, fetchBlockSize)) : 200,
    defaultColumnWidth: Number.isFinite(defaultColumnWidth) ? Math.max(80, Math.min(640, defaultColumnWidth)) : 190,
    insightsOnOpen: document.body.dataset.insightsOnOpen !== "false",
    filterMode: document.body.dataset.filterMode === "advanced" ? "advanced" : "basic"
  };
}

function applySnapshotFilters(metadata: SessionMetadata, rows: DataRow[], model: FilterModel): DataRow[] {
  const filtered = rows.filter((row) => {
    const matches = model.filters.map((filter) => snapshotFilterMatches(metadata, row, filter));
    return (model.logic ?? "and") === "or" ? matches.length === 0 || matches.some(Boolean) : matches.every(Boolean);
  });
  const [firstSort, ...remainingSorts] = model.sort;
  if (!firstSort) {
    return filtered;
  }

  return [...filtered].sort((left, right) => {
    for (const rule of [firstSort, ...remainingSorts]) {
      const index = metadata.schema.findIndex((column) => column.name === rule.column);
      const comparison = compareCells(left.values[index], right.values[index]);
      if (comparison !== 0) {
        return rule.direction === "asc" ? comparison : -comparison;
      }
    }
    return left.rowNumber - right.rowNumber;
  });
}

function snapshotFilterMatches(metadata: SessionMetadata, row: DataRow, filter: ColumnFilter): boolean {
  const index = metadata.schema.findIndex((column) => column.name === filter.column);
  if (index < 0) {
    return true;
  }
  const cell = row.values[index];
  const valueText = cell.display.toLowerCase();
  const conditions: boolean[] = [];
  const valueFilter = filter.valueFilter;
  if (valueFilter && (valueFilter.selectedValues.length > 0 || valueFilter.includeNulls || valueFilter.includeNaN)) {
    const selected = new Set(valueFilter.selectedValues.map(String));
    const selectedMatch = selected.has(cell.display);
    const nullMatch = valueFilter.includeNulls && cell.isNull;
    const nanMatch = valueFilter.includeNaN && cell.isNaN;
    conditions.push(selectedMatch || nullMatch || nanMatch);
  }

  conditions.push(...filter.predicates.map((predicate) => predicateMatches(cell, valueText, predicate)));
  return (filter.logic ?? "and") === "or"
    ? conditions.length === 0 || conditions.some(Boolean)
    : conditions.every(Boolean);
}

function predicateMatches(cell: CellValue, valueText: string, predicate: PredicateFilter): boolean {
  const value = String(predicate.value ?? "").toLowerCase();
  const raw = typeof cell.raw === "number" ? cell.raw : Number(cell.display);
  const predicateNumber = Number(predicate.value);
  const secondNumber = Number(predicate.secondValue);
  switch (predicate.operator) {
    case "equals":
      return valueText === value;
    case "notEquals":
      return valueText !== value;
    case "contains":
      return valueText.includes(value);
    case "startsWith":
      return valueText.startsWith(value);
    case "endsWith":
      return valueText.endsWith(value);
    case "gt":
      return raw > predicateNumber;
    case "gte":
      return raw >= predicateNumber;
    case "lt":
      return raw < predicateNumber;
    case "lte":
      return raw <= predicateNumber;
    case "between":
      return raw >= predicateNumber && raw <= secondNumber;
    case "isNull":
      return cell.isNull;
    case "isNotNull":
      return !cell.isNull;
    case "isNaN":
      return cell.isNaN;
    case "isNotNaN":
      return !cell.isNaN;
    default:
      return true;
  }
}

function compareCells(left: CellValue | undefined, right: CellValue | undefined): number {
  if (!left || !right) {
    return 0;
  }
  if (left.isNull && right.isNull) {
    return 0;
  }
  if (left.isNull) {
    return 1;
  }
  if (right.isNull) {
    return -1;
  }
  if (typeof left.raw === "number" && typeof right.raw === "number") {
    return left.raw - right.raw;
  }
  return left.display.localeCompare(right.display);
}

function snapshotColumnValues(
  metadata: SessionMetadata,
  rows: DataRow[],
  model: FilterModel,
  column: string,
  search?: string
): ValuesResponse {
  const index = metadata.schema.findIndex((schema) => schema.name === column);
  const searchText = search?.toLowerCase() ?? "";
  const counts = new Map<string, number>();
  for (const row of applySnapshotFilters(metadata, rows, model)) {
    const cell = row.values[index];
    if (!cell || cell.isNull || cell.isNaN) {
      continue;
    }
    if (searchText && !cell.display.toLowerCase().includes(searchText)) {
      continue;
    }
    counts.set(cell.display, (counts.get(cell.display) ?? 0) + 1);
  }

  return {
    kind: "columnValues",
    revision: metadata.revision,
    column,
    values: [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 100)
      .map(([value, count]) => ({ value, count })),
    hasMore: counts.size > 100
  };
}

function snapshotSummaries(metadata: SessionMetadata, rows: DataRow[]): ColumnSummary[] {
  return metadata.schema.map((schema, index) => {
    const cells = rows.map((row) => row.values[index]).filter(Boolean);
    const values = cells.filter((cell) => !cell.isNull && !cell.isNaN);
    const counts = new Map<string, number>();
    for (const cell of values) {
      counts.set(cell.display, (counts.get(cell.display) ?? 0) + 1);
    }
    const numericValues = values
      .map((cell) => (typeof cell.raw === "number" ? cell.raw : Number(cell.display)))
      .filter((value) => Number.isFinite(value));
    const topValues: ValueCount[] = [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));

    return {
      column: schema.name,
      type: schema.type,
      rawType: schema.rawType,
      totalCount: rows.length,
      nullCount: cells.filter((cell) => cell.isNull).length,
      nanCount: cells.filter((cell) => cell.isNaN).length,
      distinctCount: counts.size,
      topValues,
      numeric:
        numericValues.length > 0
          ? {
              min: Math.min(...numericValues),
              max: Math.max(...numericValues),
              mean: numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length,
              median: median(numericValues)
            }
          : undefined
    };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
