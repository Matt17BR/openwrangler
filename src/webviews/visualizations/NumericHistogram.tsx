import { useMemo, useState } from "react";
import type { NumericVisualization } from "../../shared/protocol";
import { formatProfilePercent, type ProfileValueMode } from "../profileValueMode";

interface NumericHistogramProps {
  visualization: NumericVisualization;
  compact?: boolean;
  valueMode?: ProfileValueMode;
  percentDenominator?: number;
  onSelectBin?(bin: NumericVisualization["bins"][number], index: number): void;
}

interface HistogramView {
  visualization: NumericVisualization;
  compact: boolean;
  valueMode: "count" | "percent";
  percentDenominator: number | undefined;
}

interface ActiveHistogramBin {
  view: HistogramView;
  index: number;
}

export function NumericHistogram({
  visualization,
  compact = false,
  valueMode = "count",
  percentDenominator,
  onSelectBin
}: NumericHistogramProps) {
  const view = useMemo(
    () => ({ visualization, compact, valueMode, percentDenominator }),
    [compact, percentDenominator, valueMode, visualization]
  );
  const [hoveredBin, setHoveredBin] = useState<ActiveHistogramBin>();
  const [focusedBin, setFocusedBin] = useState<ActiveHistogramBin>();
  const maximumCount = Math.max(1, ...visualization.bins.map((bin) => bin.count));
  const width = compact ? 160 : 320;
  const height = compact ? 36 : 92;
  const barWidth = visualization.bins.length > 0 ? width / visualization.bins.length : width;
  const rangeStart = visualization.bins.at(0)?.min;
  const rangeEnd = visualization.bins.at(-1)?.max;
  const rangeLabel =
    rangeStart === undefined || rangeEnd === undefined
      ? "No finite values"
      : `${formatHistogramValue(rangeStart)} to ${formatHistogramValue(rangeEnd)}`;
  const chartLabel = `${visualization.sampled ? "Sampled " : ""}numeric distribution with ${visualization.bins.length} bins; range ${rangeLabel}.`;
  const denominator = Math.max(
    0,
    percentDenominator ?? visualization.bins.reduce((total, bin) => total + bin.count, 0)
  );
  const hoveredBinIndex = hoveredBin?.view === view ? hoveredBin.index : undefined;
  const focusedBinIndex = focusedBin?.view === view ? focusedBin.index : undefined;
  const activeBinIndex = hoveredBinIndex ?? focusedBinIndex;
  const activeBin = activeBinIndex === undefined ? undefined : visualization.bins[activeBinIndex];
  const activeBinLabel = activeBin
    ? histogramBinLabel(activeBin, denominator, valueMode, activeBinIndex === visualization.bins.length - 1)
    : undefined;
  const activeBinStatus = activeBin ? histogramBinStatus(activeBin) : undefined;
  const interactive = onSelectBin !== undefined;
  const currentBinIndex = activeBinIndex ?? 0;
  const currentBin = visualization.bins[currentBinIndex];
  const currentBinLabel = currentBin
    ? histogramBinLabel(currentBin, denominator, valueMode, currentBinIndex === visualization.bins.length - 1)
    : "No finite values";

  const binIndexAt = (clientX: number, element: Element): number => {
    const bounds = element.getBoundingClientRect();
    if (visualization.bins.length <= 1 || bounds.width <= 0) return 0;
    const relativeX = Math.min(Math.max(clientX - bounds.left, 0), Math.max(0, bounds.width - Number.EPSILON));
    return Math.min(visualization.bins.length - 1, Math.floor((relativeX / bounds.width) * visualization.bins.length));
  };

  const moveFocusedBin = (direction: "first" | "last" | "previous" | "next") => {
    setFocusedBin((focused) => {
      const currentIndex = focused?.view === view ? focused.index : (hoveredBinIndex ?? 0);
      let nextIndex: number;
      if (direction === "first") nextIndex = 0;
      else if (direction === "last") nextIndex = Math.max(0, visualization.bins.length - 1);
      else if (direction === "previous") nextIndex = Math.max(0, currentIndex - 1);
      else nextIndex = Math.min(Math.max(0, visualization.bins.length - 1), currentIndex + 1);
      return { view, index: nextIndex };
    });
    setHoveredBin(undefined);
  };

  return (
    <span
      className={`numericHistogram${compact ? " compact" : ""}${interactive ? " interactive" : ""}`}
      role={interactive ? "group" : undefined}
      aria-label={interactive ? chartLabel : undefined}
    >
      <span className="numericHistogramChart">
        <svg
          className="miniChart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role={interactive ? undefined : "img"}
          aria-hidden={interactive ? "true" : undefined}
          aria-label={interactive ? undefined : chartLabel}
          onPointerMove={
            interactive
              ? undefined
              : (event) => {
                  setHoveredBin({ view, index: binIndexAt(event.clientX, event.currentTarget) });
                }
          }
          onPointerLeave={interactive ? undefined : () => setHoveredBin(undefined)}
          onPointerCancel={interactive ? undefined : () => setHoveredBin(undefined)}
        >
          {visualization.bins.map((bin, index) => {
            const barHeight = Math.max(2, (bin.count / maximumCount) * height);
            return (
              <g
                className={`numericHistogramBin${activeBinIndex === index ? " active" : ""}`}
                key={`${bin.min}-${bin.max}-${index}`}
                aria-hidden="true"
              >
                <rect
                  className="numericHistogramBar"
                  x={index * barWidth}
                  y={height - barHeight}
                  width={Math.max(1, barWidth - 1)}
                  height={barHeight}
                />
              </g>
            );
          })}
        </svg>
        {interactive && visualization.bins.length > 0 && (
          <button
            type="button"
            className="numericHistogramHitTarget"
            aria-label={currentBinLabel}
            onPointerMove={(event) => {
              setHoveredBin({ view, index: binIndexAt(event.clientX, event.currentTarget) });
            }}
            onPointerLeave={() => setHoveredBin(undefined)}
            onPointerCancel={() => setHoveredBin(undefined)}
            onFocus={() => {
              setFocusedBin((focused) => (focused?.view === view ? focused : { view, index: hoveredBinIndex ?? 0 }));
            }}
            onBlur={() => {
              setFocusedBin(undefined);
              setHoveredBin(undefined);
            }}
            onClick={(event) => {
              const index = event.detail > 0 ? binIndexAt(event.clientX, event.currentTarget) : currentBinIndex;
              const bin = visualization.bins[index];
              if (bin) onSelectBin(bin, index);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                moveFocusedBin("previous");
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                moveFocusedBin("next");
              } else if (event.key === "Home") {
                event.preventDefault();
                moveFocusedBin("first");
              } else if (event.key === "End") {
                event.preventDefault();
                moveFocusedBin("last");
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setFocusedBin({ view, index: currentBinIndex });
                const bin = visualization.bins[currentBinIndex];
                if (bin) onSelectBin(bin, currentBinIndex);
              }
            }}
          />
        )}
      </span>
      <span
        className={`miniChartCaption${activeBinLabel ? " active" : ""}`}
        title={activeBinLabel ?? `${rangeLabel} · ${visualization.bins.length} bins`}
      >
        {activeBinStatus ?? `${rangeLabel} · ${visualization.bins.length} bins`}
      </span>
    </span>
  );
}

function histogramBinStatus(bin: NumericVisualization["bins"][number]): string {
  const count = `${bin.count.toLocaleString()} ${bin.count === 1 ? "row" : "rows"}`;
  return `${formatHistogramValue(bin.min)}-${formatHistogramValue(bin.max)}: ${count}`;
}

function histogramBinLabel(
  bin: NumericVisualization["bins"][number],
  denominator: number,
  valueMode: ProfileValueMode,
  upperInclusive: boolean
): string {
  const count = `${bin.count.toLocaleString()} ${bin.count === 1 ? "row" : "rows"}`;
  const percent = formatProfilePercent(bin.count, denominator);
  const value = valueMode === "count" ? `${count} (${percent})` : `${percent} (${count})`;
  const boundary = upperInclusive ? "both bounds included" : "lower bound included, upper bound excluded";
  return `${formatHistogramValue(bin.min)}-${formatHistogramValue(bin.max)}: ${value}; ${boundary}`;
}

function formatHistogramValue(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(value);
}
