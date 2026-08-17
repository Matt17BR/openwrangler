import { describe, expect, it } from "vitest";
import type { ColumnSchema, DataDiff } from "../shared/protocol";
import type { RColumnSchema, RFramePageContract } from "../extension/r/rFrameContract";
import type { RKernelTransformStep } from "../extension/r/rKernelProtocol";
import {
  acceptRetainedByExampleStep,
  assertCustomDerivedRowIdentities,
  customRowIdentityConstraintAfterRStep,
  dynamicCategoricalSchema,
  dynamicCustomCodeSchema,
  keyColumnsAfterRStep,
  rowCountAfterRStep,
  rowIdentityDomainAfterRStep,
  rowNamesAfterRStep,
  schemaAfterFormula,
  schemaAfterGroupBy,
  schemaAfterRStep
} from "../extension/r/rKernelMutationSchema";

describe("R kernel mutation schema", () => {
  it("routes static schema changes and owns row/key transitions", () => {
    const renamed = schemaAfterRStep(
      schema,
      { id: "rename", kind: "renameColumn", params: { column: reference(0), newName: "category" } },
      []
    );
    expect(renamed).toEqual([{ ...schema[0], name: "category" }, schema[1]]);
    expect(renamed).not.toBe(schema);
    expect(rowNamesAfterRStep("explicit", groupStep)).toBe("positional");
    expect(rowNamesAfterRStep("explicit", sortStep)).toBe("explicit");
    expect(keyColumnsAfterRStep(["a", "b"], schema, sortStep)).toEqual([]);
    expect(keyColumnsAfterRStep(["a", "b"], schema, cloneStep)).toEqual(["a", "b"]);

    expect(rowCountAfterRStep(filterStep, 5, rowDiff(2))).toBe(3);
    expect(() => rowCountAfterRStep(filterStep, 5, { ...rowDiff(2), addedRows: 1 })).toThrow("invalid row counts");
    expect(rowIdentityDomainAfterRStep(groupStep, 5, 2)).toBe(7);
    expect(rowIdentityDomainAfterRStep(cloneStep, 5, 2)).toBe(5);
  });

  it("derives formula and group schemas with stable created-output identities", () => {
    expect(
      schemaAfterFormula(schema, {
        id: "formula",
        kind: "formula",
        params: { leftColumn: reference(1), operator: "add", value: 1, newColumn: "total" }
      })
    ).toEqual([
      ...schema,
      {
        id: "c:step:formula:0",
        name: "total",
        position: 2,
        rawType: "integer",
        type: "integer",
        nullable: true
      }
    ]);
    expect(schemaAfterGroupBy(schema, groupStep)).toEqual([
      { ...schema[0], position: 0 },
      {
        id: "c:step:group:0",
        name: "total",
        position: 1,
        rawType: "integer",
        type: "integer",
        nullable: false
      }
    ]);
    expect(() =>
      schemaAfterGroupBy(schema, {
        ...groupStep,
        params: { ...groupStep.params, aggregations: [{ ...groupStep.params.aggregations[0]!, alias: "group" }] }
      })
    ).toThrow("cannot duplicate a key name");
  });

  it("accepts exact retained by-example identity and rejects substitution", () => {
    const requested: RKernelTransformStep = {
      id: "derive",
      kind: "byExample",
      params: {
        sourceColumns: [reference(0)],
        newColumn: "upper",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "case", style: "upper", input: { kind: "column", column: reference(0) } }
      }
    };
    const retained = {
      ...requested,
      params: { ...requested.params, warnings: [], candidateCount: 1 }
    };
    expect(acceptRetainedByExampleStep(retained, requested, schema)).toEqual(retained);
    expect(() =>
      acceptRetainedByExampleStep(
        { ...retained, params: { ...retained.params, newColumn: "substituted" } },
        requested,
        schema
      )
    ).toThrow("does not match the exact preview request");
  });

  it("validates runtime-derived categorical and custom-code lineage", () => {
    const inputRSchema = frameContract(schema).schema;
    const categoricalStep = {
      id: "encode",
      kind: "oneHotEncode" as const,
      params: { columns: [reference(0)], dropOriginal: true }
    };
    const categoricalSchema: readonly ColumnSchema[] = [
      { ...schema[1]!, position: 0 },
      {
        id: "c:step:encode:0",
        name: "group_alpha",
        position: 1,
        rawType: "integer",
        type: "integer",
        nullable: false
      }
    ];
    expect(dynamicCategoricalSchema(schema, inputRSchema, categoricalStep, frameContract(categoricalSchema))).toEqual(
      categoricalSchema
    );
    expect(() =>
      dynamicCategoricalSchema(
        schema,
        inputRSchema,
        categoricalStep,
        frameContract([{ ...categoricalSchema[0]! }, { ...categoricalSchema[1]!, name: "wrong" }])
      )
    ).toThrow("colliding or reserved categorical output name");

    const customStep = { id: "custom", kind: "customCode" as const, params: { code: "data.frame(group, extra = 1)" } };
    const customSchema: readonly ColumnSchema[] = [
      schema[0]!,
      { id: "c:step:custom:0", name: "extra", position: 1, rawType: "integer", type: "integer", nullable: false }
    ];
    expect(dynamicCustomCodeSchema(schema, customStep, frameContract(customSchema))).toEqual(customSchema);
    expect(() =>
      dynamicCustomCodeSchema(
        schema,
        customStep,
        frameContract([{ ...customSchema[0]!, id: "c:step:custom:0" }, customSchema[1]!])
      )
    ).toThrow("invalid custom-code column lineage");
  });

  it("creates fresh custom-row constraints and enforces exact or ascending order", () => {
    const custom = { id: "custom", kind: "customCode" as const, params: { code: "data.frame(x = 1:2)" } };
    const constraint = customRowIdentityConstraintAfterRStep(custom, undefined, 4, 2);
    expect(constraint).toEqual({ first: 4, endExclusive: 6, order: "exact" });
    expect(() =>
      assertCustomDerivedRowIdentities(frameContract(schema, ["r:r:4", "r:r:5"]), constraint, emptyView)
    ).not.toThrow();
    expect(() =>
      assertCustomDerivedRowIdentities(frameContract(schema, ["r:r:5", "r:r:4"]), constraint, emptyView)
    ).toThrow("outside physical output order");

    const ascending = customRowIdentityConstraintAfterRStep(filterStep, constraint, 6, 1);
    expect(ascending).toEqual({ first: 4, endExclusive: 6, order: "ascending" });
    expect(() =>
      assertCustomDerivedRowIdentities(frameContract(schema, ["r:r:4", "r:r:4"]), ascending, emptyView)
    ).toThrow("duplicate fresh row identities");
    expect(() => assertCustomDerivedRowIdentities(frameContract(schema, ["r:r:3"]), ascending, emptyView)).toThrow(
      "out-of-suffix row identity"
    );
  });
});

function reference(position: number): { id: string; name: string } {
  const column = schema[position] as ColumnSchema;
  return { id: column.id, name: column.name };
}

function rowDiff(removedRows: number): DataDiff {
  return {
    addedRows: 0,
    removedRows,
    addedColumns: [],
    removedColumns: [],
    changedCells: 0,
    cells: [],
    truncated: false
  };
}

function frameContract(columns: readonly ColumnSchema[], rowIds: readonly string[] = []): RFramePageContract {
  const rSchema = columns.map((column): RColumnSchema => ({
    ...column,
    semantics:
      column.rawType === "character"
        ? { kind: "character", classes: ["character"] }
        : { kind: "integer", storageMode: "integer", classes: ["integer"] }
  }));
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: rowIds.length, columns: columns.length },
    frameSemantics: { classes: ["data.frame"], rowNames: "automatic", keyColumnIds: [] },
    schema: rSchema,
    page: {
      offset: 0,
      limit: Math.max(1, rowIds.length),
      totalRows: rowIds.length,
      columnOffset: 0,
      columnLimit: columns.length,
      columnIds: columns.map((column) => column.id),
      rows: rowIds.map((id, rowNumber) => ({ id, rowNumber, values: [] }))
    }
  };
}

const schema = Object.freeze([
  Object.freeze({ id: "a", name: "group", position: 0, rawType: "character", type: "string" as const, nullable: true }),
  Object.freeze({ id: "b", name: "count", position: 1, rawType: "integer", type: "integer" as const, nullable: true })
]);

const sortStep = {
  id: "sort",
  kind: "sortRows" as const,
  params: { rules: [{ column: { id: "a", name: "group" }, direction: "asc" as const, nulls: "last" as const }] }
};
const filterStep = { id: "filter", kind: "filterRows" as const, params: { filterModel: { filters: [], sort: [] } } };
const cloneStep = {
  id: "clone",
  kind: "cloneColumn" as const,
  params: { column: { id: "a", name: "group" }, newName: "copy" }
};
const groupStep = {
  id: "group",
  kind: "groupBy" as const,
  params: {
    keys: [{ id: "a", name: "group" }],
    aggregations: [{ column: { id: "b", name: "count" }, operation: "sum" as const, alias: "total" }]
  }
};
const emptyView = Object.freeze({ filters: Object.freeze([]), sorts: Object.freeze([]) });
