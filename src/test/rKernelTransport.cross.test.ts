import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  R_KERNEL_TRANSPORT_VERSION,
  decodeRKernelResponseJson,
  encodeRKernelRequest,
  type RKernelRequest
} from "../extension/r/rKernelProtocol";
import {
  R_KERNEL_RUNTIME_BINDING,
  buildRKernelBootstrapCode,
  buildRKernelDispatchCode,
  buildRKernelTeardownCode,
  readRRuntimeFiles
} from "../extension/r/rKernelRuntimeBundle";

const enabled = process.env.OPEN_WRANGLER_R_CONTRACT_TESTS === "1";
const root = resolve(__dirname, "../..");
const rscript = process.env.RSCRIPT ?? "Rscript";
const sessionId = "11111111-1111-4111-8111-111111111111";
const openRequestId = "22222222-2222-4222-8222-222222222222";
const pageRequestId = "33333333-3333-4333-8333-333333333333";
const closeRequestId = "44444444-4444-4444-8444-444444444444";
const namedRowsSessionId = "55555555-5555-4555-8555-555555555555";
const namedRowsRequestId = "66666666-6666-4666-8666-666666666666";
const sourceChangedRequestId = "77777777-7777-4777-8777-777777777777";
const summaryRequestId = "88888888-8888-4888-8888-888888888888";
const statsRequestId = "99999999-9999-4999-8999-999999999999";
const filteredPageRequestId = "f1111111-1111-4111-8111-111111111111";
const valuesRequestId = "f2222222-2222-4222-8222-222222222222";
const numericValuesRequestId = "f3333333-3333-4333-8333-333333333333";

describe.skipIf(!enabled)("R kernel bootstrap to TypeScript transport", () => {
  it("pages current same-schema values, rejects structural changes, and closes the live session", () => {
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: openRequestId,
      kind: "openSession",
      payload: { sessionId, variableName: "frame", page: pageWindow() }
    });
    const page = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: pageRequestId,
      kind: "getPage",
      payload: {
        sessionId,
        page: pageWindow([{ column: { id: "r:c:0", name: "value" }, direction: "desc", nulls: "last" }])
      }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: closeRequestId,
      kind: "closeSession",
      payload: { sessionId }
    });
    const summary = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: summaryRequestId,
      kind: "getSummary",
      payload: { sessionId, columns: [{ id: "r:c:0", name: "value" }], view: emptyView() }
    });
    const stats = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: statsRequestId,
      kind: "getDatasetStats",
      payload: { sessionId, view: emptyView() }
    });
    const sourceChanged = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: sourceChangedRequestId,
      kind: "getPage",
      payload: { sessionId, page: pageWindow() }
    });
    const filteredPage = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: filteredPageRequestId,
      kind: "getPage",
      payload: {
        sessionId,
        page: {
          ...pageWindow(),
          view: {
            filters: [
              {
                column: { id: "r:c:1", name: "label" },
                type: "string",
                predicates: [{ kind: "predicate", operator: "contains", value: "H" }]
              }
            ],
            sorts: []
          }
        }
      }
    });
    const values = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: valuesRequestId,
      kind: "getColumnValues",
      payload: {
        sessionId,
        column: { id: "r:c:1", name: "label" },
        view: emptyView(),
        search: "H",
        limit: 10
      }
    });
    const numericValues = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: numericValuesRequestId,
      kind: "getColumnValues",
      payload: {
        sessionId,
        column: { id: "r:c:0", name: "value" },
        view: emptyView(),
        search: "1200",
        limit: 10
      }
    });
    const namedRows = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: namedRowsRequestId,
      kind: "openSession",
      payload: { sessionId: namedRowsSessionId, variableName: "named_rows", page: pageWindow() }
    });
    const code = `
frame <- data.frame(value = c(1, 3, 2), label = c("a", "c", "b"), stringsAsFactors = FALSE)
named_rows <- data.frame(value = 1L, row.names = "named-row")
${bootstrap}
${open.code}
frame <- data.frame(value = c(1200, 7, 8), label = c("i", "g", "h"), stringsAsFactors = FALSE)
${page.code}
${summary.code}
${stats.code}
${filteredPage.code}
${values.code}
${numericValues.code}
frame <- data.frame(value = 999L, label = "replacement", stringsAsFactors = FALSE)
${sourceChanged.code}
${close.code}
${namedRows.code}
`;
    const result = runR(code);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), openRequestId);
    const paged = decodeRKernelResponseJson(marked(result.stdout, page.marker), pageRequestId);
    const profiled = decodeRKernelResponseJson(marked(result.stdout, summary.marker), summaryRequestId);
    const datasetStats = decodeRKernelResponseJson(marked(result.stdout, stats.marker), statsRequestId);
    const filtered = decodeRKernelResponseJson(marked(result.stdout, filteredPage.marker), filteredPageRequestId);
    const columnValues = decodeRKernelResponseJson(marked(result.stdout, values.marker), valuesRequestId);
    const numericColumnValues = decodeRKernelResponseJson(
      marked(result.stdout, numericValues.marker),
      numericValuesRequestId
    );
    const changed = decodeRKernelResponseJson(marked(result.stdout, sourceChanged.marker), sourceChangedRequestId);
    const closed = decodeRKernelResponseJson(marked(result.stdout, close.marker), closeRequestId);
    const namedRowsPage = decodeRKernelResponseJson(marked(result.stdout, namedRows.marker), namedRowsRequestId);
    expect(opened).toMatchObject({ kind: "page", sessionId, page: { shape: { rows: 3, columns: 2 } } });
    expect(paged).toMatchObject({ kind: "page", sessionId, page: { shape: { rows: 3, columns: 2 } } });
    if (paged.kind !== "page") throw new Error("Expected a page response.");
    expect(paged.page.page.rows.map((row) => row.rowNumber)).toEqual([0, 1, 2]);
    expect(paged.page.page.rows.map((row) => row.id)).toEqual(["r:r:0", "r:r:2", "r:r:1"]);
    expect(paged.page.page.rows.map((row) => row.values[0]?.raw)).toEqual(["1200", "8", "7"]);
    if (profiled.kind === "error") throw new Error(`R profile failed: ${profiled.code}: ${profiled.message}`);
    expect(profiled).toMatchObject({
      kind: "summary",
      sessionId,
      summaries: [{ columnId: "r:c:0", numeric: { min: 7, max: 1200 }, totalCount: 3 }]
    });
    expect(datasetStats).toMatchObject({
      kind: "datasetStats",
      sessionId,
      stats: { missingCells: 0, missingRows: 0, duplicateRows: 0 }
    });
    expect(filtered).toMatchObject({
      kind: "page",
      sessionId,
      page: { page: { totalRows: 1, rows: [{ id: "r:r:2", rowNumber: 0 }] } }
    });
    expect(columnValues).toMatchObject({
      kind: "columnValues",
      sessionId,
      column: "label",
      values: [
        {
          value: "h",
          count: 1,
          selectionValue: { kind: "typedSelection", version: 1, columnType: "string" }
        }
      ],
      hasMore: false
    });
    expect(numericColumnValues).toMatchObject({
      kind: "columnValues",
      sessionId,
      column: "value",
      values: [
        {
          value: "1200",
          count: 1,
          selectionValue: {
            kind: "typedSelection",
            version: 1,
            columnType: "float",
            cell: { kind: "number", raw: 1200, display: "1200", isNull: false, isNaN: false }
          }
        }
      ],
      hasMore: false
    });
    expect(changed).toMatchObject({
      kind: "error",
      code: "runtime_error",
      recoverable: true,
      message: expect.stringContaining("changed shape or schema")
    });
    expect(closed).toEqual({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: closeRequestId,
      kind: "closed",
      sessionId
    });
    expect(namedRowsPage).toMatchObject({
      kind: "page",
      sessionId: namedRowsSessionId,
      page: {
        shape: { rows: 1, columns: 1 },
        frameSemantics: { rowNames: "explicit" },
        page: { rows: [{ id: "r:r:0", rowNumber: 0, rowLabel: "named-row" }] }
      }
    });
  });

  it("preserves R profile semantics through the strict TypeScript decoder", () => {
    const typedSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const typedOpenId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const typedSummaryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const typedStatsId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const typedCloseId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: typedOpenId,
      kind: "openSession",
      payload: { sessionId: typedSessionId, variableName: "typed", page: pageWindow() }
    });
    const names = ["amount", "flag", "text", "category", "date", "when", "elapsed", "wide"];
    const summary = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: typedSummaryId,
      kind: "getSummary",
      payload: {
        sessionId: typedSessionId,
        columns: names.map((name, index) => ({ id: `r:c:${index}`, name })),
        view: emptyView()
      }
    });
    const stats = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: typedStatsId,
      kind: "getDatasetStats",
      payload: { sessionId: typedSessionId, view: emptyView() }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: typedCloseId,
      kind: "closeSession",
      payload: { sessionId: typedSessionId }
    });
    const result = runR(`
typed <- data.frame(
  amount = c(1, NA_real_, NaN, Inf),
  flag = c(TRUE, FALSE, NA, FALSE),
  text = c("", "é", NA_character_, "😀"),
  category = ordered(c("small", "large", NA, "small"), levels = c("small", "large")),
  date = as.Date(c("2026-01-01", "2026-01-02", NA, "2026-01-04")),
  when = as.POSIXct(c("2026-01-01 00:00:00", "2026-01-02 00:00:00", NA, "2026-01-04 00:00:00"), tz = "UTC"),
  elapsed = as.difftime(c(1, 2, NA, 4), units = "hours"),
  wide = bit64::as.integer64(c("9223372036854775806", "0", NA, "-9223372036854775807")),
  check.names = FALSE
)
${bootstrap}
${open.code}
${summary.code}
${stats.code}
${close.code}
`);

    const profiled = decodeRKernelResponseJson(marked(result.stdout, summary.marker), typedSummaryId);
    const datasetStats = decodeRKernelResponseJson(marked(result.stdout, stats.marker), typedStatsId);
    expect(profiled).toMatchObject({ kind: "summary", sessionId: typedSessionId });
    if (profiled.kind !== "summary") throw new Error("Expected typed R summaries.");
    expect(profiled.summaries).toHaveLength(8);
    expect(profiled.summaries[0]).toMatchObject({ nullCount: 1, nanCount: 1, numeric: { min: 1 } });
    expect(profiled.summaries[1]).toMatchObject({
      visualization: { kind: "boolean", trueCount: 1, falseCount: 2 }
    });
    expect(profiled.summaries[2]).toMatchObject({ text: { emptyCount: 1, minLength: 0, maxLength: 1 } });
    expect(profiled.summaries[3]).toMatchObject({ rawType: "ordered factor", distinctCount: 2 });
    expect(profiled.summaries[4]).toMatchObject({
      visualization: { kind: "datetime", min: "2026-01-01", max: "2026-01-04" }
    });
    expect(profiled.summaries[5]).toMatchObject({
      visualization: {
        kind: "datetime",
        min: "2026-01-01T00:00:00.000000",
        max: "2026-01-04T00:00:00.000000"
      }
    });
    expect(profiled.summaries[6]).toMatchObject({ numeric: { min: 1, max: 4 } });
    expect(profiled.summaries[7]).toMatchObject({
      numeric: {
        exactMin: { raw: "-9223372036854775807" },
        exactMax: { raw: "9223372036854775806" }
      }
    });
    expect(datasetStats).toMatchObject({
      kind: "datasetStats",
      stats: { missingCells: 9, missingRows: 2, duplicateRows: 0 }
    });
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), typedCloseId)).toMatchObject({
      kind: "closed",
      sessionId: typedSessionId
    });
  });

  it("runs the native R rename draft, apply, edit, undo, and generated code lifecycle", () => {
    const editingSessionId = "10000000-0000-4000-8000-000000000001";
    const ids = {
      open: "10000000-0000-4000-8000-000000000002",
      preview: "10000000-0000-4000-8000-000000000003",
      stale: "10000000-0000-4000-8000-000000000004",
      discard: "10000000-0000-4000-8000-000000000005",
      secondPreview: "10000000-0000-4000-8000-000000000006",
      apply: "10000000-0000-4000-8000-000000000007",
      edit: "10000000-0000-4000-8000-000000000008",
      editApply: "10000000-0000-4000-8000-000000000009",
      undo: "10000000-0000-4000-8000-00000000000a",
      close: "10000000-0000-4000-8000-00000000000b",
      inspect: "10000000-0000-4000-8000-00000000000c"
    } as const;
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const projectedPage = {
      ...pageWindow(),
      columnOffset: 1,
      columnLimit: 1
    } as const;
    const step = (
      requestId: string,
      revision: number,
      oldName: string,
      newName: string,
      replaceStepId?: string
    ): Extract<RKernelRequest, { kind: "previewStep" }> => ({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision,
        step: {
          id: "rename-step",
          kind: "renameColumn",
          params: { column: { id: "r:c:1", name: oldName }, newName }
        },
        page: projectedPage,
        ...(replaceStepId === undefined ? {} : { replaceStepId })
      }
    });
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.open,
      kind: "openSession",
      payload: { sessionId: editingSessionId, variableName: "frame", page: projectedPage }
    });
    const preview = requestCode(step(ids.preview, 0, "duplicate", "second duplicate"));
    const stale = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.stale,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 0, page: projectedPage }
    });
    const discard = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.discard,
      kind: "discardDraft",
      payload: { sessionId: editingSessionId, revision: 1, page: projectedPage }
    });
    const secondPreview = requestCode(step(ids.secondPreview, 2, "duplicate", "second duplicate"));
    const apply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.apply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 3, page: projectedPage }
    });
    const inspect = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.inspect,
      kind: "inspectStep",
      payload: {
        sessionId: editingSessionId,
        revision: 4,
        stepId: "rename-step",
        page: projectedPage
      }
    });
    const edit = requestCode(step(ids.edit, 4, "duplicate", "updated duplicate", "rename-step"));
    const editApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.editApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 5, page: projectedPage }
    });
    const undo = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.undo,
      kind: "undoStep",
      payload: { sessionId: editingSessionId, revision: 6, page: projectedPage }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });
    const result = runR(`
frame <- data.frame(duplicate = 1:2, duplicate = 3:4, label = c("a", "b"), check.names = FALSE)
frame_before <- unserialize(serialize(frame, NULL, version = 3L))
${bootstrap}
${open.code}
${preview.code}
${stale.code}
${discard.code}
${secondPreview.code}
${apply.code}
${inspect.code}
${edit.code}
${editApply.code}
${undo.code}
stopifnot(identical(frame, frame_before))
${close.code}
`);

    const previewed = decodeRKernelResponseJson(marked(result.stdout, preview.marker), ids.preview);
    expect(previewed).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      diff: { changedCells: 0, cells: [] }
    });
    if (previewed.kind !== "stepPreview") throw new Error("Expected a native R rename preview.");
    expect(previewed.page.schema.map((column) => column.name)).toEqual(["duplicate", "second duplicate", "label"]);
    expect(previewed.page.schema.map((column) => column.nullable)).toEqual([true, true, true]);
    expect(previewed.page.page.columnIds).toEqual(["r:c:1"]);
    expect(decodeRKernelResponseJson(marked(result.stdout, stale.marker), ids.stale)).toMatchObject({
      kind: "error",
      code: "stale_revision",
      recoverable: true
    });
    const discarded = decodeRKernelResponseJson(marked(result.stdout, discard.marker), ids.discard);
    expect(discarded).toMatchObject({
      kind: "planUpdated",
      action: "discard",
      revision: 2,
      code: ""
    });
    const applied = decodeRKernelResponseJson(marked(result.stdout, apply.marker), ids.apply);
    expect(applied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 4 });
    if (applied.kind !== "planUpdated") throw new Error("Expected an applied native R rename.");
    const inspected = decodeRKernelResponseJson(marked(result.stdout, inspect.marker), ids.inspect);
    expect(inspected).toMatchObject({
      kind: "stepInspection",
      revision: 4,
      stepId: "rename-step",
      stepIndex: 0,
      diff: { changedCells: 0, cells: [] }
    });
    if (inspected.kind !== "stepInspection") throw new Error("Expected an applied native R rename inspection.");
    expect(inspected.inputSchema.map((column) => column.name)).toEqual(["duplicate", "duplicate", "label"]);
    expect(inspected.outputSchema.map((column) => column.name)).toEqual(["duplicate", "second duplicate", "label"]);
    expect(inspected.inputPage.page.columnIds).toEqual(["r:c:1"]);
    expect(inspected.outputPage.page.columnIds).toEqual(["r:c:1"]);
    expect(inspected.code).toContain("second duplicate");
    const edited = decodeRKernelResponseJson(marked(result.stdout, edit.marker), ids.edit);
    expect(edited).toMatchObject({ kind: "stepPreview", revision: 5 });
    if (edited.kind !== "stepPreview") throw new Error("Expected an edited native R rename preview.");
    expect(edited.page.schema.map((column) => column.name)).toEqual(["duplicate", "updated duplicate", "label"]);
    expect(decodeRKernelResponseJson(marked(result.stdout, editApply.marker), ids.editApply)).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 6
    });
    const undone = decodeRKernelResponseJson(marked(result.stdout, undo.marker), ids.undo);
    expect(undone).toMatchObject({ kind: "planUpdated", action: "undo", revision: 7 });
    if (undone.kind !== "planUpdated") throw new Error("Expected an undone native R rename.");
    expect(undone.page.schema.map((column) => column.name)).toEqual(["duplicate", "duplicate", "label"]);
    expect(undone.code).toBe("");
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), ids.close)).toMatchObject({
      kind: "closed",
      sessionId: editingSessionId
    });

    const generated = runR(`
frame <- data.frame(duplicate = 1:2, duplicate = 3:4, label = c("a", "b"), check.names = FALSE)
frame_before <- unserialize(serialize(frame, NULL, version = 3L))
${applied.code}
stopifnot(identical(names(open_wrangler_result), c("duplicate", "second duplicate", "label")))
stopifnot(identical(frame, frame_before))
cat("generated-ok\\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");
  });

  it("runs a native R Drop Columns then Rename Column plan with stable identities", () => {
    const editingSessionId = "20000000-0000-4000-8000-000000000001";
    const ids = {
      open: "20000000-0000-4000-8000-000000000002",
      dropPreview: "20000000-0000-4000-8000-000000000003",
      dropApply: "20000000-0000-4000-8000-000000000004",
      renamePreview: "20000000-0000-4000-8000-000000000005",
      renameApply: "20000000-0000-4000-8000-000000000006",
      inspect: "20000000-0000-4000-8000-000000000007",
      undoRename: "20000000-0000-4000-8000-000000000008",
      undoDrop: "20000000-0000-4000-8000-000000000009",
      close: "20000000-0000-4000-8000-00000000000a"
    } as const;
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.open,
      kind: "openSession",
      payload: { sessionId: editingSessionId, variableName: "frame", page: pageWindow() }
    });
    const dropPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.dropPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 0,
        step: {
          id: "drop-step",
          kind: "dropColumns",
          params: { columns: [{ id: "r:c:0", name: "duplicate" }] }
        },
        page: pageWindow()
      }
    });
    const dropApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.dropApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 1, page: pageWindow() }
    });
    const renamePreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.renamePreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 2,
        step: {
          id: "rename-step",
          kind: "renameColumn",
          params: { column: { id: "r:c:1", name: "duplicate" }, newName: "remaining duplicate" }
        },
        page: pageWindow()
      }
    });
    const renameApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.renameApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 3, page: pageWindow() }
    });
    const inspect = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.inspect,
      kind: "inspectStep",
      payload: { sessionId: editingSessionId, revision: 4, stepId: "drop-step", page: pageWindow() }
    });
    const undoRename = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.undoRename,
      kind: "undoStep",
      payload: { sessionId: editingSessionId, revision: 4, page: pageWindow() }
    });
    const undoDrop = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.undoDrop,
      kind: "undoStep",
      payload: { sessionId: editingSessionId, revision: 5, page: pageWindow() }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });
    const result = runR(`
frame <- data.frame(duplicate = 1:2, duplicate = 3:4, label = c("a", "b"), check.names = FALSE)
frame_before <- unserialize(serialize(frame, NULL, version = 3L))
${bootstrap}
${open.code}
${dropPreview.code}
${dropApply.code}
${renamePreview.code}
${renameApply.code}
${inspect.code}
${undoRename.code}
${undoDrop.code}
stopifnot(identical(frame, frame_before))
${close.code}
`);

    const dropped = decodeRKernelResponseJson(marked(result.stdout, dropPreview.marker), ids.dropPreview);
    expect(dropped).toMatchObject({ kind: "stepPreview", diff: { removedColumns: ["duplicate"] } });
    if (dropped.kind !== "stepPreview") throw new Error("Expected a native R drop preview.");
    expect(dropped.page.schema.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "r:c:1", position: 0 },
      { id: "r:c:2", position: 1 }
    ]);
    expect(decodeRKernelResponseJson(marked(result.stdout, dropApply.marker), ids.dropApply)).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2
    });
    const renamed = decodeRKernelResponseJson(marked(result.stdout, renameApply.marker), ids.renameApply);
    expect(renamed).toMatchObject({ kind: "planUpdated", action: "apply", revision: 4 });
    if (renamed.kind !== "planUpdated") throw new Error("Expected an applied mixed R plan.");
    expect(renamed.page.schema.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "r:c:1", name: "remaining duplicate" },
      { id: "r:c:2", name: "label" }
    ]);
    const inspected = decodeRKernelResponseJson(marked(result.stdout, inspect.marker), ids.inspect);
    expect(inspected).toMatchObject({
      kind: "stepInspection",
      stepId: "drop-step",
      diff: { removedColumns: ["duplicate"] }
    });
    const afterRenameUndo = decodeRKernelResponseJson(marked(result.stdout, undoRename.marker), ids.undoRename);
    expect(afterRenameUndo).toMatchObject({ kind: "planUpdated", action: "undo", revision: 5 });
    if (afterRenameUndo.kind !== "planUpdated") throw new Error("Expected the R rename undo.");
    expect(afterRenameUndo.page.schema.map((column) => column.id)).toEqual(["r:c:1", "r:c:2"]);
    const afterDropUndo = decodeRKernelResponseJson(marked(result.stdout, undoDrop.marker), ids.undoDrop);
    expect(afterDropUndo).toMatchObject({ kind: "planUpdated", action: "undo", revision: 6 });
    if (afterDropUndo.kind !== "planUpdated") throw new Error("Expected the R drop undo.");
    expect(afterDropUndo.page.schema.map((column) => column.id)).toEqual(["r:c:0", "r:c:1", "r:c:2"]);

    const generated = runR(`
frame <- data.frame(duplicate = 1:2, duplicate = 3:4, label = c("a", "b"), check.names = FALSE)
frame_before <- unserialize(serialize(frame, NULL, version = 3L))
${renamed.code}
stopifnot(identical(names(open_wrangler_result), c("remaining duplicate", "label")))
stopifnot(identical(frame, frame_before))
cat("generated-ok\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");
  });

  it("runs an ordered native R Select Columns plan with generated code and data-table keys", () => {
    const editingSessionId = "30000000-0000-4000-8000-000000000001";
    const ids = {
      open: "30000000-0000-4000-8000-000000000002",
      selectPreview: "30000000-0000-4000-8000-000000000003",
      selectApply: "30000000-0000-4000-8000-000000000004",
      inspect: "30000000-0000-4000-8000-000000000005",
      renamePreview: "30000000-0000-4000-8000-000000000006",
      renameApply: "30000000-0000-4000-8000-000000000007",
      undoRename: "30000000-0000-4000-8000-000000000008",
      undoSelect: "30000000-0000-4000-8000-000000000009",
      close: "30000000-0000-4000-8000-00000000000a"
    } as const;
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.open,
      kind: "openSession",
      payload: { sessionId: editingSessionId, variableName: "frame", page: pageWindow() }
    });
    const selectPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.selectPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 0,
        step: {
          id: "select-step",
          kind: "selectColumns",
          params: {
            columns: [
              { id: "r:c:2", name: "label" },
              { id: "r:c:1", name: "key_b" },
              { id: "r:c:0", name: "key_a" }
            ]
          }
        },
        page: pageWindow()
      }
    });
    const selectApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.selectApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 1, page: pageWindow() }
    });
    const inspect = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.inspect,
      kind: "inspectStep",
      payload: { sessionId: editingSessionId, revision: 2, stepId: "select-step", page: pageWindow() }
    });
    const renamePreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.renamePreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 2,
        step: {
          id: "rename-step",
          kind: "renameColumn",
          params: { column: { id: "r:c:1", name: "key_b" }, newName: "secondary_key" }
        },
        page: pageWindow()
      }
    });
    const renameApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.renameApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 3, page: pageWindow() }
    });
    const undoRename = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.undoRename,
      kind: "undoStep",
      payload: { sessionId: editingSessionId, revision: 4, page: pageWindow() }
    });
    const undoSelect = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.undoSelect,
      kind: "undoStep",
      payload: { sessionId: editingSessionId, revision: 5, page: pageWindow() }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });
    const result = runR(`
stopifnot(requireNamespace("data.table", quietly = TRUE))
frame <- data.table::data.table(
  key_a = c(1L, 1L, 2L),
  key_b = c(2L, 1L, 1L),
  label = c("alpha", "beta", "gamma"),
  score = c(10, 20, 30)
)
data.table::setkey(frame, key_a, key_b)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${selectPreview.code}
${selectApply.code}
${inspect.code}
${renamePreview.code}
${renameApply.code}
${undoRename.code}
${undoSelect.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const selected = decodeRKernelResponseJson(marked(result.stdout, selectPreview.marker), ids.selectPreview);
    expect(selected).toMatchObject({
      kind: "stepPreview",
      diff: { removedColumns: ["score"] },
      page: { frameSemantics: { keyColumnIds: ["r:c:0", "r:c:1"] } }
    });
    if (selected.kind !== "stepPreview") throw new Error("Expected a native R Select Columns preview.");
    expect(selected.page.schema.map(({ id, name, position }) => ({ id, name, position }))).toEqual([
      { id: "r:c:2", name: "label", position: 0 },
      { id: "r:c:1", name: "key_b", position: 1 },
      { id: "r:c:0", name: "key_a", position: 2 }
    ]);
    expect(selected.page.page.columnIds).toEqual(["r:c:2", "r:c:1", "r:c:0"]);
    expect(decodeRKernelResponseJson(marked(result.stdout, selectApply.marker), ids.selectApply)).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2
    });
    const inspected = decodeRKernelResponseJson(marked(result.stdout, inspect.marker), ids.inspect);
    expect(inspected).toMatchObject({
      kind: "stepInspection",
      stepId: "select-step",
      diff: { removedColumns: ["score"] }
    });
    if (inspected.kind !== "stepInspection") throw new Error("Expected an applied R Select Columns inspection.");
    expect(inspected.inputSchema.map((column) => column.id)).toEqual(["r:c:0", "r:c:1", "r:c:2", "r:c:3"]);
    expect(inspected.outputSchema.map((column) => column.id)).toEqual(["r:c:2", "r:c:1", "r:c:0"]);

    const renamed = decodeRKernelResponseJson(marked(result.stdout, renameApply.marker), ids.renameApply);
    expect(renamed).toMatchObject({ kind: "planUpdated", action: "apply", revision: 4 });
    if (renamed.kind !== "planUpdated") throw new Error("Expected an applied mixed R selection plan.");
    expect(renamed.page.schema.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "r:c:2", name: "label" },
      { id: "r:c:1", name: "secondary_key" },
      { id: "r:c:0", name: "key_a" }
    ]);
    expect(decodeRKernelResponseJson(marked(result.stdout, undoRename.marker), ids.undoRename)).toMatchObject({
      kind: "planUpdated",
      action: "undo",
      revision: 5
    });
    const restored = decodeRKernelResponseJson(marked(result.stdout, undoSelect.marker), ids.undoSelect);
    expect(restored).toMatchObject({ kind: "planUpdated", action: "undo", revision: 6 });
    if (restored.kind !== "planUpdated") throw new Error("Expected the R Select Columns undo.");
    expect(restored.page.schema.map((column) => column.id)).toEqual(["r:c:0", "r:c:1", "r:c:2", "r:c:3"]);

    expect(selected.code).toContain(".ow_select_positions");
    expect(renamed.code).toContain("secondary_key");
    expect(renamed.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);
    const generated = runR(`
stopifnot(requireNamespace("data.table", quietly = TRUE))
frame <- data.table::data.table(
  key_a = c(1L, 1L, 2L),
  key_b = c(2L, 1L, 1L),
  label = c("alpha", "beta", "gamma"),
  score = c(10, 20, 30)
)
data.table::setkey(frame, key_a, key_b)
frame_before <- serialize(frame, NULL, version = 3L)
${renamed.code}
stopifnot(identical(names(open_wrangler_result), c("label", "secondary_key", "key_a")))
stopifnot(identical(data.table::key(open_wrangler_result), c("key_a", "secondary_key")))
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
cat("generated-ok\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");
  });

  it("runs native R Clone Column then Rename Column against the derived identity", () => {
    const editingSessionId = "40000000-0000-4000-8000-000000000001";
    const cloneStepId = `clone-${"x".repeat(130)}`;
    const cloneColumnId = `c:step:${cloneStepId}:0`;
    expect(Buffer.byteLength(cloneColumnId, "utf8")).toBeGreaterThan(128);
    const ids = {
      open: "40000000-0000-4000-8000-000000000002",
      clonePreview: "40000000-0000-4000-8000-000000000003",
      cloneApply: "40000000-0000-4000-8000-000000000004",
      renamePreview: "40000000-0000-4000-8000-000000000005",
      renameApply: "40000000-0000-4000-8000-000000000006",
      inspect: "40000000-0000-4000-8000-000000000007",
      undoRename: "40000000-0000-4000-8000-000000000008",
      undoClone: "40000000-0000-4000-8000-000000000009",
      close: "40000000-0000-4000-8000-00000000000a"
    } as const;
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.open,
      kind: "openSession",
      payload: { sessionId: editingSessionId, variableName: "frame", page: pageWindow() }
    });
    const clonePreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.clonePreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 0,
        step: {
          id: cloneStepId,
          kind: "cloneColumn",
          params: { column: { id: "r:c:2", name: "duplicate" }, newName: "copied value" }
        },
        page: pageWindow()
      }
    });
    const cloneApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.cloneApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 1, page: pageWindow() }
    });
    const renamePreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.renamePreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 2,
        step: {
          id: "rename-clone-step",
          kind: "renameColumn",
          params: {
            column: { id: cloneColumnId, name: "copied value" },
            newName: "renamed copy"
          }
        },
        page: pageWindow()
      }
    });
    const renameApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.renameApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 3, page: pageWindow() }
    });
    const inspect = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.inspect,
      kind: "inspectStep",
      payload: { sessionId: editingSessionId, revision: 4, stepId: cloneStepId, page: pageWindow() }
    });
    const undoRename = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.undoRename,
      kind: "undoStep",
      payload: { sessionId: editingSessionId, revision: 4, page: pageWindow() }
    });
    const undoClone = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.undoClone,
      kind: "undoStep",
      payload: { sessionId: editingSessionId, revision: 5, page: pageWindow() }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });
    const result = runR(`
stopifnot(requireNamespace("data.table", quietly = TRUE))
frame <- data.table::data.table(row_key = c(1L, 2L), duplicate = c(10, 20), duplicate = c(30, 40))
data.table::setnames(frame, "row_key", "key")
data.table::setkey(frame, key)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${clonePreview.code}
${cloneApply.code}
${renamePreview.code}
${renameApply.code}
${inspect.code}
${undoRename.code}
${undoClone.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const cloned = decodeRKernelResponseJson(marked(result.stdout, clonePreview.marker), ids.clonePreview);
    expect(cloned).toMatchObject({
      kind: "stepPreview",
      diff: { addedColumns: ["copied value"], removedColumns: [] },
      page: { frameSemantics: { keyColumnIds: ["r:c:0"] } }
    });
    if (cloned.kind !== "stepPreview") throw new Error("Expected a native R Clone Column preview.");
    expect(cloned.page.schema.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "r:c:0", name: "key" },
      { id: "r:c:1", name: "duplicate" },
      { id: "r:c:2", name: "duplicate" },
      { id: cloneColumnId, name: "copied value" }
    ]);
    expect(cloned.page.schema[3]).toMatchObject({
      rawType: cloned.page.schema[2]?.rawType,
      type: cloned.page.schema[2]?.type,
      nullable: cloned.page.schema[2]?.nullable
    });
    expect(cloned.page.page.rows.map((row) => row.values[3])).toEqual(
      cloned.page.page.rows.map((row) => row.values[2])
    );
    expect(decodeRKernelResponseJson(marked(result.stdout, cloneApply.marker), ids.cloneApply)).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: 2
    });

    const renameDraft = decodeRKernelResponseJson(marked(result.stdout, renamePreview.marker), ids.renamePreview);
    expect(renameDraft).toMatchObject({ kind: "stepPreview", revision: 3 });

    const renamed = decodeRKernelResponseJson(marked(result.stdout, renameApply.marker), ids.renameApply);
    expect(renamed).toMatchObject({ kind: "planUpdated", action: "apply", revision: 4 });
    if (renamed.kind !== "planUpdated") throw new Error("Expected the applied R Clone then Rename plan.");
    expect(renamed.page.schema.at(-1)).toMatchObject({ id: cloneColumnId, name: "renamed copy" });
    expect(renamed.page.frameSemantics.keyColumnIds).toEqual(["r:c:0"]);

    const inspected = decodeRKernelResponseJson(marked(result.stdout, inspect.marker), ids.inspect);
    expect(inspected).toMatchObject({
      kind: "stepInspection",
      stepId: cloneStepId,
      diff: { addedColumns: ["copied value"], removedColumns: [] }
    });
    if (inspected.kind !== "stepInspection") throw new Error("Expected the applied R Clone Column inspection.");
    expect(inspected.inputSchema.map((column) => column.id)).toEqual(["r:c:0", "r:c:1", "r:c:2"]);
    expect(inspected.outputSchema.at(-1)).toMatchObject({ id: cloneColumnId, name: "copied value" });

    const afterRenameUndo = decodeRKernelResponseJson(marked(result.stdout, undoRename.marker), ids.undoRename);
    expect(afterRenameUndo).toMatchObject({ kind: "planUpdated", action: "undo", revision: 5 });
    if (afterRenameUndo.kind !== "planUpdated") throw new Error("Expected the R derived-column rename undo.");
    expect(afterRenameUndo.page.schema.at(-1)).toMatchObject({
      id: cloneColumnId,
      name: "copied value"
    });
    const restored = decodeRKernelResponseJson(marked(result.stdout, undoClone.marker), ids.undoClone);
    expect(restored).toMatchObject({ kind: "planUpdated", action: "undo", revision: 6 });
    if (restored.kind !== "planUpdated") throw new Error("Expected the R Clone Column undo.");
    expect(restored.page.schema.map((column) => column.id)).toEqual(["r:c:0", "r:c:1", "r:c:2"]);

    expect(renamed.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);
    const generated = runR(`
stopifnot(requireNamespace("data.table", quietly = TRUE))
frame <- data.table::data.table(row_key = c(1L, 2L), duplicate = c(10, 20), duplicate = c(30, 40))
data.table::setnames(frame, "row_key", "key")
data.table::setkey(frame, key)
frame_before <- serialize(frame, NULL, version = 3L)
${renamed.code}
stopifnot(identical(names(open_wrangler_result), c("key", "duplicate", "duplicate", "renamed copy")))
stopifnot(identical(open_wrangler_result[[4L]], frame[[3L]]))
stopifnot(identical(data.table::key(open_wrangler_result), "key"))
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
cat("generated-ok\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");
  });

  it("runs native R Text Length through preview, apply, inspection, undo, and generated code", () => {
    const editingSessionId = "50000000-0000-4000-8000-000000000001";
    const stepId = "text-length-unicode";
    const outputId = `c:step:${stepId}:0`;
    const ids = {
      open: "50000000-0000-4000-8000-000000000002",
      preview: "50000000-0000-4000-8000-000000000003",
      apply: "50000000-0000-4000-8000-000000000004",
      inspect: "50000000-0000-4000-8000-000000000005",
      undo: "50000000-0000-4000-8000-000000000006",
      close: "50000000-0000-4000-8000-000000000007"
    } as const;
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.open,
      kind: "openSession",
      payload: { sessionId: editingSessionId, variableName: "frame", page: pageWindow() }
    });
    const preview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.preview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 0,
        step: {
          id: stepId,
          kind: "textLength",
          params: { column: { id: "r:c:0", name: "label" }, newColumn: "label length" }
        },
        page: pageWindow()
      }
    });
    const apply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.apply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 1, page: pageWindow() }
    });
    const inspect = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.inspect,
      kind: "inspectStep",
      payload: { sessionId: editingSessionId, revision: 2, stepId, page: pageWindow() }
    });
    const undo = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.undo,
      kind: "undoStep",
      payload: { sessionId: editingSessionId, revision: 2, page: pageWindow() }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });
    const result = runR(`
frame <- data.frame(
  label = c("na\\u00efve", "\\u6771\\u4eac", "\\U0001F9EA", NA_character_),
  stringsAsFactors = FALSE,
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${preview.code}
${apply.code}
${inspect.code}
${undo.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const previewed = decodeRKernelResponseJson(marked(result.stdout, preview.marker), ids.preview);
    expect(previewed).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: ["label length"],
        removedColumns: [],
        changedCells: 0,
        cells: [],
        truncated: false
      }
    });
    if (previewed.kind !== "stepPreview") throw new Error("Expected a native R Text Length preview.");
    expect(previewed.page.schema.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "r:c:0", name: "label" },
      { id: outputId, name: "label length" }
    ]);
    expect(previewed.page.schema[1]).toMatchObject({
      id: outputId,
      rawType: "integer",
      type: "integer",
      nullable: true,
      semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
    });
    expect(previewed.page.page.rows[3]?.values[0]).toMatchObject({ kind: "null", raw: null, isNull: true });
    expect(previewed.page.page.rows.map((row) => row.values[1])).toMatchObject([
      { kind: "integer", raw: "5", isNull: false, isNaN: false },
      { kind: "integer", raw: "2", isNull: false, isNaN: false },
      { kind: "integer", raw: "1", isNull: false, isNaN: false },
      { kind: "null", raw: null, display: "NA", isNull: true, isNaN: false }
    ]);

    const applied = decodeRKernelResponseJson(marked(result.stdout, apply.marker), ids.apply);
    expect(applied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 2 });
    if (applied.kind !== "planUpdated") throw new Error("Expected an applied native R Text Length step.");
    expect(applied.page.schema[1]).toMatchObject({ id: outputId, name: "label length", type: "integer" });

    const inspected = decodeRKernelResponseJson(marked(result.stdout, inspect.marker), ids.inspect);
    expect(inspected).toMatchObject({
      kind: "stepInspection",
      revision: 2,
      stepId,
      stepIndex: 0,
      diff: { addedColumns: ["label length"], removedColumns: [], changedCells: 0 }
    });
    if (inspected.kind !== "stepInspection") throw new Error("Expected the applied R Text Length inspection.");
    expect(inspected.inputSchema.map((column) => column.id)).toEqual(["r:c:0"]);
    expect(inspected.outputSchema.map((column) => column.id)).toEqual(["r:c:0", outputId]);
    expect(inspected.outputPage.page.rows.map((row) => row.values[1])).toEqual(
      previewed.page.page.rows.map((row) => row.values[1])
    );

    const undone = decodeRKernelResponseJson(marked(result.stdout, undo.marker), ids.undo);
    expect(undone).toMatchObject({ kind: "planUpdated", action: "undo", revision: 3, code: "" });
    if (undone.kind !== "planUpdated") throw new Error("Expected the R Text Length undo.");
    expect(undone.page.schema.map((column) => column.id)).toEqual(["r:c:0"]);
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), ids.close)).toMatchObject({
      kind: "closed",
      sessionId: editingSessionId
    });

    expect(applied.code).toContain("nchar");
    expect(applied.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);
    const generated = runR(`
frame <- data.frame(
  label = c("na\\u00efve", "\\u6771\\u4eac", "\\U0001F9EA", NA_character_),
  stringsAsFactors = FALSE,
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${applied.code}
stopifnot(identical(names(open_wrangler_result), c("label", "label length")))
stopifnot(identical(open_wrangler_result[[2L]], c(5L, 2L, 1L, NA_integer_)))
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
cat("generated-ok\\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");
  });

  it("removes only the runtime binding owned by the matching transport and bundle", () => {
    const files = readRRuntimeFiles(resolve(root, "r"));
    const owner = "transport-owner-a";
    const bootstrap = buildRKernelBootstrapCode(files, owner);
    const secondOwner = "transport-owner-b";
    const wrongOwnerTeardown = buildRKernelTeardownCode(files, "transport-owner-c");
    const wrongBundleTeardown = buildRKernelTeardownCode(
      { ...files, "kernel_agent.R": `${files["kernel_agent.R"]}\n` },
      owner
    );
    const ownedTeardown = buildRKernelTeardownCode(files, owner);
    const secondBootstrap = buildRKernelBootstrapCode(files, secondOwner);
    const secondTeardown = buildRKernelTeardownCode(files, secondOwner);
    const code = `
${bootstrap}
${wrongOwnerTeardown}
cat(if (exists("${R_KERNEL_RUNTIME_BINDING}", envir = .GlobalEnv, inherits = FALSE)) "present" else "missing", "\n", sep = "")
${wrongBundleTeardown}
cat(if (exists("${R_KERNEL_RUNTIME_BINDING}", envir = .GlobalEnv, inherits = FALSE)) "present" else "missing", "\n", sep = "")
${secondBootstrap}
${ownedTeardown}
cat(if (exists("${R_KERNEL_RUNTIME_BINDING}", envir = .GlobalEnv, inherits = FALSE)) "present" else "missing", "\n", sep = "")
${secondTeardown}
cat(if (exists("${R_KERNEL_RUNTIME_BINDING}", envir = .GlobalEnv, inherits = FALSE)) "present" else "missing", "\n", sep = "")
`;
    const result = runR(code);
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual(["present", "present", "present", "missing"]);
  });
});

function runR(code: string) {
  const result = spawnSync(rscript, ["--vanilla", "-"], {
    cwd: root,
    encoding: "utf8",
    input: code,
    timeout: 30_000,
    maxBuffer: 20 * 1_024 * 1_024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      R_LIBS_USER: process.env.R_LIBS_USER,
      R_LIBS_SITE: process.env.R_LIBS_SITE,
      R_PROFILE_USER: "",
      R_ENVIRON_USER: ""
    }
  });
  if (result.error) {
    const stderr = result.stderr.trim();
    throw new Error(
      `R kernel transport fixture failed before exit (${result.error.message})${stderr.length > 0 ? `: ${stderr}` : ""}`,
      { cause: result.error }
    );
  }
  if (result.status !== 0) {
    throw new Error(`R kernel transport fixture failed (${result.status ?? "signal"}): ${result.stderr.trim()}`);
  }
  expect(result.stderr).toBe("");
  return result;
}

function requestCode(request: RKernelRequest): { readonly marker: string; readonly code: string } {
  const marker = request.requestId.replaceAll("-", "");
  return { marker, code: buildRKernelDispatchCode(encodeRKernelRequest(request), marker) };
}

function marked(output: string, marker: string): string {
  const start = `__OPEN_WRANGLER_R_START_${marker}__`;
  const end = `__OPEN_WRANGLER_R_END_${marker}__`;
  const startIndex = output.indexOf(start);
  const endIndex = output.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Missing R transport marker ${marker}. Output: ${output.slice(0, 2_000)}`);
  }
  return output.slice(startIndex + start.length, endIndex).trim();
}

function pageWindow(sorts: readonly RKernelSort[] = []) {
  return { rowOffset: 0, rowLimit: 100, columnOffset: 0, columnLimit: 100, view: { filters: [], sorts } } as const;
}

function emptyView() {
  return { filters: [], sorts: [] } as const;
}

type RKernelSort = {
  readonly column: Readonly<{ id: string; name: string }>;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
};
