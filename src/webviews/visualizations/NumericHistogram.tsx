import type { NumericVisualization } from "../../shared/protocol";

interface NumericHistogramProps {
  visualization: NumericVisualization;
  compact?: boolean;
}

export function NumericHistogram({ visualization, compact = false }: NumericHistogramProps) {
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

  return (
    <span className={`numericHistogram${compact ? " compact" : ""}`}>
      <svg
        className="miniChart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${visualization.sampled ? "Sampled " : ""}numeric distribution with ${visualization.bins.length} bins; range ${rangeLabel}.`}
      >
        {visualization.bins.map((bin, index) => {
          const barHeight = Math.max(2, (bin.count / maximumCount) * height);
          const label = `${formatHistogramValue(bin.min)}-${formatHistogramValue(bin.max)}: ${bin.count.toLocaleString()} ${bin.count === 1 ? "row" : "rows"}`;
          return (
            <rect
              key={`${bin.min}-${bin.max}-${index}`}
              x={index * barWidth}
              y={height - barHeight}
              width={Math.max(1, barWidth - 1)}
              height={barHeight}
              tabIndex={0}
              role="graphics-symbol"
              aria-label={label}
            >
              <title>{label}</title>
            </rect>
          );
        })}
      </svg>
      <span className="miniChartCaption" title={`${rangeLabel} · ${visualization.bins.length} bins`}>
        {rangeLabel} · {visualization.bins.length} bins
      </span>
    </span>
  );
}

function formatHistogramValue(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(value);
}
