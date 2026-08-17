import { describe, expect, it } from "vitest";
import type {
  ByExampleProgram,
  ColumnSchema,
  FilterRowsTransformStep,
  RetainedTransformStep
} from "../shared/protocol";
import type { RTransformStep } from "../extension/r/rKernelTransformBinding";
import {
  copyByExampleProgram,
  copyRetainedStep,
  copyRTransformStep,
  copyTransformFilterModel,
  retainedKeyPrefix
} from "../extension/r/rKernelTransformState";

describe("R kernel transform state", () => {
  it("deep-copies every nested by-example program branch", () => {
    const program: ByExampleProgram = {
      kind: "arithmetic",
      left: {
        kind: "concat",
        parts: [
          {
            kind: "case",
            style: "upper",
            input: {
              kind: "regexReplace",
              input: { kind: "column", column: reference(0) },
              pattern: "x",
              replacement: "y"
            }
          },
          {
            kind: "datetimeFormat",
            input: {
              kind: "regexExtract",
              input: {
                kind: "split",
                input: { kind: "slice", input: { kind: "column", column: reference(1) }, start: 1, stop: 4 },
                delimiter: "-",
                index: 0
              },
              pattern: "(.*)",
              group: 1
            },
            inputFormat: "%Y-%m-%d",
            outputFormat: "%Y"
          }
        ]
      },
      operator: "add",
      right: { kind: "literal", value: 1 }
    };

    const copied = copyByExampleProgram(program);
    expect(copied).toEqual(program);
    expect(copied).not.toBe(program);
    if (copied.kind !== "arithmetic" || copied.left.kind !== "concat") {
      throw new Error("Expected the copied arithmetic/concat program.");
    }
    expect(copied.left).not.toBe(program.left);
    expect(copied.left.parts).not.toBe((program.left as Extract<ByExampleProgram, { kind: "concat" }>).parts);
    expect(copied.left.parts[0]).not.toBe((program.left as Extract<ByExampleProgram, { kind: "concat" }>).parts[0]);

    expect(() => copyByExampleProgram({ kind: "concat", parts: [] } as unknown as ByExampleProgram)).toThrow(
      "requires at least one part"
    );
  });

  it("deep-copies retained by-example and structured fill state", () => {
    const byExample: RTransformStep = {
      id: "by-example",
      kind: "byExample",
      params: {
        sourceColumns: [reference(0)],
        newColumn: "derived",
        examples: [
          { inputs: ["x"], output: "X" },
          { inputs: ["y"], output: "Y" }
        ],
        program: { kind: "case", style: "upper", input: { kind: "column", column: reference(0) } },
        warnings: ["bounded"],
        candidateCount: 2
      }
    };
    const copiedByExample = copyRTransformStep(byExample);
    expect(copiedByExample).toEqual(byExample);
    expect(copiedByExample).not.toBe(byExample);
    if (copiedByExample.kind !== "byExample" || byExample.kind !== "byExample") {
      throw new Error("Expected retained by-example state.");
    }
    expect(copiedByExample.params.sourceColumns).not.toBe(byExample.params.sourceColumns);
    expect(copiedByExample.params.sourceColumns[0]).not.toBe(byExample.params.sourceColumns[0]);
    expect(copiedByExample.params.examples).not.toBe(byExample.params.examples);
    expect(copiedByExample.params.examples[0]?.inputs).not.toBe(byExample.params.examples[0]?.inputs);
    expect(copiedByExample.params.program).not.toBe(byExample.params.program);
    expect(copiedByExample.params.warnings).not.toBe(byExample.params.warnings);

    const fill: RTransformStep = {
      id: "fill",
      kind: "fillMissingValues",
      params: {
        column: reference(1),
        replacement: {
          kind: "directional",
          direction: "forward",
          orderBy: [{ column: reference(0), direction: "asc", nulls: "last" }],
          maxGap: 3
        }
      }
    };
    const copiedFill = copyRTransformStep(fill);
    expect(copiedFill).toEqual(fill);
    if (copiedFill.kind !== "fillMissingValues" || fill.kind !== "fillMissingValues") {
      throw new Error("Expected fill-missing state.");
    }
    expect(copiedFill.params.column).not.toBe(fill.params.column);
    expect(copiedFill.params.replacement).not.toBe(fill.params.replacement);
    if (copiedFill.params.replacement.kind !== "directional" || fill.params.replacement.kind !== "directional") {
      throw new Error("Expected directional fill state.");
    }
    expect(copiedFill.params.replacement.orderBy).not.toBe(fill.params.replacement.orderBy);
    expect(copiedFill.params.replacement.orderBy[0]?.column).not.toBe(fill.params.replacement.orderBy[0]?.column);
  });

  it("deep-copies filter predicates, selections, sorts, and references", () => {
    const model: FilterRowsTransformStep["params"]["filterModel"] = {
      logic: "or",
      filters: [
        {
          column: reference(0),
          type: "string",
          predicates: [{ kind: "predicate", operator: "contains", value: "x", caseSensitive: true }],
          valueFilter: {
            kind: "values",
            selectedValues: ["x"],
            includeNulls: false,
            includeNaN: false
          }
        }
      ],
      sort: [{ column: reference(1), direction: "desc", nulls: "first" }]
    };

    const copied = copyTransformFilterModel(model);
    expect(copied).toEqual(model);
    expect(copied).not.toBe(model);
    expect(copied.filters).not.toBe(model.filters);
    expect(copied.filters[0]?.column).not.toBe(model.filters[0]?.column);
    expect(copied.filters[0]?.predicates).not.toBe(model.filters[0]?.predicates);
    expect(copied.filters[0]?.predicates[0]).not.toBe(model.filters[0]?.predicates[0]);
    expect(copied.filters[0]?.valueFilter).not.toBe(model.filters[0]?.valueFilter);
    expect(copied.filters[0]?.valueFilter?.selectedValues).not.toBe(model.filters[0]?.valueFilter?.selectedValues);
    expect(copied.sort).not.toBe(model.sort);
    expect(copied.sort[0]?.column).not.toBe(model.sort[0]?.column);
  });

  it("rejects unsupported or incomplete retained state", () => {
    expect(() =>
      copyRetainedStep({ id: "unsupported", kind: "imaginary", params: {} } as unknown as RetainedTransformStep)
    ).toThrow("unsupported cleaning step");
    expect(() =>
      copyRetainedStep({
        id: "incomplete",
        kind: "byExample",
        params: {
          sourceColumns: [reference(0)],
          newColumn: "derived",
          examples: [
            { inputs: ["x"], output: "X" },
            { inputs: ["y"], output: "Y" }
          ],
          program: { kind: "column", column: reference(0) }
        }
      } as RetainedTransformStep)
    ).toThrow("incomplete by-example step");
  });

  it("retains only the contiguous source-key prefix present in the schema", () => {
    expect(retainedKeyPrefix(["a", "b", "c"], schema)).toEqual(["a", "b"]);
    expect(retainedKeyPrefix(["missing", "a"], schema)).toEqual([]);
    expect(retainedKeyPrefix([], schema)).toEqual([]);
  });
});

function reference(position: number): { id: string; name: string } {
  const column = schema[position] as ColumnSchema;
  return { id: column.id, name: column.name };
}

const schema = Object.freeze([
  Object.freeze({ id: "a", name: "text", position: 0, rawType: "character", type: "string" as const, nullable: true }),
  Object.freeze({ id: "b", name: "count", position: 1, rawType: "integer", type: "integer" as const, nullable: true }),
  Object.freeze({ id: "d", name: "other", position: 2, rawType: "double", type: "float" as const, nullable: false })
]);
