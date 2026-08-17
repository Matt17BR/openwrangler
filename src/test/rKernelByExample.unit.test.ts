import { describe, expect, it } from "vitest";
import type { ByExampleProgram, ByExampleTransformStep } from "../shared/protocol";
import type { RColumnSchema, RFramePageContract } from "../extension/r/rFrameContract";
import {
  createRKernelBridge as createBridge,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelByExampleTransformStep as byExampleTransformStep,
  rKernelCastContract as castContract,
  rKernelCloneContract as cloneContract,
  rKernelCloneDiff as cloneDiff,
  rKernelFactorContract as factorContract,
  rKernelFrameContract as frameContract,
  rKernelOpenRequest as openRequest,
  rKernelPlanRequest as planRequest,
  rKernelReplaceColumnSemantics as replaceColumnSemantics,
  rKernelReplaceContractCell as replaceContractCell,
  rKernelRetainedByExampleTransformStep as retainedByExampleTransformStep,
  rKernelTestCell as rCell,
  rKernelWithColumnNullable as withColumnNullable
} from "./rKernelBridgeTestFixtures";

describe("R kernel by-example lifecycle", () => {
  it("retains the exact normalized native R by-example program and runtime-derived output schema", async () => {
    const source = frameContract();
    const step = byExampleTransformStep();
    const output = cloneContract(source, "r:c:1", step.params.newColumn, step.id);
    const retainedStep = retainedByExampleTransformStep(step);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: cloneDiff(step.params.newColumn),
      code: "orders[['count copy']] <- orders[['count']]",
      retainedStep
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });

    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      step,
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      warnings: ["2 programs match; Open Wrangler selected the simplest deterministic program."],
      metadata: {
        shape: { rows: 1, columns: 9 },
        schema: expect.arrayContaining([
          expect.objectContaining({
            id: "c:step:by-example-step:0",
            name: "count copy",
            rawType: "integer64",
            type: "integer"
          })
        ]),
        draftStep: {
          id: "by-example-step",
          kind: "byExample",
          params: {
            program: { kind: "column", column: { id: "r:c:1", name: "count" } },
            candidateCount: 2
          }
        }
      },
      diff: { addedColumns: ["count copy"], addedRows: 0, removedRows: 0 }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: output,
      code: "orders[['count copy']] <- orders[['count']]"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [
          {
            id: "by-example-step",
            kind: "byExample",
            params: { program: { kind: "column" }, warnings: expect.any(Array), candidateCount: 2 }
          }
        ]
      }
    });
  });

  it.each([
    {
      label: "factor",
      source: factorContract(frameContract(), "r:c:6", ["alpha", "beta"]),
      sourceColumn: { id: "r:c:6", name: "missing" },
      examples: [
        { inputs: ["alpha"], output: "alpha" },
        { inputs: ["beta"], output: "beta" }
      ] as ByExampleTransformStep["params"]["examples"],
      rawType: "factor"
    },
    {
      label: "difftime",
      source: frameContract(),
      sourceColumn: { id: "r:c:4", name: "elapsed" },
      examples: [
        { inputs: [90], output: 90 },
        { inputs: [120], output: 120 }
      ] as ByExampleTransformStep["params"]["examples"],
      rawType: "difftime"
    }
  ])("preserves a direct $label output's native R contract", async ({ source, sourceColumn, examples, rawType }) => {
    const step: ByExampleTransformStep = {
      id: `direct-${rawType}`,
      kind: "byExample",
      params: {
        sourceColumns: [sourceColumn],
        newColumn: `${sourceColumn.name} copy`,
        examples
      }
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloneContract(source, sourceColumn.id, step.params.newColumn, step.id),
      diff: cloneDiff(step.params.newColumn),
      code: "open_wrangler_result <- orders",
      retainedStep: retainedByExampleTransformStep(step)
    });

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: `c:step:${step.id}:0`, name: step.params.newColumn, rawType })
        ])
      }
    });
  });

  it.each([
    { label: "observed nonmissing", outputNullable: false },
    { label: "observed missing", outputNullable: true }
  ])(
    "accepts runtime-derived $label direct-result nullability from a conservatively nullable source",
    async ({ outputNullable }) => {
      const base = frameContract();
      const source = outputNullable
        ? replaceContractCell(base, "r:c:1", {
            kind: "null",
            raw: null,
            display: "NA",
            isNull: true,
            isNaN: false
          })
        : base;
      expect(source.schema[1]).toMatchObject({ id: "r:c:1", nullable: true });
      const step = byExampleTransformStep();
      const outputId = `c:step:${step.id}:0`;
      const output = withColumnNullable(
        cloneContract(source, "r:c:1", step.params.newColumn, step.id),
        outputId,
        outputNullable
      );
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: output,
        diff: cloneDiff(step.params.newColumn),
        code: "open_wrangler_result <- orders",
        retainedStep: retainedByExampleTransformStep(step)
      });

      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({
        kind: "stepPreview",
        metadata: {
          schema: expect.arrayContaining([expect.objectContaining({ id: outputId, nullable: outputNullable })])
        }
      });
    }
  );

  it.each([
    {
      label: "null",
      value: null,
      source: frameContract(),
      outputColumnId: "r:c:5",
      rawType: "logical"
    },
    {
      label: "logical",
      value: true,
      source: frameContract(),
      outputColumnId: "r:c:5",
      rawType: "logical"
    },
    {
      label: "character",
      value: "fixed",
      source: frameContract(),
      outputColumnId: "r:c:6",
      rawType: "character"
    },
    {
      label: "R integer maximum",
      value: 2_147_483_647,
      source: castContract(
        frameContract(),
        "r:c:1",
        "integer",
        "integer",
        rCell("integer", "2147483647", "2147483647"),
        false
      ),
      outputColumnId: "r:c:1",
      rawType: "integer"
    },
    {
      label: "reserved R integer minimum",
      value: -2_147_483_648,
      source: frameContract(),
      outputColumnId: "r:c:1",
      rawType: "integer64"
    },
    {
      label: "maximum safe integer",
      value: Number.MAX_SAFE_INTEGER,
      source: frameContract(),
      outputColumnId: "r:c:1",
      rawType: "integer64"
    },
    {
      label: "non-whole number",
      value: 1.5,
      source: frameContract(),
      outputColumnId: "r:c:0",
      rawType: "double"
    }
  ])("derives the exact native R $label literal result", async ({ value, source, outputColumnId, rawType }) => {
    const baseStep = byExampleTransformStep();
    const step: ByExampleTransformStep = {
      ...baseStep,
      id: `literal-${rawType}-${String(value)}`,
      params: {
        ...baseStep.params,
        newColumn: `literal ${rawType}`,
        examples: [
          { inputs: [1], output: value },
          { inputs: [2], output: value }
        ]
      }
    };
    const program: ByExampleProgram = { kind: "literal", value };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloneContract(source, outputColumnId, step.params.newColumn, step.id),
      diff: cloneDiff(step.params.newColumn),
      code: "open_wrangler_result <- orders",
      retainedStep: retainedByExampleTransformStep(step, program)
    });

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: `c:step:${step.id}:0`, name: step.params.newColumn, rawType })
        ])
      }
    });
  });

  it.each([
    {
      label: "direct integer64 program as factor",
      program: { kind: "column", column: { id: "r:c:1", name: "count" } } as ByExampleProgram,
      outputColumnId: "r:c:6"
    },
    {
      label: "computed text program as integer64",
      program: {
        kind: "case",
        style: "upper",
        input: { kind: "column", column: { id: "r:c:1", name: "count" } }
      } as ByExampleProgram,
      outputColumnId: "r:c:1"
    },
    {
      label: "integer arithmetic program as double",
      program: {
        kind: "arithmetic",
        left: { kind: "column", column: { id: "r:c:1", name: "count" } },
        operator: "add",
        right: { kind: "literal", value: 1 }
      } as ByExampleProgram,
      outputColumnId: "r:c:0"
    }
  ])("rejects an allowed native raw type that mismatches a $label", async ({ program, outputColumnId }) => {
    const source = factorContract(frameContract(), "r:c:6", ["one", "two"]);
    const step = byExampleTransformStep();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloneContract(source, outputColumnId, step.params.newColumn, step.id),
      diff: cloneDiff(step.params.newColumn),
      code: "open_wrangler_result <- orders",
      retainedStep: retainedByExampleTransformStep(step, program)
    });

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("does not match the retained program");
  });

  it.each(["factor levels", "difftime units"])("rejects direct by-example %s drift", async (drift) => {
    const source =
      drift === "factor levels" ? factorContract(frameContract(), "r:c:6", ["alpha", "beta"]) : frameContract();
    const sourceColumn =
      drift === "factor levels" ? { id: "r:c:6", name: "missing" } : { id: "r:c:4", name: "elapsed" };
    const baseStep = byExampleTransformStep();
    const step: ByExampleTransformStep = {
      ...baseStep,
      id: drift === "factor levels" ? "factor-level-drift" : "difftime-unit-drift",
      params: {
        ...baseStep.params,
        sourceColumns: [sourceColumn],
        newColumn: `${sourceColumn.name} copy`
      }
    };
    const outputId = `c:step:${step.id}:0`;
    const cloned = cloneContract(source, sourceColumn.id, step.params.newColumn, step.id);
    const sourceRColumn = source.schema.find((column) => column.id === sourceColumn.id);
    if (!sourceRColumn) throw new Error("Fake direct by-example source column is missing.");
    let driftedSemantics: RColumnSchema["semantics"];
    if (drift === "factor levels") {
      if (sourceRColumn.semantics.kind !== "factor") throw new Error("Fake factor semantics are missing.");
      driftedSemantics = { ...sourceRColumn.semantics, levels: ["alpha", "gamma"] };
    } else {
      if (sourceRColumn.semantics.kind !== "difftime") throw new Error("Fake difftime semantics are missing.");
      driftedSemantics = { ...sourceRColumn.semantics, units: "mins" };
    }
    const drifted = replaceColumnSemantics(cloned, outputId, driftedSemantics);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: drifted,
      diff: cloneDiff(step.params.newColumn),
      code: "open_wrangler_result <- orders",
      retainedStep: retainedByExampleTransformStep(step)
    });

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("changed the native semantics");
  });

  it.each(["program literal", "example value"])("rejects an unsafe whole-number by-example %s", async (location) => {
    const baseStep = byExampleTransformStep();
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const step: ByExampleTransformStep = {
      ...baseStep,
      id: `unsafe-${location.replace(" ", "-")}`,
      params: {
        ...baseStep.params,
        ...(location === "program literal" ? { program: { kind: "literal", value: unsafeInteger } as const } : {}),
        ...(location === "example value"
          ? {
              examples: [
                { inputs: [unsafeInteger], output: 1 },
                { inputs: [2], output: 2 }
              ] as ByExampleTransformStep["params"]["examples"]
            }
          : {})
      }
    };
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request"
    });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it.each(["program literal", "example value"])(
    "rejects a negative-zero by-example %s before transport",
    async (location) => {
      const baseStep = byExampleTransformStep();
      const step: ByExampleTransformStep = {
        ...baseStep,
        id: `negative-zero-${location.replace(" ", "-")}`,
        params: {
          ...baseStep.params,
          ...(location === "program literal" ? { program: { kind: "literal", value: -0 } as const } : {}),
          ...(location === "example value"
            ? {
                examples: [
                  { inputs: [-0], output: 0 },
                  { inputs: [2], output: 2 }
                ] as ByExampleTransformStep["params"]["examples"]
              }
            : {})
        }
      };
      const transport = fakeTransport(frameContract());
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));

      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
      expect(transport.previewStep).not.toHaveBeenCalled();
    }
  );

  it("rejects embedded NUL in native R by-example strings before transport dispatch", async () => {
    const baseStep = byExampleTransformStep();
    const step: ByExampleTransformStep = {
      ...baseStep,
      params: {
        ...baseStep.params,
        program: {
          kind: "regexReplace",
          input: { kind: "column", column: { id: "r:c:1", name: "count" } },
          pattern: "1",
          replacement: "one\u0000truncated"
        }
      }
    };
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("U+0000")
    });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("rejects a native R by-example source whose raw type is unsupported", async () => {
    const base = frameContract();
    const source: RFramePageContract = {
      ...base,
      schema: base.schema.map((column) => (column.id === "r:c:6" ? { ...column, rawType: "raw" } : { ...column }))
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const step: ByExampleTransformStep = {
      id: "unsupported-raw-by-example",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "r:c:6", name: "missing" }],
        newColumn: "raw copy",
        examples: [
          { inputs: ["00"], output: "00" },
          { inputs: ["ff"], output: "ff" }
        ]
      }
    };

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("unsupported R raw values")
    });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("fails closed on stale, type-incompatible, or mis-correlated native R by-example state", async () => {
    const source = frameContract();
    const staleTransport = fakeTransport(source);
    const staleBridge = createBridge(staleTransport);
    await staleBridge.request(openRequest("editing"));
    const stale = byExampleTransformStep();
    stale.params.sourceColumns[0] = { id: "r:c:404", name: "count" };
    await expect(
      staleBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: stale,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request", message: expect.stringContaining("stale") });
    expect(staleTransport.previewStep).not.toHaveBeenCalled();

    const incompatibleTransport = fakeTransport(source);
    const incompatibleBridge = createBridge(incompatibleTransport);
    await incompatibleBridge.request(openRequest("editing"));
    const incompatible: ByExampleTransformStep = {
      id: "bad-by-example-step",
      kind: "byExample",
      params: {
        sourceColumns: [{ id: "r:c:5", name: "flag" }],
        newColumn: "bad output",
        examples: [
          { inputs: [true], output: "TRUE" },
          { inputs: [false], output: "FALSE" }
        ],
        program: {
          kind: "case",
          style: "upper",
          input: { kind: "column", column: { id: "r:c:5", name: "flag" } }
        }
      }
    };
    await expect(
      incompatibleBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: incompatible,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("portable text-coercible")
    });
    expect(incompatibleTransport.previewStep).not.toHaveBeenCalled();

    const mismatchedTransport = fakeTransport(source);
    const mismatchedBridge = createBridge(mismatchedTransport);
    await mismatchedBridge.request(openRequest("editing"));
    const requestStep = byExampleTransformStep();
    const returnedStep = retainedByExampleTransformStep(requestStep);
    mismatchedTransport.queuePreview({
      sessionId,
      revision: 1,
      page: cloneContract(source, "r:c:1", requestStep.params.newColumn, requestStep.id),
      diff: cloneDiff(requestStep.params.newColumn),
      code: "orders[['count copy']] <- orders[['count']]",
      retainedStep: {
        ...returnedStep,
        params: {
          ...returnedStep.params,
          examples: [{ inputs: [999], output: 999 }, ...returnedStep.params.examples.slice(1)]
        }
      }
    });
    await expect(
      mismatchedBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: requestStep,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("does not match the exact preview request");
  });
});
