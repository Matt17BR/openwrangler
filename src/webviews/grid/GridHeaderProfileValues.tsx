import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type {
  ColumnFilter,
  ColumnSchema,
  ColumnSummary,
  ColumnVisualization,
  SessionMetadata
} from "../../shared/protocol";
import { viewNumericBinFilter, viewValueSelectionFilter } from "../../shared/filterModel";
import { ProfileValueToggle } from "../ProfileValueToggle";
import { numericExtremumDisplay } from "../numericSummary";
import {
  describeProfileValue,
  formatProfileValue,
  profileDistributionDenominator,
  type ProfileValueMode
} from "../profileValueMode";
import { NumericHistogram } from "../visualizations/NumericHistogram";
import { gridRowHeight } from "./rowScrollModel";

const headerProfileFitTolerance = 1;
const compactHeaderProfilesDescription =
  "Header profile distributions are temporarily hidden until the grid has enough room.";
const restoredHeaderProfilesDescription = "Header profile distributions are visible again.";

interface GridHeaderProfilesOptions {
  backend: SessionMetadata["backend"];
  sessionId: string;
  scrollerRef: RefObject<HTMLDivElement | null>;
  visibleColumns: ColumnSchema[];
  summaries: ColumnSummary[];
  visibleSummaryOwner: string;
  insightsOnOpen: boolean;
  disabled: boolean;
  disabledReason: string;
  valueMode: ProfileValueMode;
  onValueModeChange?(mode: ProfileValueMode): void;
  onApplyFilter?(column: ColumnSchema, filter: ColumnFilter): void;
  onVisibleSummaryColumnsChange(columnIds: string[]): void;
}

export function useGridHeaderProfiles({
  backend,
  sessionId,
  scrollerRef,
  visibleColumns,
  summaries,
  visibleSummaryOwner,
  insightsOnOpen,
  disabled,
  disabledReason,
  valueMode,
  onValueModeChange,
  onApplyFilter,
  onVisibleSummaryColumnsChange
}: GridHeaderProfilesOptions) {
  const headerRef = useRef<HTMLTableSectionElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const fitDescriptionId = useId();
  const startsWithProfilesOff = backend === "pyspark" || backend === "r";
  const [showProfiles, setShowProfiles] = useState(startsWithProfilesOff || disabled ? false : insightsOnOpen);
  const [fitState, setFitState] = useState({ compact: false, sessionId });
  const [fitAnnouncement, setFitAnnouncement] = useState({ message: "", sessionId });
  const compact = showProfiles && !disabled && fitState.sessionId === sessionId && fitState.compact;
  const fitStatusText =
    !showProfiles || disabled
      ? ""
      : compact
        ? compactHeaderProfilesDescription
        : fitAnnouncement.sessionId === sessionId
          ? fitAnnouncement.message
          : "";
  const summaryByColumnId = useMemo(
    () => new Map(summaries.map((summary) => [summary.columnId, summary])),
    [summaries]
  );

  useEffect(() => {
    onVisibleSummaryColumnsChange(showProfiles && !disabled ? visibleColumns.map((column) => column.id) : []);
  }, [disabled, onVisibleSummaryColumnsChange, showProfiles, visibleColumns, visibleSummaryOwner]);

  useEffect(
    () => () => {
      onVisibleSummaryColumnsChange([]);
    },
    [onVisibleSummaryColumnsChange]
  );

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const header = headerRef.current;
    if (!showProfiles || disabled) return;
    if (!scroller || !header) return;

    const updateProfileFit = (): void => {
      const scrollerHeight = scroller.clientHeight;
      if (scrollerHeight <= 0) return;
      const hasDistributions = header.querySelector(".summaryDistribution") !== null;
      if (!hasDistributions) {
        if (fitState.sessionId === sessionId && fitState.compact) {
          setFitState({ compact: false, sessionId });
        }
        if (fitAnnouncement.sessionId === sessionId && fitAnnouncement.message !== "") {
          setFitAnnouncement({ message: "", sessionId });
        }
        return;
      }

      // offsetHeight and clientHeight share the element's layout-pixel
      // coordinate system. getBoundingClientRect() is scaled by CSS zoom,
      // which would make a 200%-zoom editor compact profiles too early.
      const expandedHeight = expandedProfileHeaderHeight(header);
      if (expandedHeight <= 0) return;
      const currentCompact = fitState.sessionId === sessionId && fitState.compact;
      const nextCompact = currentCompact
        ? scrollerHeight < expandedHeight + gridRowHeight + headerProfileFitTolerance
        : scrollerHeight - expandedHeight < gridRowHeight;
      if (nextCompact === currentCompact) return;

      if (nextCompact) {
        const activeElement = document.activeElement;
        if (
          activeElement instanceof Element &&
          [...header.querySelectorAll(".summaryDistribution")].some((distribution) =>
            distribution.contains(activeElement)
          )
        ) {
          toggleRef.current?.focus({ preventScroll: true });
        }
      }
      setFitAnnouncement({
        message: nextCompact ? compactHeaderProfilesDescription : restoredHeaderProfilesDescription,
        sessionId
      });
      setFitState({ compact: nextCompact, sessionId });
    };

    updateProfileFit();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => updateProfileFit());
    resizeObserver?.observe(scroller);
    resizeObserver?.observe(header);
    window.addEventListener("resize", updateProfileFit);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateProfileFit);
    };
  }, [
    disabled,
    fitAnnouncement.message,
    fitAnnouncement.sessionId,
    fitState.compact,
    fitState.sessionId,
    scrollerRef,
    sessionId,
    showProfiles,
    summaries,
    valueMode,
    visibleColumns
  ]);

  const renderColumnProfile = (column: ColumnSchema, filterAvailable: boolean): ReactNode => {
    if (!showProfiles) return null;
    const summary = summaryByColumnId.get(column.id);
    if (!summary) return <span className="columnInsight emptyInsight">Profiling…</span>;
    const applyFilter =
      filterAvailable && onApplyFilter ? (filter: ColumnFilter): void => onApplyFilter(column, filter) : undefined;
    return (
      <div className={`columnInsight${compact ? " compact" : ""}`}>
        <div className="exactSummaryStats">
          <HeaderProfileValue
            label="Missing"
            value={summary.nullCount + summary.nanCount}
            denominator={summary.totalCount}
            mode={valueMode}
          />
          <HeaderProfileValue
            label="Distinct"
            value={summary.distinctCount}
            denominator={summary.totalCount}
            mode={valueMode}
          />
          {summary.numeric && <CompactExtremum label="Min" summary={summary.numeric} bound="min" />}
          {summary.numeric && <CompactExtremum label="Max" summary={summary.numeric} bound="max" />}
        </div>
        <div className="summaryDistribution">
          {summary.visualization?.sampled && <span className="sampledLabel">Distribution sampled</span>}
          <MiniChart
            visualization={summary.visualization}
            column={column}
            valueMode={valueMode}
            denominator={profileDistributionDenominator(summary)}
            onApplyFilter={applyFilter}
          />
        </div>
      </div>
    );
  };

  const controls = (
    <div className="gridProfileControls">
      {!disabled && onValueModeChange && (
        <ProfileValueToggle
          mode={valueMode}
          onChange={onValueModeChange}
          ariaLabel="Header profile values"
          countAriaLabel="Show header profile counts"
          percentAriaLabel="Show header profile percentages"
          compact
        />
      )}
      <button
        ref={toggleRef}
        type="button"
        className="headerProfilesButton"
        aria-pressed={showProfiles}
        aria-describedby={compact ? fitDescriptionId : undefined}
        disabled={disabled}
        title={
          disabled
            ? disabledReason
            : compact
              ? compactHeaderProfilesDescription
              : backend === "pyspark"
                ? "Runs Spark profiling queries for the visible columns."
                : backend === "r"
                  ? "Runs R profiling queries for the visible columns."
                  : undefined
        }
        onClick={() => {
          if (disabled) return;
          if (showProfiles) {
            setFitState({ compact: false, sessionId });
            setFitAnnouncement({ message: "", sessionId });
          }
          setShowProfiles(!showProfiles);
        }}
      >
        {disabled ? "Profiles unavailable" : "Header profiles"}
      </button>
      <span
        id={fitDescriptionId}
        className="headerProfilesFitStatus"
        role="status"
        aria-label="Header profile layout"
        aria-live="polite"
        aria-atomic="true"
      >
        {fitStatusText}
      </span>
    </div>
  );

  return { controls, headerRef, renderColumnProfile };
}

function expandedProfileHeaderHeight(header: HTMLTableSectionElement): number {
  const compactInsights = [...header.querySelectorAll<HTMLElement>(".columnInsight.compact")];
  if (compactInsights.length === 0) return header.offsetHeight;
  for (const insight of compactInsights) insight.classList.remove("compact");
  try {
    return header.offsetHeight;
  } finally {
    for (const insight of compactInsights) insight.classList.add("compact");
  }
}

function HeaderProfileValue({
  label,
  value,
  denominator,
  mode
}: {
  label: string;
  value: number | undefined;
  denominator: number;
  mode: ProfileValueMode;
}) {
  if (value === undefined) {
    return (
      <span title={`${label} is unavailable`} aria-label={`${label} is unavailable`}>
        {label} n/a
      </span>
    );
  }
  const description = describeProfileValue(label, value, denominator);
  return (
    <span title={description} aria-label={description}>
      {label} {formatProfileValue(value, denominator, mode)}
    </span>
  );
}

function CompactExtremum({
  label,
  summary,
  bound
}: {
  label: "Min" | "Max";
  summary: NonNullable<ColumnSummary["numeric"]>;
  bound: "min" | "max";
}) {
  const value = numericExtremumDisplay(summary, bound);
  if (!value) return null;
  const accessibleLabel = `${label === "Min" ? "Minimum" : "Maximum"} ${value.display}`;
  return (
    <span
      className={value.exact ? "exactNumericExtremum" : undefined}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      {label} {value.display}
    </span>
  );
}

function MiniChart({
  visualization,
  column,
  valueMode,
  denominator,
  onApplyFilter
}: {
  visualization: ColumnVisualization | undefined;
  column: ColumnSchema;
  valueMode: ProfileValueMode;
  denominator: number;
  onApplyFilter?: (filter: ColumnFilter) => void;
}) {
  if (!visualization) return <span className="miniChart emptyInsight">No chart</span>;
  if (visualization.kind === "numeric") {
    return (
      <NumericHistogram
        visualization={visualization}
        compact
        valueMode={valueMode}
        percentDenominator={denominator}
        onSelectBin={
          onApplyFilter
            ? (bin, index) => onApplyFilter(viewNumericBinFilter(column, bin, index === visualization.bins.length - 1))
            : undefined
        }
      />
    );
  }
  if (visualization.kind === "boolean") {
    const total = Math.max(1, visualization.trueCount + visualization.falseCount);
    const trueDescription = describeProfileValue("True", visualization.trueCount, denominator);
    const falseDescription = describeProfileValue("False", visualization.falseCount, denominator);
    const values = [
      { label: "True", value: true, count: visualization.trueCount, description: trueDescription },
      { label: "False", value: false, count: visualization.falseCount, description: falseDescription }
    ] as const;
    return (
      <span
        className={`booleanMiniChart${onApplyFilter ? " interactive" : ""}`}
        role={onApplyFilter ? "group" : "img"}
        aria-label={`${visualization.sampled ? "Sampled " : ""}boolean distribution: ${trueDescription}, ${falseDescription}.`}
      >
        <span className="miniChartLegend">
          {values.map((item) => {
            const contents = (
              <>
                {item.label} {formatProfileValue(item.count, denominator, valueMode)}
              </>
            );
            return onApplyFilter ? (
              <button
                type="button"
                className="booleanMiniValue"
                key={item.label}
                aria-label={`Filter ${column.name} to ${item.label}; ${item.description}`}
                title={`Filter ${column.name} to ${item.label} · ${item.description}`}
                onClick={() => onApplyFilter(viewValueSelectionFilter(column, item.value))}
              >
                {contents}
              </button>
            ) : (
              <span key={item.label} title={item.description}>
                {contents}
              </span>
            );
          })}
        </span>
        <span className="stackedMiniChart" aria-hidden="true">
          <i style={{ width: `${(visualization.trueCount / total) * 100}%` }} />
          <b style={{ width: `${(visualization.falseCount / total) * 100}%` }} />
        </span>
      </span>
    );
  }
  if (visualization.kind === "categorical") {
    const max = Math.max(1, ...visualization.categories.map((category) => category.count), visualization.otherCount);
    const visibleCategories = visualization.categories.slice(0, 3);
    const categoryLabel = [
      ...visibleCategories.map((category) => describeProfileValue(category.value, category.count, denominator)),
      ...(visualization.otherCount > 0 ? [describeProfileValue("Other", visualization.otherCount, denominator)] : [])
    ].join(", ");
    return (
      <span
        className={`categoryMiniChart${onApplyFilter ? " interactive" : ""}`}
        role={onApplyFilter ? "group" : "img"}
        aria-label={`${visualization.sampled ? "Sampled " : ""}categorical distribution${categoryLabel ? `: ${categoryLabel}` : " with no values"}.`}
      >
        {visibleCategories.map((category, index) => {
          const description = describeProfileValue(category.value || "Empty string", category.count, denominator);
          const contents = (
            <>
              <span className="categoryMiniLabel" title={category.value}>
                {category.value}
              </span>
              <i aria-hidden="true" style={{ width: `${(category.count / max) * 100}%` }} />
              <small title={description}>{formatProfileValue(category.count, denominator, valueMode)}</small>
            </>
          );
          return onApplyFilter ? (
            <button
              type="button"
              className="categoryMiniRow interactive"
              key={`${category.value}-${index}`}
              aria-label={`Filter ${column.name} to ${category.value || "empty string"}; ${description}`}
              onClick={() => onApplyFilter(viewValueSelectionFilter(column, category.selectionValue ?? category.value))}
            >
              {contents}
            </button>
          ) : (
            <span className="categoryMiniRow" key={`${category.value}-${index}`}>
              {contents}
            </span>
          );
        })}
        {visualization.otherCount > 0 && (
          <span className="categoryMiniRow">
            <span className="categoryMiniLabel">Other</span>
            <i aria-hidden="true" style={{ width: `${(visualization.otherCount / max) * 100}%` }} />
            <small title={describeProfileValue("Other", visualization.otherCount, denominator)}>
              {formatProfileValue(visualization.otherCount, denominator, valueMode)}
            </small>
          </span>
        )}
      </span>
    );
  }
  const min = visualization.min ?? "n/a";
  const max = visualization.max ?? "n/a";
  return (
    <span
      className="datetimeMiniChart"
      role="img"
      aria-label={`${visualization.sampled ? "Sampled " : ""}datetime distribution: minimum ${min}, maximum ${max}.`}
    >
      <span title={`Minimum ${min}`}>
        <b>Min</b> {min}
      </span>
      <span title={`Maximum ${max}`}>
        <b>Max</b> {max}
      </span>
    </span>
  );
}
