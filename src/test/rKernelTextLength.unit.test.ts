import { describe, expect, it } from "vitest";
import type { TextLengthTransformStep } from "../shared/protocol";
import { R_FRAME_CONTRACT_LIMITS, type RFramePageContract } from "../extension/r/rFrameContract";
import {
  createRKernelBridge as createBridge,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelCloneDiff as cloneDiff,
  rKernelDataTableContract as dataTableContract,
  rKernelFrameContract as frameContract,
  rKernelOpenRequest as openRequest,
  rKernelPlanRequest as planRequest,
  rKernelTestColumn as column
} from "./rKernelBridgeTestFixtures";

describe("R kernel text-length lifecycle", () => {
  it("creates native R character lengths with stable lineage and preserves the active view", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0", "r:c:1"]);
    const transformed = textLengthContract(source, "r:c:6", "missing_length", "r-text-length-1");
    const step: TextLengthTransformStep = {
      id: "r-text-length-1",
      kind: "textLength",
      params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_length" }
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "text-length-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [
          {
            column: "missing",
            type: "string",
            predicates: [{ kind: "predicate", operator: "contains", value: "a" }]
          }
        ],
        sort: [{ column: "missing", direction: "asc", nulls: "last" }]
      }
    });

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: transformed,
      diff: cloneDiff("missing_length"),
      code: "open_wrangler_result <- orders"
    });
    const previewRequest = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    };
    const preview = await bridge.request(previewRequest);
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      {
        id: "r-text-length-1",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_length" }
      },
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:6", name: "missing" }, type: "string" })],
          sorts: [expect.objectContaining({ column: { id: "r:c:6", name: "missing" } })]
        }
      }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        shape: { rows: 1, columns: 9 },
        schema: expect.arrayContaining([
          {
            id: "c:step:r-text-length-1:0",
            name: "missing_length",
            position: 8,
            rawType: "integer",
            type: "integer",
            nullable: true
          }
        ]),
        filterModel: {
          filters: [expect.objectContaining({ column: "missing", type: "string" })],
          sort: [expect.objectContaining({ column: "missing" })]
        },
        draftStep: step
      },
      diff: { addedColumns: ["missing_length"], removedColumns: [] }
    });
    step.params.newColumn = "tampered_after_preview";
    expect(preview).toMatchObject({ metadata: { draftStep: { params: { newColumn: "missing_length" } } } });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: transformed,
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [{ id: "r-text-length-1", kind: "textLength", params: { newColumn: "missing_length" } }],
        filterModel: {
          filters: [expect.objectContaining({ column: "missing" })],
          sort: [expect.objectContaining({ column: "missing" })]
        }
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-text-length-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: transformed,
      inputSchema: source.schema,
      outputSchema: transformed.schema,
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-text-length-1",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      outputSchema: expect.arrayContaining([
        expect.objectContaining({ id: "c:step:r-text-length-1:0", name: "missing_length", type: "integer" })
      ]),
      diff: { addedColumns: ["missing_length"], removedColumns: [] }
    });
  });

  it("rejects invalid R Text Length inputs and malformed results before publication", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const preview = (step: TextLengthTransformStep) =>
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });

    for (const step of [
      {
        id: "stale-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "stale" }, newColumn: "length" }
      },
      {
        id: "numeric-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:0", name: "value" }, newColumn: "length" }
      },
      {
        id: "colliding-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "count" }
      },
      {
        id: "private-text-length",
        kind: "textLength",
        params: {
          column: { id: "r:c:6", name: "missing" },
          newColumn: "__OPEN_WRANGLER_INTERNAL_ROW_ID_forged"
        }
      },
      {
        id: "long-output-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "é".repeat(513) }
      },
      {
        id: "x".repeat(R_FRAME_CONTRACT_LIMITS.columnIdBytes),
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "length" }
      }
    ] satisfies TextLengthTransformStep[]) {
      await expect(preview(step)).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    }
    expect(transport.previewStep).not.toHaveBeenCalled();

    const validContract = textLengthContract(source, "r:c:6", "missing_length", "bad-schema-text-length");
    const malformed = {
      ...validContract,
      schema: validContract.schema.map((column, index) =>
        index === 8 ? { ...column, rawType: "double", type: "float" as const } : column
      )
    } satisfies RFramePageContract;
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: malformed,
      diff: cloneDiff("missing_length"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      preview({
        id: "bad-schema-text-length",
        kind: "textLength",
        params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_length" }
      })
    ).rejects.toThrow("schema");

    const diffTransport = fakeTransport(source);
    const diffBridge = createBridge(diffTransport);
    await diffBridge.request(openRequest("editing"));
    diffTransport.queuePreview({
      sessionId,
      revision: 1,
      page: textLengthContract(source, "r:c:6", "missing_length", "bad-diff-text-length"),
      diff: cloneDiff("wrong_name"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      diffBridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "bad-diff-text-length",
          kind: "textLength",
          params: { column: { id: "r:c:6", name: "missing" }, newColumn: "missing_length" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("mutation diff");
  });

  it("rejects R Text Length at the frame width limit", async () => {
    const base = frameContract();
    const schema = [
      ...base.schema,
      ...Array.from({ length: R_FRAME_CONTRACT_LIMITS.columns - base.schema.length }, (_, index) => {
        const position = base.schema.length + index;
        return column(position, `extra_${position}`, "double", "float", true, "double");
      })
    ];
    const source = {
      ...base,
      shape: { ...base.shape, columns: R_FRAME_CONTRACT_LIMITS.columns },
      schema
    } satisfies RFramePageContract;
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "maximum-width-text-length",
          kind: "textLength",
          params: { column: { id: "r:c:6", name: "missing" }, newColumn: "length" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });
});

function textLengthContract(
  source: RFramePageContract,
  columnId: string,
  newColumn: string,
  stepId: string
): RFramePageContract {
  const sourceColumn = source.schema.find((column) => column.id === columnId);
  if (!sourceColumn) throw new Error(`Unknown fake R text-length column ${columnId}.`);
  return {
    ...source,
    shape: { ...source.shape, columns: source.schema.length + 1 },
    frameSemantics: { ...source.frameSemantics, keyColumnIds: [...source.frameSemantics.keyColumnIds] },
    schema: [
      ...source.schema.map((column) => ({ ...column })),
      {
        id: `c:step:${stepId}:0`,
        name: newColumn,
        position: source.schema.length,
        rawType: "integer",
        type: "integer",
        nullable: sourceColumn.nullable,
        semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
      }
    ],
    page: {
      ...source.page,
      columnIds: [...source.page.columnIds],
      rows: source.page.rows.map((row) => ({
        ...row,
        values: row.values.map((value) => ({ ...value }))
      }))
    }
  };
}
