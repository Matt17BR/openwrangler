import { describe, expect, it } from "vitest";
import type { CloneColumnTransformStep } from "../shared/protocol";
import { R_FRAME_CONTRACT_LIMITS, type RFramePageContract } from "../extension/r/rFrameContract";
import {
  createRKernelBridge as createBridge,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelCloneContract as cloneContract,
  rKernelCloneDiff as cloneDiff,
  rKernelDataTableContract as dataTableContract,
  rKernelFrameContract as frameContract,
  rKernelOpenRequest as openRequest,
  rKernelPlanRequest as planRequest,
  rKernelTestColumn as column
} from "./rKernelBridgeTestFixtures";

describe("R kernel clone-column lifecycle", () => {
  it("clones one exact R column with stable lineage through preview, apply, inspection, edit, and undo", async () => {
    const source = dataTableContract(frameContract(), ["r:c:0", "r:c:1"]);
    const cloned = cloneContract(source, "r:c:0", "value_copy", "r-clone-1");
    const edited = cloneContract(source, "r:c:0", "value_duplicate", "r-clone-1");
    const cloneStep: CloneColumnTransformStep = {
      id: "r-clone-1",
      kind: "cloneColumn",
      params: { column: { id: "r:c:0", name: "value" }, newName: "value_copy" }
    };
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "clone-view",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8,
      filterModel: {
        filters: [
          {
            column: "value",
            type: "float",
            predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
          }
        ],
        sort: [{ column: "count", direction: "desc", nulls: "last" }]
      }
    });

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloned,
      diff: cloneDiff("value_copy"),
      code: "open_wrangler_result <- orders"
    });
    const previewRequest = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step: cloneStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    };
    const preview = await bridge.request(previewRequest);
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      cloneStep,
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })],
          sorts: [expect.objectContaining({ column: { id: "r:c:1", name: "count" } })]
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
            id: "c:step:r-clone-1:0",
            name: "value_copy",
            position: 8,
            rawType: "double",
            type: "float",
            nullable: true
          }
        ]),
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "count" })]
        },
        draftStep: cloneStep
      },
      diff: { addedColumns: ["value_copy"], removedColumns: [] }
    });
    cloneStep.params.newName = "tampered_after_preview";
    expect(preview).toMatchObject({
      metadata: { draftStep: { kind: "cloneColumn", params: { newName: "value_copy" } } }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: cloned,
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [{ id: "r-clone-1", kind: "cloneColumn", params: { newName: "value_copy" } }],
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "count" })]
        }
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-clone-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: cloned,
      inputSchema: source.schema,
      outputSchema: cloned.schema,
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-clone-1",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      outputSchema: expect.arrayContaining([
        expect.objectContaining({ id: "c:step:r-clone-1:0", name: "value_copy", position: 8 })
      ]),
      diff: { addedColumns: ["value_copy"], removedColumns: [] }
    });

    const replacement: CloneColumnTransformStep = {
      id: "r-clone-1",
      kind: "cloneColumn",
      params: { column: { id: "r:c:0", name: "value" }, newName: "value_duplicate" }
    };
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: edited,
      diff: cloneDiff("value_duplicate"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      bridge.request({ ...previewRequest, revision: 2, replaceStepId: "r-clone-1", step: replacement })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        steps: [{ id: "r-clone-1", params: { newName: "value_copy" } }],
        draftStep: { id: "r-clone-1", params: { newName: "value_duplicate" } },
        draftReplacesStepId: "r-clone-1",
        latestStepInputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:0", name: "value" })]),
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "c:step:r-clone-1:0", name: "value_duplicate", position: 8 })
        ])
      }
    });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: edited,
      code: "open_wrangler_result <- orders"
    });
    await bridge.request(planRequest("applyDraft", 3));

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 5,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("undoStep", 4))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        steps: [],
        schema: expect.not.arrayContaining([expect.objectContaining({ id: "c:step:r-clone-1:0" })]),
        filterModel: {
          filters: [expect.objectContaining({ column: "value" })],
          sort: [expect.objectContaining({ column: "count" })]
        }
      }
    });
  });

  it("rejects invalid R clone references, names, identities, and structural diffs before publication", async () => {
    const source = frameContract();
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const preview = (step: CloneColumnTransformStep) =>
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
        id: "stale-clone",
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "stale" }, newName: "copy" }
      },
      {
        id: "colliding-clone",
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "count" }
      },
      {
        id: "private-clone",
        kind: "cloneColumn",
        params: {
          column: { id: "r:c:0", name: "value" },
          newName: "__OPEN_WRANGLER_INTERNAL_ROW_ID_forged"
        }
      },
      {
        id: "long-name-clone",
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "é".repeat(513) }
      },
      {
        id: "x".repeat(R_FRAME_CONTRACT_LIMITS.columnIdBytes),
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "copy" }
      }
    ] satisfies CloneColumnTransformStep[]) {
      await expect(preview(step)).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    }
    expect(transport.previewStep).not.toHaveBeenCalled();

    const cloned = cloneContract(source, "r:c:0", "value_copy", "bad-diff-clone");
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: cloned,
      diff: cloneDiff("wrong_name"),
      code: "open_wrangler_result <- orders"
    });
    await expect(
      preview({
        id: "bad-diff-clone",
        kind: "cloneColumn",
        params: { column: { id: "r:c:0", name: "value" }, newName: "value_copy" }
      })
    ).rejects.toThrow("mutation diff");
  });

  it("rejects cloning a case-insensitive reserved R source column before transport", async () => {
    const base = frameContract();
    const reservedName = "__Open_Wrangler_Internal_Row_Id_source";
    const source = {
      ...base,
      schema: base.schema.map((entry, index) => (index === 0 ? { ...entry, name: reservedName } : entry))
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
          id: "reserved-source-clone",
          kind: "cloneColumn",
          params: { column: { id: "r:c:0", name: reservedName }, newName: "copy" }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(transport.previewStep).not.toHaveBeenCalled();
  });

  it("rejects cloning an R frame at the column limit before transport", async () => {
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
          id: "maximum-width-clone",
          kind: "cloneColumn",
          params: { column: { id: "r:c:0", name: "value" }, newName: "copy" }
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
