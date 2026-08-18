import { describe, expect, it } from "vitest";
import {
  createRKernelBridge as createBridge,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelDataTableContract as dataTableContract,
  rKernelFrameContract as frameContract,
  rKernelOpenRequest as openRequest,
  rKernelPlanRequest as planRequest,
  rKernelRowDiff as rowDiff,
  rKernelRowOrderContract as rowOrderContract
} from "./rKernelBridgeTestFixtures";

describe("R kernel row-reduction lifecycle", () => {
  it("keeps stable R row identities through compound sort preview, apply, edit, discard, inspection, and undo", async () => {
    const original = dataTableContract(
      rowOrderContract(frameContract({ totalRows: 4 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3"], 4),
      ["r:c:0"]
    );
    const firstSorted = dataTableContract(rowOrderContract(original, ["r:r:2", "r:r:0", "r:r:3", "r:r:1"], 4), []);
    const editedSorted = dataTableContract(rowOrderContract(original, ["r:r:1", "r:r:3", "r:r:0", "r:r:2"], 4), []);
    const transport = fakeTransport(original);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const firstStep = {
      id: "sort-step",
      kind: "sortRows" as const,
      params: {
        rules: [
          { column: { id: "r:c:0", name: "value" }, direction: "asc" as const, nulls: "last" as const },
          { column: { id: "r:c:1", name: "count" }, direction: "desc" as const, nulls: "first" as const }
        ] as [
          {
            column: { id: string; name: string };
            direction: "asc";
            nulls: "last";
          },
          {
            column: { id: string; name: string };
            direction: "desc";
            nulls: "first";
          }
        ]
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: firstSorted,
      diff: rowDiff(),
      code: "open_wrangler_result <- sorted_orders"
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: firstStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      firstStep,
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      page: { totalRows: 4, rows: [{ id: "r:r:2" }, { id: "r:r:0" }, { id: "r:r:3" }, { id: "r:r:1" }] },
      metadata: {
        shape: { rows: 4, columns: 8 },
        draftStep: { id: "sort-step", kind: "sortRows" },
        steps: []
      }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: firstSorted,
      code: "open_wrangler_result <- sorted_orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2,
      metadata: { steps: [{ id: "sort-step", kind: "sortRows" }], shape: { rows: 4, columns: 8 } }
    });

    const editedStep = {
      ...firstStep,
      params: {
        rules: [{ column: { id: "r:c:1", name: "count" }, direction: "asc" as const, nulls: "last" as const }] as [
          {
            column: { id: string; name: string };
            direction: "asc";
            nulls: "last";
          }
        ]
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: editedSorted,
      diff: rowDiff(),
      code: "open_wrangler_result <- edited_sort"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 2,
        step: editedStep,
        replaceStepId: "sort-step",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      revision: 3,
      metadata: { draftStep: { id: "sort-step", kind: "sortRows" }, steps: [{ id: "sort-step" }] }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      2,
      editedStep,
      expect.any(Object),
      expect.any(Array),
      "sort-step",
      expect.any(Object)
    );

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 4,
      page: firstSorted,
      code: "open_wrangler_result <- sorted_orders"
    });
    const discarded = await bridge.request(planRequest("discardDraft", 3));
    expect(discarded).toMatchObject({
      kind: "planUpdated",
      action: "discard",
      revision: 4,
      metadata: { steps: [{ id: "sort-step", kind: "sortRows" }] }
    });
    if (discarded.kind !== "planUpdated") throw new Error("Expected the R sort draft to be discarded.");
    expect(discarded.page.rows.map(({ id }) => id)).toEqual(["r:r:2", "r:r:0", "r:r:3", "r:r:1"]);
    expect(discarded.metadata.draftStep).toBeUndefined();

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: "sort-step",
      stepIndex: 0,
      inputPage: original,
      outputPage: firstSorted,
      inputSchema: original.schema,
      outputSchema: firstSorted.schema,
      code: "open_wrangler_result <- sorted_orders"
    });
    const inspection = await bridge.request({
      kind: "inspectStep",
      sessionId,
      revision: 4,
      stepId: "sort-step",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(inspection).toMatchObject({
      kind: "stepInspection",
      stepId: "sort-step",
      diff: { addedRows: 0, removedRows: 0, changedCells: 0, truncated: false }
    });
    if (inspection.kind !== "stepInspection") throw new Error("Expected an R sort-step inspection.");
    expect(inspection.inputRowAxis).toEqual({ kind: "positional", levelNames: [] });
    expect(inspection.outputRowAxis).toEqual({ kind: "positional", levelNames: [] });
    expect(inspection.inputPage.rows.map(({ id }) => id)).toEqual(["r:r:0", "r:r:1", "r:r:2", "r:r:3"]);
    expect(inspection.outputPage.rows.map(({ id }) => id)).toEqual(["r:r:2", "r:r:0", "r:r:3", "r:r:1"]);

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 5,
      page: original,
      code: ""
    });
    const undone = await bridge.request(planRequest("undoStep", 4));
    expect(undone).toMatchObject({
      kind: "planUpdated",
      action: "undo",
      revision: 5,
      metadata: { steps: [], shape: { rows: 4, columns: 8 } }
    });
    if (undone.kind !== "planUpdated") throw new Error("Expected the R sort step to be undone.");
    expect(undone.page.rows.map(({ id }) => id)).toEqual(["r:r:0", "r:r:1", "r:r:2", "r:r:3"]);
  });

  it("binds committed R filters by exact identity and tracks removed rows through apply and inspection", async () => {
    const source = rowOrderContract(
      frameContract({ duplicateFirstName: true, totalRows: 4 }),
      ["r:r:0", "r:r:1", "r:r:2", "r:r:3"],
      4
    );
    const filtered = rowOrderContract(source, ["r:r:1", "r:r:3"], 2);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const filterStep = {
      id: "filter-step",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          logic: "or" as const,
          filters: [
            {
              column: { id: "r:c:0", name: "value" },
              type: "float" as const,
              logic: "or" as const,
              predicates: [
                { kind: "predicate" as const, operator: "isNull" as const },
                { kind: "predicate" as const, operator: "isNaN" as const }
              ]
            },
            {
              column: { id: "r:c:6", name: "missing" },
              type: "string" as const,
              predicates: [],
              valueFilter: {
                kind: "values" as const,
                selectedValues: ["keep"],
                includeNulls: false,
                includeNaN: false
              }
            }
          ],
          sort: [{ column: { id: "r:c:1", name: "value" }, direction: "desc" as const, nulls: "last" as const }]
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: filtered,
      diff: rowDiff(2),
      code: "open_wrangler_result <- filtered_orders"
    });
    const preview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: filterStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenCalledWith(
      sessionId,
      0,
      filterStep,
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      page: { totalRows: 2, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] },
      diff: { addedRows: 0, removedRows: 2, changedCells: 0, truncated: false },
      metadata: { shape: { rows: 2, columns: 8 }, draftStep: { id: "filter-step", kind: "filterRows" } }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: filtered,
      code: "open_wrangler_result <- filtered_orders"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      revision: 2,
      metadata: { shape: { rows: 2, columns: 8 }, steps: [{ id: "filter-step", kind: "filterRows" }] }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 2,
      stepId: "filter-step",
      stepIndex: 0,
      inputPage: source,
      outputPage: filtered,
      inputSchema: source.schema,
      outputSchema: filtered.schema,
      code: "open_wrangler_result <- filtered_orders"
    });
    const inspection = await bridge.request({
      kind: "inspectStep",
      sessionId,
      revision: 2,
      stepId: "filter-step",
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(inspection).toMatchObject({
      kind: "stepInspection",
      diff: { addedRows: 0, removedRows: 2, changedCells: 0, truncated: false },
      outputPage: { totalRows: 2, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] }
    });
    if (inspection.kind !== "stepInspection") throw new Error("Expected an R filter-step inspection.");
    expect(inspection.inputPage.rows.map(({ id }) => id)).toEqual(["r:r:0", "r:r:1", "r:r:2", "r:r:3"]);

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 3,
      page: source,
      code: ""
    });
    const undone = await bridge.request(planRequest("undoStep", 2));
    expect(undone).toMatchObject({
      kind: "planUpdated",
      revision: 3,
      page: { totalRows: 4 },
      metadata: { shape: { rows: 4, columns: 8 }, steps: [] }
    });
    if (undone.kind !== "planUpdated") throw new Error("Expected the R filter step to be undone.");
    expect(undone.page.rows.map(({ id }) => id)).toEqual(["r:r:0", "r:r:1", "r:r:2", "r:r:3"]);
  });

  it("retains native R missing-row and duplicate-row steps through apply, inspection, and undo", async () => {
    const source = dataTableContract(
      rowOrderContract(frameContract({ totalRows: 5 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3", "r:r:4"], 5),
      ["r:c:0"]
    );
    const withoutMissing = dataTableContract(rowOrderContract(source, ["r:r:0", "r:r:2", "r:r:4"], 3), ["r:c:0"]);
    const withoutDuplicates = dataTableContract(rowOrderContract(source, ["r:r:0", "r:r:4"], 2), ["r:c:0"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const missingStep = {
      id: "drop-missing-step",
      kind: "dropMissingRows" as const,
      params: {
        columns: [{ id: "r:c:6", name: "missing" }],
        how: "any" as const
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: withoutMissing,
      diff: rowDiff(2),
      code: "open_wrangler_result <- orders[!is.na(orders[[7L]]), , drop = FALSE]"
    });
    const missingPreview = await bridge.request({
      kind: "previewStep",
      sessionId,
      revision: 0,
      step: missingStep,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 8
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      missingStep,
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
    expect(missingPreview).toMatchObject({
      kind: "stepPreview",
      diff: { addedRows: 0, removedRows: 2, changedCells: 0 },
      metadata: {
        shape: { rows: 3, columns: 8 },
        draftStep: {
          id: "drop-missing-step",
          kind: "dropMissingRows",
          params: { columns: [{ id: "r:c:6", name: "missing" }], how: "any" }
        }
      }
    });

    missingStep.params.columns[0]!.name = "tampered after preview";
    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: withoutMissing,
      code: "open_wrangler_result <- orders[!is.na(orders[[7L]]), , drop = FALSE]"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        shape: { rows: 3 },
        steps: [
          {
            id: "drop-missing-step",
            kind: "dropMissingRows",
            params: { columns: [{ id: "r:c:6", name: "missing" }], how: "any" }
          }
        ]
      }
    });

    const duplicateStep = {
      id: "drop-duplicates-step",
      kind: "dropDuplicates" as const,
      params: { keep: "last" as const }
    };
    transport.queuePreview({
      sessionId,
      revision: 3,
      page: withoutDuplicates,
      diff: rowDiff(1),
      code: "open_wrangler_result <- open_wrangler_input[!duplicated(open_wrangler_input, fromLast = TRUE), ]"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 2,
        step: duplicateStep,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      diff: { removedRows: 1 },
      metadata: {
        shape: { rows: 2 },
        steps: [{ id: "drop-missing-step" }],
        draftStep: { id: "drop-duplicates-step", kind: "dropDuplicates", params: { keep: "last" } }
      }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      2,
      duplicateStep,
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 4,
      page: withoutDuplicates,
      code: "open_wrangler_result <- open_wrangler_input[!duplicated(open_wrangler_input, fromLast = TRUE), ]"
    });
    await expect(bridge.request(planRequest("applyDraft", 3))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: {
        shape: { rows: 2 },
        steps: [{ id: "drop-missing-step" }, { id: "drop-duplicates-step", params: { keep: "last" } }]
      }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: "drop-missing-step",
      stepIndex: 0,
      inputPage: source,
      outputPage: withoutMissing,
      inputSchema: source.schema,
      outputSchema: withoutMissing.schema,
      code: "drop missing"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 4,
        stepId: "drop-missing-step",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      diff: { removedRows: 2, changedCells: 0, truncated: false },
      outputPage: { rows: [{ id: "r:r:0" }, { id: "r:r:2" }, { id: "r:r:4" }] }
    });

    transport.inspectStep.mockResolvedValueOnce({
      sessionId,
      revision: 4,
      stepId: "drop-duplicates-step",
      stepIndex: 1,
      inputPage: withoutMissing,
      outputPage: withoutDuplicates,
      inputSchema: withoutMissing.schema,
      outputSchema: withoutDuplicates.schema,
      code: "drop duplicates"
    });
    await expect(
      bridge.request({
        kind: "inspectStep",
        sessionId,
        revision: 4,
        stepId: "drop-duplicates-step",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepInspection",
      diff: { removedRows: 1, changedCells: 0, truncated: false },
      outputPage: { rows: [{ id: "r:r:0" }, { id: "r:r:4" }] }
    });

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 5,
      page: withoutMissing,
      code: "drop missing"
    });
    await expect(bridge.request(planRequest("undoStep", 4))).resolves.toMatchObject({
      kind: "planUpdated",
      page: { totalRows: 3 },
      metadata: { shape: { rows: 3 }, steps: [{ id: "drop-missing-step" }] }
    });

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 6,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("undoStep", 5))).resolves.toMatchObject({
      kind: "planUpdated",
      page: { totalRows: 5 },
      metadata: { shape: { rows: 5 }, steps: [] }
    });
  });

  it("normalizes an empty R drop-missing selection to all columns at the kernel boundary", async () => {
    const source = rowOrderContract(frameContract({ totalRows: 3 }), ["r:r:0", "r:r:1", "r:r:2"], 3);
    const reduced = rowOrderContract(source, ["r:r:1", "r:r:2"], 2);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: reduced,
      diff: rowDiff(1),
      code: "drop missing across all columns"
    });

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: { id: "drop-missing-all", kind: "dropMissingRows", params: { columns: [], how: "any" } },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: { draftStep: { params: { columns: [], how: "any" } } }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      { id: "drop-missing-all", kind: "dropMissingRows", params: { how: "any" } },
      expect.any(Object),
      expect.any(Array),
      undefined,
      expect.any(Object)
    );
  });

  it("rejects stale native R row-reduction columns and impossible row diffs", async () => {
    const source = rowOrderContract(frameContract({ totalRows: 3 }), ["r:r:0", "r:r:1", "r:r:2"], 3);
    const reduced = rowOrderContract(source, ["r:r:0", "r:r:2"], 2);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: {
          id: "stale-drop-missing",
          kind: "dropMissingRows",
          params: { columns: [{ id: "r:c:6", name: "old name" }] }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_request",
      message: expect.stringContaining("no longer matches")
    });
    expect(transport.previewStep).not.toHaveBeenCalled();

    transport.queuePreview({
      sessionId,
      revision: 1,
      page: reduced,
      diff: { ...rowDiff(4), truncated: true },
      code: "bad result"
    });
    await expect(
      bridge.request({
        kind: "previewStep",
        sessionId,
        revision: 0,
        step: { id: "bad-drop-duplicates", kind: "dropDuplicates", params: {} },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8
      })
    ).rejects.toThrow("invalid row counts for Drop duplicates");
  });

  it("accepts an explicit-row-name R dataframe filtered to zero rows", async () => {
    const source = frameContract({ explicitRowLabel: "named-row", totalRows: 1 });
    const empty = rowOrderContract(source, [], 0);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));

    const step = {
      id: "empty-named-filter-step",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          filters: [
            {
              column: { id: "r:c:0", name: "value" },
              type: "float" as const,
              predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 100 }]
            }
          ],
          sort: []
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: empty,
      diff: rowDiff(1),
      code: "open_wrangler_result <- orders[orders[[1L]] > 100, , drop = FALSE]"
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
      page: { totalRows: 0, rows: [] },
      metadata: { shape: { rows: 0 }, filteredShape: { rows: 0 } },
      diff: { removedRows: 1, truncated: false }
    });
  });

  it.each([false, true])(
    "accepts a complete filtered output even when the page is smaller than the input (truncated: %s)",
    async (truncated) => {
      const source = rowOrderContract(frameContract({ totalRows: 4 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3"], 4);
      const filtered = rowOrderContract(source, ["r:r:1", "r:r:3"], 2);
      const completeOutput = { ...filtered, page: { ...filtered.page, limit: 2 } };
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));

      transport.getPage.mockResolvedValueOnce(completeOutput);
      await expect(
        bridge.request({
          kind: "getPage",
          sessionId,
          revision: 0,
          viewRequestId: "current-filter",
          offset: 0,
          limit: 2,
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
            sort: []
          }
        })
      ).resolves.toMatchObject({ kind: "page", page: { totalRows: 2, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] } });

      const filterStep = {
        id: "current-filter-step",
        kind: "filterRows" as const,
        params: {
          filterModel: {
            logic: "and" as const,
            filters: [
              {
                column: { id: "r:c:0", name: "value" },
                type: "float" as const,
                predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
              }
            ],
            sort: []
          }
        }
      };
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: completeOutput,
        diff: { ...rowDiff(2), truncated },
        code: "open_wrangler_result <- orders[orders[[1L]] > 0, , drop = FALSE]"
      });

      await expect(
        bridge.request({
          kind: "previewStep",
          sessionId,
          revision: 0,
          step: filterStep,
          offset: 0,
          limit: 2,
          columnOffset: 0,
          columnLimit: 8
        })
      ).resolves.toMatchObject({
        kind: "stepPreview",
        page: { totalRows: 2, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] },
        diff: { removedRows: 2, truncated }
      });
      expect(transport.previewStep).toHaveBeenLastCalledWith(
        sessionId,
        0,
        filterStep,
        expect.objectContaining({
          rowLimit: 2,
          view: { filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })], sorts: [] }
        }),
        expect.any(Array),
        undefined,
        expect.any(Object)
      );
    }
  );

  it.each([true, false])("requires an incomplete filtered output to be marked truncated (%s)", async (truncated) => {
    const source = rowOrderContract(frameContract({ totalRows: 4 }), ["r:r:0", "r:r:1", "r:r:2", "r:r:3"], 4);
    const incompleteOutput = rowOrderContract(source, ["r:r:1", "r:r:3"], 3);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    const filterStep = {
      id: "incomplete-filter-step",
      kind: "filterRows" as const,
      params: {
        filterModel: {
          filters: [
            {
              column: { id: "r:c:0", name: "value" },
              type: "float" as const,
              predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 0 }]
            }
          ],
          sort: []
        }
      }
    };
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: { ...incompleteOutput, page: { ...incompleteOutput.page, limit: 2 } },
      diff: { ...rowDiff(1), truncated },
      code: "open_wrangler_result <- orders[orders[[1L]] > 0, , drop = FALSE]"
    });
    const request = {
      kind: "previewStep" as const,
      sessionId,
      revision: 0,
      step: filterStep,
      offset: 0,
      limit: 2,
      columnOffset: 0,
      columnLimit: 8
    };

    if (truncated) {
      await expect(bridge.request(request)).resolves.toMatchObject({
        kind: "stepPreview",
        page: { totalRows: 3, rows: [{ id: "r:r:1" }, { id: "r:r:3" }] },
        diff: { removedRows: 1, truncated: true }
      });
    } else {
      await expect(bridge.request(request)).rejects.toThrow("invalid row-operation diff");
    }
  });
});
