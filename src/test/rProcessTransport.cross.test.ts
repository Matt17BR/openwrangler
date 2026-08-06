import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import { RProcessSessionTransport } from "../extension/r/rProcessTransport";
import type { RKernelPageWindow } from "../extension/r/rKernelProtocol";

const enabled = process.env.OPEN_WRANGLER_R_CONTRACT_TESTS === "1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeRoot = resolve(root, "r/openwrangler_runtime");
const rscriptPath = process.env.RSCRIPT ?? "/usr/bin/Rscript";

describe.skipIf(!enabled)("plain R process transport", () => {
  it("executes one noisy document once, discovers native frames, edits, closes, and removes its private root", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-test-"));
    const markerPath = resolve(temporaryParent, "execution-count.txt");
    const argumentsPath = resolve(temporaryParent, "document-arguments.txt");
    await writeFile(resolve(temporaryParent, "relative.csv"), "id,label\n1,relative\n", "utf8");
    await writeFile(
      resolve(temporaryParent, "helper.R"),
      'helper_frame <- data.frame(id = 4L, label = "sourced")\n',
      "utf8"
    );
    const documentText = `
document_environment <- environment()
private_agent_names <- c(
  "runtime_root",
  "document_path",
  "response_root",
  "maximum_request_bytes",
  "atomic_write_raw",
  "initialized"
)
visible_private_names <- private_agent_names[vapply(
  private_agent_names,
  exists,
  logical(1L),
  envir = document_environment,
  inherits = TRUE
)]
if (length(visible_private_names) != 0L) {
  stop(sprintf("private process-agent names leaked into the document: %s", paste(visible_private_names, collapse = ", ")))
}
rm(document_environment, private_agent_names, visible_private_names)
cat("executed\\n", file = ${rString(markerPath)}, append = TRUE)
cat(length(commandArgs(trailingOnly = TRUE)), file = ${rString(argumentsPath)})
cat(paste(rep("stdout-noise", 20000L), collapse = ""), "\\n")
message(paste(rep("stderr-noise", 20000L), collapse = ""))
if (.Platform$OS.type != "windows") {
  system("printf direct-subprocess-stdout; printf direct-subprocess-stderr >&2")
}
plain_frame <- data.frame(id = 1:3, label = c("ALPHA", "BETA", "GAMMA"), stringsAsFactors = FALSE)
tibble_frame <- tibble::tibble(id = 1:2, label = c("one", "two"))
table_frame <- data.table::data.table(id = c(2L, 1L), label = c("b", "a"))
relative_frame <- read.csv("relative.csv", stringsAsFactors = FALSE)
source("helper.R", local = TRUE)
delayedAssign("lazy_frame", stop("lazy dataframe binding was forced"))
not_a_frame <- matrix(1:4, nrow = 2L)
`;
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText
    });

    try {
      const discovery = await transport.discoverVariables({ timeoutMs: 15_000 });
      expect(discovery).toEqual({
        truncated: false,
        variables: [
          { backend: "r", dataframeFlavor: "r.data.frame", name: "helper_frame" },
          { backend: "r", dataframeFlavor: "r.data.frame", name: "plain_frame" },
          { backend: "r", dataframeFlavor: "r.data.frame", name: "relative_frame" },
          { backend: "r", dataframeFlavor: "r.data.table", name: "table_frame" },
          { backend: "r", dataframeFlavor: "r.tibble", name: "tibble_frame" }
        ]
      });
      expect(await transport.discoverVariables()).toBe(discovery);
      expect(await readFile(markerPath, "utf8")).toBe("executed\n");
      expect(await readFile(argumentsPath, "utf8")).toBe("0");

      const sessionId = randomUUID();
      const opened = await transport.open("plain_frame", pageWindow(), { requestedSessionId: sessionId });
      expect(opened).toMatchObject({
        sessionId,
        page: {
          dataframeFlavor: "r.data.frame",
          shape: { rows: 3, columns: 2 },
          page: { columnIds: ["r:c:0", "r:c:1"] }
        }
      });
      expect(transport.isSessionMapped(sessionId)).toBe(true);

      const preview = await transport.previewStep(
        sessionId,
        0,
        {
          id: "lower-label",
          kind: "lowerText",
          params: { column: { id: "r:c:1", name: "label" } }
        },
        pageWindow(),
        opened.page.schema
      );
      expect(preview.page.page.rows.map((row) => row.values[1]?.raw)).toEqual(["alpha", "beta", "gamma"]);
      // Generated code is for insertion into the user's ordinary R execution
      // context; the private worker environment is never leaked into it.
      expect(preview.code).toContain("parent.env(environment())");
      const applied = await transport.applyDraft(sessionId, 1, pageWindow());
      expect(applied).toMatchObject({ action: "apply", revision: 2 });

      await transport.close(sessionId);
      expect(transport.isSessionMapped(sessionId)).toBe(false);
      expect(await readFile(markerPath, "utf8")).toBe("executed\n");
      expect((await readdir(temporaryParent)).filter((name) => name.startsWith("openwrangler-r-"))).toEqual([]);

      const rerun = new RProcessSessionTransport({
        runtimeRoot,
        rscriptPath,
        temporaryParent,
        workingDirectory: temporaryParent,
        documentText: `${documentText}\n${applied.code}\n`
      });
      try {
        const rerunDiscovery = await rerun.discoverVariables({ timeoutMs: 15_000 });
        expect(rerunDiscovery.variables).toContainEqual({
          backend: "r",
          dataframeFlavor: "r.data.frame",
          name: "open_wrangler_result"
        });
      } finally {
        await rerun.dispose();
      }
      expect(await readFile(markerPath, "utf8")).toBe("executed\nexecuted\n");
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([
        "document-arguments.txt",
        "execution-count.txt",
        "helper.R",
        "relative.csv"
      ]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports source failures without retaining its private process directory", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-error-test-"));
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: 'stop("document failed before discovery")'
    });
    try {
      await expect(transport.discoverVariables({ timeoutMs: 10_000 })).rejects.toThrow(
        "document failed before discovery"
      );
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  });

  it("parses Unicode source and request text under a non-UTF-8 process locale", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-unicode-test-"));
    const previousLocale = process.env.LC_ALL;
    process.env.LC_ALL = "C";
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: 'cafe_frame <- data.frame(label = c("München", "Zürich"), stringsAsFactors = FALSE)\n'
    });
    try {
      const discovery = await transport.discoverVariables({ timeoutMs: 10_000 });
      expect(discovery.variables).toEqual([{ backend: "r", dataframeFlavor: "r.data.frame", name: "cafe_frame" }]);
      const sessionId = randomUUID();
      const opened = await transport.open("cafe_frame", pageWindow(), {
        requestedSessionId: sessionId,
        timeoutMs: 10_000
      });
      expect(opened.page.page.rows[0]?.values[0]?.raw).toBe("München");
      const values = await transport.getColumnValues(
        sessionId,
        { id: "r:c:0", name: "label" },
        { filters: [], sorts: [] },
        "Mü",
        20,
        { timeoutMs: 10_000 }
      );
      expect(values).toMatchObject({
        column: "label",
        values: [{ value: "München", count: 1 }],
        hasMore: false
      });
      await transport.close(sessionId, { timeoutMs: 10_000 });
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await transport.dispose().catch(() => undefined);
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("terminates the exact owned child when disposal interrupts document execution", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-dispose-test-"));
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: "Sys.sleep(60); frame <- data.frame(value = 1L)"
    });
    const startup = transport.discoverVariables({ timeoutMs: 60_000 }).catch(() => undefined);
    await sleep(100);
    await transport.dispose();
    await startup;
    expect(await readdir(temporaryParent)).toEqual([]);
    await rm(temporaryParent, { recursive: true, force: true });
  }, 10_000);

  it.skipIf(process.platform === "win32")(
    "terminates background descendants in the owned POSIX process group",
    async () => {
      const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-tree-test-"));
      const pidPath = resolve(temporaryParent, "background.pid");
      const transport = new RProcessSessionTransport({
        runtimeRoot,
        rscriptPath,
        temporaryParent,
        workingDirectory: temporaryParent,
        documentText: `
system(sprintf("sh -c 'sleep 60 & echo $! > %s'", ${rString(pidPath)}))
frame <- data.frame(value = 1L)
`
      });
      let backgroundPid: number | undefined;
      try {
        await transport.discoverVariables({ timeoutMs: 10_000 });
        backgroundPid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
        expect(Number.isSafeInteger(backgroundPid) && backgroundPid > 0).toBe(true);
        expect(processExists(backgroundPid)).toBe(true);
        await transport.dispose();
        await expectProcessExit(backgroundPid);
        expect(await readdir(temporaryParent)).toEqual(["background.pid"]);
      } finally {
        await transport.dispose().catch(() => undefined);
        if (backgroundPid && processExists(backgroundPid)) process.kill(backgroundPid, "SIGKILL");
        await rm(temporaryParent, { recursive: true, force: true });
      }
    },
    15_000
  );

  it("detaches from a dispatched request without claiming the running work was cancelled", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-cancel-test-"));
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: `frame <- data.frame(value = seq_len(400000L), label = rep("VALUE", 400000L))`
    });
    try {
      const sessionId = randomUUID();
      const opened = await transport.open("frame", pageWindow(), { requestedSessionId: sessionId, timeoutMs: 20_000 });
      const cancellation = cancellationAfter(10);
      let detached: DetachedBridgeRequestError | undefined;
      try {
        await transport.previewStep(
          sessionId,
          0,
          {
            id: "slow-lower",
            kind: "lowerText",
            params: { column: { id: "r:c:1", name: "label" } }
          },
          pageWindow(),
          opened.page.schema,
          undefined,
          { cancellation, timeoutMs: 20_000 }
        );
      } catch (error) {
        if (error instanceof DetachedBridgeRequestError) detached = error;
        else throw error;
      }
      expect(detached).toMatchObject({ reason: "cancellation", dispatched: true });
      expect(detached?.message).toContain("still finishing");
      expect(detached?.message).not.toContain("was cancelled");
      await detached?.settlement;
      await transport.close(sessionId, { timeoutMs: 20_000 });
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 45_000);

  it.each(["diagnostic", "malformed", "mis-correlated"] as const)(
    "closes the host-owned candidate once after a %s open failure",
    async (failure) => {
      const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-open-cleanup-test-"));
      const responseCallsPath = resolve(temporaryParent, "response-calls.txt");
      const candidateSessionId = randomUUID();
      const otherSessionId = randomUUID();
      const transport = new RProcessSessionTransport({
        runtimeRoot,
        rscriptPath,
        temporaryParent,
        workingDirectory: temporaryParent,
        documentText: openCleanupDocument(responseCallsPath, candidateSessionId, otherSessionId, failure)
      });
      try {
        await transport.discoverVariables({ timeoutMs: 15_000 });
        await expect(
          transport.open(failure === "diagnostic" ? "missing_frame" : "frame", pageWindow(), {
            requestedSessionId: candidateSessionId,
            timeoutMs: 15_000
          })
        ).rejects.toBeInstanceOf(Error);

        expect(transport.isSessionMapped(candidateSessionId)).toBe(false);
        await expect(transport.close(candidateSessionId, { timeoutMs: 15_000 })).resolves.toBeUndefined();
        const responseCalls = (await readFile(responseCallsPath, "utf8")).trim().split(/\s+/u).map(Number);
        expect(responseCalls).toEqual(failure === "diagnostic" ? [1, 2, 3] : [1, 2, 3, 4, 5]);
      } finally {
        await transport.dispose();
        expect(await readdir(temporaryParent)).toEqual(["response-calls.txt"]);
        await rm(temporaryParent, { recursive: true, force: true });
      }
    },
    30_000
  );
});

function openCleanupDocument(
  responseCallsPath: string,
  candidateSessionId: string,
  otherSessionId: string,
  failure: "diagnostic" | "malformed" | "mis-correlated"
): string {
  return `
jsonlite_namespace <- asNamespace("jsonlite")
original_to_json <- get("toJSON", envir = jsonlite_namespace, inherits = FALSE)
response_calls <- 0L
cleanup_failure <- ${rString(failure)}
candidate_session_id <- ${rString(candidateSessionId)}
other_session_id <- ${rString(otherSessionId)}
unlockBinding("toJSON", jsonlite_namespace)
assign("toJSON", function(...) {
  response_calls <<- response_calls + 1L
  cat(response_calls, "\\n", file = ${rString(responseCallsPath)}, append = TRUE)
  encoded <- original_to_json(...)
  if (response_calls == 3L && identical(cleanup_failure, "malformed")) {
    return("{")
  }
  if (response_calls == 3L && identical(cleanup_failure, "mis-correlated")) {
    return(sub(candidate_session_id, other_session_id, as.character(encoded), fixed = TRUE))
  }
  encoded
}, envir = jsonlite_namespace)
lockBinding("toJSON", jsonlite_namespace)
frame <- data.frame(value = 1:3)
`;
}

function pageWindow(): RKernelPageWindow {
  return {
    rowOffset: 0,
    rowLimit: 20,
    columnOffset: 0,
    columnLimit: 20,
    view: { filters: [], sorts: [] }
  };
}

function rString(value: string): string {
  return JSON.stringify(value);
}

function cancellationAfter(milliseconds: number): {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
} {
  let cancelled = false;
  const listeners = new Set<() => void>();
  const timer = setTimeout(() => {
    cancelled = true;
    for (const listener of listeners) listener();
  }, milliseconds);
  return {
    get isCancellationRequested(): boolean {
      return cancelled;
    },
    onCancellationRequested(listener: () => void): { dispose(): void } {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
          if (listeners.size === 0) clearTimeout(timer);
        }
      };
    }
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ESRCH");
  }
}

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processExists(pid) && Date.now() < deadline) await sleep(20);
  expect(processExists(pid)).toBe(false);
}
