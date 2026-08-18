import { describe, expect, it } from "vitest";
import type { RenameColumnTransformStep } from "../shared/protocol";
import {
  createRKernelBridge as createBridge,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelFrameContract as frameContract,
  rKernelOpenRequest as openRequest,
  rKernelPlanRequest as planRequest,
  rKernelRenameContract as renameContract,
  rKernelRenameDiff as renameDiff
} from "./rKernelBridgeTestFixtures";

describe("R kernel selected earlier-step editing", () => {
  it("binds the replacement to its recorded input and refuses a direct partial-plan apply", async () => {
    const source = frameContract();
    const first = rename("first-rename", "r:c:0", "value", "amount");
    const suffix = rename("suffix-rename", "r:c:1", "count", "quantity");
    const firstOutput = renameContract(source, "r:c:0", "amount");
    const confirmed = renameContract(firstOutput, "r:c:1", "quantity");
    const replacement = rename("first-rename", "r:c:0", "value", "updated amount");
    const replacementOutput = renameContract(source, "r:c:0", "updated amount");
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.queuePreview({ sessionId, revision: 1, page: firstOutput, diff: renameDiff(), code: "first" });
    await bridge.request(preview(first, 0));
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: firstOutput,
      code: "first"
    });
    await bridge.request(planRequest("applyDraft", 1));

    transport.queuePreview({ sessionId, revision: 3, page: confirmed, diff: renameDiff(), code: "first\nsuffix" });
    await bridge.request(preview(suffix, 2));
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: confirmed,
      code: "first\nsuffix"
    });
    await bridge.request(planRequest("applyDraft", 3));

    transport.queuePreview({
      sessionId,
      revision: 5,
      page: replacementOutput,
      diff: renameDiff(),
      code: "replacement"
    });
    const edited = await bridge.request(preview(replacement, 4, first.id));

    expect(transport.previewStep.mock.calls.at(-1)?.[4].map((column) => column.name)).toEqual(
      source.schema.map((column) => column.name)
    );
    expect(edited).toMatchObject({
      kind: "stepPreview",
      metadata: {
        steps: [first, suffix],
        draftStep: replacement,
        draftReplacesStepId: first.id,
        latestStepInputSchema: expect.arrayContaining([
          expect.objectContaining({ id: "r:c:0", name: "value", position: 0 }),
          expect.objectContaining({ id: "r:c:1", name: "count", position: 1 })
        ])
      }
    });
    await expect(bridge.request(planRequest("applyDraft", 5))).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("host plan-rewrite transaction")
    });
    expect(transport.applyDraft).toHaveBeenCalledTimes(2);
  });
});

function rename(id: string, columnId: string, oldName: string, newName: string): RenameColumnTransformStep {
  return { id, kind: "renameColumn", params: { column: { id: columnId, name: oldName }, newName } };
}

function preview(step: RenameColumnTransformStep, revision: number, replaceStepId?: string) {
  return {
    kind: "previewStep" as const,
    sessionId,
    revision,
    step,
    ...(replaceStepId === undefined ? {} : { replaceStepId }),
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8
  };
}
