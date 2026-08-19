import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
import { DataGrid } from "../webviews/grid/DataGrid";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "resize-session",
  revision: 1,
  backend: "pandas",
  mode: "editing",
  source: { kind: "file", label: "resize.csv", path: "resize.csv" },
  capabilities: {
    editable: true,
    lazy: false,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 2 },
  filteredShape: { rows: 1, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "__proto__", name: "prototype", position: 0, rawType: "object", type: "string", nullable: false },
    { id: "列😀", name: "unicode", position: 1, rawType: "object", type: "string", nullable: false }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 1,
  totalRows: 1,
  columnIds: metadata.schema.map((column) => column.id),
  rows: [
    {
      id: "row:0",
      rowNumber: 0,
      values: [stringCell("prototype value"), stringCell("Unicode value")]
    }
  ]
};

describe("DataGrid column resizing", () => {
  it("resizes and restores prototype-name and Unicode column IDs without object-key coercion", () => {
    const onViewStateChange = vi.fn();
    render(<GridHarness onViewStateChange={onViewStateChange} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Resize prototype column" }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize unicode column" }), { key: "End" });

    const latest = onViewStateChange.mock.calls.at(-1)?.[0] as GridViewState;
    expect(latest.columnWidths).toBeInstanceOf(Map);
    expect([...latest.columnWidths]).toEqual([
      ["__proto__", 200],
      ["列😀", 640]
    ]);
    expect(document.querySelectorAll("col")[1]).toHaveStyle({ width: "200px" });
    expect(document.querySelectorAll("col")[2]).toHaveStyle({ width: "640px" });
  });
});

function GridHarness({ onViewStateChange }: { onViewStateChange(state: GridViewState): void }) {
  const [viewState, setViewState] = useState<GridViewState>({
    columnWidths: new Map(),
    viewport: { firstVisibleRow: 0, scrollLeft: 0 }
  });
  return (
    <DataGrid
      metadata={metadata}
      page={page}
      summaries={[]}
      pageSize={1}
      defaultColumnWidth={190}
      insightsOnOpen={false}
      viewState={viewState}
      onViewStateChange={(next) => {
        onViewStateChange(next);
        setViewState(next);
      }}
      onPage={() => undefined}
      onSortColumn={() => undefined}
      onOpenFilter={() => undefined}
      onVisibleSummaryColumnsChange={() => undefined}
    />
  );
}

function stringCell(display: string) {
  return { kind: "string" as const, raw: display, display, isNull: false, isNaN: false };
}
