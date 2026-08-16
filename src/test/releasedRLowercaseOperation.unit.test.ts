import { describe, expect, it } from "vitest";
import type { OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import { exerciseReleasedRLowercaseOperation } from "./extensionHost/releasedRLowercaseOperation";

function activeSession(): NonNullable<ReturnType<TestApi["activeSession"]>> {
  return {
    sessionId: "session-r",
    metadata: {
      revision: 7,
      schema: [{ id: "c:group", name: "group" }]
    },
    viewState: {}
  } as NonNullable<ReturnType<TestApi["activeSession"]>>;
}

function response(value: unknown): OpenWranglerResponse {
  return value as OpenWranglerResponse;
}

describe("released R Lowercase operation", () => {
  it.each([
    ["jupyter-r", "value-operations", true],
    ["jupyter-r-remote", "core-catalog", false]
  ] as const)("owns exact preview, apply, and undo ordering for %s/%s", async (phase, catalog, valueOwned) => {
    const events: string[] = [];
    const requests: OpenWranglerRequest[] = [];
    const testing = {
      activeSession,
      request: async (request: OpenWranglerRequest) => {
        requests.push(request);
        events.push(request.kind);
        if (request.kind === "previewStep") {
          return response({
            kind: "stepPreview",
            revision: 8,
            metadata: { schema: [{ id: "c:group", name: "group", rawType: "character" }] },
            page: { rows: [{ values: [{ display: "1" }, { display: "a" }] }] },
            code: "orders_frame$group <- tolower(orders_frame$group)",
            diff: { changedCells: 2 }
          });
        }
        if (request.kind === "applyDraft") {
          return response({ kind: "planUpdated", revision: 9, page: { rows: [{ values: [{}, { display: "a" }] }] } });
        }
        return response({ kind: "planUpdated", revision: 10, page: { rows: [{ values: [{}, { display: "A" }] }] } });
      }
    };

    await exerciseReleasedRLowercaseOperation({
      testing,
      sessionId: "session-r",
      phase,
      catalog,
      recordProgress: (checkpoint) => events.push(`progress:${checkpoint}`),
      recordValueOperationBoundary: (boundary) => events.push(`value:${boundary}`)
    });

    expect(requests.map((request) => request.kind)).toEqual(["previewStep", "applyDraft", "undoStep"]);
    expect(requests[0]).toEqual({
      kind: "previewStep",
      sessionId: "session-r",
      revision: 7,
      step: {
        id: "released-r-lowercase-group",
        kind: "lowerText",
        params: { column: { id: "c:group", name: "group" } }
      },
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(requests[1]).toEqual({
      kind: "applyDraft",
      sessionId: "session-r",
      revision: 8,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(requests[2]).toEqual({
      kind: "undoStep",
      sessionId: "session-r",
      revision: 9,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(events).toEqual([
      ...(valueOwned ? ["value:start"] : []),
      `progress:${phase}:editing:lowercase-preview-apply-undo`,
      "previewStep",
      "applyDraft",
      "undoStep",
      ...(valueOwned ? ["value:complete"] : [])
    ]);
  });

  it.each([
    ["jupyter-r", "core-catalog"],
    ["jupyter-r-remote", "value-operations"]
  ] as const)("fails before dispatch or progress for ineligible %s/%s ownership", async (phase, catalog) => {
    let requests = 0;
    const progress: string[] = [];
    const boundaries: string[] = [];
    await expect(
      exerciseReleasedRLowercaseOperation({
        testing: { activeSession, request: async () => (requests += 1) as unknown as OpenWranglerResponse },
        sessionId: "session-r",
        phase,
        catalog,
        recordProgress: (checkpoint) => progress.push(checkpoint),
        recordValueOperationBoundary: (boundary) => boundaries.push(boundary)
      })
    ).rejects.toThrow(/remote-core or local-value owner/u);
    expect(requests).toBe(0);
    expect(progress).toEqual([]);
    expect(boundaries).toEqual([]);
  });
});
