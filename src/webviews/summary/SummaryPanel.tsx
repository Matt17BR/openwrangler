import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ColumnSchema, ColumnSummary, SessionMetadata, ValueCount } from "../../shared/protocol";
import { formatSessionRowCount } from "../../shared/protocol";
import { formatNumericSummaryNumber, numericExtremumDisplay } from "../numericSummary";
import { NumericHistogram } from "../visualizations/NumericHistogram";

export type SummaryPanelView = "column" | "dataset" | "filters";

interface SummaryPanelProps {
  metadata: SessionMetadata | undefined;
  summaries: ColumnSummary[];
  schemaById: Map<string, ColumnSchema>;
  selectedColumnId?: string;
  activeView: SummaryPanelView;
  onSelectView(view: SummaryPanelView): void;
}

const summaryViews: readonly SummaryPanelView[] = ["column", "dataset", "filters"];
const MAX_VISIBLE_EXACT_EXTREMUM_CHARACTERS = 96;

export function SummaryPanel({
  metadata,
  summaries,
  schemaById,
  selectedColumnId,
  activeView,
  onSelectView
}: SummaryPanelProps) {
  const resolvedColumnId =
    selectedColumnId && schemaById.has(selectedColumnId) ? selectedColumnId : metadata?.schema[0]?.id;
  const selectedSchema = resolvedColumnId ? schemaById.get(resolvedColumnId) : undefined;
  const selectedSummary = resolvedColumnId
    ? summaries.find((summary) => summary.columnId === resolvedColumnId)
    : undefined;

  return (
    <section className="panel summaryPanel" data-active-view={activeView}>
      <div className="summaryViewTabs" role="tablist" aria-label="Column profiles view">
        {summaryViews.map((view) => (
          <button
            key={view}
            id={summaryTabId(view)}
            type="button"
            role="tab"
            className="summaryViewTab"
            aria-controls={summaryPanelId(view)}
            aria-selected={activeView === view}
            tabIndex={activeView === view ? 0 : -1}
            data-summary-view={view}
            onClick={() => onSelectView(view)}
            onKeyDown={(event) => moveTabSelection(event, view, onSelectView)}
          >
            {viewLabel(view)}
          </button>
        ))}
      </div>

      {activeView === "column" && (
        <div
          id={summaryPanelId("column")}
          className="summaryViewContent"
          role="tabpanel"
          aria-labelledby={summaryTabId("column")}
        >
          <SelectedColumnSummary metadata={metadata} schema={selectedSchema} summary={selectedSummary} />
        </div>
      )}

      {activeView === "dataset" && (
        <div
          id={summaryPanelId("dataset")}
          className="summaryViewContent"
          role="tabpanel"
          aria-labelledby={summaryTabId("dataset")}
        >
          <DatasetSummary metadata={metadata} />
        </div>
      )}
    </section>
  );
}

export function summaryTabId(view: SummaryPanelView): string {
  return `openwrangler-insights-tab-${view}`;
}

export function summaryPanelId(view: SummaryPanelView): string {
  return `openwrangler-insights-view-${view}`;
}

function SelectedColumnSummary({
  metadata,
  schema,
  summary
}: {
  metadata: SessionMetadata | undefined;
  schema: ColumnSchema | undefined;
  summary: ColumnSummary | undefined;
}) {
  if (!metadata) {
    return (
      <p className="summaryPlaceholder" role="status">
        Preparing column summary...
      </p>
    );
  }
  if (!schema) {
    return <p className="summaryPlaceholder">This dataset has no columns.</p>;
  }

  const displayName = schemaDisplayName(schema, metadata.schema);

  return (
    <>
      <header className="summaryColumnHeader">
        <div>
          <span className="summaryEyebrow">Selected column</span>
          <h2>{displayName}</h2>
        </div>
        <span className="summaryTypeBadge" title={schema.rawType}>
          {schema.rawType}
        </span>
      </header>

      {!summary ? (
        <p className="summaryPlaceholder" role="status" aria-live="polite">
          Profiling selected column...
        </p>
      ) : (
        <>
          <div className="summaryEvidence" aria-label="Profile provenance">
            <span>Exact statistics</span>
            {summary.visualization && (
              <span className={summary.visualization.sampled ? "sampled" : undefined}>
                {summary.visualization.sampled ? "Sampled distribution" : "Exact distribution"}
              </span>
            )}
          </div>

          <dl className="summaryStatGrid">
            <dt>Rows</dt>
            <dd>{summary.totalCount.toLocaleString()}</dd>
            <dt>Null</dt>
            <dd>{summary.nullCount.toLocaleString()}</dd>
            {(summary.type !== "string" || summary.nanCount > 0) && (
              <>
                <dt>NaN</dt>
                <dd>{summary.nanCount.toLocaleString()}</dd>
              </>
            )}
            <dt>Distinct</dt>
            <dd>{summary.distinctCount?.toLocaleString() ?? "n/a"}</dd>
            <TypeSpecificStats summary={summary} />
          </dl>

          {summary.visualization?.kind === "numeric" && (
            <section className="summaryDistributionChart" aria-labelledby={`summary-distribution-${summary.columnId}`}>
              <h3 id={`summary-distribution-${summary.columnId}`}>Distribution</h3>
              <NumericHistogram visualization={summary.visualization} />
            </section>
          )}

          <TopValues summary={summary} />
        </>
      )}
    </>
  );
}

function TypeSpecificStats({ summary }: { summary: ColumnSummary }) {
  if (summary.text) {
    return (
      <>
        <dt>Empty</dt>
        <dd>{summary.text.emptyCount.toLocaleString()}</dd>
        <dt>Min length</dt>
        <dd>{formatNumber(summary.text.minLength)}</dd>
        <dt>Max length</dt>
        <dd>{formatNumber(summary.text.maxLength)}</dd>
        <dt>Mean length</dt>
        <dd>{formatNumber(summary.text.meanLength)}</dd>
        {summary.visualization?.kind === "categorical" && summary.visualization.otherCount > 0 && (
          <>
            <dt>Other values</dt>
            <dd>{summary.visualization.otherCount.toLocaleString()}</dd>
          </>
        )}
      </>
    );
  }

  if (summary.numeric) {
    const minimum = numericExtremumDisplay(summary.numeric, "min");
    const maximum = numericExtremumDisplay(summary.numeric, "max");
    return (
      <>
        <dt>Min</dt>
        <NumericExtremumValue label="Minimum" value={minimum} />
        <dt>Max</dt>
        <NumericExtremumValue label="Maximum" value={maximum} />
        <dt>Mean</dt>
        <dd>{formatNumber(summary.numeric.mean)}</dd>
        <dt>Median</dt>
        <dd>{formatNumber(summary.numeric.median)}</dd>
        <dt>Std. deviation</dt>
        <dd>{formatNumber(summary.numeric.std)}</dd>
      </>
    );
  }

  if (summary.visualization?.kind === "datetime") {
    return (
      <>
        <dt>Min</dt>
        <dd>{summary.visualization.min ?? "n/a"}</dd>
        <dt>Max</dt>
        <dd>{summary.visualization.max ?? "n/a"}</dd>
      </>
    );
  }

  if (summary.visualization?.kind === "boolean") {
    return (
      <>
        <dt>True</dt>
        <dd>{summary.visualization.trueCount.toLocaleString()}</dd>
        <dt>False</dt>
        <dd>{summary.visualization.falseCount.toLocaleString()}</dd>
      </>
    );
  }

  if (summary.visualization?.kind === "categorical" && summary.visualization.otherCount > 0) {
    return (
      <>
        <dt>Other values</dt>
        <dd>{summary.visualization.otherCount.toLocaleString()}</dd>
      </>
    );
  }

  return null;
}

function NumericExtremumValue({
  label,
  value
}: {
  label: "Minimum" | "Maximum";
  value: ReturnType<typeof numericExtremumDisplay>;
}) {
  if (!value) return <dd>n/a</dd>;
  const visibleValue = value.exact ? boundedExactExtremumText(value.display) : value.display;
  return (
    <dd
      className={value.exact ? "exactNumericExtremum" : undefined}
      title={value.exact ? `${label}: ${value.display}` : undefined}
      aria-label={`${label} ${value.display}`}
    >
      {visibleValue}
    </dd>
  );
}

function boundedExactExtremumText(value: string): string {
  if (value.length <= MAX_VISIBLE_EXACT_EXTREMUM_CHARACTERS) return value;
  const leadingCharacters = Math.ceil((MAX_VISIBLE_EXACT_EXTREMUM_CHARACTERS - 1) / 2);
  const trailingCharacters = MAX_VISIBLE_EXACT_EXTREMUM_CHARACTERS - leadingCharacters - 1;
  return `${value.slice(0, leadingCharacters)}…${value.slice(-trailingCharacters)}`;
}

function TopValues({ summary }: { summary: ColumnSummary }) {
  const categorical = summary.visualization?.kind === "categorical" ? summary.visualization : undefined;
  const values = categorical?.categories ?? (summary.type === "string" ? summary.topValues : []);
  const otherCount = categorical?.otherCount ?? 0;
  if (values.length === 0 && otherCount === 0) return null;
  const maximum = Math.max(1, ...values.map((item) => item.count), otherCount);

  return (
    <section className="summaryTopValues" aria-labelledby={`summary-top-values-${summary.columnId}`}>
      <h3 id={`summary-top-values-${summary.columnId}`}>Top values</h3>
      <div className="topValues">
        {values.map((item, index) => (
          <TopValueRow key={topValueKey(item, index)} item={item} maximum={maximum} />
        ))}
        {otherCount > 0 && <TopValueRow item={{ value: "Other", count: otherCount }} maximum={maximum} />}
      </div>
    </section>
  );
}

function TopValueRow({ item, maximum }: { item: ValueCount; maximum: number }) {
  const label = item.value.length === 0 ? "Empty string" : item.value;
  return (
    <div className="barRow">
      <span title={label}>{label}</span>
      <meter min={0} max={maximum} value={item.count} aria-label={`${label}: ${item.count.toLocaleString()}`} />
      <small>{item.count.toLocaleString()}</small>
    </div>
  );
}

function DatasetSummary({ metadata }: { metadata: SessionMetadata | undefined }) {
  const stats = metadata?.stats;
  const missingByColumn = stats?.missingValuesByColumn.filter((item) => item.count > 0) ?? [];

  return (
    <>
      <header className="summaryDatasetHeader">
        <span className="summaryEyebrow">Current view</span>
        <h2>Dataset</h2>
      </header>
      <dl className="summaryStatGrid dataSummaryStats">
        <dt>Rows</dt>
        <dd>{metadata ? formatSessionRowCount(metadata.filteredShape.rows) : "Loading"}</dd>
        <dt>Columns</dt>
        <dd>{metadata?.filteredShape.columns.toLocaleString() ?? "Loading"}</dd>
        {metadata && metadata.shape.rows !== metadata.filteredShape.rows && (
          <>
            <dt>Rows before filters</dt>
            <dd>{formatSessionRowCount(metadata.shape.rows)}</dd>
          </>
        )}
      </dl>

      {!stats ? (
        <p className="summaryPlaceholder" role="status" aria-live="polite">
          Profiling exact dataset statistics...
        </p>
      ) : (
        <>
          <div className="summaryEvidence" aria-label="Profile provenance">
            <span>Exact statistics</span>
          </div>
          <dl className="summaryStatGrid">
            <dt>Missing cells</dt>
            <dd>{stats.missingCells.toLocaleString()}</dd>
            <dt>Rows with missing values</dt>
            <dd>{stats.missingRows.toLocaleString()}</dd>
            <dt>Duplicate rows</dt>
            <dd>{stats.duplicateRows.toLocaleString()}</dd>
          </dl>

          <details className="summaryGroup" open={missingByColumn.length > 0}>
            <summary>Missing values by column</summary>
            {missingByColumn.length === 0 ? (
              <p className="mutedText">No missing values.</p>
            ) : (
              <div className="missingList">
                {missingByColumn.map((item, index) => (
                  <div key={`${item.column}-${index}`} className="barRow">
                    <span title={item.column}>{item.column}</span>
                    <meter
                      min={0}
                      max={metadata?.filteredShape.rows ?? Math.max(1, ...missingByColumn.map((value) => value.count))}
                      value={item.count}
                      aria-label={`${item.column}: ${item.count.toLocaleString()} missing`}
                    />
                    <small>{item.count.toLocaleString()}</small>
                  </div>
                ))}
              </div>
            )}
          </details>
        </>
      )}
    </>
  );
}

function moveTabSelection(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  currentView: SummaryPanelView,
  onSelectView: (view: SummaryPanelView) => void
): void {
  const currentIndex = summaryViews.indexOf(currentView);
  let nextIndex: number;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % summaryViews.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + summaryViews.length) % summaryViews.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = summaryViews.length - 1;
  else return;

  event.preventDefault();
  const nextView = summaryViews[nextIndex];
  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-summary-view="${nextView}"]`)?.focus();
  onSelectView(nextView);
}

function schemaDisplayName(schema: ColumnSchema, allColumns: readonly ColumnSchema[]): string {
  const duplicateCount = allColumns.filter((column) => column.name === schema.name).length;
  return duplicateCount > 1 ? `${schema.name} (column ${schema.position + 1})` : schema.name;
}

function topValueKey(item: ValueCount, index: number): string {
  return `${item.value}-${item.count}-${index}`;
}

function viewLabel(view: SummaryPanelView): string {
  if (view === "column") return "Column";
  if (view === "dataset") return "Dataset";
  return "Filters";
}

const formatNumber = formatNumericSummaryNumber;
