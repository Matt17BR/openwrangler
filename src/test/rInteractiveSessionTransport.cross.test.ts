import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import type { RKernelPageWindow } from "../extension/r/rKernelProtocol";
import { RInteractiveSessionTransport } from "../extension/r/rInteractiveSessionTransport";

const enabled = process.env.OPEN_WRANGLER_R_CONTRACT_TESTS === "1";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rExecutable = process.env.R ?? "/usr/bin/R";

describe.skipIf(!enabled)("official R extension interactive transport", () => {
  it("publishes one workspace scan to two transports without echoing Open Wrangler requests", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-change-test-"));
    const interactive = startInteractiveR();
    const first = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      testProcessId: interactive.pid!,
      runSelection: async (code) => writeR(interactive, code)
    });
    const second = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      testProcessId: interactive.pid!,
      runSelection: async (code) => writeR(interactive, code)
    });
    const firstDiscoveries: string[][] = [];
    const secondDiscoveries: string[][] = [];
    const firstSubscription = first.onDidChangeVariables((value) => {
      firstDiscoveries.push(value.variables.map((variable) => variable.name));
    });
    const secondSubscription = second.onDidChangeVariables((value) => {
      secondDiscoveries.push(value.variables.map((variable) => variable.name));
    });
    try {
      await first.discoverVariables({ timeoutMs: 10_000 });
      await second.discoverVariables({ timeoutMs: 10_000 });
      await delay(100);
      expect(firstDiscoveries).toEqual([]);
      expect(secondDiscoveries).toEqual([]);

      await writeR(
        interactive,
        'automatic_orders <- data.frame(id = 1:3, callback_count = sum(grepl("^openwrangler\\\\.workspace\\\\.", getTaskCallbackNames())))'
      );
      await waitUntil(
        () =>
          firstDiscoveries.some((names) => names.includes("automatic_orders")) &&
          secondDiscoveries.some((names) => names.includes("automatic_orders")),
        "The active R workspace descriptors were not published to both transports."
      );

      const sessionId = randomUUID();
      const opened = await first.open("automatic_orders", pageWindow(), {
        requestedSessionId: sessionId,
        timeoutMs: 10_000
      });
      expect(Number(opened.page.page.rows[0]?.values[1]?.raw)).toBe(1);
      await first.close(sessionId, { timeoutMs: 10_000 });

      const afterUserChange = [firstDiscoveries.length, secondDiscoveries.length];
      await first.discoverVariables({ timeoutMs: 10_000 });
      await second.discoverVariables({ timeoutMs: 10_000 });
      await delay(100);
      expect([firstDiscoveries.length, secondDiscoveries.length]).toEqual(afterUserChange);
    } finally {
      firstSubscription.dispose();
      secondSubscription.dispose();
      await first.dispose();
      await second.dispose();
      await stopInteractiveR(interactive);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 20_000);

  it("discovers and opens a real readr tibble from one persistent R session", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-test-"));
    const interactive = startInteractiveR();
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      testProcessId: interactive.pid!,
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

  it("preserves the exact R .Last.value across initial and later discovery", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-last-value-test-"));
    const resultPath = resolve(temporaryParent, "last-value.txt");
    const interactive = startInteractiveR();
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      testProcessId: interactive.pid!,
      runSelection: async (code) => writeR(interactive, code)
    });
    try {
      await writeR(interactive, "first_marker <- new.env(); first_marker");
      await transport.discoverVariables({ timeoutMs: 10_000 });
      await writeR(
        interactive,
        `writeLines(as.character(identical(.Last.value, first_marker)), ${JSON.stringify(resultPath)})`
      );
      await waitForFileText(resultPath, "TRUE");
      await unlink(resultPath);

      await writeR(interactive, "second_marker <- new.env(); second_marker");
      await transport.discoverVariables({ timeoutMs: 10_000 });
      await writeR(
        interactive,
        `writeLines(as.character(identical(.Last.value, second_marker)), ${JSON.stringify(resultPath)})`
      );
      await waitForFileText(resultPath, "TRUE");
      await unlink(resultPath);
    } finally {
      await transport.dispose();
      await stopInteractiveR(interactive);
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 20_000);

  it("returns a direct dependency diagnostic when jsonlite is unavailable", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-no-jsonlite-test-"));
    const interactive = startInteractiveR();
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      testProcessId: interactive.pid!,
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
      testProcessId: interactive.pid!,
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

  it("silently expires its callback after host cleanup when terminal teardown fails", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-expiry-test-"));
    const callbackPath = resolve(temporaryParent, "callback-count.txt");
    const stderr: string[] = [];
    const interactive = startInteractiveR(stderr);
    let rejectTeardown = false;
    const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
      temporaryParent,
      testProcessId: interactive.pid!,
      runSelection: async (code) => {
        const requestPath = resolveMailboxRequestPath(code);
        const request = JSON.parse(await readFile(requestPath, "utf8")) as { kind: string };
        if (rejectTeardown && request.kind === "teardownInteractiveRuntime") {
          throw new Error("simulated terminal teardown failure");
        }
        await writeR(interactive, code);
      }
    });
    await transport.discoverVariables({ timeoutMs: 10_000 });
    rejectTeardown = true;
    await expect(transport.dispose()).rejects.toThrow("simulated terminal teardown failure");
    expect(await readdir(temporaryParent)).toEqual([]);

    await writeR(interactive, "cleanup_probe <- 1L");
    await writeR(
      interactive,
      `writeLines(as.character(sum(grepl("^openwrangler\\\\.workspace\\\\.", getTaskCallbackNames()))), ${JSON.stringify(callbackPath)})`
    );
    await waitForFileText(callbackPath, "0");
    await unlink(callbackPath);
    await stopInteractiveR(interactive);
    expect(stderr.join("")).not.toMatch(/warning/i);
    await rm(temporaryParent, { recursive: true, force: true });
  }, 20_000);

  it.each(["remove", "replace"] as const)(
    "expires its callback when the private binding is %s",
    async (mode) => {
      const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-interactive-dispatcher-failure-test-"));
      const callbackPath = resolve(temporaryParent, "callback-count.txt");
      const stderr: string[] = [];
      const interactive = startInteractiveR(stderr);
      const transport = new RInteractiveSessionTransport({ extensionPath: repositoryRoot } as vscode.ExtensionContext, {
        temporaryParent,
        testProcessId: interactive.pid!,
        runSelection: async (code) => writeR(interactive, code),
        disposalSettlementMs: 2_000
      });
      let changeCount = 0;
      const subscription = transport.onDidChangeVariables(() => {
        changeCount += 1;
      });
      let disposed = false;
      try {
        await expect(transport.discoverVariables({ timeoutMs: 5_000 })).resolves.toMatchObject({ truncated: false });
        await writeR(
          interactive,
          `base::local({${[
            'ow_binding <- ls(envir = .GlobalEnv, all.names = TRUE, pattern = "^\\\\.openwrangler_r_request_[a-f0-9]{16}$")',
            "stopifnot(length(ow_binding) == 1L)",
            mode === "remove"
              ? "remove(list = ow_binding, envir = .GlobalEnv)"
              : 'assign(ow_binding, function(...) stop("replaced dispatcher"), envir = .GlobalEnv)'
          ].join("; ")}})`
        );
        await delay(100);
        expect(changeCount).toBe(0);
        const startedAt = Date.now();
        await expect(transport.discoverVariables({ timeoutMs: 5_000 })).rejects.toThrow(
          "interactive R dispatcher is unavailable"
        );
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        await writeR(
          interactive,
          `writeLines(as.character(sum(grepl("^openwrangler\\\\.workspace\\\\.", getTaskCallbackNames()))), ${JSON.stringify(callbackPath)})`
        );
        await waitForFileText(callbackPath, "0");
        await unlink(callbackPath);
        expect(stderr.join("")).not.toMatch(/warning/i);
        await expect(transport.dispose()).rejects.toThrow("interactive R dispatcher is unavailable");
        disposed = true;
        expect(await readdir(temporaryParent)).toEqual([]);
      } finally {
        subscription.dispose();
        if (!disposed) await transport.dispose().catch(() => undefined);
        await stopInteractiveR(interactive);
        await rm(temporaryParent, { recursive: true, force: true });
      }
    },
    20_000
  );
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

function resolveMailboxRequestPath(code: string): string {
  const encodedResponse = /\.__ow_response_path <- ("(?:\\.|[^"\\])*")/u.exec(code)?.[1];
  if (!encodedResponse) throw new Error("The R dispatcher did not contain its correlated response path.");
  const responsePath = JSON.parse(encodedResponse) as string;
  return resolve(dirname(dirname(responsePath)), "requests", basename(responsePath));
}

function startInteractiveR(stderrOutput?: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(rExecutable, ["--vanilla", "--slave"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", (chunk: Buffer) => {
    stderrOutput?.push(chunk.toString("utf8"));
  });
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}

async function waitForFileText(filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const actual = await readFile(filePath, "utf8").catch(() => "");
    if (actual.trim() === expected) return;
    if (Date.now() >= deadline) throw new Error(`R did not write ${expected} to ${filePath}.`);
    await delay(20);
  }
}
