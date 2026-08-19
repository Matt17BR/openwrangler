import { describe, expect, it } from "vitest";
import type { ColumnReference, ColumnSchema, OperationKind, TransformStep } from "../shared/protocol";
import { savedStepEditError } from "../webviews/operations/savedStepEditValidation";

const text = { id: "c:text", name: "text" } as const;
const otherText = { id: "c:other-text", name: "other_text" } as const;
const value = { id: "c:value", name: "value" } as const;
const otherValue = { id: "c:other-value", name: "other_value" } as const;
const order = { id: "c:order", name: "order" } as const;
const date = { id: "c:date", name: "date" } as const;
const nested = { id: "c:nested", name: "nested" } as const;
const mystery = { id: "c:mystery", name: "mystery" } as const;
const missing = { id: "c:missing", name: "missing" } as const;

const schema = [
  column(text, 0, "string", "String"),
  column(otherText, 1, "string", "String"),
  column(value, 2, "float", "Float64"),
  column(otherValue, 3, "float", "Float64"),
  column(order, 4, "integer", "Int64"),
  column(date, 5, "date", "Date"),
  column(nested, 6, "list", "List(String)"),
  column(mystery, 7, "unknown", "Null")
] satisfies ColumnSchema[];

function column(
  reference: ColumnReference,
  position: number,
  type: ColumnSchema["type"],
  rawType: string
): ColumnSchema {
  return { ...reference, position, type, rawType, nullable: true };
}

type StepByKind = { [Kind in OperationKind]: Extract<TransformStep, { kind: Kind }> };

const validSteps = {
  sortRows: step("sortRows", { rules: [{ column: text, direction: "asc", nulls: "last" }] }),
  filterRows: step("filterRows", {
    filterModel: {
      filters: [{ column: text, type: "string", predicates: [] }],
      sort: [{ column: value, direction: "desc", nulls: "first" }]
    }
  }),
  dropMissingRows: step("dropMissingRows", { columns: [text], how: "any" }),
  fillMissingValues: step("fillMissingValues", { column: value, replacement: { kind: "median" } }),
  dropDuplicates: step("dropDuplicates", { columns: [text], keep: "first" }),
  selectColumns: step("selectColumns", { columns: [text] }),
  dropColumns: step("dropColumns", { columns: [text] }),
  renameColumn: step("renameColumn", { column: text, newName: "renamed" }),
  cloneColumn: step("cloneColumn", { column: text, newName: "copy" }),
  castColumn: step("castColumn", { column: text, dtype: "string" }),
  formula: step("formula", {
    leftColumn: value,
    rightColumn: otherValue,
    operator: "add",
    newColumn: "total"
  }),
  textLength: step("textLength", { column: text, newColumn: "length" }),
  oneHotEncode: step("oneHotEncode", { columns: [text] }),
  multiLabelBinarize: step("multiLabelBinarize", { column: text, delimiter: "," }),
  findReplace: step("findReplace", { column: text, find: "a", replacement: "b" }),
  stripText: step("stripText", { column: text }),
  splitText: step("splitText", { column: text, delimiter: ",", index: 0, newColumn: "part" }),
  splitTextColumns: step("splitTextColumns", {
    column: text,
    delimiter: ",",
    newColumns: ["first", "second"]
  }),
  pivotLonger: step("pivotLonger", {
    columns: [text, otherText],
    labelColumn: "variable",
    valueColumn: "reading"
  }),
  pivotWider: step("pivotWider", {
    namesFrom: text,
    valuesFrom: value,
    outputs: [
      {
        key: {
          kind: "typedSelection",
          version: 1,
          columnType: "string",
          cell: { kind: "string", raw: "a", display: "a", isNull: false, isNaN: false }
        },
        name: "a_value"
      },
      {
        key: {
          kind: "typedSelection",
          version: 1,
          columnType: "string",
          cell: { kind: "string", raw: "b", display: "b", isNull: false, isNaN: false }
        },
        name: "b_value"
      }
    ]
  }),
  extractRegexGroup: step("extractRegexGroup", {
    column: text,
    pattern: "([A-Za-z]+)",
    group: 1,
    newColumn: "word"
  }),
  capitalizeText: step("capitalizeText", { column: text }),
  lowerText: step("lowerText", { column: text }),
  upperText: step("upperText", { column: text }),
  minMaxScale: step("minMaxScale", { column: value }),
  roundNumber: step("roundNumber", { column: value, decimals: 2 }),
  floorNumber: step("floorNumber", { column: value }),
  ceilNumber: step("ceilNumber", { column: value }),
  formatDatetime: step("formatDatetime", { column: date, format: "%Y-%m-%d" }),
  groupBy: step("groupBy", {
    keys: [text],
    aggregations: [{ column: value, operation: "sum", alias: "total" }]
  }),
  byExample: step("byExample", {
    sourceColumns: [text],
    newColumn: "example",
    examples: [
      { inputs: ["a"], output: "A" },
      { inputs: ["b"], output: "B" }
    ],
    program: { kind: "case", style: "upper", input: { kind: "column", column: text } }
  }),
  customCode: step("customCode", { code: "result = df" })
} satisfies StepByKind;

function step<Kind extends OperationKind>(
  kind: Kind,
  params: Extract<TransformStep, { kind: Kind }>["params"]
): Extract<TransformStep, { kind: Kind }> {
  return { id: `step-${kind}`, kind, params } as Extract<TransformStep, { kind: Kind }>;
}

describe("savedStepEditError", () => {
  it.each(Object.values(validSteps))("accepts a valid saved $kind operation", (savedStep) => {
    expect(savedStepEditError(savedStep, schema)).toBeUndefined();
  });

  it("requires the recorded schema and rejects duplicate schema identities", () => {
    expect(savedStepEditError(validSteps.renameColumn, undefined)).toContain("recorded input schema is unavailable");
    expect(savedStepEditError(validSteps.renameColumn, [schema[0], { ...schema[1], id: schema[0].id }])).toContain(
      "recorded input schema contains duplicate column IDs"
    );
  });

  it.each([
    ["sort rules", step("sortRows", { rules: [{ column: missing, direction: "asc", nulls: "last" }] }), "sort rule 1"],
    [
      "filters",
      step("filterRows", {
        filterModel: { filters: [{ column: missing, type: "string", predicates: [] }], sort: [] }
      }),
      "filter 1"
    ],
    [
      "filter-step sorts",
      step("filterRows", {
        filterModel: {
          filters: [],
          sort: [{ column: missing, direction: "asc", nulls: "last" }]
        }
      }),
      "filter-step sort 1"
    ],
    ["optional column lists", step("dropMissingRows", { columns: [missing] }), "column 1"],
    ["drop-duplicates lists", step("dropDuplicates", { columns: [missing] }), "column 1"],
    ["select lists", step("selectColumns", { columns: [missing] }), "column 1"],
    ["drop lists", step("dropColumns", { columns: [missing] }), "column 1"],
    ["encoding lists", step("oneHotEncode", { columns: [missing] }), "column 1"],
    [
      "formula operands",
      step("formula", { leftColumn: value, rightColumn: missing, operator: "add", newColumn: "total" }),
      "right formula column"
    ],
    ["fill targets", step("fillMissingValues", { column: missing, replacement: { kind: "median" } }), "fill target"],
    [
      "fill fallbacks",
      step("fillMissingValues", {
        column: text,
        replacement: { kind: "fallbackColumns", columns: [missing] }
      }),
      "fallback column 1"
    ],
    [
      "fill group keys",
      step("fillMissingValues", {
        column: value,
        replacement: { kind: "groupedStatistic", statistic: "median", keys: [missing] }
      }),
      "group key 1"
    ],
    [
      "fill calculation order",
      step("fillMissingValues", {
        column: text,
        replacement: {
          kind: "directional",
          direction: "forward",
          orderBy: [{ column: missing, direction: "asc", nulls: "last" }]
        }
      }),
      "calculation order 1"
    ],
    [
      "fill interpolation coordinate",
      step("fillMissingValues", {
        column: value,
        replacement: { kind: "linearInterpolation", coordinate: missing }
      }),
      "interpolation coordinate"
    ],
    ["single input columns", step("renameColumn", { column: missing, newName: "renamed" }), "input column"],
    [
      "group keys",
      step("groupBy", {
        keys: [missing],
        aggregations: [{ column: value, operation: "sum", alias: "total" }]
      }),
      "group key 1"
    ],
    [
      "aggregation values",
      step("groupBy", {
        keys: [text],
        aggregations: [{ column: missing, operation: "sum", alias: "total" }]
      }),
      "aggregation value 1"
    ],
    [
      "by-example sources",
      step("byExample", {
        sourceColumns: [missing],
        newColumn: "example",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "literal", value: "A" }
      }),
      "by-example source 1"
    ],
    [
      "by-example program operands",
      step("byExample", {
        sourceColumns: [text],
        newColumn: "example",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "column", column: missing }
      }),
      "by-example program operand 1"
    ]
  ] satisfies [caseName: string, savedStep: TransformStep, message: string][])(
    "checks missing references in %s",
    (_caseName, savedStep, message) => {
      expect(savedStepEditError(savedStep, schema)).toContain(`saved ${message} refers to column ID “c:missing”`);
    }
  );

  it("rejects saved-reference name and filter-type mismatches", () => {
    expect(
      savedStepEditError(step("renameColumn", { column: { ...text, name: "old_name" }, newName: "renamed" }), schema)
    ).toContain("expects column name “old_name”");
    expect(
      savedStepEditError(
        step("filterRows", {
          filterModel: { filters: [{ column: value, type: "string", predicates: [] }], sort: [] }
        }),
        schema
      )
    ).toContain("declares type “string”, but its recorded input column has type “float”");
  });

  it.each([
    [
      "sort rules",
      step("sortRows", {
        rules: [
          { column: text, direction: "asc", nulls: "last" },
          { column: text, direction: "desc", nulls: "first" }
        ]
      })
    ],
    [
      "filters",
      step("filterRows", {
        filterModel: {
          filters: [
            { column: text, type: "string", predicates: [] },
            { column: text, type: "string", predicates: [] }
          ],
          sort: []
        }
      })
    ],
    [
      "filter-step sorts",
      step("filterRows", {
        filterModel: {
          filters: [],
          sort: [
            { column: value, direction: "asc", nulls: "last" },
            { column: value, direction: "desc", nulls: "first" }
          ]
        }
      })
    ],
    ["column list", step("oneHotEncode", { columns: [text, text] })],
    [
      "fill columns",
      step("fillMissingValues", {
        column: text,
        replacement: { kind: "fallbackColumns", columns: [text] }
      })
    ],
    [
      "group keys",
      step("groupBy", {
        keys: [text, text],
        aggregations: [{ column: value, operation: "sum", alias: "total" }]
      })
    ],
    [
      "by-example sources",
      step("byExample", {
        sourceColumns: [text, text],
        newColumn: "example",
        examples: [
          { inputs: ["a", "a"], output: "A" },
          { inputs: ["b", "b"], output: "B" }
        ],
        program: { kind: "column", column: text }
      })
    ]
  ] satisfies [group: string, savedStep: TransformStep][])(
    "rejects duplicate identities within %s",
    (group, savedStep) => {
      expect(savedStepEditError(savedStep, schema)).toContain(`saved ${group} repeats column ID`);
    }
  );

  it("permits repeated formula operands and aggregation inputs where repetition is meaningful", () => {
    expect(
      savedStepEditError(
        step("formula", { leftColumn: value, rightColumn: value, operator: "add", newColumn: "doubled" }),
        schema
      )
    ).toBeUndefined();
    expect(
      savedStepEditError(
        step("groupBy", {
          keys: [text],
          aggregations: [
            { column: value, operation: "sum", alias: "total" },
            { column: value, operation: "mean", alias: "average" }
          ]
        }),
        schema
      )
    ).toBeUndefined();
  });

  it.each([
    [
      "formula left operand",
      step("formula", { leftColumn: text, rightColumn: otherValue, operator: "add", newColumn: "total" }),
      "left formula column",
      "formula inputs must be numeric"
    ],
    [
      "formula right operand",
      step("formula", { leftColumn: value, rightColumn: text, operator: "add", newColumn: "total" }),
      "right formula column",
      "formula inputs must be numeric"
    ],
    ["text length", step("textLength", { column: value, newColumn: "length" }), "input column", "string column"],
    [
      "multi-label encoding",
      step("multiLabelBinarize", { column: value, delimiter: "," }),
      "input column",
      "string column"
    ],
    [
      "find and replace",
      step("findReplace", { column: value, find: "a", replacement: "b" }),
      "input column",
      "string column"
    ],
    ["strip text", step("stripText", { column: value }), "input column", "string column"],
    [
      "split text",
      step("splitText", { column: value, delimiter: ",", index: 0, newColumn: "part" }),
      "input column",
      "string column"
    ],
    ["capitalize text", step("capitalizeText", { column: value }), "input column", "string column"],
    ["lower text", step("lowerText", { column: value }), "input column", "string column"],
    ["upper text", step("upperText", { column: value }), "input column", "string column"],
    ["min-max scale", step("minMaxScale", { column: text }), "input column", "numeric operation"],
    ["round number", step("roundNumber", { column: text, decimals: 2 }), "input column", "numeric operation"],
    ["floor number", step("floorNumber", { column: text }), "input column", "numeric operation"],
    ["ceil number", step("ceilNumber", { column: text }), "input column", "numeric operation"],
    [
      "format datetime",
      step("formatDatetime", { column: text, format: "%Y-%m-%d" }),
      "input column",
      "date or datetime"
    ],
    ["one-hot encoding", step("oneHotEncode", { columns: [nested] }), "column 1", "portable scalar"],
    [
      "group key",
      step("groupBy", {
        keys: [nested],
        aggregations: [{ column: value, operation: "sum", alias: "total" }]
      }),
      "group key 1",
      "portable scalar"
    ],
    [
      "by-example source",
      step("byExample", {
        sourceColumns: [nested],
        newColumn: "example",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "column", column: nested }
      }),
      "by-example source 1",
      "portable scalar"
    ]
  ] satisfies [caseName: string, savedStep: TransformStep, reference: string, requirement: string][])(
    "rejects operation/type mismatch: %s",
    (_caseName, savedStep, reference, requirement) => {
      const error = savedStepEditError(savedStep, schema);
      expect(error).toContain(`saved ${reference} uses a recorded`);
      expect(error).toContain(requirement);
    }
  );

  it.each([
    ["sum", text],
    ["mean", text],
    ["median", text],
    ["min", nested],
    ["max", nested],
    ["count", nested],
    ["nUnique", nested],
    ["first", nested],
    ["last", nested]
  ] as const)("rejects a %s aggregation whose saved input type is incompatible", (operation, reference) => {
    const error = savedStepEditError(
      step("groupBy", {
        keys: [text],
        aggregations: [{ column: reference, operation, alias: "result" }]
      }),
      schema
    );
    expect(error).toContain("saved aggregation value 1 uses a recorded");
    expect(error).toContain(`the ${operation} aggregation does not support that column type`);
  });

  it.each([
    [
      "fallback type mismatch",
      step("fillMissingValues", {
        column: text,
        replacement: { kind: "fallbackColumns", columns: [value] }
      }),
      "not compatible with the recorded string target"
    ],
    [
      "unorderable directional key",
      step("fillMissingValues", {
        column: text,
        replacement: {
          kind: "directional",
          direction: "forward",
          orderBy: [{ column: nested, direction: "asc", nulls: "last" }]
        }
      }),
      "cannot be ordered safely"
    ],
    [
      "non-float interpolation target",
      step("fillMissingValues", {
        column: order,
        replacement: { kind: "linearInterpolation", coordinate: date }
      }),
      "interpolation target is not a floating-point column"
    ],
    [
      "unsafe interpolation coordinate",
      step("fillMissingValues", {
        column: value,
        replacement: { kind: "linearInterpolation", coordinate: text }
      }),
      "interpolation coordinate cannot be used safely"
    ],
    [
      "unusable grouped key",
      step("fillMissingValues", {
        column: value,
        replacement: { kind: "groupedStatistic", statistic: "mean", keys: [nested] }
      }),
      "cannot be used for grouped filling"
    ]
  ] satisfies [caseName: string, savedStep: TransformStep, message: string][])(
    "rejects fill compatibility: %s",
    (_caseName, savedStep, message) => {
      expect(savedStepEditError(savedStep, schema)).toContain(message);
    }
  );

  it.each([
    step("fillMissingValues", {
      column: text,
      replacement: { kind: "fallbackColumns", columns: [otherText] }
    }),
    step("fillMissingValues", {
      column: text,
      replacement: {
        kind: "directional",
        direction: "backward",
        orderBy: [{ column: order, direction: "asc", nulls: "last" }]
      }
    }),
    step("fillMissingValues", {
      column: value,
      replacement: { kind: "linearInterpolation", coordinate: date }
    }),
    step("fillMissingValues", {
      column: value,
      replacement: { kind: "groupedStatistic", statistic: "mean", keys: [text] }
    })
  ])("accepts compatible saved fill references for $params.replacement.kind", (savedStep) => {
    expect(savedStepEditError(savedStep, schema)).toBeUndefined();
  });

  it.each([
    [
      "unsupported target",
      step("fillMissingValues", { column: nested, replacement: { kind: "string", value: "" } }),
      "does not support filling"
    ],
    ["median target", step("fillMissingValues", { column: text, replacement: { kind: "median" } }), "not compatible"],
    ["mean target", step("fillMissingValues", { column: order, replacement: { kind: "mean" } }), "not compatible"],
    [
      "most-frequent target",
      step("fillMissingValues", { column: value, replacement: { kind: "mostFrequent" } }),
      "not compatible"
    ],
    [
      "grouped-median target",
      step("fillMissingValues", {
        column: text,
        replacement: { kind: "groupedStatistic", statistic: "median", keys: [order] }
      }),
      "not compatible"
    ],
    [
      "grouped-mean target",
      step("fillMissingValues", {
        column: order,
        replacement: { kind: "groupedStatistic", statistic: "mean", keys: [text] }
      }),
      "not compatible"
    ],
    [
      "grouped-most-frequent target",
      step("fillMissingValues", {
        column: value,
        replacement: { kind: "groupedStatistic", statistic: "mostFrequent", keys: [text] }
      }),
      "not compatible"
    ],
    [
      "directional target",
      step("fillMissingValues", {
        column: mystery,
        replacement: {
          kind: "directional",
          direction: "forward",
          orderBy: [{ column: order, direction: "asc", nulls: "last" }]
        }
      }),
      "not compatible"
    ],
    [
      "explicit value kind",
      step("fillMissingValues", { column: order, replacement: { kind: "float", value: "1" } }),
      "not compatible"
    ]
  ] satisfies [caseName: string, savedStep: TransformStep, message: string][])(
    "rejects saved fill method/target policy mismatch: %s",
    (_caseName, savedStep, message) => {
      expect(savedStepEditError(savedStep, schema)).toContain(message);
    }
  );

  it("requires a deterministic by-example program and contains every nested operand within selected sources", () => {
    expect(
      savedStepEditError(
        step("byExample", {
          sourceColumns: [text],
          newColumn: "example",
          examples: [
            { inputs: ["a"], output: "A" },
            { inputs: ["b"], output: "B" }
          ]
        }),
        schema
      )
    ).toContain("has no deterministic program");

    const nestedProgramStep = step("byExample", {
      sourceColumns: [text],
      newColumn: "example",
      examples: [
        { inputs: ["a"], output: "A" },
        { inputs: ["b"], output: "B" }
      ],
      program: {
        kind: "concat",
        parts: [
          { kind: "slice", input: { kind: "column", column: text }, start: 0 },
          {
            kind: "arithmetic",
            left: { kind: "literal", value: 1 },
            operator: "add",
            right: { kind: "column", column: otherValue }
          }
        ]
      }
    });
    expect(savedStepEditError(nestedProgramStep, schema)).toContain(
      "column ID “c:other-value” outside its selected sources"
    );
    expect(
      savedStepEditError(
        { ...nestedProgramStep, params: { ...nestedProgramStep.params, sourceColumns: [text, otherValue] } },
        schema
      )
    ).toBeUndefined();
  });

  it("rejects saved regex extraction whose output name cannot hydrate in a single-line control", () => {
    expect(
      savedStepEditError(
        step("extractRegexGroup", {
          column: text,
          pattern: "([A-Za-z]+)",
          group: 1,
          newColumn: "first\nsecond"
        }),
        schema
      )
    ).toContain("single-line Unicode scalar text");
  });

  it("handles custom code explicitly and fails closed for an unknown operation kind", () => {
    expect(savedStepEditError(validSteps.customCode, schema)).toBeUndefined();
    const unknownStep = { id: "future", kind: "futureOperation", params: {} } as unknown as TransformStep;
    expect(savedStepEditError(unknownStep, schema)).toContain("operation kind “futureOperation” is unsupported");
  });
});
