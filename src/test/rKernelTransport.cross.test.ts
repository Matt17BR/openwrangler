import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeRKernelResponseJson, encodeRKernelRequest, type RKernelRequest } from "../extension/r/rKernelProtocol";
import {
  buildRKernelBootstrapCode,
  buildRKernelDispatchCode,
  readRRuntimeFiles
} from "../extension/r/rKernelRuntimeBundle";

const enabled = process.env.OPEN_WRANGLER_R_CONTRACT_TESTS === "1";
const root = resolve(__dirname, "../..");
const rscript = process.env.RSCRIPT ?? "Rscript";
const sessionId = "11111111-1111-4111-8111-111111111111";
const openRequestId = "22222222-2222-4222-8222-222222222222";
const pageRequestId = "33333333-3333-4333-8333-333333333333";
const closeRequestId = "44444444-4444-4444-8444-444444444444";
const unsupportedSessionId = "55555555-5555-4555-8555-555555555555";
const unsupportedRequestId = "66666666-6666-4666-8666-666666666666";

describe.skipIf(!enabled)("R kernel bootstrap to TypeScript transport", () => {
  it("opens one isolated capture, pages it after variable replacement, and closes it", () => {
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
    const unsupported = requestCode({
      transportVersion: 1,
      requestId: unsupportedRequestId,
      kind: "openSession",
      payload: { sessionId: unsupportedSessionId, variableName: "named_rows", page: pageWindow() }
    });
    const code = `
frame <- data.frame(value = c(1L, 3L, 2L), label = c("a", "c", "b"), stringsAsFactors = FALSE)
named_rows <- data.frame(value = 1L, row.names = "named-row")
${bootstrap}
${open.code}
frame <- data.frame(value = 999L, label = "replacement", stringsAsFactors = FALSE)
${page.code}
${close.code}
${unsupported.code}
`;
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

    const opened = decodeRKernelResponseJson(marked(result.stdout, open.marker), openRequestId);
    const paged = decodeRKernelResponseJson(marked(result.stdout, page.marker), pageRequestId);
    const closed = decodeRKernelResponseJson(marked(result.stdout, close.marker), closeRequestId);
    const unsupportedFrame = decodeRKernelResponseJson(marked(result.stdout, unsupported.marker), unsupportedRequestId);
    expect(opened).toMatchObject({ kind: "page", sessionId, page: { shape: { rows: 3, columns: 2 } } });
    expect(paged).toMatchObject({ kind: "page", sessionId, page: { shape: { rows: 3, columns: 2 } } });
    if (paged.kind !== "page") throw new Error("Expected a page response.");
    expect(paged.page.page.rows.map((row) => row.rowNumber)).toEqual([1, 2, 0]);
    expect(closed).toEqual({
      transportVersion: 1,
      requestId: closeRequestId,
      kind: "closed",
      sessionId
    });
    expect(unsupportedFrame).toMatchObject({
      kind: "error",
      code: "unsupported_frame",
      recoverable: false,
      message: "explicit row names are not yet supported"
    });
  });
});

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
