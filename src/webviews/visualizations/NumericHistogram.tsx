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
  const denominator = Math.max(
    0,
    percentDenominator ?? visualization.bins.reduce((total, bin) => total + bin.count, 0)
  );
  const activeBinIndex = hoveredBinIndex ?? focusedBinIndex;
  const activeBin = activeBinIndex === undefined ? undefined : visualization.bins[activeBinIndex];
  const activeBinLabel = activeBin
    ? histogramBinLabel(activeBin, denominator, valueMode, activeBinIndex === visualization.bins.length - 1)
    : undefined;

  return (
    <span className={`numericHistogram${compact ? " compact" : ""}${onSelectBin ? " interactive" : ""}`}>
      {activeBinLabel && (
        <span id={tooltipId} className="numericHistogramTooltip" role="tooltip">
          {activeBinLabel}
        </span>
      )}
      <svg
        className="miniChart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${visualization.sampled ? "Sampled " : ""}numeric distribution with ${visualization.bins.length} bins; range ${rangeLabel}.`}
      >
        {visualization.bins.map((bin, index) => {
          const barHeight = Math.max(2, (bin.count / maximumCount) * height);
          const label = histogramBinLabel(bin, denominator, valueMode, index === visualization.bins.length - 1);
          const selectBin = () => onSelectBin?.(bin, index);
          return (
            <g className="numericHistogramBin" key={`${bin.min}-${bin.max}-${index}`}>
              <rect
                className="numericHistogramBar"
                x={index * barWidth}
                y={height - barHeight}
                width={Math.max(1, barWidth - 1)}
                height={barHeight}
                aria-hidden="true"
              />
              <rect
                className="numericHistogramHitTarget"
                x={index * barWidth}
                y={0}
                width={barWidth}
                height={height}
                tabIndex={0}
                role={onSelectBin ? "button" : "graphics-symbol"}
                aria-label={label}
                onPointerEnter={() => setHoveredBinIndex(index)}
                onPointerLeave={() => setHoveredBinIndex((hovered) => (hovered === index ? undefined : hovered))}
                onPointerCancel={() => setHoveredBinIndex((hovered) => (hovered === index ? undefined : hovered))}
                onFocus={() => setFocusedBinIndex(index)}
                onBlur={() => setFocusedBinIndex((focused) => (focused === index ? undefined : focused))}
                onClick={selectBin}
                onKeyDown={(event) => {
                  if (!onSelectBin || (event.key !== "Enter" && event.key !== " ")) return;
                  event.preventDefault();
                  selectBin();
                }}
              />
            </g>
          );
        })}
      </svg>
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
