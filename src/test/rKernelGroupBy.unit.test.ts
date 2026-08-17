import { describe, expect, it } from "vitest";
import type { GroupByTransformStep } from "../shared/protocol";
import type { RFramePageContract } from "../extension/r/rFrameContract";
import {
  createRKernelBridge as createBridge,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelFrameContract as frameContract,
  rKernelGroupContract as groupContract,
  rKernelGroupDiff as groupDiff,
  rKernelOpenRequest as openRequest,
  rKernelPlanRequest as planRequest,
  rKernelRowOrderContract as rowOrderContract
} from "./rKernelBridgeTestFixtures";

describe("R kernel Group By lifecycle", () => {
  it("keeps native R Group By lineage, replacement diffs, inspection, replay, and undo atomic", async () => {
    const source = rowOrderContract(frameContract({ totalRows: 4 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3"], 4);
    const step: GroupByTransformStep = {
      id: "r-group-1",
      kind: "groupBy",
      params: {
        keys: [{ id: "r:c:5", name: "flag" }],
        aggregations: [
          { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
          { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "average_value" },
          { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
        ]
      }
    };
    const grouped = groupContract(source, step, 2);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: grouped,
      diff: groupDiff(source, grouped, step),
      code: "open_wrangler_result <- grouped_orders"
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

    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      {
        id: "r-group-1",
        kind: "groupBy",
        params: {
          keys: [{ id: "r:c:5", name: "flag" }],
          aggregations: [
            { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
            { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "average_value" },
            { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
          ]
        }
      },
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      diff: {
        addedRows: 2,
        removedRows: 4,
        addedColumns: ["rows_present", "average_value", "first_label"],
        removedColumns: ["value", "count", "date", "when", "elapsed", "missing", "infinite"],
        changedCells: 0
      },
      metadata: {
        schema: [
          expect.objectContaining({ id: "r:c:5", name: "flag", position: 0 }),
          expect.objectContaining({ id: "c:step:r-group-1:0", name: "rows_present", type: "integer" }),
          expect.objectContaining({ id: "c:step:r-group-1:1", name: "average_value", type: "float" }),
          expect.objectContaining({ id: "c:step:r-group-1:2", name: "first_label", type: "string" })
        ],
        draftStep: { id: "r-group-1", kind: "groupBy" }
      }
    });

    step.params.aggregations[0]!.alias = "tampered after preview";
    expect(preview).toMatchObject({
      metadata: {
        draftStep: {
          params: {
            aggregations: [{ alias: "rows_present" }, { alias: "average_value" }, { alias: "first_label" }]
          }
        }
      }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: grouped,
      code: "open_wrangler_result <- grouped_orders"
    });
    const applied = await bridge.request(planRequest("applyDraft", 1));
    expect(applied).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      metadata: {
        steps: [{ id: "r-group-1", kind: "groupBy" }],
        latestStepInputSchema: expect.arrayContaining([expect.objectContaining({ id: "r:c:5", name: "flag" })])
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "r-group-1",
      stepIndex: 0,
      inputPage: source,
      outputPage: grouped,
      inputSchema: source.schema,
      outputSchema: grouped.schema,
      code: "open_wrangler_result <- grouped_orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 2,
        stepId: "r-group-1",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      diff: { addedRows: 2, removedRows: 4, changedCells: 0 },
      outputSchema: expect.arrayContaining([expect.objectContaining({ id: "c:step:r-group-1:0" })])
    });

    transport.undoStep.mockResolvedValueOnce({ sessionId, action: "undo", revision: 3, page: source, code: "" });
    await expect(bridge.request(planRequest("undoStep", 2))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "undo",
      metadata: { steps: [], schema: expect.arrayContaining([expect.objectContaining({ id: "r:c:5" })]) }
    });
  });

  it.each([true, false])(
    "requires a Group By diff to cover both its input and output row windows (truncated: %s)",
    async (truncated) => {
      const source = frameContract({ totalRows: 25 });
      const step: GroupByTransformStep = {
        id: "r-group-bounded-diff",
        kind: "groupBy",
        params: {
          keys: [{ id: "r:c:5", name: "flag" }],
          aggregations: [
            { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
            { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "average_value" },
            { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
          ]
        }
      };
      const grouped = groupContract(source, step, 2);
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: grouped,
        diff: { ...groupDiff(source, grouped, step), truncated },
        code: "open_wrangler_result <- grouped_orders"
      });
      const request = {
        kind: "previewStep" as const,
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      };

      if (truncated) {
        await expect(bridge.request(request)).resolves.toMatchObject({
          kind: "stepPreview",
          diff: { addedRows: 2, removedRows: 25, truncated: true }
        });
      } else {
        await expect(bridge.request(request)).rejects.toThrow("invalid Group and aggregate diff");
      }
    }
  );

  it("tracks explicit R row names across the complete Group By lifecycle", async () => {
    const source = frameContract({ explicitRowLabel: "source-row", totalRows: 1 });
    const step: GroupByTransformStep = {
      id: "r-group-row-names",
      kind: "groupBy",
      params: {
        keys: [{ id: "r:c:5", name: "flag" }],
        aggregations: [
          { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
          { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "average_value" },
          { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
        ]
      }
    };
    const grouped = groupContract(source, step, 1);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
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

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: grouped,
      diff: groupDiff(source, grouped, step),
      code: "open_wrangler_result <- grouped_orders"
    });
    await expect(bridge.request(previewRequest)).resolves.toMatchObject({
      kind: "stepPreview",
      page: { rows: [expect.not.objectContaining({ rowLabel: expect.anything() })] }
    });

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 2,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("discardDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      page: { rows: [expect.objectContaining({ rowLabel: "source-row" })] }
    });

    transport.queuePreview({
      sessionId,
      revision: 3,
      page: grouped,
      diff: groupDiff(source, grouped, step),
      code: "open_wrangler_result <- grouped_orders"
    });
    await bridge.request({ ...previewRequest, revision: 2 });
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: grouped,
      code: "open_wrangler_result <- grouped_orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 3))).resolves.toMatchObject({ kind: "planUpdated" });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: step.id,
      stepIndex: 0,
      inputPage: source,
      outputPage: grouped,
      inputSchema: source.schema,
      outputSchema: grouped.schema,
      code: "open_wrangler_result <- grouped_orders"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 4,
        stepId: step.id,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      inputPage: { rows: [expect.objectContaining({ rowLabel: "source-row" })] },
      outputPage: { rows: [expect.not.objectContaining({ rowLabel: expect.anything() })] }
    });

    transport.undoStep.mockResolvedValueOnce({ sessionId, action: "undo", revision: 5, page: source, code: "" });
    await expect(bridge.request(planRequest("undoStep", 4))).resolves.toMatchObject({
      kind: "planUpdated",
      page: { rows: [expect.objectContaining({ rowLabel: "source-row" })] }
    });
  });

  it.each(["filter", "sort"] as const)(
    "retains an aggregation-output %s while replacing and undoing the latest R Group By",
    async (viewKind) => {
      const source = frameContract({ totalRows: 2 });
      const step: GroupByTransformStep = {
        id: "r-group-retained-view",
        kind: "groupBy",
        params: {
          keys: [{ id: "r:c:5", name: "flag" }],
          aggregations: [
            { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
            { column: { id: "r:c:0", name: "value" }, operation: "mean", alias: "value" },
            { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
          ]
        }
      };
      const replacement: GroupByTransformStep = {
        id: step.id,
        kind: "groupBy",
        params: {
          keys: [{ id: "r:c:5", name: "flag" }],
          aggregations: [
            { column: { id: "r:c:1", name: "count" }, operation: "count", alias: "rows_present" },
            { column: { id: "r:c:0", name: "value" }, operation: "median", alias: "value" },
            { column: { id: "r:c:6", name: "missing" }, operation: "first", alias: "first_label" }
          ]
        }
      };
      const grouped = groupContract(source, step, 2);
      const viewedGrouped =
        viewKind === "filter"
          ? ({
              ...grouped,
              page: { ...grouped.page, totalRows: 1, rows: grouped.page.rows.slice(0, 1) }
            } satisfies RFramePageContract)
          : grouped;
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));

      transport.queuePreview({
        sessionId,
        revision: 1,
        page: grouped,
        diff: groupDiff(source, grouped, step),
        code: "open_wrangler_result <- grouped_orders"
      });
      await bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      });
      transport.applyDraft.mockResolvedValueOnce({
        sessionId,
        action: "apply",
        revision: 2,
        page: grouped,
        code: "open_wrangler_result <- grouped_orders"
      });
      await bridge.request(planRequest("applyDraft", 1));

      transport.getPage.mockResolvedValueOnce(viewedGrouped);
      const filterModel =
        viewKind === "filter"
          ? {
              filters: [
                {
                  column: "value",
                  type: "float" as const,
                  predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 2 }]
                },
                {
                  column: "flag",
                  type: "boolean" as const,
                  predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: true }]
                }
              ],
              sort: []
            }
          : {
              filters: [],
              sort: [
                { column: "value", direction: "desc" as const, nulls: "last" as const },
                { column: "flag", direction: "asc" as const, nulls: "last" as const }
              ]
            };
      await bridge.request({
        kind: "getPage",
        sessionId,
        revision: 2,
        viewRequestId: "group-output-view",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel
      });

      transport.queuePreview({
        sessionId,
        revision: 3,
        page: viewedGrouped,
        diff: { ...groupDiff(source, grouped, replacement), truncated: viewKind === "filter" },
        code: "open_wrangler_result <- grouped_orders_with_median"
      });
      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 2,
          replaceStepId: step.id,
          step: replacement,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({
        kind: "stepPreview",
        metadata: { filterModel },
        page: { totalRows: viewKind === "filter" ? 1 : 2 }
      });
      expect(transport.previewStep).toHaveBeenLastCalledWith(
        sessionId,
        2,
        expect.objectContaining({ id: step.id, kind: "groupBy" }),
        expect.objectContaining({
          view: {
            filters:
              viewKind === "filter"
                ? [
                    expect.objectContaining({ column: { id: `c:step:${step.id}:1`, name: "value" } }),
                    expect.objectContaining({ column: { id: "r:c:5", name: "flag" } })
                  ]
                : [],
            sorts:
              viewKind === "sort"
                ? [
                    expect.objectContaining({ column: { id: `c:step:${step.id}:1`, name: "value" } }),
                    expect.objectContaining({ column: { id: "r:c:5", name: "flag" } })
                  ]
                : []
          }
        }),
        expect.any(Array),
        step.id,
        expect.any(Object)
      );

      transport.applyDraft.mockResolvedValueOnce({
        sessionId,
        action: "apply",
        revision: 4,
        page: viewedGrouped,
        code: "open_wrangler_result <- grouped_orders_with_median"
      });
      await expect(bridge.request(planRequest("applyDraft", 3))).resolves.toMatchObject({
        kind: "planUpdated",
        action: "apply",
        metadata: {
          filterModel,
          steps: [
            {
              id: step.id,
              kind: "groupBy",
              params: {
                aggregations: expect.arrayContaining([expect.objectContaining({ operation: "median" })])
              }
            }
          ]
        }
      });

      transport.undoStep.mockResolvedValueOnce({ sessionId, action: "undo", revision: 5, page: source, code: "" });
      await expect(bridge.request(planRequest("undoStep", 4))).resolves.toMatchObject({
        kind: "planUpdated",
        action: "undo",
        metadata: {
          filterModel:
            viewKind === "filter"
              ? { filters: [expect.objectContaining({ column: "flag" })], sort: [] }
              : { filters: [], sort: [expect.objectContaining({ column: "flag" })] },
          steps: []
        }
      });
      expect(transport.undoStep).toHaveBeenLastCalledWith(
        sessionId,
        4,
        expect.objectContaining({
          view:
            viewKind === "filter"
              ? {
                  filters: [expect.objectContaining({ column: { id: "r:c:5", name: "flag" } })],
                  sorts: []
                }
              : {
                  filters: [],
                  sorts: [expect.objectContaining({ column: { id: "r:c:5", name: "flag" } })]
                }
        }),
        expect.any(Object)
      );
    }
  );
});
