import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
import { DataGrid } from "../webviews/grid/DataGrid";

const metadata: SessionMetadata = {
  sessionId: "session",
  backend: "polars",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  filterModel: { filters: [], sort: [] },
  schema: [
    { name: "city", rawType: "String", type: "string", nullable: false },
    { name: "sales", rawType: "Float64", type: "float", nullable: true }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 2,
  totalRows: 2,
  rows: [
    {
      rowNumber: 0,
      values: [
        { raw: "Milan", display: "Milan", isNull: false, isNaN: false },
        { raw: 10.5, display: "10.5", isNull: false, isNaN: false }
      ]
    },
    {
      rowNumber: 1,
      values: [
        { raw: "Paris", display: "Paris", isNull: false, isNaN: false },
        { raw: null, display: "", isNull: true, isNaN: false }
      ]
    }
  ]
};

describe("DataGrid", () => {
  it("renders schema headers and cell values", () => {
    render(
      <DataGrid
        metadata={metadata}
        page={page}
        summaries={[]}
        pageSize={2}
        onPage={() => undefined}
        onSortColumn={() => undefined}
        onOpenFilter={() => undefined}
      />
    );

    expect(screen.getByText("city")).toBeTruthy();
    expect(screen.getByText("sales")).toBeTruthy();
    expect(screen.getByText("Milan")).toBeTruthy();
    expect(screen.getByText("Paris")).toBeTruthy();
  });
});
