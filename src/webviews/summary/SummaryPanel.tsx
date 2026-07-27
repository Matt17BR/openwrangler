import type { ColumnSchema, ColumnSummary, SessionMetadata } from "../../shared/protocol";

interface SummaryPanelProps {
  metadata: SessionMetadata | undefined;
  summaries: ColumnSummary[];
  schemaById: Map<string, ColumnSchema>;
}

export function SummaryPanel({ metadata, summaries, schemaById }: SummaryPanelProps) {
  const missingByColumn = metadata?.stats?.missingValuesByColumn.filter((item) => item.count > 0) ?? [];
  const summaryByColumnId = new Map(summaries.map((summary) => [summary.columnId, summary]));
  const orderedSummaries = metadata
    ? metadata.schema.flatMap((column) => {
        const summary = summaryByColumnId.get(column.id);
        return summary ? [summary] : [];
      })
    : summaries;

  return (
    <section className="panel summaryPanel">
      <h2>Data Summary</h2>
      <dl className="dataSummaryStats">
        <dt>Data shape</dt>
        <dd>
          {metadata
            ? `${metadata.filteredShape.rows.toLocaleString()} rows x ${metadata.filteredShape.columns.toLocaleString()} columns`
            : "Loading"}
        </dd>
        <dt>Columns</dt>
        <dd>{metadata?.shape.columns.toLocaleString() ?? "-"}</dd>
        <dt>Rows</dt>
        <dd>{metadata?.filteredShape.rows.toLocaleString() ?? "-"}</dd>
        <dt>Missing cells</dt>
        <dd>{metadata?.stats?.missingCells.toLocaleString() ?? "-"}</dd>
        <dt>Duplicate rows</dt>
        <dd>{metadata?.stats?.duplicateRows.toLocaleString() ?? "-"}</dd>
      </dl>
      <details className="summaryGroup" open={missingByColumn.length > 0}>
        <summary>Missing values (by column)</summary>
        {!metadata?.stats ? (
          <p className="mutedText" role="status">
            Profiling exact missing values…
          </p>
        ) : missingByColumn.length === 0 ? (
          <p className="mutedText">No missing values.</p>
        ) : (
          <div className="missingList">
            {missingByColumn.map((item, index) => (
              <div key={`${item.column}-${index}`} className="barRow">
                <span>{item.column}</span>
                <meter min={0} max={metadata?.filteredShape.rows ?? 1} value={item.count} />
                <small>{item.count.toLocaleString()}</small>
              </div>
            ))}
          </div>
        )}
      </details>

      <h3>Column Summary</h3>
      {orderedSummaries.length === 0 && <p>No summary data yet.</p>}
      {orderedSummaries.map((summary) => {
        const schema = schemaById.get(summary.columnId);
        const displayName = columnDisplayName(summary, schema, metadata?.schema);
        return (
          <details key={summary.columnId} className="summaryGroup" open={orderedSummaries.length <= 6}>
            <summary>
              <span>{displayName}</span>
              <small>{schema?.rawType ?? summary.rawType}</small>
            </summary>
            <dl>
              <dt>Values</dt>
              <dd>{summary.totalCount.toLocaleString()}</dd>
              <dt>Missing</dt>
              <dd>{(summary.nullCount + summary.nanCount).toLocaleString()}</dd>
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
                  <dt>Median</dt>
                  <dd>{formatNumber(summary.numeric.median)}</dd>
                  <dt>Std. deviation</dt>
                  <dd>{formatNumber(summary.numeric.std)}</dd>
                </>
              )}
            </dl>
            {summary.topValues.length > 0 && (
              <div className="topValues">
                {summary.topValues.map((item, index) => (
                  <div key={`${item.value}-${index}`} className="barRow">
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

function columnDisplayName(
  summary: ColumnSummary,
  schema: ColumnSchema | undefined,
  allColumns: readonly ColumnSchema[] | undefined
): string {
  if (!schema || !allColumns) return summary.column;
  const duplicateCount = allColumns.filter((column) => column.name === schema.name).length;
  return duplicateCount > 1 ? `${summary.column} (column ${schema.position + 1})` : summary.column;
}

const formatNumber = (value: number | undefined): string => {
  if (value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
