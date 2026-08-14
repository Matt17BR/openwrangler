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

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), openRequestId, {
      expectExportFormats: true
    });
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
    const namedRowsPage = decodeRKernelResponseJson(marked(result.stdout, namedRows.marker), namedRowsRequestId, {
      expectExportFormats: true
    });
    expect(opened).toMatchObject({ kind: "page", sessionId, page: { shape: { rows: 3, columns: 2 } } });
    expect(opened).toMatchObject({ exportFormats: ["csv", "parquet"] });
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

  it("streams a native Parquet file through the strict kernel transport", () => {
    const parquetSessionId = "10101010-1010-4010-8010-101010101010";
    const parquetOpenId = "11111111-2222-4111-8111-111111111111";
    const parquetExportRequestId = "22222222-3333-4222-8222-222222222222";
    const parquetReadRequestId = "33333333-4444-4333-8333-333333333333";
    const parquetCloseExportId = "44444444-5555-4444-8444-444444444444";
    const parquetCloseSessionId = "55555555-6666-4555-8555-555555555555";
    const parquetExportId = "66666666-7777-4666-8666-666666666666";
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: parquetOpenId,
      kind: "openSession",
      payload: { sessionId: parquetSessionId, variableName: "parquet_frame", page: pageWindow() }
    });
    const exportRequest = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: parquetExportRequestId,
      kind: "exportData",
      payload: { sessionId: parquetSessionId, revision: 0, exportId: parquetExportId, format: "parquet" }
    });
    const read = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: parquetReadRequestId,
      kind: "readDataExport",
      payload: {
        sessionId: parquetSessionId,
        revision: 0,
        exportId: parquetExportId,
        offset: 0,
        limit: 1_048_576
      }
    });
    const closeExport = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: parquetCloseExportId,
      kind: "closeDataExport",
      payload: { sessionId: parquetSessionId, revision: 0, exportId: parquetExportId }
    });
    const closeSession = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: parquetCloseSessionId,
      kind: "closeSession",
      payload: { sessionId: parquetSessionId }
    });
    const code = `
parquet_frame <- data.frame(
  duplicate = factor(c("one", "two")),
  duplicate = as.Date(c("2026-01-01", "2026-01-02")),
  check.names = FALSE
)
${bootstrap}
${open.code}
${exportRequest.code}
${read.code}
${closeExport.code}
${closeSession.code}
`;
    const result = runR(code);
    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), parquetOpenId, {
      expectExportFormats: true
    });
    const exported = decodeRKernelResponseJson(marked(result.stdout, exportRequest.marker), parquetExportRequestId);
    const chunk = decodeRKernelResponseJson(marked(result.stdout, read.marker), parquetReadRequestId);
    const exportClosed = decodeRKernelResponseJson(marked(result.stdout, closeExport.marker), parquetCloseExportId);
    const sessionClosed = decodeRKernelResponseJson(marked(result.stdout, closeSession.marker), parquetCloseSessionId);

    expect(opened).toMatchObject({ kind: "page", exportFormats: ["csv", "parquet"] });
    expect(exported).toMatchObject({ kind: "dataExported", format: "parquet", rows: 2, columns: 2 });
    expect(chunk).toMatchObject({ kind: "dataExportChunk", offset: 0 });
    if (chunk.kind !== "dataExportChunk") throw new Error("Expected an R Parquet export chunk.");
    const bytes = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    expect(bytes.subarray(0, 4).toString("utf8")).toBe("PAR1");
    expect(bytes.subarray(-4).toString("utf8")).toBe("PAR1");
    expect(exportClosed).toMatchObject({ kind: "dataExportClosed", exportId: parquetExportId });
    expect(sessionClosed).toMatchObject({ kind: "closed", sessionId: parquetSessionId });
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
    const inspect = inspectionRequestCodes(ids.inspect, {
      sessionId: editingSessionId,
      revision: 4,
      stepId: "rename-step",
      page: projectedPage
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
${inspect.info.code}
${inspect.input.code}
${inspect.output.code}
${edit.code}
${editApply.code}
${undo.code}
stopifnot(identical(frame, frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R rename session.");
    const previewed = decodeRKernelResponseJson(marked(result.stdout, preview.marker), ids.preview, {
      inputSchema: opened.page.schema
    });
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
    const inspectedInfo = decodeRKernelResponseJson(marked(result.stdout, inspect.info.marker), inspect.infoRequestId);
    const inspectedInput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.input.marker),
      inspect.inputRequestId,
      { inputSchema: opened.page.schema, inspectionSide: "input" }
    );
    const inspectedOutput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.output.marker),
      inspect.outputRequestId,
      { outputSchema: applied.page.schema, inspectionSide: "output" }
    );
    expect(inspectedInput).toMatchObject({
      kind: "stepInspectionPage",
      side: "input",
      revision: 4,
      stepId: "rename-step",
      stepIndex: 0
    });
    expect(inspectedOutput).toMatchObject({
      kind: "stepInspectionPage",
      side: "output",
      revision: 4,
      stepId: "rename-step",
      stepIndex: 0
    });
    if (inspectedInput.kind !== "stepInspectionPage" || inspectedOutput.kind !== "stepInspectionPage") {
      throw new Error("Expected both applied native R rename inspection pages.");
    }
    if (inspectedInfo.kind !== "stepInspectionInfo") {
      throw new Error("Expected applied native R rename inspection metadata.");
    }
    expect(inspectedInput.page.schema.map((column) => column.name)).toEqual(["duplicate", "duplicate", "label"]);
    expect(inspectedOutput.page.schema.map((column) => column.name)).toEqual([
      "duplicate",
      "second duplicate",
      "label"
    ]);
    expect(inspectedInput.page.page.columnIds).toEqual(["r:c:1"]);
    expect(inspectedOutput.page.page.columnIds).toEqual(["r:c:1"]);
    expect(inspectedInfo.code).toContain("second duplicate");
    const edited = decodeRKernelResponseJson(marked(result.stdout, edit.marker), ids.edit, {
      inputSchema: opened.page.schema
    });
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

  it("round-trips native R Min-max scale through preview, apply, and generated code", () => {
    const editingSessionId = "18000000-0000-4000-8000-000000000001";
    const ids = {
      open: "18000000-0000-4000-8000-000000000002",
      preview: "18000000-0000-4000-8000-000000000003",
      apply: "18000000-0000-4000-8000-000000000004",
      close: "18000000-0000-4000-8000-000000000005"
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
          id: "scale-derived",
          kind: "minMaxScale",
          params: { column: { id: "r:c:0", name: "value" }, newColumn: "scaled" }
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
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });

    const result = runR(`
frame <- data.frame(value = bit64::as.integer64(c("9007199254740992", "9007199254740993", "9007199254740994", NA)), check.names = FALSE)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${preview.code}
${apply.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);
    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R Min-max scale session.");
    const previewed = decodeRKernelResponseJson(marked(result.stdout, preview.marker), ids.preview, {
      inputSchema: opened.page.schema
    });
    expect(previewed).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      diff: { addedColumns: ["scaled"], changedCells: 0, cells: [] }
    });
    if (previewed.kind !== "stepPreview") throw new Error("Expected a native R Min-max scale preview.");
    expect(previewed.page.schema.at(-1)).toMatchObject({
      id: "c:step:scale-derived:0",
      name: "scaled",
      rawType: "double",
      type: "float",
      nullable: true
    });
    expect(previewed.page.page.rows.map((row) => row.values.at(-1))).toMatchObject([
      { kind: "number", raw: "0", isNull: false },
      { kind: "number", raw: "0.5", isNull: false },
      { kind: "number", raw: "1", isNull: false },
      { kind: "null", isNull: true }
    ]);

    const applied = decodeRKernelResponseJson(marked(result.stdout, apply.marker), ids.apply);
    expect(applied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 2 });
    if (applied.kind !== "planUpdated") throw new Error("Expected an applied native R Min-max scale step.");
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), ids.close)).toMatchObject({
      kind: "closed",
      sessionId: editingSessionId
    });
    expect(applied.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);

    const generated = runR(`
frame <- data.frame(value = bit64::as.integer64(c("9007199254740992", "9007199254740993", "9007199254740994", NA)), check.names = FALSE)
frame_before <- serialize(frame, NULL, version = 3L)
${applied.code}
stopifnot(identical(open_wrangler_result$scaled, c(0, 0.5, 1, NA_real_)))
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
cat("generated-ok\\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");
  });

  it("round-trips scalar and right-column Formula steps through the real R transport", () => {
    const editingSessionId = "19000000-0000-4000-8000-000000000001";
    const ids = {
      open: "19000000-0000-4000-8000-000000000002",
      scalarPreview: "19000000-0000-4000-8000-000000000003",
      scalarApply: "19000000-0000-4000-8000-000000000004",
      columnPreview: "19000000-0000-4000-8000-000000000005",
      columnApply: "19000000-0000-4000-8000-000000000006",
      close: "19000000-0000-4000-8000-000000000007"
    } as const;
    const scalarStepId = "formula-scalar-cross";
    const columnStepId = "formula-column-cross";
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.open,
      kind: "openSession",
      payload: { sessionId: editingSessionId, variableName: "frame", page: pageWindow() }
    });
    const scalarPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.scalarPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 0,
        step: {
          id: scalarStepId,
          kind: "formula",
          params: {
            leftColumn: { id: "r:c:0", name: "left" },
            operator: "add",
            newColumn: "scalar result",
            value: 0.5
          }
        },
        page: pageWindow()
      }
    });
    const scalarApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.scalarApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 1, page: pageWindow() }
    });
    const columnPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.columnPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 2,
        step: {
          id: columnStepId,
          kind: "formula",
          params: {
            leftColumn: { id: "r:c:0", name: "left" },
            operator: "divide",
            newColumn: "column result",
            rightColumn: { id: "r:c:1", name: "right" }
          }
        },
        page: pageWindow()
      }
    });
    const columnApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.columnApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 3, page: pageWindow() }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });

    const result = runR(`
frame <- data.frame(
  left = c(8, -8, NA_real_, 2),
  right = c(2, 4, 5, NA_real_),
  label = c("first", "second", "missing left", "missing right"),
  row.names = paste0("formula-cross-", seq_len(4L)),
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${scalarPreview.code}
${scalarApply.code}
${columnPreview.code}
${columnApply.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R Formula session.");
    expect(opened.page.schema.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "r:c:0", name: "left" },
      { id: "r:c:1", name: "right" },
      { id: "r:c:2", name: "label" }
    ]);

    const scalarPreviewed = decodeRKernelResponseJson(marked(result.stdout, scalarPreview.marker), ids.scalarPreview, {
      inputSchema: opened.page.schema
    });
    expect(scalarPreviewed).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: ["scalar result"],
        removedColumns: [],
        changedCells: 0,
        cells: [],
        truncated: false
      }
    });
    if (scalarPreviewed.kind !== "stepPreview") throw new Error("Expected a scalar native R Formula preview.");
    expect(scalarPreviewed.page.schema.at(-1)).toMatchObject({
      id: `c:step:${scalarStepId}:0`,
      name: "scalar result",
      rawType: "double",
      type: "float",
      nullable: true
    });
    expect(scalarPreviewed.page.page.rows.map((row) => row.values.at(-1))).toMatchObject([
      { kind: "number", raw: "8.5", isNull: false },
      { kind: "number", raw: "-7.5", isNull: false },
      { kind: "null", raw: null, isNull: true },
      { kind: "number", raw: "2.5", isNull: false }
    ]);

    const scalarApplied = decodeRKernelResponseJson(marked(result.stdout, scalarApply.marker), ids.scalarApply);
    expect(scalarApplied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 2 });
    if (scalarApplied.kind !== "planUpdated") throw new Error("Expected an applied scalar native R Formula.");
    expect(scalarApplied.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);

    const columnPreviewed = decodeRKernelResponseJson(marked(result.stdout, columnPreview.marker), ids.columnPreview, {
      inputSchema: scalarApplied.page.schema
    });
    expect(columnPreviewed).toMatchObject({
      kind: "stepPreview",
      revision: 3,
      diff: {
        addedColumns: ["column result"],
        removedColumns: [],
        changedCells: 0,
        cells: [],
        truncated: false
      }
    });
    if (columnPreviewed.kind !== "stepPreview") {
      throw new Error("Expected a right-column native R Formula preview.");
    }
    expect(columnPreviewed.page.schema.at(-1)).toMatchObject({
      id: `c:step:${columnStepId}:0`,
      name: "column result",
      rawType: "double",
      type: "float",
      nullable: true
    });
    expect(columnPreviewed.page.page.rows.map((row) => row.values.at(-1))).toMatchObject([
      { kind: "number", raw: "4", isNull: false },
      { kind: "number", raw: "-2", isNull: false },
      { kind: "null", raw: null, isNull: true },
      { kind: "null", raw: null, isNull: true }
    ]);

    const columnApplied = decodeRKernelResponseJson(marked(result.stdout, columnApply.marker), ids.columnApply);
    expect(columnApplied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 4 });
    if (columnApplied.kind !== "planUpdated") throw new Error("Expected an applied right-column native R Formula.");
    expect(columnApplied.page.schema.map((column) => column.id)).toEqual([
      "r:c:0",
      "r:c:1",
      "r:c:2",
      `c:step:${scalarStepId}:0`,
      `c:step:${columnStepId}:0`
    ]);
    expect(columnApplied.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), ids.close)).toEqual({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closed",
      sessionId: editingSessionId
    });

    const generated = runR(`
frame <- data.frame(
  left = c(8, -8, NA_real_, 2),
  right = c(2, 4, 5, NA_real_),
  label = c("first", "second", "missing left", "missing right"),
  row.names = paste0("formula-cross-", seq_len(4L)),
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${columnApplied.code}
stopifnot(identical(open_wrangler_result$\`scalar result\`, c(8.5, -7.5, NA_real_, 2.5)))
stopifnot(identical(open_wrangler_result$\`column result\`, c(4, -2, NA_real_, NA_real_)))
stopifnot(identical(row.names(open_wrangler_result), row.names(frame)))
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
cat("generated-ok\\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");
  });

  it("round-trips appended Date and in-place POSIXct formatting through the real R transport", () => {
    const editingSessionId = "19100000-0000-4000-8000-000000000001";
    const ids = {
      open: "19100000-0000-4000-8000-000000000002",
      datePreview: "19100000-0000-4000-8000-000000000003",
      dateApply: "19100000-0000-4000-8000-000000000004",
      momentPreview: "19100000-0000-4000-8000-000000000005",
      momentApply: "19100000-0000-4000-8000-000000000006",
      close: "19100000-0000-4000-8000-000000000007"
    } as const;
    const dateStepId = "format-date-cross";
    const momentStepId = "format-moment-cross";
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.open,
      kind: "openSession",
      payload: { sessionId: editingSessionId, variableName: "frame", page: pageWindow() }
    });
    const datePreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.datePreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 0,
        step: {
          id: dateStepId,
          kind: "formatDatetime",
          params: {
            column: { id: "r:c:0", name: "day" },
            format: "%Y-%j",
            newColumn: "day of year"
          }
        },
        page: pageWindow()
      }
    });
    const dateApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.dateApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 1, page: pageWindow() }
    });
    const momentPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.momentPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 2,
        step: {
          id: momentStepId,
          kind: "formatDatetime",
          params: {
            column: { id: "r:c:1", name: "moment" },
            format: "%Y-%m-%d %H:%M %Z"
          }
        },
        page: pageWindow()
      }
    });
    const momentApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.momentApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 3, page: pageWindow() }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });

    const result = runR(`
frame <- data.frame(
  day = as.Date(c("2024-02-29", "2025-01-02", NA)),
  moment = as.POSIXct(c("2024-03-31 00:30:00", "2024-03-31 03:30:00", NA), tz = "Europe/Berlin"),
  label = c("leap", "ordinary", "missing"),
  row.names = c("datetime-cross-a", "datetime-cross-b", "datetime-cross-c"),
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${datePreview.code}
${dateApply.code}
${momentPreview.code}
${momentApply.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R Format Datetime session.");
    expect(opened.page.schema).toMatchObject([
      { id: "r:c:0", name: "day", rawType: "Date", type: "date" },
      { id: "r:c:1", name: "moment", rawType: "POSIXct", type: "datetime" },
      { id: "r:c:2", name: "label", rawType: "character", type: "string" }
    ]);

    const datePreviewed = decodeRKernelResponseJson(marked(result.stdout, datePreview.marker), ids.datePreview, {
      inputSchema: opened.page.schema
    });
    expect(datePreviewed).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      diff: {
        addedColumns: ["day of year"],
        removedColumns: [],
        changedCells: 0,
        cells: [],
        truncated: false
      }
    });
    if (datePreviewed.kind !== "stepPreview") throw new Error("Expected an appended native R Date preview.");
    expect(datePreviewed.page.schema.at(-1)).toMatchObject({
      id: `c:step:${dateStepId}:0`,
      name: "day of year",
      rawType: "character",
      type: "string",
      nullable: true
    });
    expect(datePreviewed.page.page.rows.map((row) => row.values.at(-1))).toMatchObject([
      { kind: "string", raw: "2024-060", isNull: false },
      { kind: "string", raw: "2025-002", isNull: false },
      { kind: "null", raw: null, isNull: true }
    ]);

    const dateApplied = decodeRKernelResponseJson(marked(result.stdout, dateApply.marker), ids.dateApply);
    expect(dateApplied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 2 });
    if (dateApplied.kind !== "planUpdated") throw new Error("Expected an applied native R Date format.");

    const momentPreviewed = decodeRKernelResponseJson(marked(result.stdout, momentPreview.marker), ids.momentPreview, {
      inputSchema: dateApplied.page.schema
    });
    expect(momentPreviewed).toMatchObject({
      kind: "stepPreview",
      revision: 3,
      diff: {
        addedColumns: [],
        removedColumns: [],
        changedCells: 2,
        truncated: false
      }
    });
    if (momentPreviewed.kind !== "stepPreview") {
      throw new Error("Expected an in-place native R POSIXct preview.");
    }
    expect(momentPreviewed.page.schema[1]).toMatchObject({
      id: "r:c:1",
      name: "moment",
      rawType: "character",
      type: "string",
      nullable: true
    });
    expect(momentPreviewed.page.page.rows.map((row) => row.values[1])).toMatchObject([
      { kind: "string", raw: "2024-03-31 00:30 CET", isNull: false },
      { kind: "string", raw: "2024-03-31 03:30 CEST", isNull: false },
      { kind: "null", raw: null, isNull: true }
    ]);
    expect(
      momentPreviewed.diff.cells.map(({ rowNumber, columnId, column }) => ({ rowNumber, columnId, column }))
    ).toEqual([
      { rowNumber: 0, columnId: "r:c:1", column: "moment" },
      { rowNumber: 1, columnId: "r:c:1", column: "moment" }
    ]);

    const momentApplied = decodeRKernelResponseJson(marked(result.stdout, momentApply.marker), ids.momentApply);
    expect(momentApplied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 4 });
    if (momentApplied.kind !== "planUpdated") throw new Error("Expected an applied native R POSIXct format.");
    expect(momentApplied.page.schema.map((column) => column.id)).toEqual([
      "r:c:0",
      "r:c:1",
      "r:c:2",
      `c:step:${dateStepId}:0`
    ]);
    expect(momentApplied.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), ids.close)).toEqual({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closed",
      sessionId: editingSessionId
    });

    const generated = runR(`
frame <- data.frame(
  day = as.Date(c("2024-02-29", "2025-01-02", NA)),
  moment = as.POSIXct(c("2024-03-31 00:30:00", "2024-03-31 03:30:00", NA), tz = "Europe/Berlin"),
  label = c("leap", "ordinary", "missing"),
  row.names = c("datetime-cross-a", "datetime-cross-b", "datetime-cross-c"),
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${momentApplied.code}
stopifnot(identical(open_wrangler_result$\`day of year\`, c("2024-060", "2025-002", NA_character_)))
stopifnot(identical(open_wrangler_result$moment, c("2024-03-31 00:30 CET", "2024-03-31 03:30 CEST", NA_character_)))
stopifnot(identical(row.names(open_wrangler_result), row.names(frame)))
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
cat("generated-ok\\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");

    const generatedUtc = runR(`
frame <- data.frame(
  day = as.Date(c("2024-02-29", "2025-01-02", NA)),
  moment = as.POSIXct(c("2024-03-31 00:30:00", "2024-03-31 03:30:00", NA), tz = "UTC"),
  label = c("leap", "ordinary", "missing"),
  row.names = c("datetime-cross-a", "datetime-cross-b", "datetime-cross-c"),
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${momentApplied.code}
stopifnot(identical(open_wrangler_result$moment, c("2024-03-31 00:30 UTC", "2024-03-31 03:30 UTC", NA_character_)))
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
cat("generated-utc-ok\\n")
`);
    expect(generatedUtc.stdout.trim()).toBe("generated-utc-ok");
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
    const inspect = inspectionRequestCodes(ids.inspect, {
      sessionId: editingSessionId,
      revision: 4,
      stepId: "drop-step",
      page: pageWindow()
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
${inspect.info.code}
${inspect.input.code}
${inspect.output.code}
${undoRename.code}
${undoDrop.code}
stopifnot(identical(frame, frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R Drop Columns session.");
    const dropped = decodeRKernelResponseJson(marked(result.stdout, dropPreview.marker), ids.dropPreview, {
      inputSchema: opened.page.schema
    });
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
    const inspectedInput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.input.marker),
      inspect.inputRequestId,
      { inputSchema: opened.page.schema, inspectionSide: "input" }
    );
    const inspectedOutput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.output.marker),
      inspect.outputRequestId,
      { outputSchema: dropped.page.schema, inspectionSide: "output" }
    );
    expect(inspectedInput).toMatchObject({
      kind: "stepInspectionPage",
      side: "input",
      stepId: "drop-step"
    });
    expect(inspectedOutput).toMatchObject({
      kind: "stepInspectionPage",
      side: "output",
      stepId: "drop-step"
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
    const inspect = inspectionRequestCodes(ids.inspect, {
      sessionId: editingSessionId,
      revision: 2,
      stepId: "select-step",
      page: pageWindow()
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
${inspect.info.code}
${inspect.input.code}
${inspect.output.code}
${renamePreview.code}
${renameApply.code}
${undoRename.code}
${undoSelect.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R Select Columns session.");
    const selected = decodeRKernelResponseJson(marked(result.stdout, selectPreview.marker), ids.selectPreview, {
      inputSchema: opened.page.schema
    });
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
    const inspectedInput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.input.marker),
      inspect.inputRequestId,
      { inputSchema: opened.page.schema, inspectionSide: "input" }
    );
    const inspectedOutput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.output.marker),
      inspect.outputRequestId,
      { outputSchema: selected.page.schema, inspectionSide: "output" }
    );
    expect(inspectedInput).toMatchObject({
      kind: "stepInspectionPage",
      side: "input",
      stepId: "select-step"
    });
    expect(inspectedOutput).toMatchObject({
      kind: "stepInspectionPage",
      side: "output",
      stepId: "select-step"
    });
    if (inspectedInput.kind !== "stepInspectionPage" || inspectedOutput.kind !== "stepInspectionPage") {
      throw new Error("Expected both applied R Select Columns inspection pages.");
    }
    expect(inspectedInput.page.schema.map((column) => column.id)).toEqual(["r:c:0", "r:c:1", "r:c:2", "r:c:3"]);
    expect(inspectedOutput.page.schema.map((column) => column.id)).toEqual(["r:c:2", "r:c:1", "r:c:0"]);

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
    const inspect = inspectionRequestCodes(ids.inspect, {
      sessionId: editingSessionId,
      revision: 4,
      stepId: cloneStepId,
      page: pageWindow()
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
${inspect.info.code}
${inspect.input.code}
${inspect.output.code}
${undoRename.code}
${undoClone.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R Clone Column session.");
    const cloned = decodeRKernelResponseJson(marked(result.stdout, clonePreview.marker), ids.clonePreview, {
      inputSchema: opened.page.schema
    });
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

    const renameDraft = decodeRKernelResponseJson(marked(result.stdout, renamePreview.marker), ids.renamePreview, {
      inputSchema: cloned.page.schema
    });
    expect(renameDraft).toMatchObject({ kind: "stepPreview", revision: 3 });

    const renamed = decodeRKernelResponseJson(marked(result.stdout, renameApply.marker), ids.renameApply);
    expect(renamed).toMatchObject({ kind: "planUpdated", action: "apply", revision: 4 });
    if (renamed.kind !== "planUpdated") throw new Error("Expected the applied R Clone then Rename plan.");
    expect(renamed.page.schema.at(-1)).toMatchObject({ id: cloneColumnId, name: "renamed copy" });
    expect(renamed.page.frameSemantics.keyColumnIds).toEqual(["r:c:0"]);

    const inspectedInput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.input.marker),
      inspect.inputRequestId,
      { inputSchema: opened.page.schema, inspectionSide: "input" }
    );
    const inspectedOutput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.output.marker),
      inspect.outputRequestId,
      { outputSchema: cloned.page.schema, inspectionSide: "output" }
    );
    expect(inspectedInput).toMatchObject({
      kind: "stepInspectionPage",
      side: "input",
      stepId: cloneStepId
    });
    expect(inspectedOutput).toMatchObject({
      kind: "stepInspectionPage",
      side: "output",
      stepId: cloneStepId
    });
    if (inspectedInput.kind !== "stepInspectionPage" || inspectedOutput.kind !== "stepInspectionPage") {
      throw new Error("Expected both applied R Clone Column inspection pages.");
    }
    expect(inspectedInput.page.schema.map((column) => column.id)).toEqual(["r:c:0", "r:c:1", "r:c:2"]);
    expect(inspectedOutput.page.schema.at(-1)).toMatchObject({ id: cloneColumnId, name: "copied value" });

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
    const inspect = inspectionRequestCodes(ids.inspect, {
      sessionId: editingSessionId,
      revision: 2,
      stepId,
      page: pageWindow()
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
${inspect.info.code}
${inspect.input.code}
${inspect.output.code}
${undo.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R Text Length session.");
    const previewed = decodeRKernelResponseJson(marked(result.stdout, preview.marker), ids.preview, {
      inputSchema: opened.page.schema
    });
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

    const inspectedInput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.input.marker),
      inspect.inputRequestId,
      { inputSchema: opened.page.schema, inspectionSide: "input" }
    );
    const inspectedOutput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.output.marker),
      inspect.outputRequestId,
      { outputSchema: applied.page.schema, inspectionSide: "output" }
    );
    expect(inspectedInput).toMatchObject({
      kind: "stepInspectionPage",
      side: "input",
      revision: 2,
      stepId,
      stepIndex: 0
    });
    expect(inspectedOutput).toMatchObject({
      kind: "stepInspectionPage",
      side: "output",
      revision: 2,
      stepId,
      stepIndex: 0
    });
    if (inspectedInput.kind !== "stepInspectionPage" || inspectedOutput.kind !== "stepInspectionPage") {
      throw new Error("Expected both applied R Text Length inspection pages.");
    }
    expect(inspectedInput.page.schema.map((column) => column.id)).toEqual(["r:c:0"]);
    expect(inspectedOutput.page.schema.map((column) => column.id)).toEqual(["r:c:0", outputId]);
    expect(inspectedOutput.page.page.rows.map((row) => row.values[1])).toEqual(
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

  it("runs native R lowercase in place through the TypeScript transport lifecycle", () => {
    const editingSessionId = "51000000-0000-4000-8000-000000000001";
    const stepId = "lowercase-factor";
    const ids = {
      open: "51000000-0000-4000-8000-000000000002",
      preview: "51000000-0000-4000-8000-000000000003",
      apply: "51000000-0000-4000-8000-000000000004",
      inspect: "51000000-0000-4000-8000-000000000005",
      undo: "51000000-0000-4000-8000-000000000006",
      close: "51000000-0000-4000-8000-000000000007"
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
          kind: "lowerText",
          params: { column: { id: "r:c:0", name: "label" } }
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
    const inspect = inspectionRequestCodes(ids.inspect, {
      sessionId: editingSessionId,
      revision: 2,
      stepId,
      page: pageWindow()
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
  label = factor(c("ALPHA", "MiXeD", NA_character_)),
  stringsAsFactors = TRUE,
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${preview.code}
${apply.code}
${inspect.info.code}
${inspect.input.code}
${inspect.output.code}
${undo.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R lowercase session.");
    const previewed = decodeRKernelResponseJson(marked(result.stdout, preview.marker), ids.preview, {
      inputSchema: opened.page.schema
    });
    expect(previewed).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      page: {
        schema: [expect.objectContaining({ id: "r:c:0", name: "label", rawType: "character", type: "string" })]
      },
      diff: {
        addedColumns: [],
        removedColumns: [],
        changedCells: 2,
        truncated: false
      }
    });
    if (previewed.kind !== "stepPreview") throw new Error("Expected a native R lowercase preview.");
    expect(previewed.page.page.rows.map((row) => row.values[0])).toMatchObject([
      { kind: "string", raw: "alpha", display: "alpha" },
      { kind: "string", raw: "mixed", display: "mixed" },
      { kind: "null", raw: null, display: "NA", isNull: true }
    ]);
    expect(previewed.diff.cells.map(({ rowNumber, columnId, column }) => ({ rowNumber, columnId, column }))).toEqual([
      { rowNumber: 0, columnId: "r:c:0", column: "label" },
      { rowNumber: 1, columnId: "r:c:0", column: "label" }
    ]);

    const applied = decodeRKernelResponseJson(marked(result.stdout, apply.marker), ids.apply);
    expect(applied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 2 });
    if (applied.kind !== "planUpdated") throw new Error("Expected an applied native R lowercase step.");
    expect(applied.page.schema[0]).toMatchObject({ id: "r:c:0", rawType: "character", type: "string" });

    const inspectedInput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.input.marker),
      inspect.inputRequestId,
      { inputSchema: opened.page.schema, inspectionSide: "input" }
    );
    const inspectedOutput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.output.marker),
      inspect.outputRequestId,
      { outputSchema: applied.page.schema, inspectionSide: "output" }
    );
    expect(inspectedInput).toMatchObject({
      kind: "stepInspectionPage",
      side: "input",
      stepId,
      stepIndex: 0
    });
    expect(inspectedOutput).toMatchObject({
      kind: "stepInspectionPage",
      side: "output",
      stepId,
      stepIndex: 0
    });
    if (inspectedInput.kind !== "stepInspectionPage" || inspectedOutput.kind !== "stepInspectionPage") {
      throw new Error("Expected both applied R lowercase inspection pages.");
    }
    expect(inspectedInput.page.schema[0]).toMatchObject({ id: "r:c:0", rawType: "factor", type: "string" });
    expect(inspectedOutput.page.schema[0]).toMatchObject({ id: "r:c:0", rawType: "character", type: "string" });

    const undone = decodeRKernelResponseJson(marked(result.stdout, undo.marker), ids.undo);
    expect(undone).toMatchObject({ kind: "planUpdated", action: "undo", revision: 3, code: "" });
    if (undone.kind !== "planUpdated") throw new Error("Expected the R lowercase undo.");
    expect(undone.page.schema[0]).toMatchObject({ id: "r:c:0", rawType: "factor", type: "string" });
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), ids.close)).toMatchObject({
      kind: "closed",
      sessionId: editingSessionId
    });
    expect(applied.code).toContain("tolower");
    expect(applied.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);
  });

  it("chains native R uppercase with literal, regex, and blank replacements", () => {
    const editingSessionId = "51100000-0000-4000-8000-000000000001";
    const ids = {
      open: "51100000-0000-4000-8000-000000000002",
      upperPreview: "51100000-0000-4000-8000-000000000003",
      upperApply: "51100000-0000-4000-8000-000000000004",
      literalPreview: "51100000-0000-4000-8000-000000000005",
      literalApply: "51100000-0000-4000-8000-000000000006",
      regexPreview: "51100000-0000-4000-8000-000000000007",
      regexApply: "51100000-0000-4000-8000-000000000008",
      blankPreview: "51100000-0000-4000-8000-000000000009",
      close: "51100000-0000-4000-8000-00000000000a"
    } as const;
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.open,
      kind: "openSession",
      payload: { sessionId: editingSessionId, variableName: "frame", page: pageWindow() }
    });
    const upperPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.upperPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 0,
        step: {
          id: "uppercase-derived",
          kind: "upperText",
          params: { column: { id: "r:c:0", name: "label" }, newColumn: "upper" }
        },
        page: pageWindow()
      }
    });
    const upperApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.upperApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 1, page: pageWindow() }
    });
    const literalPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.literalPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 2,
        step: {
          id: "replace-literal-derived",
          kind: "findReplace",
          params: {
            column: { id: "r:c:0", name: "label" },
            find: ".",
            replacement: "!",
            regex: false,
            newColumn: "literal"
          }
        },
        page: pageWindow()
      }
    });
    const literalApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.literalApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 3, page: pageWindow() }
    });
    const regexPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.regexPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 4,
        step: {
          id: "replace-regex-derived",
          kind: "findReplace",
          params: {
            column: { id: "r:c:0", name: "label" },
            find: "[[:digit:]]+",
            replacement: "#",
            regex: true,
            newColumn: "regex"
          }
        },
        page: pageWindow()
      }
    });
    const regexApply = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.regexApply,
      kind: "applyDraft",
      payload: { sessionId: editingSessionId, revision: 5, page: pageWindow() }
    });
    const blankPreview = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.blankPreview,
      kind: "previewStep",
      payload: {
        sessionId: editingSessionId,
        revision: 6,
        step: {
          id: "replace-blank-in-place",
          kind: "findReplace",
          params: { column: { id: "r:c:0", name: "label" }, find: "", replacement: "_" }
        },
        page: pageWindow()
      }
    });
    const close = requestCode({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: ids.close,
      kind: "closeSession",
      payload: { sessionId: editingSessionId }
    });
    const result = runR(`
frame <- data.frame(
  label = factor(c("a.b 42", "naive2", NA_character_)),
  stringsAsFactors = TRUE,
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${upperPreview.code}
${upperApply.code}
${literalPreview.code}
${literalApply.code}
${regexPreview.code}
${regexApply.code}
${blankPreview.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R text-cleaning session.");
    const upperPreviewed = decodeRKernelResponseJson(marked(result.stdout, upperPreview.marker), ids.upperPreview, {
      inputSchema: opened.page.schema
    });
    expect(upperPreviewed).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      page: {
        schema: [
          expect.objectContaining({ id: "r:c:0", rawType: "factor" }),
          expect.objectContaining({ id: "c:step:uppercase-derived:0", name: "upper", rawType: "character" })
        ]
      },
      diff: { addedColumns: ["upper"], changedCells: 0 }
    });
    const upperApplied = decodeRKernelResponseJson(marked(result.stdout, upperApply.marker), ids.upperApply);
    if (upperApplied.kind !== "planUpdated") throw new Error("Expected the native R uppercase apply.");

    const literalPreviewed = decodeRKernelResponseJson(
      marked(result.stdout, literalPreview.marker),
      ids.literalPreview,
      { inputSchema: upperApplied.page.schema }
    );
    expect(literalPreviewed).toMatchObject({
      kind: "stepPreview",
      revision: 3,
      page: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "c:step:replace-literal-derived:0", name: "literal" })
        ])
      },
      diff: { addedColumns: ["literal"], changedCells: 0 }
    });
    const literalApplied = decodeRKernelResponseJson(marked(result.stdout, literalApply.marker), ids.literalApply);
    if (literalApplied.kind !== "planUpdated") throw new Error("Expected the literal replacement apply.");

    const regexPreviewed = decodeRKernelResponseJson(marked(result.stdout, regexPreview.marker), ids.regexPreview, {
      inputSchema: literalApplied.page.schema
    });
    expect(regexPreviewed).toMatchObject({
      kind: "stepPreview",
      revision: 5,
      page: {
        schema: expect.arrayContaining([
          expect.objectContaining({ id: "c:step:replace-regex-derived:0", name: "regex" })
        ])
      },
      diff: { addedColumns: ["regex"], changedCells: 0 }
    });
    const regexApplied = decodeRKernelResponseJson(marked(result.stdout, regexApply.marker), ids.regexApply);
    if (regexApplied.kind !== "planUpdated") throw new Error("Expected the regex replacement apply.");

    const blankPreviewed = decodeRKernelResponseJson(marked(result.stdout, blankPreview.marker), ids.blankPreview, {
      inputSchema: regexApplied.page.schema
    });
    expect(blankPreviewed).toMatchObject({
      kind: "stepPreview",
      revision: 7,
      page: {
        schema: [
          expect.objectContaining({ id: "r:c:0", name: "label", rawType: "character", type: "string" }),
          expect.objectContaining({ name: "upper" }),
          expect.objectContaining({ name: "literal" }),
          expect.objectContaining({ name: "regex" })
        ]
      },
      diff: { addedColumns: [], changedCells: 2, truncated: false }
    });
    if (blankPreviewed.kind !== "stepPreview") throw new Error("Expected the blank replacement preview.");
    expect(blankPreviewed.page.page.rows.map((row) => row.values[0])).toMatchObject([
      { kind: "string", raw: "_a_._b_ _4_2_", display: "_a_._b_ _4_2_" },
      { kind: "string", raw: "_n_a_i_v_e_2_", display: "_n_a_i_v_e_2_" },
      { kind: "null", raw: null, display: "NA", isNull: true }
    ]);
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), ids.close)).toMatchObject({
      kind: "closed",
      sessionId: editingSessionId
    });
    expect(blankPreviewed.code).toContain("toupper");
    expect(blankPreviewed.code).toContain("gsub");
    expect(blankPreviewed.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);

    const generated = runR(`
frame <- data.frame(
  label = factor(c("a.b 42", "naive2", NA_character_)),
  stringsAsFactors = TRUE,
  check.names = FALSE
)
frame_before <- serialize(frame, NULL, version = 3L)
${blankPreviewed.code}
stopifnot(identical(names(open_wrangler_result), c("label", "upper", "literal", "regex")))
stopifnot(identical(open_wrangler_result$label, c("_a_._b_ _4_2_", "_n_a_i_v_e_2_", NA_character_)))
stopifnot(identical(open_wrangler_result$literal, c("a!b 42", "naive2", NA_character_)))
stopifnot(identical(open_wrangler_result$regex, c("a.b #", "naive#", NA_character_)))
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
cat("generated-ok\\n")
`);
    expect(generated.stdout.trim()).toBe("generated-ok");
  });

  it("runs native R type conversion through preview, history, undo, and generated code", () => {
    const editingSessionId = "52000000-0000-4000-8000-000000000001";
    const stepId = "cast-text-to-integer";
    const ids = {
      open: "52000000-0000-4000-8000-000000000002",
      preview: "52000000-0000-4000-8000-000000000003",
      apply: "52000000-0000-4000-8000-000000000004",
      inspect: "52000000-0000-4000-8000-000000000005",
      undo: "52000000-0000-4000-8000-000000000006",
      close: "52000000-0000-4000-8000-000000000007"
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
          kind: "castColumn",
          params: { column: { id: "r:c:0", name: "amount" }, dtype: "integer" }
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
    const inspect = inspectionRequestCodes(ids.inspect, {
      sessionId: editingSessionId,
      revision: 2,
      stepId,
      page: pageWindow()
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
frame <- data.frame(amount = c("42.9", "bad", NA_character_), check.names = FALSE)
frame_before <- serialize(frame, NULL, version = 3L)
${bootstrap}
${open.code}
${preview.code}
${apply.code}
${inspect.info.code}
${inspect.input.code}
${inspect.output.code}
${undo.code}
stopifnot(identical(serialize(frame, NULL, version = 3L), frame_before))
${close.code}
`);

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), ids.open, {
      expectExportFormats: true
    });
    if (opened.kind !== "page") throw new Error("Expected an opened native R type-conversion session.");
    const previewed = decodeRKernelResponseJson(marked(result.stdout, preview.marker), ids.preview, {
      inputSchema: opened.page.schema
    });
    expect(previewed).toMatchObject({
      kind: "stepPreview",
      revision: 1,
      page: {
        schema: [
          expect.objectContaining({ id: "r:c:0", name: "amount", rawType: "integer", type: "integer", nullable: true })
        ]
      },
      diff: { addedColumns: [], removedColumns: [], changedCells: 2, truncated: false }
    });
    if (previewed.kind !== "stepPreview") throw new Error("Expected a native R type-conversion preview.");
    expect(previewed.page.page.rows.map((row) => row.values[0])).toMatchObject([
      { kind: "integer", raw: "42", display: "42" },
      { kind: "null", raw: null, display: "NA", isNull: true },
      { kind: "null", raw: null, display: "NA", isNull: true }
    ]);
    expect(previewed.diff.cells.map(({ rowNumber, columnId, column }) => ({ rowNumber, columnId, column }))).toEqual([
      { rowNumber: 0, columnId: "r:c:0", column: "amount" },
      { rowNumber: 1, columnId: "r:c:0", column: "amount" }
    ]);

    const applied = decodeRKernelResponseJson(marked(result.stdout, apply.marker), ids.apply);
    expect(applied).toMatchObject({ kind: "planUpdated", action: "apply", revision: 2 });
    if (applied.kind !== "planUpdated") throw new Error("Expected an applied native R type conversion.");
    expect(applied.page.schema[0]).toMatchObject({ id: "r:c:0", rawType: "integer", type: "integer" });

    const inspectedInput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.input.marker),
      inspect.inputRequestId,
      { inputSchema: opened.page.schema, inspectionSide: "input" }
    );
    const inspectedOutput = decodeRKernelResponseJson(
      marked(result.stdout, inspect.output.marker),
      inspect.outputRequestId,
      { outputSchema: applied.page.schema, inspectionSide: "output" }
    );
    expect(inspectedInput).toMatchObject({
      kind: "stepInspectionPage",
      side: "input",
      stepId,
      stepIndex: 0,
      page: { schema: [expect.objectContaining({ id: "r:c:0", rawType: "character", type: "string" })] }
    });
    expect(inspectedOutput).toMatchObject({
      kind: "stepInspectionPage",
      side: "output",
      stepId,
      stepIndex: 0,
      page: { schema: [expect.objectContaining({ id: "r:c:0", rawType: "integer", type: "integer" })] }
    });

    const undone = decodeRKernelResponseJson(marked(result.stdout, undo.marker), ids.undo);
    expect(undone).toMatchObject({ kind: "planUpdated", action: "undo", revision: 3, code: "" });
    if (undone.kind !== "planUpdated") throw new Error("Expected the native R type-conversion undo.");
    expect(undone.page.schema[0]).toMatchObject({ id: "r:c:0", rawType: "character", type: "string" });
    expect(decodeRKernelResponseJson(marked(result.stdout, close.marker), ids.close)).toMatchObject({
      kind: "closed",
      sessionId: editingSessionId
    });

    expect(applied.code).not.toMatch(/\b(?:pandas|polars|python)\b/iu);
    const generated = runR(`
frame <- data.frame(amount = c("42.9", "bad", NA_character_), check.names = FALSE)
frame_before <- serialize(frame, NULL, version = 3L)
${applied.code}
stopifnot(identical(open_wrangler_result[[1L]], c(42L, NA_integer_, NA_integer_)))
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

function inspectionRequestCodes(
  requestId: string,
  payload: Omit<Extract<RKernelRequest, { kind: "inspectStepPage" }>["payload"], "side">
) {
  const inputRequestId = `${requestId.slice(0, -1)}e`;
  const outputRequestId = `${requestId.slice(0, -1)}f`;
  const info = requestCode({
    transportVersion: R_KERNEL_TRANSPORT_VERSION,
    requestId,
    kind: "inspectStepInfo",
    payload: { sessionId: payload.sessionId, revision: payload.revision, stepId: payload.stepId }
  });
  const input = requestCode({
    transportVersion: R_KERNEL_TRANSPORT_VERSION,
    requestId: inputRequestId,
    kind: "inspectStepPage",
    payload: { ...payload, side: "input" }
  });
  const output = requestCode({
    transportVersion: R_KERNEL_TRANSPORT_VERSION,
    requestId: outputRequestId,
    kind: "inspectStepPage",
    payload: { ...payload, side: "output" }
  });
  return { info, input, output, infoRequestId: requestId, inputRequestId, outputRequestId } as const;
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
