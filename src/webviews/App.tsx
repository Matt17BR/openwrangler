import { useEffect, useMemo, useState } from "react";
import type {
  ColumnSummary,
  DataExplorerResponse,
  GridPage,
  SessionMetadata,
  ValuesResponse
} from "../shared/protocol";
import { emptyFilterModel, type FilterModel } from "../shared/filterModel";
import { FilterPanel } from "./filters/FilterPanel";
import { DataGrid } from "./grid/DataGrid";
import { SummaryPanel } from "./summary/SummaryPanel";
import { vscode } from "./vscodeApi";

const pageSize = 200;

export function App(): JSX.Element {
  const [metadata, setMetadata] = useState<SessionMetadata | undefined>();
  const [page, setPage] = useState<GridPage | undefined>();
  const [summaries, setSummaries] = useState<ColumnSummary[]>([]);
  const [filterModel, setFilterModel] = useState<FilterModel>(emptyFilterModel);
  const [columnValues, setColumnValues] = useState<Record<string, ValuesResponse>>({});
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

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
      }
      if (response.kind === "page") {
        setMetadata(response.metadata);
        setFilterModel(response.metadata.filterModel);
        setPage(response.page);
      }
      if (response.kind === "summary") {
        setSummaries(response.summaries);
      }
      if (response.kind === "columnValues") {
        setColumnValues((current) => ({ ...current, [response.column]: response }));
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
  const readOnlyReason =
    metadata?.source.kind === "notebookOutput"
      ? "This expanded notebook output is a static preview. Use Data Explorer: Open Notebook Variable for live filters and sorting."
      : undefined;

  const requestPage = (offset: number, model = filterModel) => {
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
  };

  const requestValues = (column: string, search?: string) => {
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
    requestPage(0, model);
    vscode.postMessage({
      kind: "runtimeRequest",
      request: {
        kind: "getSummary",
        filterModel: model
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
        <div>
          <h1>Data Explorer</h1>
          <p>{metadata?.source.label ?? "Loading dataframe..."}</p>
        </div>
        {metadata && (
          <div className="toolbarStats">
            <span>{metadata.backend}</span>
            <span>
              {metadata.filteredShape.rows.toLocaleString()} rows x {metadata.filteredShape.columns.toLocaleString()} cols
            </span>
          </div>
        )}
      </header>

      <section className="layout">
        <aside className="sidebar">
          <FilterPanel
            metadata={metadata}
            model={filterModel}
            values={columnValues}
            disabledReason={readOnlyReason}
            onApply={applyFilters}
            onRequestValues={requestValues}
          />
          <SummaryPanel summaries={summaries} schemaByName={schemaByName} />
        </aside>
        <section className="gridShell">
          {error && <div className="errorBanner">{error}</div>}
          {loading && <div className="loading">Loading...</div>}
          {metadata && page ? (
            <DataGrid metadata={metadata} page={page} onPage={requestPage} pageSize={pageSize} />
          ) : (
            <div className="emptyState">Opening session...</div>
          )}
        </section>
      </section>
    </main>
  );
}
