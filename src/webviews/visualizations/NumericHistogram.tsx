import { useId, useState } from "react";
import type { NumericVisualization } from "../../shared/protocol";

interface NumericHistogramProps {
  visualization: NumericVisualization;
  compact?: boolean;
  valueMode?: "count" | "percent";
  percentDenominator?: number;
  onSelectBin?(bin: NumericVisualization["bins"][number], index: number): void;
}

export function NumericHistogram({
  visualization,
  compact = false,
  valueMode = "count",
  percentDenominator,
  onSelectBin
}: NumericHistogramProps) {
  const [hoveredBinIndex, setHoveredBinIndex] = useState<number>();
  const [focusedBinIndex, setFocusedBinIndex] = useState<number>();
  const tooltipId = useId();
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
  const activeBinIndex = hoveredBinIndex ?? focusedBinIndex;
  const activeBin = activeBinIndex === undefined ? undefined : visualization.bins[activeBinIndex];
  const activeBinLabel = activeBin
    ? histogramBinLabel(activeBin, denominator, valueMode, activeBinIndex === visualization.bins.length - 1)
    : undefined;
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
    setFocusedBinIndex((focused) => {
      const current = focused ?? hoveredBinIndex ?? 0;
      if (direction === "first") return 0;
      if (direction === "last") return Math.max(0, visualization.bins.length - 1);
      if (direction === "previous") return Math.max(0, current - 1);
      return Math.min(Math.max(0, visualization.bins.length - 1), current + 1);
    });
  };

  return (
    <span
      className={`numericHistogram${compact ? " compact" : ""}${interactive ? " interactive" : ""}`}
      role={interactive ? "group" : undefined}
      aria-label={interactive ? chartLabel : undefined}
    >
      {activeBinLabel && (
        <span id={tooltipId} className="numericHistogramTooltip" role="tooltip">
          {activeBinLabel}
        </span>
      )}
      <span className="numericHistogramChart">
        <svg
          className="miniChart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role={interactive ? undefined : "img"}
          aria-hidden={interactive ? "true" : undefined}
          aria-label={interactive ? undefined : chartLabel}
          onPointerMove={
            interactive ? undefined : (event) => setHoveredBinIndex(binIndexAt(event.clientX, event.currentTarget))
          }
          onPointerLeave={interactive ? undefined : () => setHoveredBinIndex(undefined)}
          onPointerCancel={interactive ? undefined : () => setHoveredBinIndex(undefined)}
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
            onPointerMove={(event) => setHoveredBinIndex(binIndexAt(event.clientX, event.currentTarget))}
            onPointerLeave={() => setHoveredBinIndex(undefined)}
            onPointerCancel={() => setHoveredBinIndex(undefined)}
            onFocus={() => setFocusedBinIndex((focused) => focused ?? hoveredBinIndex ?? 0)}
            onBlur={() => setFocusedBinIndex(undefined)}
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
                const bin = visualization.bins[currentBinIndex];
                if (bin) onSelectBin(bin, currentBinIndex);
              }
            }}
          />
        )}
      </span>
      <span className="miniChartCaption" title={`${rangeLabel} · ${visualization.bins.length} bins`}>
        {rangeLabel} · {visualization.bins.length} bins
      </span>
    </span>
  );
}

function histogramBinLabel(
  bin: NumericVisualization["bins"][number],
  denominator: number,
  valueMode: "count" | "percent",
  upperInclusive: boolean
): string {
  const count = `${bin.count.toLocaleString()} ${bin.count === 1 ? "row" : "rows"}`;
  const percent = formatDistributionPercent(bin.count, denominator);
  const value = valueMode === "count" ? `${count} (${percent})` : `${percent} (${count})`;
  const boundary = upperInclusive ? "both bounds included" : "lower bound included, upper bound excluded";
  return `${formatHistogramValue(bin.min)}-${formatHistogramValue(bin.max)}: ${value}; ${boundary}`;
}

function formatDistributionPercent(count: number, denominator: number): string {
  if (denominator <= 0) return "0%";
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(count / denominator);
}

function formatHistogramValue(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(value);
}
