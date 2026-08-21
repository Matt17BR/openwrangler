import { describe, expect, it } from "vitest";
import pandasMimeV2Contract from "../../fixtures/notebook-pandas-mime-v2-contract.json";
import {
  isNotebookLiveResultHandle,
  OPEN_WRANGLER_MIME_V2,
  normalizeNotebookOutputPayload
} from "../shared/notebookOutput";
import { runtimeIdentityForDataBackend } from "../shared/runtimeIdentity";

const page = {
  offset: 0,
  limit: 1,
  totalRows: 1,
  columnIds: ["c:0"],
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
    }
  ]
};

const metadata = {
  protocolVersion: 2,
  sessionId: "snapshot",
  revision: 0,
  backend: "polars",
  mode: "viewing",
  source: { kind: "notebookOutput", label: "frame" },
  capabilities: {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 1 },
  filteredShape: { rows: 1, columns: 1 },
  schema: [{ id: "c:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }],
  filterModel: { filters: [], sort: [] },
  steps: []
};

describe("notebook output", () => {
  it("uses the canonical MIME v2 payload", () => {
    expect(OPEN_WRANGLER_MIME_V2).toBe("application/vnd.openwrangler.viewer.v2+json");
    const normalized = normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page, summaries: [] });
    expect(normalized?.mimeVersion).toBe(2);
  });

  it("strips additive top-level fields while keeping private identity out of canonical MIME", () => {
    const runtimeIdentity = runtimeIdentityForDataBackend("polars");

    const normalized = normalizeNotebookOutputPayload({
      mimeVersion: 2,
      metadata,
      page,
      summaries: [],
      runtimeIdentity,
      futureAdditiveField: "ignored"
    });

    expect(normalized).toEqual({ mimeVersion: 2, metadata, page, summaries: [] });
    expect(normalized).not.toHaveProperty("runtimeIdentity");
    expect(normalized).not.toHaveProperty("futureAdditiveField");
  });

  it("rejects private runtime identity inside strict saved metadata", () => {
    const runtimeIdentity = runtimeIdentityForDataBackend("polars");

    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: { ...metadata, runtimeIdentity },
        page,
        summaries: []
      })
    ).toBeUndefined();
  });

  it("accepts only notebook-producing backends", () => {
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: { ...metadata, backend: "pandas", rowAxis: { kind: "positional", levelNames: [] } },
        page,
        summaries: []
      })?.metadata.backend
    ).toBe("pandas");
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: { ...metadata, backend: "duckdb" },
        page,
        summaries: []
      })?.metadata.backend
    ).toBe("duckdb");
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: { ...metadata, backend: "pyspark" },
        page,
        summaries: []
      })
    ).toBeUndefined();
  });

  it("enforces the shared Python-producer Pandas row-axis contract", () => {
    expect(pandasMimeV2Contract).toEqual({
      schemaVersion: 1,
      pandasRowAxisCases: [
        {
          name: "positional-range-index",
          rowAxis: { kind: "positional", levelNames: [] },
          expectedRows: [{}, {}]
        },
        {
          name: "named-index",
          rowAxis: { kind: "index", levelNames: ["record_id"] },
          expectedRows: [{ rowLabel: "10" }, { rowLabel: "20" }]
        },
        {
          name: "one-level-multi-index",
          rowAxis: { kind: "index", levelNames: ["region"] },
          expectedRows: [{ rowLabel: "north" }, { rowLabel: "south" }]
        },
        {
          name: "named-multi-index",
          rowAxis: { kind: "multiIndex", levelNames: ["region", "sequence"] },
          expectedRows: [{ rowLabel: "north · 1" }, { rowLabel: "south · 2" }]
        }
      ],
      nonPandasBackends: ["polars", "duckdb"]
    });

    for (const { name, rowAxis, expectedRows } of pandasMimeV2Contract.pandasRowAxisCases) {
      const rows = expectedRows.map((expectedRow, rowNumber) => ({
        ...page.rows[0],
        id: `r:${rowNumber}`,
        rowNumber,
        values: page.rows[0].values.map((value) => ({ ...value })),
        ...(Object.prototype.hasOwnProperty.call(expectedRow, "rowLabel")
          ? { rowLabel: (expectedRow as { rowLabel: string }).rowLabel }
          : {})
      }));
      const normalized = normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: {
          ...metadata,
          backend: "pandas",
          rowAxis,
          shape: { rows: rows.length, columns: 1 },
          filteredShape: { rows: rows.length, columns: 1 }
        },
        page: { ...page, limit: rows.length, totalRows: rows.length, rows },
        summaries: []
      });

      expect(normalized?.metadata.rowAxis, name).toEqual(rowAxis);
      expect(
        normalized?.page.rows.map((row) => Object.prototype.hasOwnProperty.call(row, "rowLabel")),
        name
      ).toEqual(expectedRows.map((row) => Object.prototype.hasOwnProperty.call(row, "rowLabel")));
      expect(
        normalized?.page.rows.map((row) => row.rowLabel),
        name
      ).toEqual(
        expectedRows.map((row) =>
          Object.prototype.hasOwnProperty.call(row, "rowLabel") ? (row as { rowLabel: string }).rowLabel : undefined
        )
      );

      if (rowAxis.kind === "positional") {
        expect(
          normalizeNotebookOutputPayload({
            mimeVersion: 2,
            metadata: {
              ...metadata,
              backend: "pandas",
              rowAxis,
              shape: { rows: 1, columns: 1 },
              filteredShape: { rows: 1, columns: 1 }
            },
            page: {
              ...page,
              limit: 1,
              totalRows: 1,
              rows: [{ ...page.rows[0], rowLabel: null }]
            },
            summaries: []
          })
        ).toBeUndefined();
      }
    }

    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: { ...metadata, backend: "pandas" },
        page,
        summaries: []
      })
    ).toBeUndefined();

    for (const backend of pandasMimeV2Contract.nonPandasBackends) {
      expect(
        normalizeNotebookOutputPayload({ mimeVersion: 2, metadata: { ...metadata, backend }, page, summaries: [] })
          ?.metadata.backend
      ).toBe(backend);
      expect(
        normalizeNotebookOutputPayload({
          mimeVersion: 2,
          metadata: {
            ...metadata,
            backend,
            rowAxis: pandasMimeV2Contract.pandasRowAxisCases[0].rowAxis
          },
          page,
          summaries: []
        })
      ).toBeUndefined();
    }
  });

  it("discards saved profiles so captured rows remain the only source of truth", () => {
    const savedSummary = {
      column: "value",
      type: "integer",
      rawType: "Int64",
      totalCount: 1,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 999,
      topValues: [{ value: "forged", count: 999 }]
    };
    const normalized = normalizeNotebookOutputPayload({
      mimeVersion: 2,
      metadata: {
        ...metadata,
        stats: { missingCells: 999, missingRows: 999, duplicateRows: 999, missingValuesByColumn: [] }
      },
      page,
      summaries: [savedSummary]
    });

    expect(normalized?.summaries).toEqual([]);
    expect(normalized?.metadata.stats).toBeUndefined();
  });

  it("accepts only canonical ASCII Python identifiers as optional live links", () => {
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: { ...metadata, source: { ...metadata.source, variableName: "frame_2" } },
        page,
        summaries: []
      })?.metadata.source.variableName
    ).toBe("frame_2");

    for (const variableName of ["", "not a variable", "2frame", "fráme"]) {
      expect(
        normalizeNotebookOutputPayload({
          mimeVersion: 2,
          metadata: { ...metadata, source: { ...metadata.source, variableName } },
          page,
          summaries: []
        })
      ).toBeUndefined();
    }
  });

  it("recognizes only the reserved opaque live-result handle shape", () => {
    const handle = "__openwrangler_live_result_0123456789abcdef0123456789abcdef";
    const normalized = normalizeNotebookOutputPayload({
      mimeVersion: 2,
      metadata: { ...metadata, source: { ...metadata.source, variableName: handle } },
      page,
      summaries: []
    });

    expect(normalized?.metadata.source.variableName).toBe(handle);
    expect(isNotebookLiveResultHandle(handle)).toBe(true);
    expect(isNotebookLiveResultHandle("__openwrangler_live_result_0123")).toBe(false);
    expect(isNotebookLiveResultHandle("__openwrangler_live_result_0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(isNotebookLiveResultHandle("ordinary_frame")).toBe(false);
  });

  it("requires current MIME v2 pages to declare their column identities", () => {
    const { columnIds: _columnIds, ...pageWithoutColumnIds } = page;

    const normalized = normalizeNotebookOutputPayload({
      mimeVersion: 2,
      metadata,
      page: pageWithoutColumnIds,
      summaries: []
    });

    expect(normalized).toBeUndefined();
  });

  it("rejects oversized containers before traversing their nested fields", () => {
    let schemaFieldRead = false;
    const oversizedSchema = Array.from({ length: 2_049 }, (_, position) => ({
      get id() {
        schemaFieldRead = true;
        throw new Error("validation traversed an oversized schema");
      },
      name: `column-${position}`,
      position,
      rawType: "Int64",
      type: "integer",
      nullable: false
    }));
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: { ...metadata, schema: oversizedSchema },
        page: { offset: 0, limit: 1, totalRows: 0, columnIds: ["c:0"], rows: [] },
        summaries: []
      })
    ).toBeUndefined();
    expect(schemaFieldRead).toBe(false);

    let rowFieldRead = false;
    const oversizedRows = Array.from({ length: 10_001 }, (_, rowNumber) => ({
      id: `r:${rowNumber}`,
      rowNumber,
      get values() {
        rowFieldRead = true;
        throw new Error("validation traversed oversized rows");
      }
    }));
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata,
        page: { offset: 0, limit: 10_001, totalRows: 10_001, columnIds: ["c:0"], rows: oversizedRows },
        summaries: []
      })
    ).toBeUndefined();
    expect(rowFieldRead).toBe(false);
  });

  it("rejects projected notebook snapshots that cannot fetch their missing columns", () => {
    const secondColumn = {
      id: "c:1",
      name: "other",
      position: 1,
      rawType: "Int64",
      type: "integer",
      nullable: false
    };
    const wideMetadata = {
      ...metadata,
      shape: { rows: 1, columns: 2 },
      filteredShape: { rows: 1, columns: 2 },
      schema: [...metadata.schema, secondColumn]
    };
    expect(
      normalizeNotebookOutputPayload({ mimeVersion: 2, metadata: wideMetadata, page, summaries: [] })
    ).toBeUndefined();
  });

  it("rejects snapshots that omit claimed rows", () => {
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata,
        page: { ...page, totalRows: 1, rows: [] },
        summaries: []
      })
    ).toBeUndefined();
  });

  it("rejects contradictory or unstable captured-row identity", () => {
    const secondRow = { ...page.rows[0]!, rowNumber: 1 };
    const twoRowMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 }
    };

    for (const rows of [
      [{ ...page.rows[0]!, id: "" }],
      [{ ...page.rows[0]!, rowNumber: 1 }],
      [page.rows[0]!, secondRow]
    ]) {
      expect(
        normalizeNotebookOutputPayload({
          mimeVersion: 2,
          metadata: rows.length === 2 ? twoRowMetadata : metadata,
          page: { ...page, totalRows: rows.length, limit: rows.length, rows },
          summaries: []
        })
      ).toBeUndefined();
    }

    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata,
        page: { ...page, totalRows: 0 },
        summaries: []
      })
    ).toBeUndefined();
  });

  it("rejects contradictory typed-cell flags and special-value encodings", () => {
    const baseCell = page.rows[0]!.values[0]!;
    for (const cell of [
      { ...baseCell, isNull: true },
      { ...baseCell, isNaN: true },
      { ...baseCell, sign: 1 },
      { kind: "null", raw: "not-null", display: "", isNull: true, isNaN: false },
      { kind: "nan", raw: null, display: "nan", isNull: false, isNaN: true },
      { kind: "infinity", raw: null, display: "Infinity", isNull: false, isNaN: false },
      { kind: "infinity", raw: null, display: "Infinity", isNull: false, isNaN: false, sign: -1 }
    ]) {
      expect(
        normalizeNotebookOutputPayload({
          mimeVersion: 2,
          metadata,
          page: { ...page, rows: [{ ...page.rows[0]!, values: [cell] }] },
          summaries: []
        })
      ).toBeUndefined();
    }
  });

  it("rejects snapshots that do not start at the first row", () => {
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata,
        page: { ...page, offset: 1 },
        summaries: []
      })
    ).toBeUndefined();
  });

  it("rejects malformed and unknown-version outputs", () => {
    expect(normalizeNotebookOutputPayload({ mimeVersion: 3, metadata, page, summaries: [] })).toBeUndefined();
    expect(normalizeNotebookOutputPayload({ metadata, page, summaries: [] })).toBeUndefined();
    expect(normalizeNotebookOutputPayload({ mimeVersion: 2, metadata, page: {}, summaries: [] })).toBeUndefined();
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: {
          ...metadata,
          steps: [{ id: "bad", kind: "renameColumn", params: { columns: ["value"] } }]
        },
        page,
        summaries: []
      })
    ).toBeUndefined();
  });

  it("rejects capability-elevated or stateful saved outputs instead of trusting notebook metadata", () => {
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: {
          ...metadata,
          capabilities: { ...metadata.capabilities, exportCsv: true }
        },
        page,
        summaries: []
      })
    ).toBeUndefined();
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: {
          ...metadata,
          filterModel: { filters: [], sort: [{ column: "value", direction: "asc", nulls: "last" }] }
        },
        page,
        summaries: []
      })
    ).toBeUndefined();
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: {
          ...metadata,
          source: { ...metadata.source, path: "/untrusted/source.csv" }
        },
        page,
        summaries: []
      })
    ).toBeUndefined();
  });

  it("rejects contradictory shape metadata and over-budget captures", () => {
    for (const shape of [
      { rows: 1, columns: 2 },
      { rows: 1, columns: 1 }
    ]) {
      const filteredShape = shape.columns === 2 ? metadata.filteredShape : { rows: 1, columns: 2 };
      expect(
        normalizeNotebookOutputPayload({
          mimeVersion: 2,
          metadata: { ...metadata, shape, filteredShape },
          page,
          summaries: []
        })
      ).toBeUndefined();
    }

    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata,
        page: { ...page, limit: 10_001 },
        summaries: []
      })
    ).toBeUndefined();

    const wideColumns = Array.from({ length: 500 }, (_, position) => ({
      id: `c:${position}`,
      name: `column_${position}`,
      position,
      rawType: "Int64",
      type: "integer",
      nullable: false
    }));
    const sharedCell = page.rows[0]!.values[0]!;
    const manyRows = Array.from({ length: 201 }, (_, rowNumber) => ({
      id: `r:${rowNumber}`,
      rowNumber,
      values: Array.from({ length: wideColumns.length }, () => sharedCell)
    }));
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: {
          ...metadata,
          shape: { rows: manyRows.length, columns: wideColumns.length },
          filteredShape: { rows: manyRows.length, columns: wideColumns.length },
          schema: wideColumns
        },
        page: {
          offset: 0,
          limit: manyRows.length,
          totalRows: manyRows.length,
          columnIds: wideColumns.map((column) => column.id),
          rows: manyRows
        },
        summaries: []
      })
    ).toBeUndefined();

    const oversizedText = "x".repeat(16 * 1024 * 1024 + 1);
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata,
        page: {
          ...page,
          rows: [
            {
              ...page.rows[0]!,
              values: [{ kind: "string", raw: "x", display: oversizedText, isNull: false, isNaN: false }]
            }
          ]
        },
        summaries: []
      })
    ).toBeUndefined();
  });

  it("bounds individual fields by Unicode code points rather than UTF-16 units", () => {
    const emojiLabel = "😀".repeat(256);
    expect(
      normalizeNotebookOutputPayload({
        mimeVersion: 2,
        metadata: { ...metadata, source: { ...metadata.source, label: emojiLabel } },
        page,
        summaries: []
      })?.metadata.source.label
    ).toBe(emojiLabel);

    for (const candidate of [
      {
        metadata: { ...metadata, source: { ...metadata.source, label: "x".repeat(257) } },
        page
      },
      {
        metadata: {
          ...metadata,
          schema: [{ ...metadata.schema[0], name: "x".repeat(513) }]
        },
        page
      },
      {
        metadata,
        page: {
          ...page,
          rows: [
            {
              ...page.rows[0],
              values: [{ ...page.rows[0]!.values[0], display: "x".repeat(65_537) }]
            }
          ]
        }
      },
      {
        metadata,
        page: {
          ...page,
          rows: [
            {
              ...page.rows[0],
              values: [
                {
                  kind: "struct",
                  raw: { ["x".repeat(65_537)]: 1 },
                  display: "{}",
                  isNull: false,
                  isNaN: false
                }
              ]
            }
          ]
        }
      }
    ]) {
      expect(normalizeNotebookOutputPayload({ mimeVersion: 2, ...candidate, summaries: [] })).toBeUndefined();
    }
  });
});
