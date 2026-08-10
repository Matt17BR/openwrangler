import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ColumnSchema, ColumnSummary, SessionMetadata, ValueCount } from "../../shared/protocol";
import { formatSessionRowCount } from "../../shared/protocol";
import type { ColumnFilter, FilterModel } from "../../shared/filterModel";
import {
  countViewColumnNames,
  isActiveColumnFilter,
  removeViewColumnFilter,
  replaceViewColumnFilter,
  supportsTypedViewComparison,
  viewNumericBinFilter,
  viewValueSelectionFilter
} from "../../shared/filterModel";
import { formatNumericSummaryNumber, numericExtremumDisplay } from "../numericSummary";
import { ProfileValueToggle } from "../ProfileValueToggle";
import { NumericHistogram } from "../visualizations/NumericHistogram";
import {
  describeProfileValue,
  formatProfilePercent,
  formatProfileValue,
  profileDistributionDenominator,
  type ProfileValueMode
} from "../profileValueMode";

export type SummaryPanelView = "column" | "dataset" | "filters";

interface SummaryPanelProps {
  metadata: SessionMetadata | undefined;
  summaries: ColumnSummary[];
  schemaById: Map<string, ColumnSchema>;
  selectedColumnId?: string;
  activeView: SummaryPanelView;
  profileSupported?: boolean;
  filtersSupported?: boolean;
  viewFiltersSupported?: boolean;
  filtersDisabled?: boolean;
  filtersLabel?: string;
  filterModel?: FilterModel;
  profileValueMode?: ProfileValueMode;
  onSelectView(view: SummaryPanelView): void;
  onProfileValueModeChange?(mode: ProfileValueMode): void;
  onShowMoreValues?(column: string): void;
  onApplyFilterModel?(model: FilterModel): void;
}

const summaryViews: readonly SummaryPanelView[] = ["column", "dataset", "filters"];
const MAX_VISIBLE_EXACT_EXTREMUM_CHARACTERS = 96;

export function SummaryPanel({
  metadata,
  summaries,
  schemaById,
  selectedColumnId,
  activeView,
  profileSupported = true,
  filtersSupported = true,
  viewFiltersSupported = true,
  filtersDisabled = false,
  filtersLabel = "Filters",
  filterModel,
  profileValueMode = "count",
  onSelectView,
  onProfileValueModeChange,
  onShowMoreValues,
  onApplyFilterModel
}: SummaryPanelProps) {
  const resolvedColumnId =
    selectedColumnId && schemaById.has(selectedColumnId) ? selectedColumnId : metadata?.schema[0]?.id;
  const selectedSchema = resolvedColumnId ? schemaById.get(resolvedColumnId) : undefined;
  const selectedSummary = resolvedColumnId
    ? summaries.find((summary) => summary.columnId === resolvedColumnId)
    : undefined;
  const visibleViews = summaryViews.filter((view) => (view === "filters" ? filtersSupported : profileSupported));

  return (
    <section className="panel summaryPanel" data-active-view={activeView}>
      <div
        className="summaryViewTabs"
        role="tablist"
        aria-label={summaryViewTabsLabel(profileSupported, filtersSupported, filtersLabel)}
        style={{ gridTemplateColumns: `repeat(${Math.max(1, visibleViews.length)}, minmax(0, 1fr))` }}
      >
        {visibleViews.map((view) => (
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
            onKeyDown={(event) => moveTabSelection(event, view, visibleViews, onSelectView)}
          >
            {viewLabel(view, filtersLabel)}
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
          <SelectedColumnSummary
            metadata={metadata}
            schema={selectedSchema}
            summary={selectedSummary}
            filterModel={filterModel ?? metadata?.filterModel ?? { filters: [], sort: [] }}
            filtersSupported={viewFiltersSupported}
            filtersDisabled={filtersDisabled}
            profileValueMode={profileValueMode}
            onProfileValueModeChange={onProfileValueModeChange}
            onShowMoreValues={onShowMoreValues}
            onApplyFilterModel={onApplyFilterModel}
          />
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
  summary,
  filterModel,
  filtersSupported,
  filtersDisabled,
  profileValueMode,
  onProfileValueModeChange,
  onShowMoreValues,
  onApplyFilterModel
}: {
  metadata: SessionMetadata | undefined;
  schema: ColumnSchema | undefined;
  summary: ColumnSummary | undefined;
  filterModel: FilterModel;
  filtersSupported: boolean;
  filtersDisabled: boolean;
  profileValueMode: ProfileValueMode;
  onProfileValueModeChange?: (mode: ProfileValueMode) => void;
  onShowMoreValues?: (column: string) => void;
  onApplyFilterModel?: (model: FilterModel) => void;
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
  const duplicateNameCount = countViewColumnNames(metadata.schema).get(schema.name) ?? 0;
  const activeFilter = filterModel.filters.find(
    (filter) => filter.column === schema.name && isActiveColumnFilter(filter)
  );
  const canFilter =
    filtersSupported &&
    !filtersDisabled &&
    duplicateNameCount === 1 &&
    supportsTypedViewComparison(schema.type) &&
    onApplyFilterModel !== undefined;
  const applyProfileFilter = (filter: ColumnFilter) => {
    if (!canFilter || !onApplyFilterModel) return;
    onApplyFilterModel(replaceViewColumnFilter(filterModel, filter));
  };
  const clearProfileFilter = () => {
    if (!filtersSupported || filtersDisabled || !onApplyFilterModel) return;
    onApplyFilterModel(removeViewColumnFilter(filterModel, schema.name));
  };
  const distributionDenominator = summary ? profileDistributionDenominator(summary) : 0;
  const numericVisualization = summary?.visualization?.kind === "numeric" ? summary.visualization : undefined;
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

      {activeFilter && (
        <div className="profileFilterStatus" role="status" aria-live="polite">
          <span className="codicon codicon-filter" aria-hidden="true" />
          <span title={describeProfileFilter(activeFilter)}>{describeProfileFilter(activeFilter)}</span>
          <button
            type="button"
            className="profileFilterClear codicon codicon-close"
            aria-label={`Clear filter for ${displayName}`}
            title={`Clear filter for ${displayName}`}
            disabled={filtersDisabled || !filtersSupported || !onApplyFilterModel}
            onClick={clearProfileFilter}
          />
        </div>
      )}

      <DistributionValueToggle
        mode={profileValueMode}
        denominator={summary ? profileDistributionDenominator(summary) : undefined}
        sampled={summary?.visualization?.sampled === true}
        onChange={onProfileValueModeChange}
      />

      {!summary ? (
        <p className="summaryPlaceholder" role="status" aria-live="polite">
          Profiling selected column...
        </p>
      ) : (
        <>
          {summary.visualization?.sampled && (
            <div
              className="summarySampleNotice"
              title="The chart uses a sample. The statistics above it use all visible rows."
            >
              Distribution based on a sample
            </div>
          )}

          <dl className="summaryStatGrid">
            <dt>Rows</dt>
            <dd>{summary.totalCount.toLocaleString()}</dd>
            <dt>Null</dt>
            <ProfileCountValue
              label="Null"
              value={summary.nullCount}
              denominator={summary.totalCount}
              mode={profileValueMode}
            />
            {(summary.type !== "string" || summary.nanCount > 0) && (
              <>
                <dt>NaN</dt>
                <ProfileCountValue
                  label="NaN"
                  value={summary.nanCount}
                  denominator={summary.totalCount}
                  mode={profileValueMode}
                />
              </>
            )}
            <dt>Distinct</dt>
            {summary.distinctCount === undefined ? (
              <dd>n/a</dd>
            ) : (
              <ProfileCountValue
                label="Distinct"
                value={summary.distinctCount}
                denominator={summary.totalCount}
                mode={profileValueMode}
              />
            )}
            <TypeSpecificStats summary={summary} mode={profileValueMode} />
          </dl>

          {numericVisualization && (
            <section className="summaryDistributionChart" aria-labelledby={`summary-distribution-${summary.columnId}`}>
              <h3 id={`summary-distribution-${summary.columnId}`}>Distribution</h3>
              <NumericHistogram
                visualization={numericVisualization}
                valueMode={profileValueMode}
                percentDenominator={distributionDenominator}
                onSelectBin={
                  canFilter
                    ? (bin, index) =>
                        applyProfileFilter(
                          viewNumericBinFilter(schema, bin, index === numericVisualization.bins.length - 1)
                        )
                    : undefined
                }
              />
            </section>
          )}

          <TopValues
            summary={summary}
            mode={profileValueMode}
            denominator={distributionDenominator}
            onShowMoreValues={onShowMoreValues ? () => onShowMoreValues(schema.name) : undefined}
            onSelectValue={
              canFilter
                ? (item) => applyProfileFilter(viewValueSelectionFilter(schema, item.selectionValue ?? item.value))
                : undefined
            }
          />
        </>
      )}
    </>
  );
}

function TypeSpecificStats({ summary, mode }: { summary: ColumnSummary; mode: ProfileValueMode }) {
  const distributionDenominator = profileDistributionDenominator(summary);
  if (summary.text) {
    return (
      <>
        <dt>Empty</dt>
        <ProfileCountValue label="Empty" value={summary.text.emptyCount} denominator={summary.totalCount} mode={mode} />
        <dt>Min length</dt>
        <dd>{formatNumber(summary.text.minLength)}</dd>
        <dt>Max length</dt>
        <dd>{formatNumber(summary.text.maxLength)}</dd>
        <dt>Mean length</dt>
        <dd>{formatNumber(summary.text.meanLength)}</dd>
        {summary.visualization?.kind === "categorical" && summary.visualization.otherCount > 0 && (
          <>
            <dt>Other values</dt>
            <ProfileCountValue
              label="Other values"
              value={summary.visualization.otherCount}
              denominator={distributionDenominator}
              mode={mode}
            />
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
        <ProfileCountValue
          label="True"
          value={summary.visualization.trueCount}
          denominator={distributionDenominator}
          mode={mode}
        />
        <dt>False</dt>
        <ProfileCountValue
          label="False"
          value={summary.visualization.falseCount}
          denominator={distributionDenominator}
          mode={mode}
        />
      </>
    );
  }

  if (summary.visualization?.kind === "categorical" && summary.visualization.otherCount > 0) {
    return (
      <>
        <dt>Other values</dt>
        <ProfileCountValue
          label="Other values"
          value={summary.visualization.otherCount}
          denominator={distributionDenominator}
          mode={mode}
        />
      </>
    );
  }

  return null;
}

function ProfileCountValue({
  label,
  value,
  denominator,
  mode
}: {
  label: string;
  value: number;
  denominator: number;
  mode: ProfileValueMode;
}) {
  const description = describeProfileValue(label, value, denominator);
  return (
    <dd title={description} aria-label={description}>
      {formatProfileValue(value, denominator, mode)}
    </dd>
  );
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

function DistributionValueToggle({
  mode,
  denominator,
  sampled,
  onChange
}: {
  mode: ProfileValueMode;
  denominator: number | undefined;
  sampled: boolean;
  onChange?: (mode: ProfileValueMode) => void;
}) {
  const denominatorDescription =
    denominator === undefined
      ? "Distributions use non-missing visible rows."
      : sampled
        ? `Distributions use ${denominator.toLocaleString()} sampled non-missing ${denominator === 1 ? "row" : "rows"}.`
        : `Distributions use ${denominator.toLocaleString()} non-missing visible ${denominator === 1 ? "row" : "rows"}.`;
  return (
    <div className="distributionValueControls">
      <ProfileValueToggle
        mode={mode}
        onChange={onChange}
        ariaLabel="Distribution values"
        percentDescription={denominatorDescription}
      />
    </div>
  );
}

function TopValues({
  summary,
  mode,
  denominator,
  onShowMoreValues,
  onSelectValue
}: {
  summary: ColumnSummary;
  mode: ProfileValueMode;
  denominator: number;
  onShowMoreValues?: () => void;
  onSelectValue?: (item: ValueCount) => void;
}) {
  const categorical = summary.visualization?.kind === "categorical" ? summary.visualization : undefined;
  const values = categorical?.categories ?? (summary.type === "string" ? summary.topValues : []);
  const otherCount = categorical?.otherCount ?? 0;
  const valuesTruncated =
    (categorical !== undefined || summary.type === "string") &&
    (otherCount > 0 || (summary.distinctCount ?? values.length) > values.length);
  if (values.length === 0 && otherCount === 0 && !(valuesTruncated && onShowMoreValues)) return null;
  const maximum = Math.max(1, ...values.map((item) => item.count), otherCount);

  return (
    <section className="summaryTopValues" aria-labelledby={`summary-top-values-${summary.columnId}`}>
      <h3 id={`summary-top-values-${summary.columnId}`}>Top values</h3>
      <div className="topValues">
        {values.map((item, index) => (
          <TopValueRow
            key={topValueKey(item, index)}
            item={item}
            maximum={maximum}
            denominator={denominator}
            mode={mode}
            onSelect={onSelectValue ? () => onSelectValue(item) : undefined}
          />
        ))}
        {otherCount > 0 && (
          <TopValueRow
            item={{ value: "Other", count: otherCount }}
            maximum={maximum}
            denominator={denominator}
            mode={mode}
          />
        )}
      </div>
      {valuesTruncated && onShowMoreValues && (
        <button type="button" className="summaryMoreValues" onClick={onShowMoreValues}>
          More values…
        </button>
      )}
    </section>
  );
}

function TopValueRow({
  item,
  maximum,
  denominator,
  mode,
  onSelect
}: {
  item: ValueCount;
  maximum: number;
  denominator: number;
  mode: ProfileValueMode;
  onSelect?: () => void;
}) {
  const label = item.value.length === 0 ? "Empty string" : item.value;
  const count = `${item.count.toLocaleString()} ${item.count === 1 ? "row" : "rows"}`;
  const percent = formatProfilePercent(item.count, denominator);
  const displayedValue = mode === "count" ? item.count.toLocaleString() : percent;
  const contents = (
    <>
      <span title={label}>{label}</span>
      <meter min={0} max={maximum} value={item.count} aria-label={`${label}: ${count}, ${percent}`} />
      <small>{displayedValue}</small>
    </>
  );
  if (!onSelect) {
    return (
      <div className="barRow" title={`${count} · ${percent}`}>
        {contents}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="barRow profileDistributionRow"
      aria-label={`Filter to ${label}; ${count}, ${percent}`}
      title={`Filter to ${label} · ${count} · ${percent}`}
      onClick={onSelect}
    >
      {contents}
    </button>
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
  visibleViews: readonly SummaryPanelView[],
  onSelectView: (view: SummaryPanelView) => void
): void {
  const currentIndex = visibleViews.indexOf(currentView);
  if (currentIndex < 0 || visibleViews.length === 0) return;
  let nextIndex: number;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % visibleViews.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + visibleViews.length) % visibleViews.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = visibleViews.length - 1;
  else return;

  event.preventDefault();
  const nextView = visibleViews[nextIndex];
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

function describeProfileFilter(filter: ColumnFilter): string {
  if (filter.valueFilter?.selectedValues.length === 1 && filter.predicates.length === 0) {
    return `Filter: ${displayFilterValue(filter.valueFilter.selectedValues[0])}`;
  }
  if (filter.predicates.length === 2) {
    const lower = filter.predicates.find((predicate) => predicate.operator === "gte");
    const upper = filter.predicates.find((predicate) => predicate.operator === "lt" || predicate.operator === "lte");
    if (lower?.value !== undefined && upper?.value !== undefined) {
      return `Filter: ${displayFilterValue(lower.value)}–${displayFilterValue(upper.value)}`;
    }
  }
  return "Filter active";
}

function displayFilterValue(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "typedSelection" &&
    "cell" in value &&
    value.cell &&
    typeof value.cell === "object" &&
    "display" in value.cell &&
    typeof value.cell.display === "string"
  ) {
    return value.cell.display.length === 0 ? "Empty string" : value.cell.display;
  }
  if (typeof value === "string") return value.length === 0 ? "Empty string" : value;
  return String(value);
}

function viewLabel(view: SummaryPanelView, filtersLabel: string): string {
  if (view === "column") return "Column";
  if (view === "dataset") return "Dataset";
  return filtersLabel;
}

function summaryViewTabsLabel(profileSupported: boolean, filtersSupported: boolean, filtersLabel: string): string {
  if (!profileSupported) return `${filtersLabel} view`;
  if (!filtersSupported) return "Column profiles view";
  if (filtersLabel === "Sorts") return "Column profiles and sorts view";
  if (filtersLabel === "Filters / Sorts") return "Column profiles, filters, and sorts view";
  return "Column profiles and filters view";
}

const formatNumber = formatNumericSummaryNumber;
