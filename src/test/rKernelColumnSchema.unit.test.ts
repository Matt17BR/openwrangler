import { describe, expect, it } from "vitest";
import type {
  CastColumnTransformStep,
  CloneColumnTransformStep,
  ColumnSchema,
  DropColumnsTransformStep,
  FillMissingValuesTransformStep,
  FindReplaceTransformStep,
  SelectColumnsTransformStep,
  TextLengthTransformStep
} from "../shared/protocol";
import {
  reconcileFilterModelById,
  schemaAfterCast,
  schemaAfterClone,
  schemaAfterDrop,
  schemaAfterFillMissing,
  schemaAfterSelect,
  schemaAfterTextLength,
  schemaAfterTextTransform
} from "../extension/r/rKernelColumnSchema";

describe("R kernel column schema evolution", () => {
  it("validates fill compatibility and data.table key ownership", () => {
    const step: FillMissingValuesTransformStep = {
      id: "fill",
      kind: "fillMissingValues",
      params: { column: reference(0), replacement: { kind: "mean" } }
    };

    expect(schemaAfterFillMissing(schema, step, [])).toEqual([
      { ...schema[0]!, nullable: false },
      schema[1],
      schema[2]
    ]);
    expect(() => schemaAfterFillMissing(schema, step, ["r:c:0"])).toThrow("data.table key column");
    expect(() =>
      schemaAfterFillMissing(
        schema,
        { ...step, params: { ...step.params, replacement: { kind: "string", value: "wrong" } } },
        []
      )
    ).toThrow("incompatible with R double");
  });

  it("requires independent interpolation and directional ordering columns", () => {
    const base: FillMissingValuesTransformStep = {
      id: "fill",
      kind: "fillMissingValues",
      params: {
        column: reference(0),
        replacement: { kind: "linearInterpolation", coordinate: reference(2), maxGap: 4 }
      }
    };
    expect(schemaAfterFillMissing(schema, base, [])).toEqual(schema);
    expect(() =>
      schemaAfterFillMissing(
        schema,
        { ...base, params: { ...base.params, replacement: { kind: "linearInterpolation", coordinate: reference(0) } } },
        []
      )
    ).toThrow("cannot also be the interpolation coordinate");
    expect(() =>
      schemaAfterFillMissing(
        schema,
        {
          ...base,
          params: {
            ...base.params,
            replacement: {
              kind: "directional",
              direction: "forward",
              orderBy: [{ column: reference(0), direction: "asc", nulls: "last" }]
            }
          }
        },
        []
      )
    ).toThrow("cannot also be a directional ordering column");
  });

  it("maps safe native R casts without relaxing key or raw-type checks", () => {
    const cast: CastColumnTransformStep = {
      id: "cast",
      kind: "castColumn",
      params: { column: reference(1), dtype: "string" }
    };
    const factorSchema = schema.map((column) =>
      column.id === "r:c:1" ? { ...column, rawType: "ordered factor" } : column
    );
    expect(schemaAfterCast(factorSchema, cast, [])[1]).toEqual({ ...factorSchema[1]!, rawType: "character" });
    expect(() => schemaAfterCast(factorSchema, cast, ["r:c:1"])).toThrow("key column");
    expect(() =>
      schemaAfterCast(
        [{ ...schema[0]!, rawType: "list", type: "list" }],
        { ...cast, params: { column: reference(0), dtype: "float" } },
        []
      )
    ).toThrow("cannot safely convert R list values");
  });

  it("owns deterministic derived text, length, and clone identities", () => {
    const find: FindReplaceTransformStep = {
      id: "find",
      kind: "findReplace",
      params: { column: reference(1), find: "a", replacement: "b", newColumn: "clean_group" }
    };
    expect(schemaAfterTextTransform(schema, find, []).at(-1)).toEqual({
      id: "c:step:find:0",
      name: "clean_group",
      position: 3,
      rawType: "character",
      type: "string",
      nullable: false
    });
    expect(() =>
      schemaAfterTextTransform(schema, { ...find, params: { ...find.params, newColumn: "value" } }, [])
    ).toThrow("already exists");

    const length: TextLengthTransformStep = {
      id: "length",
      kind: "textLength",
      params: { column: reference(1), newColumn: "group_length" }
    };
    expect(schemaAfterTextLength(schema, length).at(-1)?.id).toBe("c:step:length:0");

    const clone: CloneColumnTransformStep = {
      id: "clone",
      kind: "cloneColumn",
      params: { column: reference(2), newName: "count_copy" }
    };
    expect(schemaAfterClone(schema, clone).at(-1)).toMatchObject({
      id: "c:step:clone:0",
      name: "count_copy",
      rawType: "integer",
      type: "integer"
    });
  });

  it("preserves selected order and refuses repeated or drop-all identities", () => {
    const select: SelectColumnsTransformStep = {
      id: "select",
      kind: "selectColumns",
      params: { columns: [reference(2), reference(0)] }
    };
    expect(schemaAfterSelect(schema, select).map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "r:c:2", position: 0 },
      { id: "r:c:0", position: 1 }
    ]);
    expect(() => schemaAfterSelect(schema, { ...select, params: { columns: [reference(0), reference(0)] } })).toThrow(
      "repeated R column identity"
    );

    const drop: DropColumnsTransformStep = {
      id: "drop",
      kind: "dropColumns",
      params: { columns: [reference(1)] }
    };
    expect(schemaAfterDrop(schema, drop).map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "r:c:0", position: 0 },
      { id: "r:c:2", position: 1 }
    ]);
    expect(() =>
      schemaAfterDrop(schema, { ...drop, params: { columns: [reference(0), reference(1), reference(2)] } })
    ).toThrow("leave at least one visible R column");
  });

  it("reconciles viewing state only through unique stable identities", () => {
    const model = {
      filters: [{ column: "group", type: "string" as const, predicates: [] }],
      sort: [{ column: "count", direction: "desc" as const, nulls: "last" as const }]
    };
    const renamed = schema.map((column) => (column.id === "r:c:1" ? { ...column, name: "category" } : column));
    expect(reconcileFilterModelById(model, schema, renamed)).toEqual({
      filters: [{ column: "category", type: "string", predicates: [] }],
      sort: [{ column: "count", direction: "desc", nulls: "last" }]
    });
    expect(
      reconcileFilterModelById(model, schema, [...renamed, { ...renamed[0]!, id: "duplicate", name: "category" }])
    ).toEqual({ filters: [], sort: [{ column: "count", direction: "desc", nulls: "last" }] });
  });
});

function reference(position: number): { id: string; name: string } {
  const column = schema[position] as ColumnSchema;
  return { id: column.id, name: column.name };
}

const schema = Object.freeze([
  Object.freeze({ id: "r:c:0", name: "value", position: 0, rawType: "double", type: "float" as const, nullable: true }),
  Object.freeze({
    id: "r:c:1",
    name: "group",
    position: 1,
    rawType: "character",
    type: "string" as const,
    nullable: false
  }),
  Object.freeze({
    id: "r:c:2",
    name: "count",
    position: 2,
    rawType: "integer",
    type: "integer" as const,
    nullable: true
  })
]);
