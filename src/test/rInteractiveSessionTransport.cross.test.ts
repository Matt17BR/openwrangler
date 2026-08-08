import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import type { RKernelPageWindow } from "../extension/r/rKernelProtocol";
import { RInteractiveSessionTransport } from "../extension/r/rInteractiveSessionTransport";

const enabled = process.env.OPEN_WRANGLER_R_CONTRACT_TESTS === "1";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rExecutable = process.env.R ?? "/usr/bin/R";

describe.skipIf(!enabled)("official R extension interactive transport", () => {
  it("discovers and opens a real readr tibble from one persistent R session", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-test-"));
    const interactive = startInteractiveR();
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (code) => writeR(interactive, code)
    });
    try {
      await writeR(
        interactive,
        `orders <- readr::read_csv(I("id,label\n1, ALPHA \n2,BETA\n3,NA"), na = "NA", show_col_types = FALSE); grouped_orders <- dplyr::group_by(orders, id)`
      );
      const discovery = await transport.discoverVariables({ timeoutMs: 10_000 });
      expect(discovery).toEqual({
        variables: [{ name: "orders", backend: "r", dataframeFlavor: "r.tibble" }],
        truncated: false
      });

      const sessionId = randomUUID();
      const opened = await transport.open("orders", pageWindow(), { requestedSessionId: sessionId, timeoutMs: 10_000 });
      expect(opened.page).toMatchObject({
        dataframeFlavor: "r.tibble",
        shape: { rows: 3, columns: 2 },
        schema: [
          { id: "r:c:0", name: "id", type: "float" },
          { id: "r:c:1", name: "label", type: "string" }
        ]
      });
      expect(opened.page.page.rows.map((row) => row.values[1]?.raw)).toEqual(["ALPHA", "BETA", null]);

      const preview = await transport.previewStep(
        sessionId,
        0,
        {
          id: "lower-label",
          kind: "lowerText",
          params: { column: { id: "r:c:1", name: "label" } }
        },
        pageWindow(),
        opened.page.schema,
        undefined,
        { timeoutMs: 10_000 }
      );
      expect(preview.page.page.rows.map((row) => row.values[1]?.raw)).toEqual(["alpha", "beta", null]);
      await transport.discardDraft(sessionId, preview.revision, pageWindow(), { timeoutMs: 10_000 });

      await writeR(
        interactive,
        `source_untouched <- data.frame(ok = identical(class(orders), c("spec_tbl_df", "tbl_df", "tbl", "data.frame")) && !is.null(attr(orders, "spec")))`
      );
      const sourceCheckId = randomUUID();
      const sourceCheck = await transport.open("source_untouched", pageWindow(), {
        requestedSessionId: sourceCheckId,
        timeoutMs: 10_000
      });
      expect(sourceCheck.page.page.rows[0]?.values[0]?.raw).toBe(true);
      await transport.close(sourceCheckId, { timeoutMs: 10_000 });
      await transport.close(sessionId, { timeoutMs: 10_000 });
    } finally {
      await transport.dispose();
      await stopInteractiveR(interactive);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("returns a direct dependency diagnostic when jsonlite is unavailable", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-no-jsonlite-test-"));
    const interactive = startInteractiveR();
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (code) => writeR(interactive, code)
    });
    try {
      await writeR(interactive, ".libPaths(tempdir())");
      const startedAt = Date.now();
      await expect(transport.discoverVariables({ timeoutMs: 5_000 })).rejects.toThrow(
        "Install it with install.packages('jsonlite')"
      );
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await transport.dispose();
      await stopInteractiveR(interactive);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 15_000);

  it("truncates long variable discovery before the host response limit", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-discovery-budget-test-"));
    const interactive = startInteractiveR();
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (code) => writeR(interactive, code)
    });
    try {
      await writeR(
        interactive,
        'for (index in seq_len(256L)) assign(paste0("frame_", sprintf("%03d", index), "_", paste(rep("x", 900L), collapse = "")), data.frame(value = index), envir = .GlobalEnv)'
      );
      const discovery = await transport.discoverVariables({ timeoutMs: 10_000 });
      expect(discovery.truncated).toBe(true);
      expect(discovery.variables.length).toBeGreaterThan(0);
      expect(discovery.variables.length).toBeLessThan(256);
    } finally {
      await transport.dispose();
      await stopInteractiveR(interactive);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("publishes a correlated failure when the private dispatcher is replaced", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-dispatcher-failure-test-"));
    const interactive = startInteractiveR();
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      runSelection: async (code) => writeR(interactive, code),
      disposalSettlementMs: 2_000
    });
    let disposed = false;
    try {
      await expect(transport.discoverVariables({ timeoutMs: 5_000 })).resolves.toMatchObject({ truncated: false });
      await writeR(
        interactive,
        'ow_binding <- ls(envir = .GlobalEnv, all.names = TRUE, pattern = "^\\\\.openwrangler_r_request_[a-f0-9]{16}$"); stopifnot(length(ow_binding) == 1L); assign(ow_binding, function(...) stop("replaced dispatcher"), envir = .GlobalEnv)'
      );
      const startedAt = Date.now();
      await expect(transport.discoverVariables({ timeoutMs: 5_000 })).rejects.toThrow(
        "interactive R dispatcher is unavailable"
      );
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await expect(transport.dispose()).rejects.toThrow("interactive R dispatcher is unavailable");
      disposed = true;
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      if (!disposed) await transport.dispose().catch(() => undefined);
      await stopInteractiveR(interactive);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 20_000);
});

function pageWindow(): RKernelPageWindow {
  return {
    rowOffset: 0,
    rowLimit: 20,
    columnOffset: 0,
    columnLimit: 20,
    view: { filters: [], sorts: [] }
  };
}

function startInteractiveR(): ChildProcessWithoutNullStreams {
  const child = spawn(rExecutable, ["--vanilla", "--slave"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  return child;
}

async function writeR(child: ChildProcessWithoutNullStreams, code: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(`${code}\n`, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

async function stopInteractiveR(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolveClose) => child.once("exit", () => resolveClose()));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  timer.unref();
  await closed;
  clearTimeout(timer);
}
