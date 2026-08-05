import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeRKernelResponseJson, encodeRKernelRequest, type RKernelRequest } from "../extension/r/rKernelProtocol";
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

describe.skipIf(!enabled)("R kernel bootstrap to TypeScript transport", () => {
  it("pages current same-schema values, rejects structural changes, and closes the live session", () => {
    const bootstrap = buildRKernelBootstrapCode(readRRuntimeFiles(resolve(root, "r")));
    const open = requestCode({
      transportVersion: 1,
      requestId: openRequestId,
      kind: "openSession",
      payload: { sessionId, variableName: "frame", page: pageWindow() }
    });
    const page = requestCode({
      transportVersion: 1,
      requestId: pageRequestId,
      kind: "getPage",
      payload: {
        sessionId,
        page: pageWindow([{ column: { id: "r:c:0", name: "value" }, direction: "desc", nulls: "last" }])
      }
    });
    const close = requestCode({
      transportVersion: 1,
      requestId: closeRequestId,
      kind: "closeSession",
      payload: { sessionId }
    });
    const summary = requestCode({
      transportVersion: 1,
      requestId: summaryRequestId,
      kind: "getSummary",
      payload: { sessionId, columns: [{ id: "r:c:0", name: "value" }] }
    });
    const stats = requestCode({
      transportVersion: 1,
      requestId: statsRequestId,
      kind: "getDatasetStats",
      payload: { sessionId }
    });
    const sourceChanged = requestCode({
      transportVersion: 1,
      requestId: sourceChangedRequestId,
      kind: "getPage",
      payload: { sessionId, page: pageWindow() }
    });
    const namedRows = requestCode({
      transportVersion: 1,
      requestId: namedRowsRequestId,
      kind: "openSession",
      payload: { sessionId: namedRowsSessionId, variableName: "named_rows", page: pageWindow() }
    });
    const code = `
frame <- data.frame(value = c(1L, 3L, 2L), label = c("a", "c", "b"), stringsAsFactors = FALSE)
named_rows <- data.frame(value = 1L, row.names = "named-row")
${bootstrap}
${open.code}
frame <- data.frame(value = c(9L, 7L, 8L), label = c("i", "g", "h"), stringsAsFactors = FALSE)
${page.code}
${summary.code}
${stats.code}
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
    const changed = decodeRKernelResponseJson(marked(result.stdout, sourceChanged.marker), sourceChangedRequestId);
    const closed = decodeRKernelResponseJson(marked(result.stdout, close.marker), closeRequestId);
    const namedRowsPage = decodeRKernelResponseJson(marked(result.stdout, namedRows.marker), namedRowsRequestId);
    expect(opened).toMatchObject({ kind: "page", sessionId, page: { shape: { rows: 3, columns: 2 } } });
    expect(paged).toMatchObject({ kind: "page", sessionId, page: { shape: { rows: 3, columns: 2 } } });
    if (paged.kind !== "page") throw new Error("Expected a page response.");
    expect(paged.page.page.rows.map((row) => row.rowNumber)).toEqual([0, 1, 2]);
    expect(paged.page.page.rows.map((row) => row.id)).toEqual(["r:r:0", "r:r:2", "r:r:1"]);
    expect(paged.page.page.rows.map((row) => row.values[0]?.raw)).toEqual(["9", "8", "7"]);
    if (profiled.kind === "error") throw new Error(`R profile failed: ${profiled.code}: ${profiled.message}`);
    expect(profiled).toMatchObject({
      kind: "summary",
      sessionId,
      summaries: [{ columnId: "r:c:0", numeric: { min: 7, max: 9 }, totalCount: 3 }]
    });
    expect(datasetStats).toMatchObject({
      kind: "datasetStats",
      sessionId,
      stats: { missingCells: 0, missingRows: 0, duplicateRows: 0 }
    });
    expect(changed).toMatchObject({
      kind: "error",
      code: "runtime_error",
      recoverable: true,
      message: expect.stringContaining("changed shape or schema")
    });
    expect(closed).toEqual({
      transportVersion: 1,
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
      transportVersion: 1,
      requestId: typedOpenId,
      kind: "openSession",
      payload: { sessionId: typedSessionId, variableName: "typed", page: pageWindow() }
    });
    const names = ["amount", "flag", "text", "category", "date", "when", "elapsed", "wide"];
    const summary = requestCode({
      transportVersion: 1,
      requestId: typedSummaryId,
      kind: "getSummary",
      payload: {
        sessionId: typedSessionId,
        columns: names.map((name, index) => ({ id: `r:c:${index}`, name }))
      }
    });
    const stats = requestCode({
      transportVersion: 1,
      requestId: typedStatsId,
      kind: "getDatasetStats",
      payload: { sessionId: typedSessionId }
    });
    const close = requestCode({
      transportVersion: 1,
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
  if (result.error) throw result.error;
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
  return { rowOffset: 0, rowLimit: 100, columnOffset: 0, columnLimit: 100, sorts } as const;
}

type RKernelSort = {
  readonly column: Readonly<{ id: string; name: string }>;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
};
