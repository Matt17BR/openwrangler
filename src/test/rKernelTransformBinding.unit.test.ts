import { describe, expect, it } from "vitest";
import type {
  ByExampleTransformStep,
  ColumnSchema,
  FillMissingReplacement,
  FillMissingValuesTransformStep,
  FilterRowsTransformStep,
  RoundNumberTransformStep,
  SortRowsTransformStep
} from "../shared/protocol";
import {
  bindRByExampleProgram,
  bindRByExampleStep,
  copyFillMissingReplacement,
  isRNumericRoundingStep,
  rTransformStep
} from "../extension/r/rKernelTransformBinding";

describe("R kernel transform binding", () => {
  it("binds viewing-independent sort and filter steps to frozen stable identities", () => {
    const sort: SortRowsTransformStep = {
      id: "sort",
      kind: "sortRows",
      params: { rules: [{ column: reference(2), direction: "desc", nulls: "last" }] }
    };
    const filter: FilterRowsTransformStep = {
      id: "filter",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [
            {
              column: reference(0),
              type: "float",
              predicates: [{ kind: "predicate", operator: "gt", value: 1 }]
            }
          ],
          sort: []
        }
      }
    };

    expect(rTransformStep(sort, schema)).toEqual({
      id: "sort",
      kind: "sortRows",
      params: { rules: [{ column: reference(2), direction: "desc", nulls: "last" }] }
    });
    const boundFilter = rTransformStep(filter, schema);
    expect(boundFilter).toEqual({
      id: "filter",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [
            {
              column: reference(0),
              type: "float",
              predicates: [{ kind: "predicate", operator: "gt", value: 1 }]
            }
          ],
          sort: []
        }
      }
    });
    expect(Object.isFrozen(boundFilter)).toBe(true);
    expect(Object.isFrozen(boundFilter.params)).toBe(true);
  });

  it("fails closed on repeated, stale, and private row-reduction columns", () => {
    expect(() =>
      rTransformStep(
        {
          id: "dedupe",
          kind: "dropDuplicates",
          params: { columns: [reference(1), reference(1)] }
        },
        schema
      )
    ).toThrow("same R column more than once");
    expect(() =>
      rTransformStep(
        { id: "missing", kind: "dropMissingRows", params: { columns: [{ id: "stale", name: "group" }] } },
        schema
      )
    ).toThrow("no longer matches");
    const privateColumn: ColumnSchema = {
      ...schema[0]!,
      id: "private",
      name: "__open_wrangler_internal_row_id_1"
    };
    expect(() =>
      rTransformStep(
        {
          id: "private-drop",
          kind: "dropMissingRows",
          params: { columns: [{ id: privateColumn.id, name: privateColumn.name }] }
        },
        [privateColumn]
      )
    ).toThrow("reserved private row-identity");
  });

  it("deep-copies and freezes structured fill replacements before transport", () => {
    const replacement: FillMissingReplacement = {
      kind: "directional",
      direction: "forward",
      orderBy: [{ column: reference(2), direction: "asc", nulls: "last" }],
      maxGap: 3
    };
    const copied = copyFillMissingReplacement(replacement);
    expect(copied).toEqual(replacement);
    expect(copied).not.toBe(replacement);
    if (copied.kind !== "directional") throw new Error("Expected directional replacement.");
    expect(copied.orderBy).not.toBe(replacement.orderBy);
    expect(copied.orderBy[0]?.column).not.toBe(replacement.orderBy[0]?.column);

    const step: FillMissingValuesTransformStep = {
      id: "fill",
      kind: "fillMissingValues",
      params: { column: reference(0), replacement }
    };
    const bound = rTransformStep(step, schema);
    expect(bound).toEqual({
      id: "fill",
      kind: "fillMissingValues",
      params: { column: reference(0), replacement }
    });
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.params)).toBe(true);
    if (bound.kind !== "fillMissingValues" || bound.params.replacement.kind !== "directional") {
      throw new Error("Expected bound directional replacement.");
    }
    expect(Object.isFrozen(bound.params.replacement.orderBy)).toBe(true);
  });

  it("normalizes bounded by-example sources, examples, and programs", () => {
    const step: ByExampleTransformStep = {
      id: "by-example",
      kind: "byExample",
      params: {
        sourceColumns: [reference(1)],
        newColumn: "count_copy",
        examples: [
          { inputs: [1], output: 1 },
          { inputs: [2], output: 2 }
        ],
        program: { kind: "column", column: reference(1) }
      }
    };
    const bound = bindRByExampleStep(step, schema);
    expect(bound).toEqual(step);
    expect(bound).not.toBe(step);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.params.sourceColumns)).toBe(true);
    expect(Object.isFrozen(bound.params.examples)).toBe(true);
    expect(Object.isFrozen(bound.params.program)).toBe(true);

    expect(() =>
      bindRByExampleStep({ ...step, params: { ...step.params, sourceColumns: [reference(1), reference(1)] } }, schema)
    ).toThrow("malformed or exceed their bounded public contract");
    expect(() =>
      bindRByExampleStep(
        { ...step, params: { ...step.params, newColumn: "__open_wrangler_internal_row_id_output" } },
        schema
      )
    ).toThrow("reserved private namespace");
  });

  it("rejects nonportable by-example programs before native dispatch", () => {
    const sourceById = new Map(schema.map((column) => [column.id, column]));
    const selected = new Set(["r:c:2"]);
    expect(() =>
      bindRByExampleProgram(
        {
          kind: "concat",
          parts: [
            { kind: "column", column: reference(2) },
            { kind: "literal", value: true }
          ]
        },
        sourceById,
        selected
      )
    ).toThrow("concat operands must be string, integer, or date");
    expect(() =>
      bindRByExampleProgram({ kind: "literal", value: Number.MAX_SAFE_INTEGER + 1 }, sourceById, selected)
    ).toThrow("outside the safe integer range");
  });

  it("owns the exact numeric-rounding discriminator and transport shape", () => {
    const step: RoundNumberTransformStep = {
      id: "round",
      kind: "roundNumber",
      params: { column: reference(0), decimals: 2, newColumn: "rounded" }
    };
    expect(isRNumericRoundingStep(step)).toBe(true);
    expect(
      isRNumericRoundingStep({ id: "clone", kind: "cloneColumn", params: { column: reference(0), newName: "x" } })
    ).toBe(false);
    expect(rTransformStep(step, schema)).toEqual({
      id: "round",
      kind: "roundNumber",
      params: { column: reference(0), decimals: 2, newColumn: "rounded" }
    });
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
    name: "count",
    position: 1,
    rawType: "integer64",
    type: "integer" as const,
    nullable: true
  }),
  Object.freeze({
    id: "r:c:2",
    name: "group",
    position: 2,
    rawType: "character",
    type: "string" as const,
    nullable: false
  })
]);
