import type { GridPage, SessionMetadata } from "../../shared/protocol";

interface DataGridProps {
  metadata: SessionMetadata;
  page: GridPage;
  pageSize: number;
  onPage(offset: number): void;
}

export function DataGrid({ metadata, page, pageSize, onPage }: DataGridProps): JSX.Element {
  const previousOffset = Math.max(0, page.offset - pageSize);
  const nextOffset = page.offset + pageSize;
  const canGoNext = nextOffset < page.totalRows;

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
