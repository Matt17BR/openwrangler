import type { ColumnSummary, GridPage, SessionMetadata } from "../../shared/protocol";

interface DataGridProps {
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
  pageSize: number;
  onPage(offset: number): void;
}

export function DataGrid({ metadata, page, summaries, pageSize, onPage }: DataGridProps): JSX.Element {
  const previousOffset = Math.max(0, page.offset - pageSize);
  const nextOffset = page.offset + pageSize;
  const canGoNext = nextOffset < page.totalRows;
  const summaryByColumn = new Map(summaries.map((summary) => [summary.column, summary]));

  return (
    <div className="dataGrid">
      <div className="gridControls">
        <button type="button" disabled={page.offset === 0} onClick={() => onPage(previousOffset)}>
          Previous
        </button>
        <span>
          Rows {page.offset + 1}-{Math.min(page.offset + page.limit, page.totalRows)} of{" "}
          {page.totalRows.toLocaleString()}
        </span>
        <button type="button" disabled={!canGoNext} onClick={() => onPage(nextOffset)}>
          Next
        </button>
      </div>

      <div className="tableScroller">
        <table>
          <thead>
            <tr>
              <th className="rowHeader">#</th>
              {metadata.schema.map((column) => (
                <th key={column.name} title={`${column.rawType}${column.nullable ? " nullable" : ""}`}>
                  <span>{column.name}</span>
                  <small>{column.type}</small>
                </th>
              ))}
            </tr>
            <tr className="insightRow">
              <th className="rowHeader"> </th>
              {metadata.schema.map((column) => {
                const summary = summaryByColumn.get(column.name);
                const topValue = summary?.topValues[0];
                return (
                  <th key={`${column.name}-insight`}>
                    {summary ? (
                      <div className="columnInsight">
                        <span>Missing {summary.nullCount.toLocaleString()}</span>
                        <span>Distinct {summary.distinctCount?.toLocaleString() ?? "n/a"}</span>
                        {topValue && (
                          <span className="miniBar" title={`Top value: ${topValue.value} (${topValue.count})`}>
                            <i />
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="columnInsight emptyInsight">No summary</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <tr key={row.rowNumber}>
                <td className="rowHeader">{row.rowNumber + 1}</td>
                {row.values.map((cell, index) => (
                  <td
                    key={`${row.rowNumber}-${metadata.schema[index]?.name ?? index}`}
                    className={cell.isNull || cell.isNaN ? "missingCell" : undefined}
                    title={cell.display}
                  >
                    {cell.display}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
