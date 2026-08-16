import type { SessionMetadata } from "../shared/protocol";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 0,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 4, columns: 2 },
  filteredShape: { rows: 4, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  stats: {
    missingCells: 1,
    missingRows: 1,
    duplicateRows: 1,
    missingValuesByColumn: [
      { column: "city", count: 0 },
      { column: "sales", count: 1 }
    ]
  },
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true }
  ]
};

export { metadata };
