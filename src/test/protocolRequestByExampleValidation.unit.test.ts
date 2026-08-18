import { describe, expect, it } from "vitest";
import { isOpenWranglerRequest, isRuntimeRequestEnvelope, isTransformStep } from "../shared/protocolValidation";
import { metadata, requests, valueReference } from "./protocolValidation.fixtures";

describe("protocol-v2 bounded by-example request validation", () => {
  it("bounds by-example sources, examples, concat programs, depth, and scalar values", () => {
    const sources = Array.from({ length: 17 }, (_, index) => ({ id: `column:${index}`, name: `value_${index}` }));
    const example = (width: number) => ({ inputs: Array.from({ length: width }, () => "x"), output: "x" });
    const base = {
      id: "bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [example(1), example(1)]
      }
    };
    const oversizedProgram = {
      kind: "concat",
      parts: Array.from({ length: 64 }, () => ({
        kind: "concat",
        parts: Array.from({ length: 4 }, () => ({ kind: "column", column: valueReference }))
      }))
    };
    let deepProgram: unknown = { kind: "column", column: valueReference };
    for (let index = 0; index < 65; index += 1) deepProgram = { kind: "slice", input: deepProgram, start: 0 };

    const malformed = [
      { ...base, params: { ...base.params, sourceColumns: sources, examples: [example(17), example(17)] } },
      { ...base, params: { ...base.params, examples: Array.from({ length: 65 }, () => example(1)) } },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "concat",
            parts: Array.from({ length: 65 }, () => ({ kind: "column", column: valueReference }))
          }
        }
      },
      { ...base, params: { ...base.params, program: oversizedProgram } },
      { ...base, params: { ...base.params, program: deepProgram } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "slice", input: { kind: "column", column: valueReference }, start: 2, stop: 1 }
        }
      },
      { ...base, params: { ...base.params, examples: [{ inputs: [Number.NaN], output: "x" }, example(1)] } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "literal", value: Number.POSITIVE_INFINITY }
        }
      }
    ];

    for (const step of malformed) expect(isTransformStep(step)).toBe(false);
  });

  it("rejects over-wide by-example containers before traversing their contents", () => {
    const base = {
      id: "container-bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };
    const hugeLength = 100_000;
    const malformed = [
      {
        ...base,
        params: {
          ...base.params,
          sourceColumns: Array.from({ length: hugeLength }, () => valueReference)
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "concat",
            parts: Array.from({ length: hugeLength }, () => ({ kind: "column", column: valueReference }))
          }
        }
      },
      { ...base, params: { ...base.params, warnings: Array.from({ length: hugeLength }, () => "") } }
    ];

    for (const step of malformed) {
      expect(() => isTransformStep(step)).not.toThrow();
      expect(isTransformStep(step)).toBe(false);
    }
  });

  it("caps saved by-example warnings independently of their UTF-8 payload", () => {
    const base = {
      id: "warning-bounded-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };

    expect(
      isTransformStep({ ...base, params: { ...base.params, warnings: Array.from({ length: 64 }, () => "") } })
    ).toBe(true);
    expect(
      isTransformStep({ ...base, params: { ...base.params, warnings: Array.from({ length: 65 }, () => "") } })
    ).toBe(false);
  });

  it("bounds every by-example string by strict UTF-8 bytes", () => {
    const stepWithInput = (input: string) => ({
      id: "utf8-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c", name: "" }],
        newColumn: "n",
        examples: [
          { inputs: [input], output: null },
          { inputs: [null], output: null }
        ]
      }
    });

    for (const accepted of ["a".repeat(8192), "é".repeat(4096), "🙂".repeat(2048)]) {
      expect(isTransformStep(stepWithInput(accepted))).toBe(true);
    }
    for (const rejected of ["a".repeat(8193), "é".repeat(4097), "🙂".repeat(2049), "\ud800"]) {
      expect(() => isTransformStep(stepWithInput(rejected))).not.toThrow();
      expect(isTransformStep(stepWithInput(rejected))).toBe(false);
    }
  });

  it("rejects by-example integer scalars that cannot survive the JSON transport exactly", () => {
    const stepWithValues = (input: number, output: number) => ({
      id: "numeric-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "result",
        examples: [
          { inputs: [input], output },
          { inputs: [1], output: 2 }
        ]
      }
    });

    expect(isTransformStep(stepWithValues(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER))).toBe(true);
    expect(isTransformStep(stepWithValues(Number.MAX_SAFE_INTEGER + 1, 1))).toBe(false);
    expect(isTransformStep(stepWithValues(1, Number.MIN_SAFE_INTEGER - 1))).toBe(false);
    expect(isTransformStep(stepWithValues(1.25, 2.5))).toBe(true);
    expect(isTransformStep(stepWithValues(-0, 1))).toBe(false);
    expect(isTransformStep(stepWithValues(1, -0))).toBe(false);
    expect(
      isTransformStep({
        ...stepWithValues(1, 2),
        params: {
          ...stepWithValues(1, 2).params,
          program: { kind: "literal", value: -0 }
        }
      })
    ).toBe(false);
  });

  it("requires every by-example structural integer to survive the JSON transport exactly", () => {
    const leaf = { kind: "column", column: valueReference } as const;
    const stepWithProgram = (program: unknown, candidateCount = 1) => ({
      id: "structural-integer-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "result",
        examples: [
          { inputs: ["a"], output: "a" },
          { inputs: ["b"], output: "b" }
        ],
        program,
        warnings: [],
        candidateCount
      }
    });
    const unsafe = Number.MAX_SAFE_INTEGER + 1;

    for (const program of [
      { kind: "slice", input: leaf, start: unsafe },
      { kind: "slice", input: leaf, start: 0, stop: unsafe },
      { kind: "split", input: leaf, delimiter: "-", index: unsafe },
      { kind: "regexExtract", input: leaf, pattern: "(.)", group: unsafe },
      { kind: "regexExtract", input: leaf, pattern: "(.)", group: -unsafe },
      { kind: "slice", input: leaf, start: -0 },
      { kind: "slice", input: leaf, start: 0, stop: -0 },
      { kind: "split", input: leaf, delimiter: "-", index: -0 },
      { kind: "regexExtract", input: leaf, pattern: "(.)", group: -0 }
    ]) {
      expect(isTransformStep(stepWithProgram(program))).toBe(false);
    }
    expect(isTransformStep(stepWithProgram(leaf, unsafe))).toBe(false);

    expect(
      isTransformStep(
        stepWithProgram(
          { kind: "slice", input: leaf, start: Number.MAX_SAFE_INTEGER, stop: Number.MAX_SAFE_INTEGER },
          Number.MAX_SAFE_INTEGER
        )
      )
    ).toBe(true);
  });

  it("caps the aggregate by-example text envelope at 64 KiB", () => {
    const stringsAtLimit = ["a".repeat(8190), ...Array.from({ length: 7 }, () => "b".repeat(8192))];
    const stepWithStrings = (strings: string[]) => ({
      id: "aggregate-utf8-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "c", name: "" }],
        newColumn: "n",
        examples: Array.from({ length: 4 }, (_, index) => ({
          inputs: [strings[index * 2]],
          output: strings[index * 2 + 1]
        }))
      }
    });

    expect(isTransformStep(stepWithStrings(stringsAtLimit))).toBe(true);
    expect(isTransformStep(stepWithStrings([`x${stringsAtLimit[0]}`, ...stringsAtLimit.slice(1)]))).toBe(false);
  });

  it("counts references, program text, and warnings in the by-example envelope", () => {
    const column = { id: "c", name: "value" };
    const base = {
      id: "text-fields-example",
      kind: "byExample",
      params: {
        sourceColumns: [column],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ]
      }
    };
    const oversized = "x".repeat(8193);
    const columnProgram = { kind: "column", column };
    const malformed = [
      { ...base, params: { ...base.params, sourceColumns: [{ id: "c", name: oversized }] } },
      { ...base, params: { ...base.params, newColumn: oversized } },
      { ...base, params: { ...base.params, program: { kind: "literal", value: oversized } } },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "split", input: columnProgram, delimiter: oversized, index: 0 }
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: { kind: "regexReplace", input: columnProgram, pattern: oversized, replacement: "" }
        }
      },
      {
        ...base,
        params: {
          ...base.params,
          program: {
            kind: "datetimeFormat",
            input: columnProgram,
            inputFormat: "%Y",
            outputFormat: oversized
          }
        }
      },
      { ...base, params: { ...base.params, warnings: [oversized] } },
      { ...base, params: { ...base.params, warnings: ["\udfff"] } }
    ];

    for (const step of malformed) {
      expect(() => isTransformStep(step)).not.toThrow();
      expect(isTransformStep(step)).toBe(false);
    }
  });

  it("rejects cyclic by-example programs without throwing", () => {
    const cyclic: Record<string, unknown> = { kind: "case", style: "upper" };
    cyclic.input = cyclic;
    const step = {
      id: "cyclic-example",
      kind: "byExample",
      params: {
        sourceColumns: [valueReference],
        newColumn: "clean",
        examples: [
          { inputs: ["a"], output: "A" },
          { inputs: ["b"], output: "B" }
        ],
        program: cyclic
      }
    };

    expect(() => isTransformStep(step)).not.toThrow();
    expect(isTransformStep(step)).toBe(false);
  });

  it("accepts one Unicode scalar in canonical CSV options and rejects CSV fields on Parquet", () => {
    expect(
      isOpenWranglerRequest({
        kind: "exportData",
        sessionId: "session-1",
        revision: 3,
        path: "/tmp/out.csv",
        options: {
          format: "csv",
          delimiter: "💾",
          quoteChar: "«",
          encoding: "utf-16le",
          header: false,
          rowAxisPolicy: "preserve"
        }
      })
    ).toBe(true);
    expect(
      isOpenWranglerRequest({
        kind: "exportData",
        sessionId: "session-1",
        revision: 3,
        path: "/tmp/out.parquet",
        options: { format: "parquet", delimiter: "," }
      })
    ).toBe(false);
  });

  it.each([
    {
      kind: "openSession",
      source: metadata.source,
      requestedSessionId: "",
      backend: "polars",
      mode: "editing",
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "previewStep",
      sessionId: "session-1",
      revision: 3,
      step: { id: "bad", kind: "renameColumn", params: { columns: ["value"] } },
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "inspectStep",
      sessionId: "session-1",
      revision: 3,
      stepId: "",
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "inspectStep",
      sessionId: "session-1",
      revision: 3,
      stepId: "step-1",
      offset: -1,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "previewStep",
      sessionId: "session-1",
      revision: 3,
      step: { id: "bad", kind: "customCode", params: { code: "   " } },
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "",
      options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "utf-8", header: true }
    },
    { kind: "exportData", sessionId: "session-1", revision: 3, path: "/tmp/out.csv", options: { format: "json" } },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "utf-8" }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: "", quoteChar: '"', encoding: "utf-8", header: true }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: ",", quoteChar: ",", encoding: "utf-8", header: true }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: "\n", quoteChar: '"', encoding: "utf-8", header: true }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "x".repeat(65), header: true }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: "\ud800", quoteChar: '"', encoding: "utf-8", header: true }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.parquet",
      options: { format: "parquet", delimiter: "," }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: {
        format: "csv",
        delimiter: ",",
        quoteChar: '"',
        encoding: "utf-8",
        header: true,
        rowAxisPolicy: "automatic"
      }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "utf-8", header: true },
      targetIdentity: { device: "0", inode: "0" }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "utf-8", header: true },
      targetIdentity: { device: "01", inode: "11" }
    },
    {
      kind: "exportData",
      sessionId: "session-1",
      revision: 3,
      path: "/tmp/out.csv",
      options: { format: "csv", delimiter: ",", quoteChar: '"', encoding: "utf-8", header: true },
      targetIdentity: { device: "340282366920938463463374607431768211456", inode: "11" }
    },
    { kind: "closeSession", sessionId: 17, revision: 3 },
    { kind: "closeSession", sessionId: "session-1", revision: -1 },
    { kind: "closeSession", sessionId: "session-1", revision: 3, force: true }
  ])("rejects malformed boundary input: %j", (request) => {
    expect(isOpenWranglerRequest(request)).toBe(false);
  });

  it("rejects missing, fractional, negative, zero, and oversized column windows", () => {
    const getPage = requests.find((request) => request.kind === "getPage");
    expect(getPage?.kind).toBe("getPage");
    if (getPage?.kind !== "getPage") return;

    const { columnOffset: _columnOffset, ...withoutOffset } = getPage;
    expect(isOpenWranglerRequest(withoutOffset)).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnOffset: -1 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnOffset: 0.5 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnLimit: 0 })).toBe(false);
    expect(isOpenWranglerRequest({ ...getPage, columnLimit: 257 })).toBe(false);
  });

  it("rejects unknown request kinds and malformed request envelopes", () => {
    expect(isOpenWranglerRequest({ kind: "futureRequest" })).toBe(false);
    expect(
      isRuntimeRequestEnvelope({
        protocolVersion: 2,
        requestId: "request-1",
        priority: "urgent",
        request: requests[0]
      })
    ).toBe(false);
    expect(
      isRuntimeRequestEnvelope({
        protocolVersion: 2,
        requestId: "request-1",
        priority: "interactive",
        request: requests[0],
        extra: true
      })
    ).toBe(false);
  });
});
