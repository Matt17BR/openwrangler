import { describe, expect, it } from "vitest";
import type {
  CustomCodeTransformStep,
  DataDiff,
  MultiLabelBinarizeTransformStep,
  OneHotEncodeTransformStep,
  OpenWranglerRequest,
  PivotLongerTransformStep,
  PivotWiderTransformStep
} from "../shared/protocol";
import type { RKernelStepPreviewResult } from "../extension/r/rKernelProtocol";
import type { RColumnSchema, RFrameCell, RFramePageContract } from "../extension/r/rFrameContract";
import {
  createRKernelBridge as createBridge,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelCastContract as castContract,
  rKernelFactorContract as factorContract,
  rKernelFrameContract as frameContract,
  rKernelOpenRequest as openRequest,
  rKernelPlanRequest as planRequest,
  rKernelReplaceColumnSemantics as replaceColumnSemantics,
  rKernelRenameDiff as renameDiff
} from "./rKernelBridgeTestFixtures";

describe("canonical R kernel bridge", () => {
  it("hands the native R frame and extension version across the public bridge boundary", async () => {
    const contract = frameContract();
    const transport = fakeTransport(contract);
    const bridge = createBridge(transport);

    await expect(bridge.request({ kind: "initialize" })).resolves.toMatchObject({
      kind: "initialized",
      protocolVersion: 2,
      runtimeVersion: "2.0.0-preview.1",
      capabilities: {
        editable: true,
        notebookInsert: true,
        documentInsert: true
      }
    });

    const request = openRequest();
    const response = await bridge.request(request);

    expect(transport.open).toHaveBeenCalledWith(
      "orders",
      {
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 8,
        view: { filters: [], sorts: [] }
      },
      expect.objectContaining({ requestedSessionId: sessionId })
    );
    expect(response).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        sessionId,
        revision: 0,
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        mode: "viewing",
        source: request.source,
        shape: { rows: 1, columns: 8 },
        filteredShape: { rows: 1, columns: 8 }
      },
      page: {
        columnIds: contract.page.columnIds
      },
      summaries: []
    });
    if (response.kind !== "sessionOpened") throw new Error("Expected an R session.");
    expect(response.page.rows[0]).toMatchObject({ id: "r:r:0", rowNumber: 0 });
    expect(response.page.rows[0]?.values.slice(0, 4)).toEqual([
      expect.objectContaining({ kind: "number", raw: 12.5 }),
      expect.objectContaining({ kind: "integer", raw: "9223372036854775807" }),
      expect.objectContaining({ kind: "date", raw: "2026-08-05" }),
      expect.objectContaining({ kind: "datetime", raw: "1785945600" })
    ]);
  });

  it("rejects Pivot longer overflow, class metadata drift, and portable collisions before R dispatch", async () => {
    const stringCell = (raw: string): RFrameCell => ({
      kind: "string",
      raw,
      display: raw,
      isNull: false,
      isNaN: false
    });
    const durationCell: RFrameCell = {
      kind: "duration",
      raw: "90",
      display: "90 secs",
      isNull: false,
      isNaN: false
    };
    const integerCell: RFrameCell = {
      kind: "integer",
      raw: "7",
      display: "7",
      isNull: false,
      isNaN: false
    };
    const datetimeCell: RFrameCell = {
      kind: "datetime",
      raw: "1785945600",
      display: "2026-08-05T12:00:00Z",
      isNull: false,
      isNaN: false
    };

    const factorBase = factorContract(
      castContract(
        factorContract(castContract(frameContract(), "r:c:0", "character", "string", stringCell("a"), false), "r:c:0", [
          "a",
          "b"
        ]),
        "r:c:7",
        "character",
        "string",
        stringCell("a"),
        false
      ),
      "r:c:7",
      ["a", "c"]
    );
    const datetimeBase = replaceColumnSemantics(
      castContract(frameContract(), "r:c:7", "POSIXct", "datetime", datetimeCell, false),
      "r:c:7",
      { kind: "datetime", storageMode: "double", classes: ["POSIXct", "POSIXt"], timezone: "Europe/Rome" }
    );
    const durationBase = replaceColumnSemantics(
      castContract(frameContract(), "r:c:7", "difftime", "duration", durationCell, false),
      "r:c:7",
      { kind: "difftime", storageMode: "double", classes: ["difftime"], units: "mins" }
    );
    const integer64Base = replaceColumnSemantics(
      castContract(frameContract(), "r:c:7", "integer64", "integer", integerCell, false),
      "r:c:7",
      { kind: "integer64", storageMode: "double", classes: ["integer64", "custom-integer64"] }
    );

    const cases: readonly {
      name: string;
      source: RFramePageContract;
      columns: readonly [{ id: string; name: string }, { id: string; name: string }];
      labelColumn?: string;
      valueColumn?: string;
    }[] = [
      {
        name: "row overflow",
        source: frameContract({ totalRows: 1_073_741_824 }),
        columns: [
          { id: "r:c:0", name: "value" },
          { id: "r:c:7", name: "infinite" }
        ]
      },
      {
        name: "factor levels",
        source: factorBase,
        columns: [
          { id: "r:c:0", name: "value" },
          { id: "r:c:7", name: "infinite" }
        ]
      },
      {
        name: "POSIXct timezone",
        source: datetimeBase,
        columns: [
          { id: "r:c:3", name: "when" },
          { id: "r:c:7", name: "infinite" }
        ]
      },
      {
        name: "difftime units",
        source: durationBase,
        columns: [
          { id: "r:c:4", name: "elapsed" },
          { id: "r:c:7", name: "infinite" }
        ]
      },
      {
        name: "integer64 class metadata",
        source: integer64Base,
        columns: [
          { id: "r:c:1", name: "count" },
          { id: "r:c:7", name: "infinite" }
        ]
      },
      {
        name: "portable output-name collision",
        source: frameContract(),
        columns: [
          { id: "r:c:0", name: "value" },
          { id: "r:c:7", name: "infinite" }
        ],
        labelColumn: "Straße",
        valueColumn: "STRASSE"
      }
    ];

    for (const testCase of cases) {
      const transport = fakeTransport(testCase.source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));

      await expect(
        bridge.request(
          pivotLongerPreviewRequest(
            `r-pivot-no-dispatch-${testCase.name.replaceAll(" ", "-")}`,
            testCase.columns,
            testCase.labelColumn,
            testCase.valueColumn
          )
        )
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request", sessionId });
      expect(transport.previewStep, testCase.name).not.toHaveBeenCalled();
      expect(transport.applyDraft, testCase.name).not.toHaveBeenCalled();
      expect(transport.discardDraft, testCase.name).not.toHaveBeenCalled();
      const page = await bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: `after-${testCase.name}`,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: { filters: [], sort: [] }
      });
      expect(page).toMatchObject({ kind: "page", revision: 0, metadata: { steps: [] } });
      if (page.kind !== "page") throw new Error(`Expected a page after ${testCase.name}.`);
      expect(page.metadata).not.toHaveProperty("draftStep");
    }
  });

  it("rejects Pivot wider schema and output-contract failures before R transport", async () => {
    const collisionSource = frameContract();
    const invalidNamesBase = frameContract();
    const invalidNamesSource: RFramePageContract = {
      ...invalidNamesBase,
      schema: invalidNamesBase.schema.map((column, index) =>
        index === 6
          ? {
              ...column,
              rawType: "double",
              type: "float",
              semantics: { kind: "double", storageMode: "double", classes: ["numeric"] }
            }
          : column
      )
    };
    const invalidIdentifierBase = frameContract();
    const invalidIdentifierSource: RFramePageContract = {
      ...invalidIdentifierBase,
      schema: invalidIdentifierBase.schema.map((column, index) =>
        index === 1
          ? ({
              ...column,
              rawType: "list",
              type: "list",
              semantics: { kind: "list", storageMode: "list", classes: ["list"] }
            } as unknown as RColumnSchema)
          : column
      )
    };
    const cases: readonly { name: string; source: RFramePageContract; outputNames: readonly [string, string] }[] = [
      { name: "portable retained collision", source: collisionSource, outputNames: ["count", "beta"] },
      { name: "non-text names-from metadata", source: invalidNamesSource, outputNames: ["alpha", "beta"] },
      {
        name: "non-scalar retained identifier metadata",
        source: invalidIdentifierSource,
        outputNames: ["alpha", "beta"]
      }
    ];

    for (const testCase of cases) {
      const transport = fakeTransport(testCase.source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      await expect(
        bridge.request(
          pivotWiderPreviewRequest(`r-pivot-wider-${testCase.name.replaceAll(" ", "-")}`, testCase.outputNames)
        )
      ).resolves.toMatchObject({ kind: "error", code: "invalid_request", sessionId });
      expect(transport.previewStep, testCase.name).not.toHaveBeenCalled();
      expect(transport.applyDraft, testCase.name).not.toHaveBeenCalled();
      const page = await bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: `after-pivot-wider-${testCase.name}`,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: { filters: [], sort: [] }
      });
      expect(page).toMatchObject({ kind: "page", revision: 0, metadata: { steps: [] } });
      if (page.kind !== "page") throw new Error("Expected a page after rejected Pivot wider preview.");
      expect(page.metadata).not.toHaveProperty("draftStep");
    }
  });

  it("preserves conservative Pivot wider nullability and rejects a narrowed R publication", async () => {
    const stepId = "r-pivot-wider-nullability";
    const source = frameContract();
    const valid = pivotWiderContract(source, stepId, ["alpha", "beta"]);

    const validTransport = fakeTransport(source);
    const validBridge = createBridge(validTransport);
    await validBridge.request(openRequest("editing"));
    validTransport.queuePreview({
      sessionId,
      revision: 1,
      page: valid,
      diff: pivotWiderDiff(["alpha", "beta"]),
      code: "open_wrangler_result <- orders"
    });
    await expect(validBridge.request(pivotWiderPreviewRequest(stepId, ["alpha", "beta"]))).resolves.toMatchObject({
      kind: "stepPreview",
      metadata: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "r:c:1", nullable: true }),
          expect.objectContaining({ id: `c:step:${stepId}:0`, name: "alpha", nullable: true }),
          expect.objectContaining({ id: `c:step:${stepId}:1`, name: "beta", nullable: true })
        ])
      }
    });
    expect(validTransport.previewStep).toHaveBeenCalledOnce();

    const narrowed = {
      ...valid,
      schema: valid.schema.map((column, index) => (index === 0 ? { ...column, nullable: false } : { ...column }))
    } satisfies RFramePageContract;
    const narrowedTransport = fakeTransport(source);
    const narrowedBridge = createBridge(narrowedTransport);
    await narrowedBridge.request(openRequest("editing"));
    narrowedTransport.queuePreview({
      sessionId,
      revision: 1,
      page: narrowed,
      diff: pivotWiderDiff(["alpha", "beta"]),
      code: "open_wrangler_result <- orders"
    });
    await expect(narrowedBridge.request(pivotWiderPreviewRequest(stepId, ["alpha", "beta"]))).rejects.toThrow(
      "did not match the requested session state: schema"
    );
    expect(narrowedTransport.previewStep).toHaveBeenCalledOnce();
    expect(narrowedTransport.applyDraft).not.toHaveBeenCalled();
    await expect(
      narrowedBridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: "after-pivot-wider-nullability-mismatch",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: { filters: [], sort: [] }
      })
    ).resolves.toMatchObject({ kind: "error", sessionId });
    expect(source).toEqual(frameContract());
  });

  it("publishes arbitrary custom R schemas with name-pooled lineage and exact code persistence", async () => {
    const source = frameContract();
    const step: CustomCodeTransformStep = {
      id: "r-custom",
      kind: "customCode",
      params: {
        code: "result <- data.frame(value = as.character(df$missing), value = df$missing, fresh = df$flag, check.names = FALSE)\n"
      }
    };
    const transformed = customCodeContract(
      source,
      step.id,
      [
        { name: "value", sourcePosition: 6 },
        { name: "value", sourcePosition: 6 },
        { name: "fresh", sourcePosition: 5 }
      ],
      { rows: 2, rowNames: "explicit" }
    );
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: transformed,
      diff: customCodeDiff(source, transformed),
      code: "open_wrangler_result <- local({ ... })\n",
      effectiveView: { filters: [], sorts: [] }
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
      step,
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      source.schema,
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      metadata: {
        shape: { rows: 2, columns: 3 },
        schema: [
          expect.objectContaining({ id: "r:c:0", name: "value", position: 0, type: "string" }),
          expect.objectContaining({ id: "c:step:r-custom:0", name: "value", position: 1, type: "string" }),
          expect.objectContaining({ id: "c:step:r-custom:1", name: "fresh", position: 2, type: "boolean" })
        ],
        draftStep: step
      },
      diff: {
        addedRows: 2,
        removedRows: 1,
        addedColumns: ["value", "fresh"],
        removedColumns: ["count", "date", "when", "elapsed", "flag", "missing", "infinite"]
      }
    });

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: transformed,
      code: "open_wrangler_result <- local({ ... })\n"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      metadata: { steps: [step] }
    });

    transport.undoStep.mockResolvedValueOnce({
      sessionId,
      action: "undo",
      revision: 3,
      page: source,
      code: "open_wrangler_result <- orders\n"
    });
    await expect(bridge.request(planRequest("undoStep", 2))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "undo",
      metadata: { shape: { rows: 1, columns: 8 }, steps: [] }
    });
  });

  it("accepts the exact effective view after custom R code prunes missing viewed columns", async () => {
    const source = frameContract();
    const step: CustomCodeTransformStep = {
      id: "r-custom-pruned-view",
      kind: "customCode",
      params: { code: "result <- data.frame(count = df$count)\n" }
    };
    const output = customCodeContract(source, step.id, [{ name: "count", sourcePosition: 1 }]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.getPage.mockResolvedValueOnce(source);
    await bridge.request({
      kind: "getPage",
      sessionId,
      revision: 0,
      viewRequestId: "custom-pruned-source-view",
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
        sort: [{ column: "value", direction: "asc", nulls: "last" }]
      }
    });
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: output,
      diff: customCodeDiff(source, output),
      code: "generated\n",
      effectiveView: { filters: [], sorts: [] }
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
      step,
      expect.objectContaining({
        view: {
          filters: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })],
          sorts: [expect.objectContaining({ column: { id: "r:c:0", name: "value" } })]
        }
      }),
      source.schema,
      undefined,
      expect.any(Object)
    );
    expect(preview).toMatchObject({
      kind: "stepPreview",
      metadata: { filterModel: { filters: [], sort: [] } }
    });
  });

  it("fails closed on mismatched custom R lineage, flavor, diff, and effective views", async () => {
    const source = frameContract();
    const step: CustomCodeTransformStep = {
      id: "r-custom-invalid-response",
      kind: "customCode",
      params: { code: "result <- data.frame(value = df$value, fresh = df$count)\n" }
    };
    const valid = customCodeContract(source, step.id, [
      { name: "value", sourcePosition: 0 },
      { name: "fresh", sourcePosition: 1 }
    ]);
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
    const cases: readonly Readonly<{
      label: string;
      page: RFramePageContract;
      diff: DataDiff;
      effectiveView?: RKernelStepPreviewResult["effectiveView"];
    }>[] = [
      {
        label: "empty schema",
        page: {
          ...valid,
          shape: { ...valid.shape, columns: 0 },
          schema: [],
          page: {
            ...valid.page,
            columnIds: [],
            rows: valid.page.rows.map((row) => ({ ...row, values: [] }))
          }
        },
        diff: customCodeDiff(source, valid),
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "private name",
        page: {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === 1 ? { ...column, name: "__OPEN_WRANGLER_INTERNAL_ROW_ID_hidden" } : { ...column }
          )
        },
        diff: customCodeDiff(source, valid),
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "lineage",
        page: {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === 1 ? { ...column, id: `c:step:${step.id}:1` } : { ...column }
          ),
          page: {
            ...valid.page,
            columnIds: valid.page.columnIds.map((id, index) => (index === 1 ? `c:step:${step.id}:1` : id))
          }
        },
        diff: customCodeDiff(source, valid),
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "flavor",
        page: {
          ...valid,
          dataframeFlavor: "r.tibble",
          frameSemantics: { ...valid.frameSemantics, classes: ["tbl_df", "tbl", "data.frame"] }
        },
        diff: customCodeDiff(source, valid),
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "diff",
        page: valid,
        diff: { ...customCodeDiff(source, valid), addedRows: 0 },
        effectiveView: { filters: [], sorts: [] }
      },
      {
        label: "effective view",
        page: valid,
        diff: customCodeDiff(source, valid),
        effectiveView: {
          filters: [],
          sorts: [{ column: { id: "r:c:0", name: "value" }, direction: "asc", nulls: "last" }]
        }
      },
      { label: "missing effective view", page: valid, diff: customCodeDiff(source, valid) }
    ];

    for (const candidate of cases) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page: candidate.page,
        diff: candidate.diff,
        code: "generated\n",
        ...(candidate.effectiveView === undefined ? {} : { effectiveView: candidate.effectiveView })
      });
      await expect(bridge.request(request), candidate.label).rejects.toThrow();
      expect(transport.previewStep, candidate.label).toHaveBeenCalledOnce();
    }
  });

  it("publishes dynamic native R one-hot schemas with duplicate removed labels atomically", async () => {
    const source = frameContract({ duplicateFirstName: true });
    const step: OneHotEncodeTransformStep = {
      id: "r-one-hot-dynamic",
      kind: "oneHotEncode",
      params: {
        columns: [
          { id: "r:c:0", name: "value" },
          { id: "r:c:1", name: "value" }
        ],
        prefixSeparator: "_",
        dropOriginal: true
      }
    };
    const encoded = categoricalContract(source, step.id, ["r:c:0", "r:c:1"], true, ["value_false", "value_true"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: encoded,
      diff: categoricalDiff(["value_false", "value_true"], ["value", "value"]),
      code: "open_wrangler_result <- open_wrangler_one_hot_encode_columns(orders)"
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
      revision: 1,
      metadata: { shape: { rows: 1, columns: 8 } },
      diff: { addedColumns: ["value_false", "value_true"], removedColumns: ["value", "value"] }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      {
        id: step.id,
        kind: "oneHotEncode",
        params: {
          columns: [
            { id: "r:c:0", name: "value" },
            { id: "r:c:1", name: "value" }
          ],
          prefixSeparator: "_",
          dropOriginal: true
        }
      },
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      source.schema,
      undefined,
      expect.any(Object)
    );

    transport.applyDraft.mockResolvedValueOnce({
      sessionId,
      action: "apply",
      revision: 2,
      page: encoded,
      code: "open_wrangler_result <- open_wrangler_one_hot_encode_columns(orders)"
    });
    await expect(bridge.request(planRequest("applyDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2,
      metadata: { steps: [step] }
    });
    transport.undoStep.mockResolvedValueOnce({ sessionId, action: "undo", revision: 3, page: source, code: "" });
    await expect(bridge.request(planRequest("undoStep", 2))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "undo",
      revision: 3,
      metadata: { steps: [] }
    });
  });

  it("reconciles dropped native R multi-label filters and restores them on discard", async () => {
    const source = frameContract();
    const step: MultiLabelBinarizeTransformStep = {
      id: "r-multi-label-dynamic",
      kind: "multiLabelBinarize",
      params: {
        column: { id: "r:c:6", name: "missing" },
        delimiter: "::",
        prefix: "tag_",
        dropOriginal: true
      }
    };
    const encoded = categoricalContract(source, step.id, ["r:c:6"], true, ["tag_alpha", "tag_beta"]);
    const transport = fakeTransport(source);
    const bridge = createBridge(transport);
    await bridge.request(openRequest("editing"));
    transport.getPage.mockResolvedValueOnce(source);
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: "multi-label-filter",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: {
          filters: [
            {
              column: "missing",
              type: "string",
              predicates: [{ kind: "predicate", operator: "contains", value: "alpha" }]
            }
          ],
          sort: []
        }
      })
    ).resolves.toMatchObject({ kind: "page" });
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: encoded,
      diff: categoricalDiff(["tag_alpha", "tag_beta"], ["missing"]),
      code: "open_wrangler_result <- open_wrangler_multi_label_binarize_column(orders)"
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
      metadata: { filterModel: { filters: [], sort: [] }, shape: { rows: 1, columns: 9 } },
      diff: { addedColumns: ["tag_alpha", "tag_beta"], removedColumns: ["missing"] }
    });
    expect(transport.previewStep).toHaveBeenLastCalledWith(
      sessionId,
      0,
      expect.objectContaining({ kind: "multiLabelBinarize" }),
      expect.objectContaining({ view: { filters: [], sorts: [] } }),
      source.schema,
      undefined,
      expect.any(Object)
    );

    transport.discardDraft.mockResolvedValueOnce({
      sessionId,
      action: "discard",
      revision: 2,
      page: source,
      code: ""
    });
    await expect(bridge.request(planRequest("discardDraft", 1))).resolves.toMatchObject({
      kind: "planUpdated",
      action: "discard",
      metadata: {
        filterModel: {
          filters: [expect.objectContaining({ column: "missing" })],
          sort: []
        }
      }
    });
  });

  it("rejects malformed dynamic native R categorical schemas before publication", async () => {
    const source = frameContract();
    const step: MultiLabelBinarizeTransformStep = {
      id: "r-multi-label-invalid-schema",
      kind: "multiLabelBinarize",
      params: {
        column: { id: "r:c:6", name: "missing" },
        delimiter: ",",
        prefix: "tag_",
        dropOriginal: false
      }
    };
    const valid = categoricalContract(source, step.id, ["r:c:6"], false, ["tag_alpha", "tag_beta"]);
    const invalidContracts: ReadonlyArray<readonly [string, RFramePageContract]> = [
      [
        "generated identity",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length ? { ...column, id: "c:step:wrong:0" } : { ...column }
          )
        }
      ],
      [
        "generated nullability",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length ? { ...column, nullable: true } : { ...column }
          )
        }
      ],
      [
        "generated type",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length
              ? {
                  ...column,
                  rawType: "character",
                  type: "string",
                  semantics: { kind: "character", storageMode: "character", classes: ["character"] }
                }
              : { ...column }
          ) as RColumnSchema[]
        }
      ],
      [
        "generated prefix",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length ? { ...column, name: "wrong_alpha" } : { ...column }
          )
        }
      ],
      [
        "generated order",
        {
          ...valid,
          schema: valid.schema.map((column, index) =>
            index === source.schema.length
              ? { ...column, name: "tag_beta" }
              : index === source.schema.length + 1
                ? { ...column, name: "tag_alpha" }
                : { ...column }
          )
        }
      ],
      [
        "retained column",
        {
          ...valid,
          schema: valid.schema.map((column, index) => (index === 0 ? { ...column, name: "changed" } : { ...column }))
        }
      ]
    ];

    for (const [label, page] of invalidContracts) {
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      transport.queuePreview({
        sessionId,
        revision: 1,
        page,
        diff: categoricalDiff(["tag_alpha", "tag_beta"], []),
        code: "open_wrangler_result <- orders"
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
        }),
        label
      ).rejects.toThrow(/categorical|retained column/u);
    }
  });
});

function pivotLongerPreviewRequest(
  id: string,
  columns: readonly [{ id: string; name: string }, { id: string; name: string }],
  labelColumn = "metric",
  valueColumn = "reading"
): Extract<OpenWranglerRequest, { kind: "previewStep" }> {
  const step: PivotLongerTransformStep = {
    id,
    kind: "pivotLonger",
    params: { columns: [...columns], labelColumn, valueColumn }
  };
  return {
    kind: "previewStep",
    sessionId,
    revision: 0,
    step,
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8
  };
}

function pivotWiderPreviewRequest(
  id: string,
  outputNames: readonly [string, string]
): Extract<OpenWranglerRequest, { kind: "previewStep" }> {
  const token = (value: string) => ({
    kind: "typedSelection" as const,
    version: 1 as const,
    columnType: "string" as const,
    cell: { kind: "string" as const, raw: value, display: value, isNull: false, isNaN: false }
  });
  const step: PivotWiderTransformStep = {
    id,
    kind: "pivotWider",
    params: {
      namesFrom: { id: "r:c:6", name: "missing" },
      valuesFrom: { id: "r:c:0", name: "value" },
      outputs: [
        { key: token("a"), name: outputNames[0] },
        { key: token("b"), name: outputNames[1] }
      ]
    }
  };
  return {
    kind: "previewStep",
    sessionId,
    revision: 0,
    step,
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8
  };
}

function pivotWiderContract(
  source: RFramePageContract,
  stepId: string,
  outputNames: readonly [string, string]
): RFramePageContract {
  const retainedPositions = source.schema
    .map((column, position) => ({ column, position }))
    .filter(({ column }) => column.id !== "r:c:6" && column.id !== "r:c:0")
    .map(({ position }) => position);
  const retained = retainedPositions.map((position, outputPosition) => ({
    ...(source.schema[position] as RColumnSchema),
    position: outputPosition
  }));
  const valueColumn = source.schema.find((column) => column.id === "r:c:0");
  if (!valueColumn) throw new Error("Fake Pivot wider source has no values-from column.");
  const outputs = outputNames.map((name, ordinal) => ({
    ...valueColumn,
    id: `c:step:${stepId}:${ordinal}`,
    name,
    position: retained.length + ordinal,
    nullable: true
  }));
  const schema = [...retained, ...outputs];
  const sourceRow = source.page.rows[0];
  if (!sourceRow) throw new Error("Fake Pivot wider source has no row.");
  const outputValues = [
    ...retainedPositions.map((position) => ({ ...(sourceRow.values[position] as RFrameCell) })),
    { ...(sourceRow.values[0] as RFrameCell) },
    { ...(sourceRow.values[0] as RFrameCell) }
  ];
  return {
    ...source,
    shape: { rows: 1, columns: schema.length },
    frameSemantics: { ...source.frameSemantics, rowNames: "positional", keyColumnIds: [] },
    schema,
    page: {
      ...source.page,
      offset: 0,
      totalRows: 1,
      columnOffset: 0,
      columnIds: schema.map((column) => column.id),
      rows: [{ id: "r:r:0", rowNumber: 0, values: outputValues }]
    }
  };
}

function pivotWiderDiff(outputNames: readonly [string, string]): DataDiff {
  return {
    ...renameDiff(),
    addedRows: 1,
    removedRows: 1,
    addedColumns: [...outputNames],
    removedColumns: ["value", "missing"]
  };
}

function customCodeContract(
  source: RFramePageContract,
  stepId: string,
  outputs: readonly Readonly<{ name: string; sourcePosition: number }>[],
  options: Readonly<{
    rows?: number;
    rowNames?: "positional" | "explicit";
    keyColumnIds?: readonly string[];
  }> = {}
): RFramePageContract {
  const idsByName = new Map<string, string[]>();
  for (const input of source.schema) {
    idsByName.set(input.name, [...(idsByName.get(input.name) ?? []), input.id]);
  }
  let createdOrdinal = 0;
  const schema = outputs.map((output, position) => {
    const template = source.schema[output.sourcePosition];
    if (!template) throw new Error("Unknown fake R custom-code source position.");
    const retainedId = idsByName.get(output.name)?.shift();
    const id = retainedId ?? `c:step:${stepId}:${createdOrdinal++}`;
    return { ...template, id, name: output.name, position };
  });
  const rows = options.rows ?? 1;
  const rowNames = options.rowNames ?? source.frameSemantics.rowNames;
  const columnOffset = Math.min(source.page.columnOffset, schema.length);
  const projected = schema.slice(columnOffset, columnOffset + source.page.columnLimit);
  const sourceRow = source.page.rows[0];
  if (!sourceRow && rows > 0) throw new Error("Fake R custom-code output requires one source row template.");
  return {
    ...source,
    shape: { rows: source.shape.rows + rows, columns: schema.length },
    frameSemantics: {
      ...source.frameSemantics,
      rowNames,
      keyColumnIds: [...(options.keyColumnIds ?? [])]
    },
    schema,
    page: {
      ...source.page,
      offset: 0,
      totalRows: rows,
      columnOffset,
      columnIds: projected.map((column) => column.id),
      rows: Array.from({ length: rows }, (_, rowNumber) => ({
        id: `r:r:${source.shape.rows + rowNumber}`,
        rowNumber,
        ...(rowNames === "explicit" ? { rowLabel: `custom-${rowNumber + 1}` } : {}),
        values: projected.map((column) => {
          const output = outputs[column.position] as { sourcePosition: number };
          return { ...(sourceRow?.values[output.sourcePosition] as RFrameCell) };
        })
      }))
    }
  };
}

function customCodeDiff(source: RFramePageContract, output: RFramePageContract): DataDiff {
  const inputIds = new Set(source.schema.map((column) => column.id));
  const outputIds = new Set(output.schema.map((column) => column.id));
  return {
    addedRows: output.page.totalRows,
    removedRows: source.page.totalRows,
    addedColumns: output.schema.filter((column) => !inputIds.has(column.id)).map((column) => column.name),
    removedColumns: source.schema.filter((column) => !outputIds.has(column.id)).map((column) => column.name),
    changedCells: 0,
    cells: [],
    truncated:
      output.page.offset !== 0 ||
      output.page.limit < source.page.totalRows ||
      output.page.totalRows !== output.page.rows.length
  };
}

function categoricalContract(
  source: RFramePageContract,
  stepId: string,
  selectedColumnIds: readonly string[],
  dropOriginal: boolean,
  generatedNames: readonly string[]
): RFramePageContract {
  const selectedIds = new Set(selectedColumnIds);
  const retained = source.schema
    .filter((column) => !dropOriginal || !selectedIds.has(column.id))
    .map((column, position) => ({ ...column, position }));
  const generated: RColumnSchema[] = generatedNames.map((name, ordinal) => ({
    id: `c:step:${stepId}:${ordinal}`,
    name,
    position: retained.length + ordinal,
    rawType: "integer",
    type: "integer",
    nullable: false,
    semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
  }));
  const schema = [...retained, ...generated];
  const keyColumnIds: string[] = [];
  const retainedIds = new Set(retained.map((column) => column.id));
  for (const id of source.frameSemantics.keyColumnIds) {
    if (!retainedIds.has(id)) break;
    keyColumnIds.push(id);
  }
  const projected = schema.slice(source.page.columnOffset, source.page.columnOffset + source.page.columnLimit);
  const sourcePagePosition = new Map(source.page.columnIds.map((id, position) => [id, position]));
  return {
    ...source,
    shape: { ...source.shape, columns: schema.length },
    frameSemantics: { ...source.frameSemantics, keyColumnIds },
    schema,
    page: {
      ...source.page,
      columnIds: projected.map((column) => column.id),
      rows: source.page.rows.map((row) => ({
        ...row,
        values: projected.map((column) => {
          const position = sourcePagePosition.get(column.id);
          return position === undefined
            ? ({ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false } as const)
            : { ...(row.values[position] as RFrameCell) };
        })
      }))
    }
  };
}

function categoricalDiff(addedColumns: readonly string[], removedColumns: readonly string[]): DataDiff {
  return { ...renameDiff(), addedColumns: [...addedColumns], removedColumns: [...removedColumns] };
}
