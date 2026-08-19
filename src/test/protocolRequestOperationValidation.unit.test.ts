import { describe, expect, it } from "vitest";
import { isOpenWranglerRequest, isRuntimeRequestEnvelope, isTransformStep } from "../shared/protocolValidation";
import {
  hasAtMostViewValueTextCodePoints,
  MAX_VIEW_VALUE_TEXT_CHARACTERS,
  truncateViewValueTextToCodePoints
} from "../shared/viewValueLimits";
import { otherReference, requests, validateTransportSchema, valueReference } from "./protocolValidation.fixtures";

describe("protocol-v2 operation request validation", () => {
  it("makes the canonical schema reject terminal CR/LF in public regex fields", () => {
    const preview = requests.find((candidate) => candidate.kind === "previewStep");
    expect(preview?.kind).toBe("previewStep");
    if (preview?.kind !== "previewStep") return;
    const step = {
      id: "regex-schema-single-line",
      kind: "extractRegexGroup",
      params: { column: valueReference, pattern: "([A-Za-z]+)", group: 1, newColumn: "word" }
    };
    const envelope = (candidateStep: typeof step) => ({
      protocolVersion: 2,
      requestId: "regex-schema-single-line",
      priority: "interactive",
      request: { ...preview, step: candidateStep }
    });
    expect(validateTransportSchema(envelope(step))).toBe(true);
    for (const pattern of ["([A-Za-z]+)\n", "([A-Za-z]+)\r\n"]) {
      expect(validateTransportSchema(envelope({ ...step, params: { ...step.params, pattern } }))).toBe(false);
    }
    for (const newColumn of ["word\n", "word\r\n"]) {
      expect(validateTransportSchema(envelope({ ...step, params: { ...step.params, newColumn } }))).toBe(false);
    }
  });

  it("accepts only unique, non-empty stable IDs in summary projections", () => {
    const request = requests.find((candidate) => candidate.kind === "getSummary");
    expect(request?.kind).toBe("getSummary");
    if (request?.kind !== "getSummary") return;

    expect(isOpenWranglerRequest({ ...request, columnIds: ["column:0", "column:1"] })).toBe(true);
    expect(isOpenWranglerRequest({ ...request, columnIds: [] })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, columnIds: ["column:0", "column:0"] })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, columnIds: [""] })).toBe(false);
    expect(isOpenWranglerRequest({ ...request, columns: ["value"] })).toBe(false);
  });

  it.each(["getPage", "getSummary", "getDatasetStats", "getColumnValues"] as const)(
    "rejects duplicate viewing sort columns in %s requests",
    (kind) => {
      const request = requests.find((candidate) => candidate.kind === kind);
      expect(request?.kind).toBe(kind);
      if (!request || !("filterModel" in request)) return;

      expect(
        isOpenWranglerRequest({
          ...request,
          filterModel: {
            filters: [],
            sort: [
              { column: "value", direction: "asc", nulls: "last" },
              { column: "value", direction: "desc", nulls: "first" }
            ]
          }
        })
      ).toBe(false);
    }
  );

  it("validates aggregate, same-row, directional, and typed fill-missing replacements", () => {
    const fillStep = (replacement: unknown) => ({
      id: "fill-value",
      kind: "fillMissingValues",
      params: { column: valueReference, replacement }
    });
    const previewEnvelope = (replacement: unknown) => ({
      protocolVersion: 2,
      requestId: "preview-fill",
      priority: "interactive",
      request: {
        kind: "previewStep",
        sessionId: "session-1",
        revision: 0,
        step: fillStep(replacement),
        offset: 0,
        limit: 200,
        columnOffset: 0,
        columnLimit: 64
      }
    });
    const validReplacements = [
      { kind: "median" },
      { kind: "mean" },
      { kind: "mostFrequent" },
      {
        kind: "fallbackColumns",
        columns: [otherReference, { id: "column:2", name: "third" }]
      },
      {
        kind: "directional",
        direction: "forward",
        orderBy: [
          { column: otherReference, direction: "asc", nulls: "last" },
          { column: { id: "column:2", name: "third" }, direction: "desc", nulls: "first" }
        ],
        maxGap: 1_000_000
      },
      {
        kind: "directional",
        direction: "backward",
        orderBy: [{ column: otherReference, direction: "desc", nulls: "first" }]
      },
      { kind: "groupedStatistic", statistic: "median", keys: [otherReference] },
      {
        kind: "groupedStatistic",
        statistic: "mean",
        keys: [otherReference, { id: "column:2", name: "third" }]
      },
      { kind: "groupedStatistic", statistic: "mostFrequent", keys: [otherReference] },
      { kind: "linearInterpolation", coordinate: otherReference },
      { kind: "linearInterpolation", coordinate: otherReference, maxGap: 1_000_000 },
      { kind: "string", value: "" },
      { kind: "integer", value: "99999999999999999999999999999999999999" },
      { kind: "float", value: "-1.25e+3" },
      { kind: "decimal", value: "0.00000000000000000000000000000000000001" },
      { kind: "boolean", value: true },
      { kind: "date", value: "2024-02-29" },
      { kind: "datetime", value: "2026-08-05T18:20:00+02:00" }
    ];

    for (const replacement of validReplacements) {
      expect(isTransformStep(fillStep(replacement)), replacement.kind).toBe(true);
      expect(validateTransportSchema(previewEnvelope(replacement)), replacement.kind).toBe(true);
    }

    for (const replacement of [
      { kind: "median", value: 1 },
      { kind: "mean", value: 1 },
      { kind: "mostFrequent", value: "x" },
      { kind: "integer", value: "01" },
      { kind: "integer", value: "100000000000000000000000000000000000000" },
      { kind: "float", value: "NaN" },
      { kind: "decimal", value: "999999999999999999999999999999999999999" },
      { kind: "boolean", value: "true" },
      { kind: "date", value: "2023-02-29" },
      { kind: "datetime", value: "2026-08-05T25:00" },
      { kind: "future", value: "x" },
      { kind: "string", value: "x", extra: true },
      { kind: "fallbackColumns", columns: [] },
      { kind: "fallbackColumns", columns: ["other"] },
      { kind: "fallbackColumns", columns: [otherReference], extra: true },
      { kind: "directional", direction: "sideways", orderBy: [] },
      { kind: "directional", direction: "forward", orderBy: [] },
      { kind: "directional", direction: "forward", orderBy: [otherReference] },
      {
        kind: "directional",
        direction: "forward",
        orderBy: [{ column: otherReference, direction: "asc", nulls: "last" }],
        maxGap: 0
      },
      {
        kind: "directional",
        direction: "forward",
        orderBy: [{ column: otherReference, direction: "asc", nulls: "last" }],
        maxGap: 1.5
      },
      {
        kind: "directional",
        direction: "forward",
        orderBy: [{ column: otherReference, direction: "asc", nulls: "last" }],
        maxGap: 1_000_001
      },
      {
        kind: "directional",
        direction: "forward",
        orderBy: [{ column: otherReference, direction: "asc", nulls: "last" }],
        extra: true
      },
      { kind: "groupedStatistic", statistic: "median", keys: [] },
      { kind: "groupedStatistic", statistic: "sum", keys: [otherReference] },
      { kind: "groupedStatistic", statistic: "mean", keys: ["other"] },
      { kind: "groupedStatistic", statistic: "mostFrequent", keys: [otherReference], extra: true },
      { kind: "linearInterpolation" },
      { kind: "linearInterpolation", coordinate: "other" },
      { kind: "linearInterpolation", coordinate: otherReference, maxGap: 0 },
      { kind: "linearInterpolation", coordinate: otherReference, maxGap: 1.5 },
      { kind: "linearInterpolation", coordinate: otherReference, maxGap: 1_000_001 },
      { kind: "linearInterpolation", coordinate: otherReference, extra: true }
    ]) {
      expect(isTransformStep(fillStep(replacement)), JSON.stringify(replacement)).toBe(false);
    }

    const duplicateFallback = { kind: "fallbackColumns", columns: [otherReference, otherReference] };
    expect(isTransformStep(fillStep(duplicateFallback))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(duplicateFallback))).toBe(false);

    expect(
      isTransformStep(
        fillStep({
          kind: "fallbackColumns",
          columns: [otherReference, { id: otherReference.id, name: "renamed-other" }]
        })
      )
    ).toBe(false);
    expect(isTransformStep(fillStep({ kind: "fallbackColumns", columns: [valueReference] }))).toBe(false);

    const duplicateGroupKeys = { kind: "groupedStatistic", statistic: "mean", keys: [otherReference, otherReference] };
    expect(isTransformStep(fillStep(duplicateGroupKeys))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(duplicateGroupKeys))).toBe(false);
    const targetGroupKey = { kind: "groupedStatistic", statistic: "median", keys: [valueReference] };
    expect(isTransformStep(fillStep(targetGroupKey))).toBe(false);
    expect(isRuntimeRequestEnvelope(previewEnvelope(targetGroupKey))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(targetGroupKey))).toBe(true);

    const targetInterpolationCoordinate = { kind: "linearInterpolation", coordinate: valueReference };
    expect(isTransformStep(fillStep(targetInterpolationCoordinate))).toBe(false);
    expect(isRuntimeRequestEnvelope(previewEnvelope(targetInterpolationCoordinate))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(targetInterpolationCoordinate))).toBe(true);

    const repeatedOrderColumn = {
      kind: "directional",
      direction: "forward",
      orderBy: [
        { column: otherReference, direction: "asc", nulls: "last" },
        { column: otherReference, direction: "desc", nulls: "first" }
      ]
    };
    expect(isTransformStep(fillStep(repeatedOrderColumn))).toBe(false);
    expect(isRuntimeRequestEnvelope(previewEnvelope(repeatedOrderColumn))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(repeatedOrderColumn))).toBe(true);
    const targetOrderColumn = {
      kind: "directional",
      direction: "backward",
      orderBy: [{ column: valueReference, direction: "asc", nulls: "last" }]
    };
    expect(isTransformStep(fillStep(targetOrderColumn))).toBe(false);
    expect(isRuntimeRequestEnvelope(previewEnvelope(targetOrderColumn))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(targetOrderColumn))).toBe(true);

    const tooManyFallbacks = {
      kind: "fallbackColumns",
      columns: Array.from({ length: 65 }, (_, index) => ({ id: `column:${index + 1}`, name: `fallback_${index}` }))
    };
    expect(isTransformStep(fillStep(tooManyFallbacks))).toBe(false);
    expect(validateTransportSchema(previewEnvelope(tooManyFallbacks))).toBe(false);

    for (const replacement of [null, [], { kind: "string" }]) {
      expect(isTransformStep(fillStep(replacement))).toBe(false);
      expect(validateTransportSchema(previewEnvelope(replacement))).toBe(false);
    }
  });

  it("bounds viewing and transform scalar text by Unicode code points across TypeScript and JSON Schema", () => {
    const request = requests.find((candidate) => candidate.kind === "getPage");
    expect(request?.kind).toBe("getPage");
    if (request?.kind !== "getPage") return;

    const filterModel = (value: string, secondValue: string, selectedValue: string) => ({
      filters: [
        {
          column: "value",
          type: "decimal" as const,
          valueFilter: {
            kind: "values" as const,
            selectedValues: [selectedValue],
            includeNulls: false,
            includeNaN: false
          },
          predicates: [{ kind: "predicate" as const, operator: "between" as const, value, secondValue }]
        }
      ],
      sort: []
    });

    const transformStep = (value: string, secondValue: string, selectedValue: string) => ({
      id: "filter-bounded",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [
            {
              column: valueReference,
              type: "decimal",
              valueFilter: {
                kind: "values",
                selectedValues: [selectedValue],
                includeNulls: false,
                includeNaN: false
              },
              predicates: [{ kind: "predicate", operator: "between", value, secondValue }]
            }
          ],
          sort: []
        }
      }
    });
    const transportEnvelope = (requestValue: unknown) => ({
      protocolVersion: 2,
      requestId: "bounded-filter",
      priority: "interactive",
      request: requestValue
    });
    const previewRequest = (value: string, secondValue: string, selectedValue: string) => ({
      kind: "previewStep",
      sessionId: "session-1",
      revision: 0,
      step: transformStep(value, secondValue, selectedValue),
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 64
    });
    const cases = [
      {
        label: "BMP",
        atLimit: `1e${"9".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS - 2)}`,
        overLimit: `1e${"9".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS - 1)}`
      },
      {
        label: "non-BMP",
        atLimit: "😀".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS),
        overLimit: "😀".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS + 1)
      }
    ];

    for (const { label, atLimit, overLimit } of cases) {
      const validModel = filterModel(atLimit, atLimit, atLimit);
      expect(isOpenWranglerRequest({ ...request, filterModel: validModel }), label).toBe(true);
      expect(validateTransportSchema(transportEnvelope({ ...request, filterModel: validModel })), label).toBe(true);
      expect(isOpenWranglerRequest({ ...request, filterModel: filterModel(overLimit, atLimit, atLimit) }), label).toBe(
        false
      );
      expect(
        validateTransportSchema(
          transportEnvelope({ ...request, filterModel: filterModel(overLimit, atLimit, atLimit) })
        ),
        label
      ).toBe(false);
      expect(isOpenWranglerRequest({ ...request, filterModel: filterModel(atLimit, overLimit, atLimit) }), label).toBe(
        false
      );
      expect(
        validateTransportSchema(
          transportEnvelope({ ...request, filterModel: filterModel(atLimit, overLimit, atLimit) })
        ),
        label
      ).toBe(false);
      expect(isOpenWranglerRequest({ ...request, filterModel: filterModel(atLimit, atLimit, overLimit) }), label).toBe(
        false
      );
      expect(
        validateTransportSchema(
          transportEnvelope({ ...request, filterModel: filterModel(atLimit, atLimit, overLimit) })
        ),
        label
      ).toBe(false);

      const validStep = transformStep(atLimit, atLimit, atLimit);
      expect(isTransformStep(validStep), label).toBe(true);
      expect(validateTransportSchema(transportEnvelope(previewRequest(atLimit, atLimit, atLimit))), label).toBe(true);
      for (const invalidValues of [
        [overLimit, atLimit, atLimit],
        [atLimit, overLimit, atLimit],
        [atLimit, atLimit, overLimit]
      ] as const) {
        expect(isTransformStep(transformStep(...invalidValues)), label).toBe(false);
        expect(validateTransportSchema(transportEnvelope(previewRequest(...invalidValues))), label).toBe(false);
      }
    }
  });

  it("counts and truncates view-value limits without splitting Unicode code points", () => {
    const astralAtLimit = "😀".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS);
    const astralOverLimit = `${astralAtLimit}😀`;
    const bmpAtLimit = "x".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS);
    const bmpOverLimit = `${bmpAtLimit}x`;

    expect(hasAtMostViewValueTextCodePoints(bmpAtLimit)).toBe(true);
    expect(hasAtMostViewValueTextCodePoints(bmpOverLimit)).toBe(false);
    expect(hasAtMostViewValueTextCodePoints(astralAtLimit)).toBe(true);
    expect(hasAtMostViewValueTextCodePoints(astralOverLimit)).toBe(false);
    expect(truncateViewValueTextToCodePoints(bmpOverLimit)).toBe(bmpAtLimit);
    expect(truncateViewValueTextToCodePoints(astralOverLimit)).toBe(astralAtLimit);
  });

  it("accepts exact import options with one-code-point Unicode delimiters and explicit Excel selectors", () => {
    const requestWithOptions = (importOptions: unknown, fileName = "fixture.csv"): unknown => ({
      kind: "openSession",
      source: {
        kind: "file",
        label: fileName,
        path: `/tmp/${fileName}`,
        importOptions
      },
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    });

    expect(
      isOpenWranglerRequest(
        requestWithOptions({
          delimiter: "💠",
          encoding: " utf-8 ",
          quoteChar: "“",
          hasHeader: true
        })
      )
    ).toBe(true);
    expect(isOpenWranglerRequest(requestWithOptions({}))).toBe(true);
    expect(isOpenWranglerRequest(requestWithOptions({ sheetName: " résumé " }, "fixture.xlsx"))).toBe(true);
    expect(isOpenWranglerRequest(requestWithOptions({ sheetIndex: 0 }, "fixture.xls"))).toBe(true);
  });

  it.each([
    [
      "a literal fragment marker in a raw path",
      {
        kind: "file",
        label: "fallback.parquet",
        path: "/tmp/data#1.csv",
        uri: "file:///tmp/fallback.xlsx?download=1",
        importOptions: { delimiter: ";" }
      }
    ],
    [
      "a literal query marker in a raw path",
      {
        kind: "file",
        label: "fallback.csv",
        path: "/tmp/data?1.xlsx",
        uri: "file:///tmp/fallback.csv?download=1",
        importOptions: { sheetIndex: 0 }
      }
    ],
    [
      "a literal fragment marker in a raw label",
      { kind: "file", label: "data#1.csv", importOptions: { encoding: "utf-8" } }
    ],
    [
      "a literal query marker in a raw label",
      { kind: "file", label: "data?1.xlsx", importOptions: { sheetName: "Sheet1" } }
    ],
    [
      "a query and fragment after a delimited URI path",
      {
        kind: "file",
        label: "fallback.xlsx",
        uri: "file:///tmp/data.csv?download=1#section",
        importOptions: { quoteChar: '"' }
      }
    ],
    [
      "a query and fragment after an Excel URI path",
      {
        kind: "file",
        label: "fallback.csv",
        path: "",
        uri: "file:///tmp/data.XLSX#section?download=1",
        importOptions: { sheetName: "Sheet1" }
      }
    ]
  ])("accepts import options resolved from %s", (_description, source) => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source,
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(true);
  });

  it.each([
    [
      "a raw path whose apparent extension is only before a literal query marker",
      {
        kind: "file",
        label: "fallback.csv",
        path: "/tmp/data.csv?download=1",
        uri: "file:///tmp/fallback.csv",
        importOptions: { delimiter: "," }
      }
    ],
    [
      "a URI whose extension occurs only inside its query",
      {
        kind: "file",
        label: "fallback.csv",
        uri: "file:///tmp/download?name=data.csv",
        importOptions: { delimiter: "," }
      }
    ],
    [
      "a lower-precedence compatible URI when the path is incompatible",
      {
        kind: "file",
        label: "fallback.xlsx",
        path: "/tmp/data.parquet",
        uri: "file:///tmp/data.xlsx",
        importOptions: { sheetIndex: 0 }
      }
    ],
    [
      "a hidden filename made only of an apparent extension",
      {
        kind: "file",
        label: ".csv",
        importOptions: { delimiter: "," }
      }
    ]
  ])("rejects import options resolved from %s", (_description, source) => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source,
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(false);
  });

  it("allows empty import options on non-file sources but rejects configured file imports there", () => {
    const requestWithOptions = (importOptions: unknown): unknown => ({
      kind: "openSession",
      source: {
        kind: "notebookVariable",
        label: "frame.csv",
        variableName: "frame",
        importOptions
      },
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    });

    expect(isOpenWranglerRequest(requestWithOptions({}))).toBe(true);
    expect(isOpenWranglerRequest(requestWithOptions({ delimiter: "," }))).toBe(false);
  });

  it.each([
    ["Excel selectors on a delimited source", "fixture.csv", { sheetName: "Sheet1" }],
    ["delimited controls on an Excel source", "fixture.xlsx", { delimiter: "," }],
    ["import values on a non-configurable source", "fixture.parquet", { encoding: "utf-8" }]
  ])("rejects %s", (_description, fileName, importOptions) => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source: {
          kind: "file",
          label: fileName,
          path: `/tmp/${fileName}`,
          importOptions
        },
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(false);
  });

  it.each([
    ["non-object options", null],
    ["array options", []],
    ["an unknown option", { delimiter: ",", extra: true }],
    ["the legacy ambiguous sheet option", { sheet: 0 }],
    ["a non-string delimiter", { delimiter: 1 }],
    ["an empty delimiter", { delimiter: "" }],
    ["a multi-code-point delimiter", { delimiter: "||" }],
    ["a lone high-surrogate delimiter", { delimiter: "\uD800" }],
    ["a lone low-surrogate delimiter", { delimiter: "\uDFFF" }],
    ["a non-string quote character", { quoteChar: 1 }],
    ["an empty quote character", { quoteChar: "" }],
    ["a multi-code-point quote character", { quoteChar: '""' }],
    ["a lone high-surrogate quote character", { quoteChar: "\uD800" }],
    ["a lone low-surrogate quote character", { quoteChar: "\uDFFF" }],
    ["a non-string encoding", { encoding: 1 }],
    ["a blank encoding", { encoding: " \t " }],
    ["a byte-order-mark-only encoding", { encoding: "\uFEFF" }],
    ["a non-boolean header flag", { hasHeader: "yes" }],
    ["a non-string sheet name", { sheetName: 1 }],
    ["a blank sheet name", { sheetName: " \n " }],
    ["a byte-order-mark-only sheet name", { sheetName: "\uFEFF" }],
    ["a negative sheet index", { sheetIndex: -1 }],
    ["a fractional sheet index", { sheetIndex: 1.5 }],
    ["a boolean sheet index", { sheetIndex: true }],
    ["an unsafe sheet index", { sheetIndex: Number.MAX_SAFE_INTEGER + 1 }],
    ["both Excel selectors", { sheetName: "Sheet1", sheetIndex: 0 }],
    ["a sheet name mixed with a delimiter", { sheetName: "Sheet1", delimiter: "," }],
    ["a sheet index mixed with an encoding", { sheetIndex: 0, encoding: "utf-8" }],
    ["a sheet name mixed with a quote character", { sheetName: "Sheet1", quoteChar: '"' }],
    ["a sheet index mixed with a header flag", { sheetIndex: 0, hasHeader: true }]
  ])("rejects import options containing %s", (_description, importOptions) => {
    expect(
      isOpenWranglerRequest({
        kind: "openSession",
        source: {
          kind: "file",
          label: "fixture.csv",
          path: "/tmp/fixture.csv",
          importOptions
        },
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16
      })
    ).toBe(false);
  });

  it.each([
    {
      id: "sort-rows",
      kind: "sortRows",
      params: { rules: [{ column: valueReference, direction: "asc", nulls: "last" }] }
    },
    {
      id: "filter-rows",
      kind: "filterRows",
      params: {
        filterModel: {
          logic: "and",
          filters: [
            {
              column: valueReference,
              type: "integer",
              predicates: [{ kind: "predicate", operator: "gte", value: 1 }]
            }
          ],
          sort: [{ column: valueReference, direction: "desc", nulls: "first" }]
        }
      }
    },
    { id: "drop-missing", kind: "dropMissingRows", params: { columns: [], how: "any" } },
    { id: "drop-duplicates", kind: "dropDuplicates", params: { columns: [valueReference], keep: "first" } },
    { id: "select", kind: "selectColumns", params: { columns: [valueReference, otherReference] } },
    { id: "drop", kind: "dropColumns", params: { columns: [valueReference] } },
    { id: "rename", kind: "renameColumn", params: { column: valueReference, newName: "amount" } },
    { id: "clone", kind: "cloneColumn", params: { column: valueReference, newName: "value_copy" } },
    { id: "cast", kind: "castColumn", params: { column: valueReference, dtype: "float" } },
    {
      id: "formula-value",
      kind: "formula",
      params: { leftColumn: valueReference, operator: "multiply", value: 2, newColumn: "doubled" }
    },
    {
      id: "formula-column",
      kind: "formula",
      params: { leftColumn: valueReference, operator: "add", rightColumn: otherReference, newColumn: "total" }
    },
    { id: "length", kind: "textLength", params: { column: { id: "column:2", name: "" }, newColumn: "length" } },
    {
      id: "one-hot",
      kind: "oneHotEncode",
      params: {
        columns: [valueReference, { id: "column:2", name: "value" }],
        prefixSeparator: "",
        dropOriginal: true
      }
    },
    {
      id: "multi-label",
      kind: "multiLabelBinarize",
      params: { column: valueReference, delimiter: ",", prefix: "label", dropOriginal: false }
    },
    {
      id: "find-replace",
      kind: "findReplace",
      params: { column: valueReference, find: "old", replacement: "new", regex: false }
    },
    { id: "strip-null", kind: "stripText", params: { column: valueReference, characters: null } },
    { id: "strip-omitted", kind: "stripText", params: { column: valueReference } },
    {
      id: "split",
      kind: "splitText",
      params: { column: valueReference, delimiter: ",", index: 0, newColumn: "first" }
    },
    {
      id: "split-columns",
      kind: "splitTextColumns",
      params: { column: valueReference, delimiter: ",", newColumns: ["first", "second"] }
    },
    {
      id: "regex-extraction",
      kind: "extractRegexGroup",
      params: {
        column: valueReference,
        pattern: "([A-Za-z]+)",
        group: 1,
        newColumn: "word"
      }
    },
    {
      id: "pivot-longer",
      kind: "pivotLonger",
      params: {
        columns: [valueReference, otherReference],
        labelColumn: "metric",
        valueColumn: "reading"
      }
    },
    { id: "capitalize", kind: "capitalizeText", params: { column: valueReference } },
    { id: "lower", kind: "lowerText", params: { column: valueReference, newColumn: "lower" } },
    { id: "upper", kind: "upperText", params: { column: valueReference } },
    { id: "scale", kind: "minMaxScale", params: { column: valueReference } },
    { id: "round", kind: "roundNumber", params: { column: valueReference, decimals: 2 } },
    { id: "floor", kind: "floorNumber", params: { column: valueReference } },
    { id: "ceil", kind: "ceilNumber", params: { column: valueReference } },
    { id: "format", kind: "formatDatetime", params: { column: valueReference, format: "%Y-%m-%d" } },
    {
      id: "group",
      kind: "groupBy",
      params: {
        keys: [valueReference],
        aggregations: [
          { column: otherReference, operation: "sum", alias: "total" },
          { column: otherReference, operation: "mean", alias: "average" }
        ]
      }
    },
    {
      id: "example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, otherReference],
        newColumn: "combined",
        examples: [
          { inputs: ["a", 1], output: "a1" },
          { inputs: ["b", 2], output: "b2" }
        ],
        program: {
          kind: "concat",
          parts: [
            { kind: "column", column: valueReference },
            { kind: "column", column: otherReference }
          ]
        },
        warnings: [],
        candidateCount: 1
      }
    }
  ])("accepts canonical column references for $kind", (step) => {
    expect(isTransformStep(step)).toBe(true);
  });

  it.each([
    {
      id: "sort-legacy-name",
      kind: "sortRows",
      params: { rules: [{ column: "value", direction: "asc", nulls: "last" }] }
    },
    {
      id: "filter-legacy-name",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [{ column: "value", type: "integer", predicates: [] }],
          sort: []
        }
      }
    },
    { id: "drop-missing-legacy", kind: "dropMissingRows", params: { columns: ["value"] } },
    { id: "drop-duplicates-empty", kind: "dropDuplicates", params: { columns: [] } },
    { id: "drop-duplicates-legacy", kind: "dropDuplicates", params: { columns: ["value"] } },
    { id: "select-string", kind: "selectColumns", params: { columns: ["value"] } },
    { id: "drop-empty", kind: "dropColumns", params: { columns: [] } },
    { id: "rename-string", kind: "renameColumn", params: { column: "value", newName: "amount" } },
    { id: "clone-name-only", kind: "cloneColumn", params: { column: { name: "value" }, newName: "copy" } },
    { id: "cast-id-only", kind: "castColumn", params: { column: { id: "column:0" }, dtype: "float" } },
    {
      id: "formula-string",
      kind: "formula",
      params: { leftColumn: "value", operator: "add", rightColumn: "other", newColumn: "total" }
    },
    {
      id: "length-extra",
      kind: "textLength",
      params: { column: { ...valueReference, position: 0 }, newColumn: "length" }
    },
    { id: "length-empty-id", kind: "textLength", params: { column: { id: "", name: "value" }, newColumn: "length" } },
    {
      id: "length-non-string-name",
      kind: "textLength",
      params: { column: { id: "column:0", name: 42 }, newColumn: "length" }
    },
    {
      id: "rename-name-field",
      kind: "renameColumn",
      params: { columnName: "value", newName: "amount" }
    },
    { id: "one-hot-string", kind: "oneHotEncode", params: { columns: ["value"] } },
    {
      id: "one-hot-duplicate-id",
      kind: "oneHotEncode",
      params: { columns: [valueReference, { id: valueReference.id, name: "renamed" }] }
    },
    {
      id: "sort-duplicate-id",
      kind: "sortRows",
      params: {
        rules: [
          { column: valueReference, direction: "asc", nulls: "last" },
          { column: { id: valueReference.id, name: "renamed" }, direction: "desc", nulls: "first" }
        ]
      }
    },
    {
      id: "filter-duplicate-id",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [
            { column: valueReference, type: "integer", predicates: [] },
            { column: { id: valueReference.id, name: "renamed" }, type: "integer", predicates: [] }
          ],
          sort: []
        }
      }
    },
    {
      id: "filter-sort-duplicate-id",
      kind: "filterRows",
      params: {
        filterModel: {
          filters: [],
          sort: [
            { column: valueReference, direction: "asc", nulls: "last" },
            { column: { id: valueReference.id, name: "renamed" }, direction: "desc", nulls: "first" }
          ]
        }
      }
    },
    { id: "multi-label-string", kind: "multiLabelBinarize", params: { column: "value", delimiter: "," } },
    {
      id: "find-replace-string",
      kind: "findReplace",
      params: { column: "value", find: "old", replacement: "new" }
    },
    { id: "strip-string", kind: "stripText", params: { column: "value" } },
    { id: "strip-empty-characters", kind: "stripText", params: { column: valueReference, characters: "" } },
    {
      id: "split-string",
      kind: "splitText",
      params: { column: "value", delimiter: ",", index: 0, newColumn: "first" }
    },
    {
      id: "split-columns-too-few",
      kind: "splitTextColumns",
      params: { column: valueReference, delimiter: ",", newColumns: ["first"] }
    },
    {
      id: "split-columns-duplicate",
      kind: "splitTextColumns",
      params: { column: valueReference, delimiter: ",", newColumns: ["same", "same"] }
    },
    {
      id: "regex-extraction-legacy-column",
      kind: "extractRegexGroup",
      params: { column: "value", pattern: "([A-Za-z]+)", group: 1, newColumn: "word" }
    },
    {
      id: "regex-extraction-nonportable",
      kind: "extractRegexGroup",
      params: { column: valueReference, pattern: "a{0,20}b{0,20}", group: 0, newColumn: "word" }
    },
    {
      id: "regex-extraction-multiline-pattern",
      kind: "extractRegexGroup",
      params: { column: valueReference, pattern: "first\nsecond", group: 0, newColumn: "word" }
    },
    {
      id: "regex-extraction-multiline-output",
      kind: "extractRegexGroup",
      params: { column: valueReference, pattern: "([A-Za-z]+)", group: 1, newColumn: "first\nsecond" }
    },
    {
      id: "pivot-longer-too-few",
      kind: "pivotLonger",
      params: { columns: [valueReference], labelColumn: "metric", valueColumn: "reading" }
    },
    {
      id: "pivot-longer-folded-output-collision",
      kind: "pivotLonger",
      params: {
        columns: [valueReference, otherReference],
        labelColumn: "Straße",
        valueColumn: "STRASSE"
      }
    },
    { id: "capitalize-string", kind: "capitalizeText", params: { column: "value" } },
    { id: "lower-string", kind: "lowerText", params: { column: "value" } },
    { id: "upper-string", kind: "upperText", params: { column: "value" } },
    { id: "scale-string", kind: "minMaxScale", params: { column: "value" } },
    { id: "round-string", kind: "roundNumber", params: { column: "value" } },
    { id: "floor-string", kind: "floorNumber", params: { column: "value" } },
    { id: "ceil-string", kind: "ceilNumber", params: { column: "value" } },
    { id: "format-string", kind: "formatDatetime", params: { column: "value", format: "%Y" } },
    {
      id: "group-legacy",
      kind: "groupBy",
      params: { keys: ["value"], aggregations: [{ column: "other", operation: "sum", alias: "total" }] }
    },
    {
      id: "group-position",
      kind: "groupBy",
      params: {
        keys: [{ ...valueReference, position: 0 }],
        aggregations: [{ column: otherReference, operation: "sum", alias: "total" }]
      }
    },
    {
      id: "group-duplicate-key",
      kind: "groupBy",
      params: {
        keys: [valueReference, valueReference],
        aggregations: [{ column: otherReference, operation: "sum", alias: "total" }]
      }
    },
    {
      id: "group-alias-key",
      kind: "groupBy",
      params: {
        keys: [valueReference],
        aggregations: [{ column: otherReference, operation: "sum", alias: "value" }]
      }
    },
    {
      id: "example-legacy",
      kind: "byExample",
      params: {
        sourceColumns: ["value"],
        newColumn: "clean",
        examples: [
          { inputs: { value: "a" }, output: "A" },
          { inputs: { value: "b" }, output: "B" }
        ]
      }
    },
    {
      id: "example-duplicate-source",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a", "a"], output: "A" },
          { inputs: ["b", "b"], output: "B" }
        ]
      }
    },
    {
      id: "example-wrong-arity",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference, otherReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    },
    {
      id: "example-outside-source",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: { kind: "column", column: otherReference }
      }
    },
    {
      id: "example-negative-slice",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "a" },
          { inputs: ["b"], output: "b" }
        ],
        program: { kind: "slice", input: { kind: "column", column: valueReference }, start: -1 }
      }
    },
    {
      id: "example-negative-split",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "a" },
          { inputs: ["b"], output: "b" }
        ],
        program: { kind: "split", input: { kind: "column", column: valueReference }, delimiter: ",", index: -1 }
      }
    }
  ])("rejects legacy or malformed column references for $kind", (step) => {
    expect(isTransformStep(step)).toBe(false);
  });
});
