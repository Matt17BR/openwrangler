import type { ColumnSchema, ColumnSummary } from "../../shared/protocol";

interface SummaryPanelProps {
  summaries: ColumnSummary[];
  schemaByName: Map<string, ColumnSchema>;
}

export function SummaryPanel({ summaries, schemaByName }: SummaryPanelProps): JSX.Element {
  return (
    <section className="panel summaryPanel">
      <h2>Summary</h2>
      {summaries.length === 0 && <p>No summary data yet.</p>}
      {summaries.map((summary) => {
        const schema = schemaByName.get(summary.column);
        return (
          <details key={summary.column} open={summaries.length <= 6}>
            <summary>
              <span>{summary.column}</span>
              <small>{schema?.rawType ?? summary.rawType}</small>
            </summary>
            <dl>
              <dt>Missing</dt>
              <dd>{summary.nullCount.toLocaleString()}</dd>
              <dt>Distinct</dt>
              <dd>{summary.distinctCount?.toLocaleString() ?? "n/a"}</dd>
              {summary.numeric && (
                <>
                  <dt>Min</dt>
                  <dd>{formatNumber(summary.numeric.min)}</dd>
                  <dt>Max</dt>
                  <dd>{formatNumber(summary.numeric.max)}</dd>
                  <dt>Mean</dt>
                  <dd>{formatNumber(summary.numeric.mean)}</dd>
                </>
              )}
            </dl>
            {summary.topValues.length > 0 && (
              <div className="topValues">
                {summary.topValues.map((item) => (
                  <div key={item.value} className="barRow">
                    <span>{item.value}</span>
                    <meter min={0} max={summary.topValues[0]?.count ?? 1} value={item.count} />
                    <small>{item.count}</small>
                  </div>
                ))}
              </div>
            )}
          </details>
        );
      })}
    </section>
  );
}

const formatNumber = (value: number | undefined): string => {
  if (value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
