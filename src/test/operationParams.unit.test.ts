import { describe, expect, it } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { ColumnSchema, OperationKind, TransformFilterModel } from "../shared/protocol";
import { buildParams, columnReferenceId, type OperationParamsFor } from "../webviews/operations/operationParams";

const city = { id: "c:city", name: "city" } as const;
const sales = { id: "c:sales", name: "sales" } as const;
const when = { id: "c:when", name: "when" } as const;
const units = { id: "c:units", name: "units" } as const;
const profit = { id: "c:profit", name: "profit" } as const;

const schema = [
  column(city, 0, "string", "String"),
  column(sales, 1, "float", "Float64"),
  column(when, 2, "datetime", "Datetime"),
  column(units, 3, "integer", "Int64"),
  column(profit, 4, "float", "Float64")
] satisfies ColumnSchema[];

const emptyFilterModel: FilterModel = { filters: [], sort: [] };
const viewingFilterModel = {
  logic: "and",
  filters: [
    {
      column: "city",
      type: "string",
      predicates: [{ kind: "predicate", operator: "equals", value: "Milan" }]
    }
  ],
  sort: [{ column: "sales", direction: "desc", nulls: "first" }]
} satisfies FilterModel;

type FieldEntries = readonly (readonly [name: string, value: string])[];
type ParamsCase<Kind extends OperationKind> = {
  kind: Kind;
  fields: FieldEntries;
  expected: OperationParamsFor<Kind>;
  filterModel?: FilterModel;
  savedFilterModel?: TransformFilterModel;
};
type ParamsCases = { [Kind in OperationKind]: ParamsCase<Kind> };

const validCases: ParamsCases = {
  sortRows: {
    kind: "sortRows",
    fields: [
      ["sortColumn", "c:sales"],
      ["sortDirection", "desc"],
      ["sortNulls", "first"]
    ],
    expected: { rules: [{ column: sales, direction: "desc", nulls: "first" }] }
  },
  filterRows: {
    kind: "filterRows",
    fields: [["filterSource", "current"]],
    filterModel: viewingFilterModel,
    expected: {
      filterModel: {
        logic: "and",
        filters: [
          {
            column: city,
            type: "string",
            predicates: [{ kind: "predicate", operator: "equals", value: "Milan" }]
          }
        ],
        sort: [{ column: sales, direction: "desc", nulls: "first" }]
      }
    }
  },
  dropMissingRows: {
    kind: "dropMissingRows",
    fields: [
      ["columns", "c:city"],
      ["how", "all"]
    ],
    expected: { columns: [city], how: "all" }
  },
  fillMissingValues: {
    kind: "fillMissingValues",
    fields: [
      ["column", "c:sales"],
      ["fillMode", "median"]
    ],
    expected: { column: sales, replacement: { kind: "median" } }
  },
  dropDuplicates: {
    kind: "dropDuplicates",
    fields: [
      ["columns", "c:city"],
      ["keep", "last"]
    ],
    expected: { columns: [city], keep: "last" }
  },
  selectColumns: {
    kind: "selectColumns",
    fields: [
      ["columns", "c:sales"],
      ["columns", "c:city"]
    ],
    expected: { columns: [sales, city] }
  },
  dropColumns: {
    kind: "dropColumns",
    fields: [["columns", "c:when"]],
    expected: { columns: [when] }
  },
  renameColumn: {
    kind: "renameColumn",
    fields: [
      ["column", "c:city"],
      ["newName", "location"]
    ],
    expected: { column: city, newName: "location" }
  },
  cloneColumn: {
    kind: "cloneColumn",
    fields: [
      ["column", "c:city"],
      ["newName", "city_copy"]
    ],
    expected: { column: city, newName: "city_copy" }
  },
  castColumn: {
    kind: "castColumn",
    fields: [
      ["column", "c:city"],
      ["dtype", "integer"]
    ],
    expected: { column: city, dtype: "integer" }
  },
  formula: {
    kind: "formula",
    fields: [
      ["leftColumn", "c:sales"],
      ["operator", "multiply"],
      ["operandMode", "column"],
      ["rightColumn", "c:units"],
      ["newColumn", "revenue"]
    ],
    expected: { leftColumn: sales, operator: "multiply", rightColumn: units, newColumn: "revenue" }
  },
  textLength: {
    kind: "textLength",
    fields: [
      ["column", "c:city"],
      ["newColumn", "city_length"]
    ],
    expected: { column: city, newColumn: "city_length" }
  },
  oneHotEncode: {
    kind: "oneHotEncode",
    fields: [
      ["columns", "c:city"],
      ["prefixSeparator", ""],
      ["dropOriginal", "on"]
    ],
    expected: { columns: [city], prefixSeparator: "", dropOriginal: true }
  },
  multiLabelBinarize: {
    kind: "multiLabelBinarize",
    fields: [
      ["column", "c:city"],
      ["delimiter", "|"],
      ["prefixMode", "custom"],
      ["prefix", ""],
      ["dropOriginal", "on"]
    ],
    expected: { column: city, delimiter: "|", prefix: "", dropOriginal: true }
  },
  findReplace: {
    kind: "findReplace",
    fields: [
      ["column", "c:city"],
      ["find", ""],
      ["replacement", "x"],
      ["regex", "on"],
      ["newColumn", ""]
    ],
    expected: { column: city, find: "", replacement: "x", regex: true }
  },
  stripText: {
    kind: "stripText",
    fields: [
      ["column", "c:city"],
      ["characters", ""],
      ["newColumn", "trimmed"]
    ],
    expected: { column: city, newColumn: "trimmed" }
  },
  splitText: {
    kind: "splitText",
    fields: [
      ["column", "c:city"],
      ["delimiter", "-"],
      ["index", "2"],
      ["newColumn", "segment"]
    ],
    expected: { column: city, delimiter: "-", index: 2, newColumn: "segment" }
  },
  splitTextColumns: {
    kind: "splitTextColumns",
    fields: [
      ["column", "c:city"],
      ["delimiter", "-"],
      ["newColumns", "first"],
      ["newColumns", "second"]
    ],
    expected: { column: city, delimiter: "-", newColumns: ["first", "second"] }
  },
  pivotLonger: {
    kind: "pivotLonger",
    fields: [
      ["columns", "c:sales"],
      ["columns", "c:profit"],
      ["labelColumn", "metric"],
      ["valueColumn", "reading"]
    ],
    expected: { columns: [sales, profit], labelColumn: "metric", valueColumn: "reading" }
  },
  extractRegexGroup: {
    kind: "extractRegexGroup",
    fields: [
      ["column", "c:city"],
      ["pattern", "([A-Za-z]+)"],
      ["group", "1"],
      ["newColumn", "word"]
    ],
    expected: { column: city, pattern: "([A-Za-z]+)", group: 1, newColumn: "word" }
  },
  capitalizeText: optionalOutputCase("capitalizeText", "c:city", "capitalized", city),
  lowerText: optionalOutputCase("lowerText", "c:city", "lowered", city),
  upperText: optionalOutputCase("upperText", "c:city", "uppered", city),
  minMaxScale: optionalOutputCase("minMaxScale", "c:sales", "scaled", sales),
  roundNumber: {
    kind: "roundNumber",
    fields: [
      ["column", "c:sales"],
      ["decimals", "3"],
      ["newColumn", "rounded"]
    ],
    expected: { column: sales, decimals: 3, newColumn: "rounded" }
  },
  floorNumber: optionalOutputCase("floorNumber", "c:sales", "floored", sales),
  ceilNumber: optionalOutputCase("ceilNumber", "c:sales", "ceiled", sales),
  formatDatetime: {
    kind: "formatDatetime",
    fields: [
      ["column", "c:when"],
      ["format", "%Y-%m-%d"],
      ["newColumn", "day"]
    ],
    expected: { column: when, format: "%Y-%m-%d", newColumn: "day" }
  },
  groupBy: {
    kind: "groupBy",
    fields: [
      ["keys", "c:city"],
      ["aggregationColumn", "c:sales"],
      ["aggregationOperation", "sum"],
      ["aggregationAlias", "total"],
      ["aggregationColumn", "c:sales"],
      ["aggregationOperation", "mean"],
      ["aggregationAlias", "average"]
    ],
    expected: {
      keys: [city],
      aggregations: [
        { column: sales, operation: "sum", alias: "total" },
        { column: sales, operation: "mean", alias: "average" }
      ]
    }
  },
  byExample: {
    kind: "byExample",
    fields: [
      ["sourceColumns", "c:city"],
      ["sourceColumns", "c:units"],
      ["newColumn", "label"],
      [
        "examples",
        JSON.stringify([
          { inputs: ["Milan", 2], output: "Milan-2" },
          { inputs: ["Rome", 3], output: "Rome-3" }
        ])
      ]
    ],
    expected: {
      sourceColumns: [city, units],
      newColumn: "label",
      examples: [
        { inputs: ["Milan", 2], output: "Milan-2" },
        { inputs: ["Rome", 3], output: "Rome-3" }
      ]
    }
  },
  customCode: {
    kind: "customCode",
    fields: [["code", "result = df"]],
    expected: { code: "result = df" }
  }
};

function column(
  reference: { readonly id: string; readonly name: string },
  position: number,
  type: ColumnSchema["type"],
  rawType: string
): ColumnSchema {
  return { ...reference, position, type, rawType, nullable: true };
}

function optionalOutputCase<
  Kind extends "capitalizeText" | "lowerText" | "upperText" | "minMaxScale" | "floorNumber" | "ceilNumber"
>(
  kind: Kind,
  columnId: string,
  newColumn: string,
  reference: { readonly id: string; readonly name: string }
): ParamsCase<Kind> {
  return {
    kind,
    fields: [
      ["column", columnId],
      ["newColumn", newColumn]
    ],
    expected: { column: reference, newColumn } as OperationParamsFor<Kind>
  };
}

function form(entries: FieldEntries): FormData {
  const result = new FormData();
  for (const [name, value] of entries) result.append(name, value);
  return result;
}

describe("buildParams", () => {
  it.each(Object.values(validCases))("builds exact generated parameters for $kind", (testCase) => {
    expect(
      buildParams(
        testCase.kind,
        form(testCase.fields),
        testCase.filterModel ?? emptyFilterModel,
        schema,
        testCase.savedFilterModel
      )
    ).toEqual(testCase.expected);
  });

  it("keeps an existing saved filter unless the form explicitly selects the current view", () => {
    const savedFilterModel = {
      filters: [{ column: city, type: "string", predicates: [] }],
      sort: []
    } satisfies TransformFilterModel;
    expect(buildParams("filterRows", form([]), viewingFilterModel, schema, savedFilterModel)).toEqual({
      filterModel: savedFilterModel
    });
    expect(
      buildParams("filterRows", form([["filterSource", "current"]]), viewingFilterModel, schema, savedFilterModel)
    ).toEqual(validCases.filterRows.expected);
  });

  it("drops inactive viewing filters and fails closed for missing or ambiguous viewing names", () => {
    const withInactive = {
      filters: [...viewingFilterModel.filters, { column: "city", type: "string", predicates: [] }],
      sort: []
    } satisfies FilterModel;
    expect(buildParams("filterRows", form([]), withInactive, schema)).toEqual({
      filterModel: { filters: validCases.filterRows.expected.filterModel.filters, sort: [] }
    });

    const missing = {
      filters: [],
      sort: [{ column: "missing", direction: "asc", nulls: "last" }]
    } satisfies FilterModel;
    expect(() => buildParams("filterRows", form([]), missing, schema)).toThrow(
      "Viewing query column “missing” is no longer available in the operation input."
    );
    const duplicates = [schema[0], { ...schema[1], id: "c:duplicate", name: "city" }];
    expect(() => buildParams("filterRows", form([]), viewingFilterModel, duplicates)).toThrow(
      "Viewing query column “city” is ambiguous because 2 input columns share that name."
    );
  });

  it("rejects stale stable IDs and missing required reference lists", () => {
    expect(() =>
      buildParams(
        "renameColumn",
        form([
          ["column", "c:missing"],
          ["newName", "renamed"]
        ]),
        emptyFilterModel,
        schema
      )
    ).toThrow("The selected column is no longer available.");
    expect(() => buildParams("sortRows", form([]), emptyFilterModel, schema)).toThrow(
      "Sort rows requires at least one sort rule."
    );
    expect(() => buildParams("selectColumns", form([]), emptyFilterModel, schema)).toThrow(
      "Select columns requires at least one compatible column."
    );
  });

  it.each(["", "Infinity", "NaN"])("rejects Formula scalar %j", (scalar) => {
    expect(() =>
      buildParams(
        "formula",
        form([
          ["leftColumn", "c:sales"],
          ["operator", "add"],
          ["operandMode", "value"],
          ["value", scalar],
          ["newColumn", "result"]
        ]),
        emptyFilterModel,
        schema
      )
    ).toThrow("Formula requires one finite numeric value or a right column.");
  });

  it("rejects incomplete group aggregations", () => {
    expect(() =>
      buildParams(
        "groupBy",
        form([
          ["keys", "c:city"],
          ["aggregationColumn", "c:sales"],
          ["aggregationOperation", "sum"]
        ]),
        emptyFilterModel,
        schema
      )
    ).toThrow("Group by requires at least one complete compatible aggregation.");
  });

  it("preserves optional-field omission and finite Formula scalar values", () => {
    expect(buildParams("dropMissingRows", form([["how", "any"]]), emptyFilterModel, schema)).toEqual({
      how: "any"
    });
    expect(buildParams("dropDuplicates", form([["keep", "first"]]), emptyFilterModel, schema)).toEqual({
      keep: "first"
    });
    expect(
      buildParams(
        "stripText",
        form([
          ["column", "c:city"],
          ["characters", ""],
          ["newColumn", ""]
        ]),
        emptyFilterModel,
        schema
      )
    ).toEqual({ column: city });
    expect(
      buildParams(
        "formula",
        form([
          ["leftColumn", "c:sales"],
          ["operator", "add"],
          ["operandMode", "value"],
          ["value", "2.5"],
          ["newColumn", "adjusted"]
        ]),
        emptyFilterModel,
        schema
      )
    ).toEqual({ leftColumn: sales, operator: "add", value: 2.5, newColumn: "adjusted" });
  });

  it("rejects incomplete or ambiguous multi-output split forms before preview dispatch", () => {
    expect(() =>
      buildParams(
        "splitTextColumns",
        form([
          ["column", "c:city"],
          ["delimiter", ""],
          ["newColumns", "first"],
          ["newColumns", "second"]
        ]),
        emptyFilterModel,
        schema
      )
    ).toThrow("requires a literal delimiter");
    expect(() =>
      buildParams(
        "splitTextColumns",
        form([
          ["column", "c:city"],
          ["delimiter", "-"],
          ["newColumns", "duplicate"],
          ["newColumns", "duplicate"]
        ]),
        emptyFilterModel,
        schema
      )
    ).toThrow("requires 2 to 64 unique output names");
  });

  it.each([
    ["not JSON", "Examples must be valid JSON."],
    ["{}", "Examples JSON must be an array."],
    [JSON.stringify([{ inputs: ["one"], output: "one" }]), "By-example requires between 2 and 64 examples."],
    [
      JSON.stringify([
        { inputs: [], output: "one" },
        { inputs: [], output: "two" }
      ]),
      "Example 1 inputs must be an array with 1 values in source-column order."
    ],
    ['[{"inputs":[-0],"output":"one"},{"inputs":[1],"output":"two"}]', "negative zero is not supported"]
  ] as const)("rejects malformed by-example input %#", (examples, message) => {
    expect(() =>
      buildParams(
        "byExample",
        form([
          ["sourceColumns", "c:city"],
          ["newColumn", "example"],
          ["examples", examples]
        ]),
        emptyFilterModel,
        schema
      )
    ).toThrow(message);
  });

  it.each([
    ['[{"inputs":[9007199254740993],"output":1},{"inputs":[2],"output":3}]', "9007199254740993"],
    ['[{"inputs":[-9007199254740992],"output":1},{"inputs":[2],"output":3}]', "-9007199254740992"],
    ['[{"inputs":[9.007199254740993e15],"output":1},{"inputs":[2],"output":3}]', "9.007199254740993e15"]
  ] as const)("rejects an unsafe by-example integer token %s", (examples, token) => {
    expect(() =>
      buildParams(
        "byExample",
        form([
          ["sourceColumns", "c:city"],
          ["newColumn", "example"],
          ["examples", examples]
        ]),
        emptyFilterModel,
        schema
      )
    ).toThrow(
      `Integer token ${token} is outside JavaScript's exact safe range; use smaller examples to synthesize the same operation.`
    );
  });

  it("keeps numeric-looking by-example strings exact", () => {
    const examples = [
      { inputs: ["9007199254740993"], output: "9007199254740993" },
      { inputs: ["-9007199254740992"], output: "-9007199254740992" }
    ];
    expect(
      buildParams(
        "byExample",
        form([
          ["sourceColumns", "c:city"],
          ["newColumn", "example"],
          ["examples", JSON.stringify(examples)]
        ]),
        emptyFilterModel,
        schema
      )
    ).toEqual({ sourceColumns: [city], newColumn: "example", examples });
  });

  it("extracts saved reference IDs and fails closed for a future operation kind", () => {
    expect(columnReferenceId(city)).toBe("c:city");
    expect(columnReferenceId({ id: 1 })).toBeUndefined();
    expect(columnReferenceId(null)).toBeUndefined();
    expect(() =>
      buildParams("futureOperation" as OperationKind, form([["code", "result = df"]]), emptyFilterModel, schema)
    ).toThrow("Unsupported operation kind: futureOperation");
  });
});
