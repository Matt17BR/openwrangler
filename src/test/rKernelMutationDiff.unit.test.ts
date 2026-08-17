import { describe, expect, it } from "vitest";
import type { ColumnSchema, DataDiff } from "../shared/protocol";
import type { RFramePageContract } from "../extension/r/rFrameContract";
import type { RTransformStep } from "../extension/r/rKernelTransformBinding";
import {
  assertMutationDiff,
  categoricalRetainedSchema,
  copyDiff,
  inspectionDiff,
  isRCategoricalTransformStep,
  isRFormatDatetimeInPlace,
  isRMinMaxScaleInPlace,
  isRNumericRoundingInPlace,
  isRRowReductionStep,
  numericRoundingLabel,
  rowOperationLabel
} from "../extension/r/rKernelMutationDiff";

describe("R kernel mutation diff", () => {
  it("owns categorical retention and rejects stale, repeated, and private references", () => {
    const oneHot = {
      id: "encode",
      kind: "oneHotEncode" as const,
      params: { columns: [reference(0)], dropOriginal: true }
    };
    expect(isRCategoricalTransformStep(oneHot)).toBe(true);
    expect(categoricalRetainedSchema(schema, oneHot)).toEqual([{ ...schema[1], position: 0 }]);
    expect(() =>
      categoricalRetainedSchema(schema, {
        ...oneHot,
        params: { columns: [reference(0), reference(0)] }
      })
    ).toThrow("same R column more than once");
    expect(() =>
      categoricalRetainedSchema(schema, { ...oneHot, params: { columns: [{ id: "stale", name: "group" }] } })
    ).toThrow("no longer matches");
    const privateSchema = [{ ...schema[0]!, id: "private", name: "__open_wrangler_internal_row_id_1" }];
    expect(() =>
      categoricalRetainedSchema(privateSchema, {
        ...oneHot,
        params: { columns: [{ id: "private", name: "__open_wrangler_internal_row_id_1" }] }
      })
    ).toThrow("reserved private row-identity");
  });

  it("builds exact in-place inspection cells and rejects row substitution", () => {
    const step: RTransformStep = {
      id: "cast",
      kind: "castColumn",
      params: { column: reference(1), dtype: "float" }
    };
    const input = pageContract([["alpha", "1"]]);
    const output = pageContract([["alpha", "2"]]);
    const diff = inspectionDiff(step, schema, schema, input, output, 1, 1);
    expect(diff).toEqual({
      addedRows: 0,
      removedRows: 0,
      addedColumns: [],
      removedColumns: [],
      changedCells: 1,
      cells: [
        {
          rowNumber: 0,
          columnId: "b",
          column: "count",
          before: { kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false },
          after: { kind: "integer", raw: "2", display: "2", isNull: false, isNaN: false }
        }
      ],
      truncated: false
    });
    expect(() =>
      inspectionDiff(
        step,
        schema,
        schema,
        input,
        { ...output, page: { ...output.page, rows: [{ ...output.page.rows[0]!, id: "replacement" }] } },
        1,
        1
      )
    ).toThrow("different rows");
  });

  it("validates exact structural and row-operation diffs", () => {
    const clone: RTransformStep = {
      id: "clone",
      kind: "cloneColumn",
      params: { column: reference(0), newName: "group_copy" }
    };
    const outputSchema = [
      ...schema,
      {
        id: "c:step:clone:0",
        name: "group_copy",
        position: 2,
        rawType: "character",
        type: "string" as const,
        nullable: true
      }
    ];
    const valid: DataDiff = {
      addedRows: 0,
      removedRows: 0,
      addedColumns: ["group_copy"],
      removedColumns: [],
      changedCells: 0,
      cells: [],
      truncated: false
    };
    expect(() =>
      assertMutationDiff(clone, schema, outputSchema, 1, 1, pageContract([["alpha", "1"]]), valid, emptyView)
    ).not.toThrow();
    expect(() =>
      assertMutationDiff(
        clone,
        schema,
        outputSchema,
        1,
        1,
        pageContract([["alpha", "1"]]),
        { ...valid, addedColumns: ["wrong"] },
        emptyView
      )
    ).toThrow("wrong columns or cells");

    const filtered: RTransformStep = {
      id: "filter",
      kind: "filterRows",
      params: { filterModel: { filters: [], sort: [] } }
    };
    expect(isRRowReductionStep(filtered)).toBe(true);
    expect(rowOperationLabel(filtered)).toBe("Filter rows");
    expect(() =>
      assertMutationDiff(
        filtered,
        schema,
        schema,
        2,
        1,
        pageContract([["alpha", "1"]]),
        {
          addedRows: 0,
          removedRows: 1,
          addedColumns: [],
          removedColumns: [],
          changedCells: 0,
          cells: [],
          truncated: false
        },
        emptyView
      )
    ).not.toThrow();
  });

  it("owns exact in-place and rounding labels", () => {
    const round = { id: "round", kind: "roundNumber" as const, params: { column: reference(1), decimals: 2 } };
    expect(isRNumericRoundingInPlace(round)).toBe(true);
    expect(numericRoundingLabel(round)).toBe("Round");
    expect(
      isRMinMaxScaleInPlace({ id: "scale", kind: "minMaxScale", params: { column: reference(1), newColumn: "scaled" } })
    ).toBe(false);
    expect(
      isRFormatDatetimeInPlace({ id: "date", kind: "formatDatetime", params: { column: reference(0), format: "%Y" } })
    ).toBe(true);
  });

  it("deep-copies diff arrays and cells", () => {
    const source: DataDiff = {
      addedRows: 0,
      removedRows: 0,
      addedColumns: ["new"],
      removedColumns: ["old"],
      changedCells: 1,
      cells: [
        {
          rowNumber: 0,
          columnId: "b",
          column: "count",
          before: { kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false },
          after: { kind: "integer", raw: 2, display: "2", isNull: false, isNaN: false }
        }
      ],
      truncated: false
    };
    const copied = copyDiff(source);
    expect(copied).toEqual(source);
    expect(copied).not.toBe(source);
    expect(copied.addedColumns).not.toBe(source.addedColumns);
    expect(copied.removedColumns).not.toBe(source.removedColumns);
    expect(copied.cells).not.toBe(source.cells);
    expect(copied.cells[0]).not.toBe(source.cells[0]);
    expect(copied.cells[0]?.before).not.toBe(source.cells[0]?.before);
    expect(copied.cells[0]?.after).not.toBe(source.cells[0]?.after);
  });
});

function reference(position: number): { id: string; name: string } {
  const column = schema[position] as ColumnSchema;
  return { id: column.id, name: column.name };
}

function pageContract(values: readonly [string, string][]): RFramePageContract {
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: values.length, columns: 2 },
    frameSemantics: { classes: ["data.frame"], rowNames: "automatic", keyColumnIds: [] },
    schema: [
      { ...schema[0]!, semantics: { kind: "character", classes: ["character"] } },
      { ...schema[1]!, semantics: { kind: "integer", classes: ["integer"] } }
    ],
    page: {
      offset: 0,
      limit: values.length || 1,
      totalRows: values.length,
      columnOffset: 0,
      columnLimit: 2,
      columnIds: ["a", "b"],
      rows: values.map(([text, count], rowNumber) => ({
        id: `r:r:${rowNumber}`,
        rowNumber,
        values: [
          { kind: "string", raw: text, display: text, isNull: false, isNaN: false },
          { kind: "integer", raw: count, display: count, isNull: false, isNaN: false }
        ]
      }))
    }
  };
}

const schema = Object.freeze([
  Object.freeze({ id: "a", name: "group", position: 0, rawType: "character", type: "string" as const, nullable: true }),
  Object.freeze({ id: "b", name: "count", position: 1, rawType: "integer", type: "integer" as const, nullable: true })
]);

const emptyView = Object.freeze({ filters: Object.freeze([]), sorts: Object.freeze([]) });
