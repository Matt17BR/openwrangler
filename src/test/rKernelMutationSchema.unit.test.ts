import { describe, expect, it } from "vitest";
import type {
  ColumnSchema,
  ConditionalColumnTransformStep,
  MarkDuplicatesTransformStep,
  DataDiff,
  ExtractStructFieldsTransformStep,
  GroupByTransformStep,
  OneHotEncodeTransformStep,
  SortRowsTransformStep
} from "../shared/protocol";
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
  schemaAfterRStep,
  schemaAfterNestedStep
} from "../extension/r/rKernelMutationSchema";

describe("R kernel mutation schema", () => {
  it("derives exact nested scalar metadata and fresh Explode identities without changing siblings", () => {
    const integer64 = { kind: "integer64", storageMode: "double", classes: ["integer64"] } as const;
    const factor = {
      kind: "factor",
      storageMode: "integer",
      classes: ["ordered", "factor"],
      ordered: true,
      levels: ["b", "a"]
    } as const;
    const nested: readonly RColumnSchema[] = [
      {
        id: "r:c:0",
        name: "id",
        position: 0,
        rawType: "integer",
        type: "integer",
        nullable: false,
        semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
      },
      {
        id: "r:c:1",
        name: "items",
        position: 1,
        rawType: "list",
        type: "list",
        nullable: true,
        semantics: { kind: "list", storageMode: "list", classes: ["list"], element: integer64 }
      },
      {
        id: "r:c:2",
        name: "record",
        position: 2,
        rawType: "list",
        type: "struct",
        nullable: true,
        semantics: {
          kind: "struct",
          storageMode: "list",
          classes: ["list"],
          fields: [{ name: "__proto__", semantics: factor }]
        }
      }
    ];
    const explode = { id: "explode", kind: "explodeList", params: { column: { id: "r:c:1", name: "items" } } } as const;
    const output = schemaAfterNestedStep(nested, explode);
    expect(output[0]).toEqual(nested[0]);
    expect(output[1]).toMatchObject({
      id: "r:c:1",
      rawType: "integer64",
      type: "integer",
      nullable: true,
      semantics: integer64
    });
    expect(output[2]).toEqual(nested[2]);
    expect(keyColumnsAfterRStep(["r:c:0"], output, explode)).toEqual(["r:c:0"]);
    expect(
      rowCountAfterRStep(explode, 3, {
        ...{
          addedRows: 0,
          removedRows: 0,
          addedColumns: [],
          removedColumns: [],
          changedCells: 0,
          cells: [],
          truncated: false
        },
        addedRows: 5,
        removedRows: 3
      })
    ).toBe(5);
    expect(rowIdentityDomainAfterRStep(explode, 8, 5)).toBe(13);
    expect(customRowIdentityConstraintAfterRStep(explode, undefined, 8, 5)).toEqual({
      first: 8,
      endExclusive: 13,
      order: "exact"
    });
    expect(() =>
      rowCountAfterRStep(explode, 3, {
        ...{
          addedRows: 0,
          removedRows: 0,
          addedColumns: [],
          removedColumns: [],
          changedCells: 0,
          cells: [],
          truncated: false
        },
        addedRows: 2,
        removedRows: 3
      })
    ).toThrow("row counts");
    const extract: ExtractStructFieldsTransformStep = {
      id: "extract",
      kind: "extractStructFields",
      params: { column: { id: "r:c:2", name: "record" }, fields: [{ field: "__proto__", newColumn: "category" }] }
    };
    expect(schemaAfterNestedStep(nested, extract)[3]).toEqual({
      id: "c:step:extract:0",
      name: "category",
      position: 3,
      rawType: "ordered factor",
      type: "string",
      nullable: true,
      semantics: factor
    });
    expect(() =>
      schemaAfterNestedStep(nested, {
        ...extract,
        params: { ...extract.params, fields: [{ field: "missing", newColumn: "x" }] }
      })
    ).toThrow("captured fields");
    expect(() =>
      schemaAfterNestedStep(nested, {
        ...extract,
        params: { ...extract.params, fields: [{ field: "__proto__", newColumn: "id" }] }
      })
    ).toThrow("output names");
    expect(() =>
      schemaAfterNestedStep(
        nested.map((column) =>
          column.id === "r:c:1"
            ? { ...column, semantics: { kind: "list", storageMode: "list", classes: ["list"], element: null } }
            : column
        ),
        explode
      )
    ).toThrow("element type");
  });
  it("declares conditional storage and relevant-arm nullability while retaining keys and rows", () => {
    const step: ConditionalColumnTransformStep = {
      id: "condition",
      kind: "conditionalColumn",
      params: {
        column: reference(1),
        columnType: "integer",
        predicate: { kind: "predicate", operator: "gte", value: 2 },
        newColumn: "flag",
        resultType: "boolean",
        trueValue: true,
        falseValue: false,
        missingValue: null
      }
    };
    const output = schemaAfterRStep(schema, step, ["b"]);
    expect(output).toEqual([
      ...schema,
      { id: "c:step:condition:0", name: "flag", position: 2, type: "boolean", rawType: "logical", nullable: true }
    ]);
    expect(keyColumnsAfterRStep(["b"], output, step)).toEqual(["b"]);
    expect(rowNamesAfterRStep("explicit", step, "r.data.frame", 3)).toBe("explicit");
    const nullary = {
      ...step,
      params: { ...step.params, predicate: { kind: "predicate" as const, operator: "isNull" as const } }
    };
    expect(schemaAfterRStep(schema, nullary, ["b"])[2]?.nullable).toBe(false);
    expect(
      schemaAfterRStep(
        schema,
        { ...nullary, params: { ...nullary.params, resultType: "string", trueValue: "", falseValue: null } },
        ["b"]
      )[2]
    ).toMatchObject({
      rawType: "character",
      type: "string",
      nullable: true
    });
    expect(() => schemaAfterRStep(schema, { ...step, params: { ...step.params, newColumn: "count" } }, [])).toThrow(
      "already exists"
    );
    expect(() => schemaAfterRStep(output, { ...step, params: { ...step.params, newColumn: "other" } }, [])).toThrow(
      "identity already exists"
    );
  });
  it("predicts present logical duplicate flags without copying comparison-column types or changing keys", () => {
    const step: MarkDuplicatesTransformStep = {
      id: "mark",
      kind: "markDuplicates",
      params: { columns: [reference(0), reference(1)], newColumn: "is_duplicate" }
    };
    const actual = schemaAfterRStep(schema, step, ["b"]);
    expect(actual).toEqual([
      ...schema,
      { id: "c:step:mark:0", name: "is_duplicate", position: 2, rawType: "logical", type: "boolean", nullable: false }
    ]);
    expect(keyColumnsAfterRStep(["b"], actual, step)).toEqual(["b"]);
    expect(() => schemaAfterRStep(schema, { ...step, params: { ...step.params, newColumn: "count" } }, [])).toThrow(
      "already exists"
    );
    expect(() =>
      schemaAfterRStep(schema, { ...step, params: { ...step.params, columns: [{ id: "stale", name: "count" }] } }, [])
    ).toThrow("stale or mismatched");
    expect(() => schemaAfterRStep(actual, { ...step, params: { ...step.params, newColumn: "again" } }, [])).toThrow(
      "identity already exists"
    );
  });
  it("predicts an appended integer rank with independent missingness and rejects stale/colliding outputs", () => {
    const step = {
      id: "rank",
      kind: "denseRank",
      params: { column: reference(1), direction: "asc", newColumn: "rank" }
    } as const;
    const expected: readonly ColumnSchema[] = [
      ...schema,
      { id: "c:step:rank:0", name: "rank", position: 2, rawType: "integer", type: "integer", nullable: false }
    ];
    expect(schemaAfterRStep(schema, step, ["b"])).toEqual(expected);
    expect(keyColumnsAfterRStep(["b"], expected, step)).toEqual(["b"]);
    expect(() => schemaAfterRStep(schema, { ...step, params: { ...step.params, newColumn: "count" } }, [])).toThrow(
      "already exists"
    );
    expect(() =>
      schemaAfterRStep(schema, { ...step, params: { ...step.params, column: { id: "missing", name: "count" } } }, [])
    ).toThrow("no longer matches");
    expect(() => schemaAfterRStep(schema, { ...step, params: { ...step.params, column: reference(0) } }, [])).toThrow(
      "numeric"
    );
    expect(() => schemaAfterRStep(expected, { ...step, params: { ...step.params, newColumn: "second" } }, [])).toThrow(
      "identity already exists"
    );
  });
  it("routes static schema changes and owns row/key transitions", () => {
    const renamed = schemaAfterRStep(
      schema,
      { id: "rename", kind: "renameColumn", params: { column: reference(0), newName: "category" } },
      []
    );
    expect(renamed).toEqual([{ ...schema[0], name: "category" }, schema[1]]);
    expect(renamed).not.toBe(schema);

    const castInput: readonly ColumnSchema[] = [
      { id: "a", name: "group", position: 0, rawType: "character", type: "string", nullable: true },
      { id: "b", name: "count", position: 1, rawType: "double", type: "float", nullable: true }
    ];
    expect(
      schemaAfterRStep(
        castInput,
        { id: "cast", kind: "castColumn", params: { column: { id: "b", name: "count" }, dtype: "integer" } },
        []
      )
    ).toEqual([
      { id: "a", name: "group", position: 0, rawType: "character", type: "string", nullable: true },
      { id: "b", name: "count", position: 1, rawType: "integer", type: "integer", nullable: true }
    ]);
    expect(castInput).toEqual([
      { id: "a", name: "group", position: 0, rawType: "character", type: "string", nullable: true },
      { id: "b", name: "count", position: 1, rawType: "double", type: "float", nullable: true }
    ]);

    expect(rowNamesAfterRStep("explicit", groupStep, "r.data.frame", 3)).toBe("positional");
    expect(rowNamesAfterRStep("explicit", sortStep, "r.data.frame", 3)).toBe("explicit");
    expect(keyColumnsAfterRStep(["a", "b"], schema, sortStep)).toEqual([]);
    expect(keyColumnsAfterRStep(["a", "b"], schema, cloneStep)).toEqual(["a", "b"]);

    expect(rowCountAfterRStep(filterStep, 5, rowDiff(2))).toBe(3);
    expect(() => rowCountAfterRStep(filterStep, 5, { ...rowDiff(2), addedRows: 1 })).toThrow("invalid row counts");
    expect(rowIdentityDomainAfterRStep(groupStep, 5, 2)).toBe(7);
    expect(rowIdentityDomainAfterRStep(cloneStep, 5, 2)).toBe(5);
  });

  it.each([
    sortStep,
    filterStep,
    { id: "missing", kind: "dropMissingRows", params: { how: "any" } },
    { id: "duplicates", kind: "dropDuplicates", params: { keep: "first" } }
  ] as const)("predicts native $kind row-name mode from flavor and full result size", (step) => {
    expect(rowNamesAfterRStep("positional", step, "r.data.frame", 3)).toBe("explicit");
    expect(rowNamesAfterRStep("explicit", step, "r.data.frame", 3)).toBe("explicit");
    for (const flavor of ["r.tibble", "r.data.table"] as const) {
      expect(rowNamesAfterRStep("explicit", step, flavor, 2)).toBe("positional");
      expect(rowNamesAfterRStep("positional", step, flavor, 2)).toBe("positional");
    }
    for (const flavor of ["r.data.frame", "r.tibble", "r.data.table"] as const) {
      expect(rowNamesAfterRStep("explicit", step, flavor, 0)).toBe("explicit");
      expect(rowNamesAfterRStep("positional", step, flavor, 0)).toBe("positional");
    }
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

  it("predicts only exactly representable R Formula integer text without changing legacy numbers", () => {
    for (const [value, rawType] of [
      ["0", "integer"],
      ["2147483647", "integer"],
      ["-2147483647", "integer"],
      ["-2147483648", "double"],
      ["2147483648", "double"],
      ["1152921504606846976", "double"],
      ["1267650600228229401496703205376", "double"],
      [2, "integer"],
      [0.5, "double"],
      [2 ** 60, "double"]
    ] as const) {
      for (const leftType of ["integer", "double", "integer64"] as const) {
        const input = [{ ...schema[1]!, rawType: leftType }];
        const output = schemaAfterFormula(input, {
          id: "literal",
          kind: "formula",
          params: { leftColumn: reference(1), operator: "add", value, newColumn: "result" }
        });
        const expected = leftType === "double" || rawType === "double" ? "double" : leftType;
        expect(output.at(-1)?.rawType).toBe(expected);
        expect(input).toEqual([{ ...schema[1]!, rawType: leftType }]);
      }
    }
    for (const value of ["9007199254740993", "1152921504606847000", "1267650600228229401496703205377"]) {
      expect(() =>
        schemaAfterFormula(schema, {
          id: "literal",
          kind: "formula",
          params: { leftColumn: reference(1), operator: "add", value, newColumn: "result" }
        })
      ).toThrow("represented exactly");
    }
    for (const value of ["-0", "+2", "02", "2\n", "2.5", "1e2", "9".repeat(309)]) {
      expect(() =>
        schemaAfterFormula(schema, {
          id: "literal",
          kind: "formula",
          params: { leftColumn: reference(1), operator: "add", value, newColumn: "result" }
        })
      ).toThrow("Formula requires");
    }
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
    const categoricalStep: OneHotEncodeTransformStep = {
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
  const rSchema = columns.map((column): RColumnSchema => {
    if (column.type === "string") {
      return {
        ...column,
        type: "string",
        semantics: { kind: "character", storageMode: "character", classes: ["character"] }
      };
    }
    if (column.type === "integer") {
      return {
        ...column,
        type: "integer",
        semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
      };
    }
    throw new Error(`Unsupported R test column type: ${column.type}`);
  });
  return {
    contractVersion: 7,
    dataframeFlavor: "r.data.frame",
    shape: { rows: rowIds.length, columns: columns.length },
    frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
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

const sortStep: SortRowsTransformStep = {
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
const groupStep: GroupByTransformStep = {
  id: "group",
  kind: "groupBy" as const,
  params: {
    keys: [{ id: "a", name: "group" }],
    aggregations: [{ column: { id: "b", name: "count" }, operation: "sum" as const, alias: "total" }]
  }
};
const emptyView = Object.freeze({ filters: Object.freeze([]), sorts: Object.freeze([]) });
