import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import { prepareRDocumentSource } from "../extension/r/rDocumentSource";
import { RProcessSessionTransport } from "../extension/r/rProcessTransport";
import type { RKernelPageWindow } from "../extension/r/rKernelProtocol";

const enabled = process.env.OPEN_WRANGLER_R_CONTRACT_TESTS === "1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeRoot = resolve(root, "r/openwrangler_runtime");
const rscriptPath = process.env.RSCRIPT ?? "Rscript";

describe.skipIf(!enabled)("plain R process transport", () => {
  it("does not retain an untrusted open candidate and can reuse its requested session identity", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-untrusted-open-test-"));
    const trustDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "isTrusted");
    Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, value: false });
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: "frame <- data.frame(value = 1:2)"
    });
    const requestedSessionId = randomUUID();
    try {
      await expect(transport.open("frame", pageWindow(), { requestedSessionId })).rejects.toThrow(
        "Trust this workspace"
      );
      const internals = transport as unknown as {
        openingSessions: ReadonlySet<string>;
        mappedSessions: ReadonlySet<string>;
        startPromise?: Promise<unknown>;
        owned?: unknown;
      };
      expect(internals.openingSessions.size).toBe(0);
      expect(internals.mappedSessions.size).toBe(0);
      expect(internals.startPromise).toBeUndefined();
      expect(internals.owned).toBeUndefined();
      expect(await readdir(temporaryParent)).toEqual([]);

      Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, value: true });
      await expect(transport.open("frame", pageWindow(), { requestedSessionId })).resolves.toMatchObject({
        sessionId: requestedSessionId
      });
      await expect(transport.close(requestedSessionId)).resolves.toBeUndefined();
    } finally {
      if (trustDescriptor) Object.defineProperty(vscode.workspace, "isTrusted", trustDescriptor);
      else Reflect.deleteProperty(vscode.workspace, "isTrusted");
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not dispatch queued R process work after workspace trust is revoked", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-trust-queue-test-"));
    const trustDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "isTrusted");
    Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, value: true });
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: `frame <- data.frame(value = c("alpha", "beta"), stringsAsFactors = FALSE)`
    });
    try {
      const sessionId = randomUUID();
      const opened = await transport.open("frame", pageWindow(), { requestedSessionId: sessionId });
      const slowPreview = transport.previewStep(
        sessionId,
        0,
        {
          id: "slow-custom-trust-step",
          kind: "customCode",
          params: { code: "Sys.sleep(0.5)\nresult <- df\n" }
        },
        pageWindow(),
        opened.page.schema
      );
      await sleep(50);
      const queuedPage = transport.getPage(sessionId, pageWindow());
      Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, value: false });

      await expect(slowPreview).resolves.toMatchObject({ revision: 1, effectiveView: { filters: [], sorts: [] } });
      await expect(queuedPage).rejects.toThrow("Trust this workspace");
      await expect(transport.discoverVariables()).rejects.toThrow("Trust this workspace");
      await expect(transport.close(sessionId)).resolves.toBeUndefined();
    } finally {
      if (trustDescriptor) Object.defineProperty(vscode.workspace, "isTrusted", trustDescriptor);
      else Reflect.deleteProperty(vscode.workspace, "isTrusted");
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("forwards custom effective views and retained by-example steps through the process transport", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-preview-fields-test-"));
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: `frame <- data.frame(value = c("alpha", "beta"), stringsAsFactors = FALSE)`
    });
    const customSessionId = randomUUID();
    const byExampleSessionId = randomUUID();
    try {
      const customOpened = await transport.open("frame", pageWindow(), { requestedSessionId: customSessionId });
      const custom = await transport.previewStep(
        customSessionId,
        0,
        {
          id: "custom-process-step",
          kind: "customCode",
          params: { code: "result <- df\n" }
        },
        pageWindow(),
        customOpened.page.schema
      );
      expect(custom).toMatchObject({
        revision: 1,
        effectiveView: { filters: [], sorts: [] },
        page: { shape: { rows: 4, columns: 1 } }
      });
      await transport.discardDraft(customSessionId, custom.revision, pageWindow());

      const byExampleOpened = await transport.open("frame", pageWindow(), {
        requestedSessionId: byExampleSessionId
      });
      const byExample = await transport.previewStep(
        byExampleSessionId,
        0,
        {
          id: "by-example-process-step",
          kind: "byExample",
          params: {
            sourceColumns: [{ id: "r:c:0", name: "value" }],
            newColumn: "value copy",
            examples: [
              { inputs: ["alpha"], output: "alpha" },
              { inputs: ["beta"], output: "beta" }
            ]
          }
        },
        pageWindow(),
        byExampleOpened.page.schema
      );
      expect(byExample).toMatchObject({
        revision: 1,
        retainedStep: {
          id: "by-example-process-step",
          kind: "byExample",
          params: {
            program: { kind: "column" },
            warnings: expect.any(Array),
            candidateCount: expect.any(Number)
          }
        }
      });
      await transport.close(customSessionId);
      await transport.close(byExampleSessionId);
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("streams committed CSV and Parquet exports through bounded host chunks without changing the source frame", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-export-test-"));
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: `
plain_frame <- data.frame(
  id = 1:3,
  label = c(" ALPHA ", "BETA", NA_character_),
  when = as.Date(c("2026-01-01", "2026-01-02", NA_character_)),
  category = factor(c("one", "two", NA_character_)),
  stringsAsFactors = FALSE
)
large_frame <- data.frame(
  payload = rep(paste(rep("x", 8192L), collapse = ""), 150L),
  stringsAsFactors = FALSE
)
complex_frame <- data.frame(
  first = c('München "quoted"', "line\\nbreak", ""),
  second = c("α", "", NA_character_),
  when = as.POSIXct(c("2026-01-01 12:34:56", NA, "2026-01-03 00:00:00"), tz = "UTC"),
  special = c(Inf, -Inf, NaN),
  empty = c("", NA_character_, "x"),
  check.names = FALSE,
  stringsAsFactors = FALSE
)
names(complex_frame)[1:2] <- c("odd name", "odd name")
empty_frame <- data.frame(id = integer(), label = character(), check.names = FALSE)
`
    });
    try {
      const plainSession = randomUUID();
      const opened = await transport.open("plain_frame", pageWindow(), { requestedSessionId: plainSession });
      expect(opened.exportFormats).toEqual(["csv", "parquet"]);
      const preview = await transport.previewStep(
        plainSession,
        0,
        {
          id: "lower-label",
          kind: "lowerText",
          params: { column: { id: "r:c:1", name: "label" } }
        },
        pageWindow(),
        opened.page.schema
      );
      const draftChunks: Uint8Array[] = [];
      await expect(
        transport.exportData(plainSession, preview.revision, "csv", async (chunk) => {
          draftChunks.push(Uint8Array.from(chunk));
        })
      ).rejects.toThrow("Apply or discard");
      expect(draftChunks).toEqual([]);

      const applied = await transport.applyDraft(plainSession, preview.revision, pageWindow());
      await expect(transport.exportData(plainSession, preview.revision, "csv", async () => undefined)).rejects.toThrow(
        "revision"
      );
      await expect(
        transport.exportData(plainSession, applied.revision, "csv", async () => {
          throw new Error("host sink failed");
        })
      ).rejects.toThrow("host sink failed");

      const csvChunks: Uint8Array[] = [];
      const exported = await transport.exportData(plainSession, applied.revision, "csv", async (chunk) => {
        csvChunks.push(Uint8Array.from(chunk));
      });
      expect(exported).toEqual({
        sessionId: plainSession,
        revision: applied.revision,
        format: "csv",
        rows: 3,
        columns: 4
      });
      const csv = Buffer.concat(csvChunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      expect(csv).toContain('"id","label","when","category"\n');
      expect(csv).toContain('1," alpha ",2026-01-01,"one"\n');
      expect(csv).toContain("3,,,\n");

      const parquet = await exportedBytes(transport, plainSession, "parquet", applied.revision);
      expect(parquet.subarray(0, 4).toString("utf8")).toBe("PAR1");
      expect(parquet.subarray(-4).toString("utf8")).toBe("PAR1");

      const sourceSession = randomUUID();
      const source = await transport.open("plain_frame", pageWindow(), { requestedSessionId: sourceSession });
      expect(source.page.page.rows.map((row) => row.values[1]?.raw)).toEqual([" ALPHA ", "BETA", null]);

      const largeSession = randomUUID();
      await transport.open("large_frame", pageWindow(), { requestedSessionId: largeSession });
      const largeChunkSizes: number[] = [];
      const large = await transport.exportData(largeSession, 0, "csv", async (chunk) => {
        largeChunkSizes.push(chunk.byteLength);
      });
      expect(large).toMatchObject({ rows: 150, columns: 1 });
      expect(largeChunkSizes.length).toBeGreaterThan(1);
      expect(Math.max(...largeChunkSizes)).toBeLessThanOrEqual(1_024 * 1_024);

      const complexSession = randomUUID();
      await transport.open("complex_frame", pageWindow(), { requestedSessionId: complexSession });
      const complexChunks: Uint8Array[] = [];
      const complex = await transport.exportData(complexSession, 0, "csv", async (chunk) => {
        complexChunks.push(Uint8Array.from(chunk));
      });
      expect(complex).toMatchObject({ rows: 3, columns: 5 });
      const complexCsv = Buffer.concat(complexChunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      expect(complexCsv).toContain('"odd name","odd name","when","special","empty"\n');
      expect(complexCsv).toContain('"München ""quoted"""');
      expect(complexCsv).toContain('"line\nbreak"');
      expect(complexCsv).toContain("2026-01-01 12:34:56");
      expect(complexCsv).toContain("Inf");
      expect(complexCsv).toContain("-Inf");

      const emptySession = randomUUID();
      await transport.open("empty_frame", pageWindow(), { requestedSessionId: emptySession });
      const emptyChunks: Uint8Array[] = [];
      const empty = await transport.exportData(emptySession, 0, "csv", async (chunk) => {
        emptyChunks.push(Uint8Array.from(chunk));
      });
      expect(empty).toMatchObject({ rows: 0, columns: 2 });
      expect(Buffer.concat(emptyChunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe('"id","label"\n');

      await transport.close(plainSession);
      await transport.close(sourceSession);
      await transport.close(largeSession);
      await transport.close(complexSession);
      await transport.close(emptySession);
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("exports native tibble, keyed data.table, and integer64 frames without changing their R semantics", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-export-flavors-test-"));
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: `
tibble_frame <- tibble::tibble(id = c(1L, 2L), label = c("one", "two"))
table_frame <- data.table::data.table(group = c("b", "a", "b"), id = c(2L, 1L, 1L))
data.table::setkey(table_frame, group, id)
integer64_frame <- data.frame(
  exact = bit64::as.integer64(c("-9223372036854775807", "9007199254740993", "9223372036854775806", NA_character_)),
  stringsAsFactors = FALSE
)
zero_column_frame <- data.frame(row.names = c("row-1", "row-2", "row-3"))
`
    });
    try {
      const tibbleSession = randomUUID();
      const tibble = await transport.open("tibble_frame", pageWindow(), { requestedSessionId: tibbleSession });
      expect(tibble.page).toMatchObject({ dataframeFlavor: "r.tibble", shape: { rows: 2, columns: 2 } });
      expect(await exportedCsv(transport, tibbleSession)).toBe('"id","label"\n1,"one"\n2,"two"\n');
      const reopenedTibbleSession = randomUUID();
      const reopenedTibble = await transport.open("tibble_frame", pageWindow(), {
        requestedSessionId: reopenedTibbleSession
      });
      expect(reopenedTibble.page.dataframeFlavor).toBe("r.tibble");

      const tableSession = randomUUID();
      const table = await transport.open("table_frame", pageWindow(), { requestedSessionId: tableSession });
      expect(table.page).toMatchObject({
        dataframeFlavor: "r.data.table",
        frameSemantics: { keyColumnIds: ["r:c:0", "r:c:1"] },
        shape: { rows: 3, columns: 2 }
      });
      expect(await exportedCsv(transport, tableSession)).toBe('"group","id"\n"a",1\n"b",1\n"b",2\n');
      const reopenedTableSession = randomUUID();
      const reopenedTable = await transport.open("table_frame", pageWindow(), {
        requestedSessionId: reopenedTableSession
      });
      expect(reopenedTable.page).toMatchObject({
        dataframeFlavor: "r.data.table",
        frameSemantics: { keyColumnIds: ["r:c:0", "r:c:1"] }
      });
      expect(reopenedTable.page.page.rows.map((row) => row.values.map((value) => value.raw))).toEqual([
        ["a", "1"],
        ["b", "1"],
        ["b", "2"]
      ]);

      const integer64Session = randomUUID();
      const integer64 = await transport.open("integer64_frame", pageWindow(), {
        requestedSessionId: integer64Session
      });
      const exactValues = ["-9223372036854775807", "9007199254740993", "9223372036854775806", null];
      expect(integer64.page.schema[0]).toMatchObject({ rawType: "integer64", type: "integer" });
      expect(integer64.page.page.rows.map((row) => row.values[0]?.raw)).toEqual(exactValues);
      expect(await exportedCsv(transport, integer64Session)).toBe(
        '"exact"\n-9223372036854775807\n9007199254740993\n9223372036854775806\n\n'
      );
      const reopenedInteger64Session = randomUUID();
      const reopenedInteger64 = await transport.open("integer64_frame", pageWindow(), {
        requestedSessionId: reopenedInteger64Session
      });
      expect(reopenedInteger64.page.schema[0]).toMatchObject({ rawType: "integer64", type: "integer" });
      expect(reopenedInteger64.page.page.rows.map((row) => row.values[0]?.raw)).toEqual(exactValues);

      const zeroColumnSession = randomUUID();
      const zeroColumn = await transport.open("zero_column_frame", pageWindow(), {
        requestedSessionId: zeroColumnSession
      });
      expect(zeroColumn.page.shape).toEqual({ rows: 3, columns: 0 });
      expect(zeroColumn.exportFormats).toEqual(["csv", "parquet"]);
      const zeroColumnChunks: Uint8Array[] = [];
      await expect(
        transport.exportData(zeroColumnSession, 0, "csv", async (chunk) => {
          zeroColumnChunks.push(Uint8Array.from(chunk));
        })
      ).rejects.toThrow("CSV export requires at least one column");
      expect(zeroColumnChunks).toEqual([]);
      const zeroColumnParquet = await exportedBytes(transport, zeroColumnSession, "parquet");
      expect(zeroColumnParquet.subarray(0, 4).toString("utf8")).toBe("PAR1");
      expect(zeroColumnParquet.subarray(-4).toString("utf8")).toBe("PAR1");
      expect((await transport.getPage(zeroColumnSession, pageWindow())).shape).toEqual({ rows: 3, columns: 0 });

      for (const sessionId of [
        tibbleSession,
        reopenedTibbleSession,
        tableSession,
        reopenedTableSession,
        integer64Session,
        reopenedInteger64Session,
        zeroColumnSession
      ]) {
        await transport.close(sessionId);
      }
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("disposes its owned process without removing a substituted private export path", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-export-cleanup-test-"));
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: "frame <- data.frame(value = 1:3)"
    });
    let invalidations = 0;
    let replacementPath: string | undefined;
    const subscription = transport.onDidInvalidateKernel(() => {
      invalidations += 1;
    });
    try {
      const sessionId = randomUUID();
      await transport.open("frame", pageWindow(), { requestedSessionId: sessionId });
      await expect(
        transport.exportData(sessionId, 0, "csv", async () => {
          const [processRoot] = await readdir(temporaryParent);
          const exportRoot = resolve(temporaryParent, processRoot!, "exports");
          const [artifact] = await readdir(exportRoot);
          const artifactPath = resolve(exportRoot, artifact!);
          await unlink(artifactPath);
          await mkdir(artifactPath);
          replacementPath = artifactPath;
        })
      ).rejects.toThrow();
      expect(invalidations).toBe(1);
      await expect(transport.discoverVariables()).rejects.toThrow("disposed");
      expect(replacementPath).toBeDefined();
      expect((await lstat(replacementPath!)).isDirectory()).toBe(true);
    } finally {
      subscription.dispose();
      await transport.dispose();
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an export artifact rewritten in place while it is streaming", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-export-rewrite-test-"));
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: "frame <- data.frame(value = 1:3)"
    });
    try {
      const sessionId = randomUUID();
      await transport.open("frame", pageWindow(), { requestedSessionId: sessionId });
      let rewritten = false;
      await expect(
        transport.exportData(sessionId, 0, "csv", async () => {
          if (rewritten) return;
          const [processRoot] = await readdir(temporaryParent);
          const exportRoot = resolve(temporaryParent, processRoot!, "exports");
          const [artifact] = await readdir(exportRoot);
          const artifactPath = resolve(exportRoot, artifact!);
          const expectedCsv = Buffer.from('"value"\n1\n2\n3\n', "utf8");
          await writeFile(artifactPath, Buffer.alloc(expectedCsv.byteLength, 0x78), { flag: "r+" });
          rewritten = true;
        })
      ).rejects.toThrow("changing private R export artifact");
      expect(rewritten).toBe(true);

      await expect(transport.discoverVariables()).resolves.toMatchObject({
        variables: [{ name: "frame" }]
      });
      await transport.close(sessionId);
    } finally {
      await transport.dispose();
      expect(await readdir(temporaryParent)).toEqual([]);
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("executes only runnable R cells from a real Quarto source capture", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-quarto-test-"));
    await writeFile(
      resolve(temporaryParent, "orders.csv"),
      "id,label,order_date\n1,one,2026-01-01\n2,two,2026-01-02\n",
      "utf8"
    );
    const source = [
      "---",
      "title: Orders",
      "payload: |",
      "  ```{r}",
      "  hidden_yaml_frame <- data.frame(id = 0L)",
      "  ```",
      "---",
      "",
      "---",
      "",
      "\\newpage",
      "$$",
      "x^2 + y^2 = z^2",
      "$$",
      "\\begin{center}",
      "Rendered document title",
      "\\end{center}",
      "",
      "<!-- ```{r}",
      "hidden_comment_frame <- data.frame(id = 0L)",
      "``` -->",
      "",
      "```{r disabled, eval=FALSE}",
      "disabled_frame <- stop('must not run')",
      "```",
      "",
      '```{r 3ptprog, out.width="100%", fig.cap="Orders preview", include=TRUE, purl=TRUE}',
      "orders <- read.csv('orders.csv', stringsAsFactors = FALSE)",
      "orders$order_date <- as.Date(orders$order_date)",
      "```",
      ""
    ].join("\n");
    const prepared = prepareRDocumentSource(resolve(temporaryParent, "orders.qmd"), source);
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: prepared.executableUnits
    });
    try {
      try {
        expect(prepared).toMatchObject({ kind: "quarto", rChunkCount: 2, runnableRChunkCount: 1 });
        expect(await transport.discoverVariables({ timeoutMs: 10_000 })).toEqual({
          truncated: false,
          variables: [{ backend: "r", dataframeFlavor: "r.data.frame", name: "orders" }]
        });
        const sessionId = randomUUID();
        const opened = await transport.open("orders", pageWindow(), { requestedSessionId: sessionId });
        expect(opened.page).toMatchObject({ shape: { rows: 2, columns: 3 } });
        const summaries = await transport.getSummary(
          sessionId,
          opened.page.schema.map(({ id, name }) => ({ id, name })),
          { filters: [], sorts: [] }
        );
        expect(summaries).toHaveLength(3);
        const datasetStats = await transport.getDatasetStats(sessionId, { filters: [], sorts: [] });
        expect(datasetStats).toMatchObject({ totalRows: 2 });
        const preview = await transport.previewStep(
          sessionId,
          0,
          {
            id: "rename-id",
            kind: "renameColumn",
            params: { column: { id: "r:c:0", name: "id" }, newName: "order_id" }
          },
          pageWindow(),
          opened.page.schema
        );
        expect(preview.page.schema[0]?.name).toBe("order_id");
        const applied = await transport.applyDraft(sessionId, preview.revision, pageWindow());
        expect(applied).toMatchObject({ action: "apply", revision: 2 });
        await transport.close(sessionId);
      } finally {
        await transport.dispose();
        expect(await readdir(temporaryParent)).toEqual(["orders.csv"]);
      }
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  }, 30_000);

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
  "document_root",
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
readr_frame <- readr::read_csv(I("id,label\n1,one\n2,two"), show_col_types = FALSE)
grouped_frame <- dplyr::group_by(tibble_frame, id)
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
          { backend: "r", dataframeFlavor: "r.tibble", name: "readr_frame" },
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

      const readrSessionId = randomUUID();
      const readrOpened = await transport.open("readr_frame", pageWindow(), { requestedSessionId: readrSessionId });
      expect(readrOpened.page).toMatchObject({
        dataframeFlavor: "r.tibble",
        frameSemantics: { classes: ["tbl_df", "tbl", "data.frame"] },
        shape: { rows: 2, columns: 2 }
      });

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
      // Generated code captures only the exact caller environment needed to
      // read the source, then runs its implementation below baseenv so caller
      // operators, methods, and helper bindings cannot intercept the plan.
      expect(preview.code).toMatch(/^base::evalq\(\{/u);
      expect(preview.code).toContain(".ow_generated_result <- base::evalq({");
      expect(preview.code).toContain('base::get("plain_frame", envir = .ow_source_environment, inherits = FALSE)');
      expect(preview.code).toContain("base::list(.ow_caller_environment = base::environment())");
      expect(preview.code).toContain(
        "base::list(.ow_source_environment = .ow_caller_environment, .ow_custom_parent_environment = .ow_caller_environment)"
      );
      expect(preview.code).toContain(
        "base::assign(.ow_publication_name, .ow_generated_result, envir = .ow_caller_environment, inherits = FALSE)"
      );
      expect(preview.code).toContain("parent = base::baseenv()");
      expect(preview.code).not.toContain("open_wrangler_result <- base::evalq");
      expect(preview.code).not.toContain("parent.env(environment())");
      const applied = await transport.applyDraft(sessionId, 1, pageWindow());
      expect(applied).toMatchObject({ action: "apply", revision: 2 });

      const lengthPreview = await transport.previewStep(
        sessionId,
        applied.revision,
        {
          id: "label-length",
          kind: "textLength",
          params: { column: { id: "r:c:1", name: "label" }, newColumn: "label_length" }
        },
        pageWindow(),
        applied.page.schema
      );
      const lengthApplied = await transport.applyDraft(sessionId, lengthPreview.revision, pageWindow());
      expect(lengthApplied).toMatchObject({ action: "apply", revision: 4 });
      const derivedColumn = lengthApplied.page.schema.at(-1);
      expect(derivedColumn).toMatchObject({ id: "c:step:label-length:0", name: "label_length", type: "integer" });
      const lengthPage = await transport.getPage(sessionId, {
        ...pageWindow(),
        columnOffset: lengthApplied.page.schema.length - 1,
        columnLimit: 1
      });
      expect(lengthPage.page.columnIds).toEqual(["c:step:label-length:0"]);
      expect(lengthPage.page.rows.map((row) => row.values[0]?.display)).toEqual(["5", "4", "5"]);

      await transport.close(sessionId);
      await transport.close(readrSessionId);
      expect(transport.isSessionMapped(sessionId)).toBe(false);
      expect(await readFile(markerPath, "utf8")).toBe("executed\n");
      expect((await readdir(temporaryParent)).filter((name) => name.startsWith("openwrangler-r-"))).toEqual([]);

      const rerun = new RProcessSessionTransport({
        runtimeRoot,
        rscriptPath,
        temporaryParent,
        workingDirectory: temporaryParent,
        documentText: `${documentText}\n${lengthApplied.code}\n`
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

  it("parses every literate-document cell separately before any cell runs", async () => {
    const temporaryParent = await mkdtemp(resolve(tmpdir(), "ow-r-process-cells-test-"));
    const markerPath = resolve(temporaryParent, "must-not-exist.txt");
    const transport = new RProcessSessionTransport({
      runtimeRoot,
      rscriptPath,
      temporaryParent,
      workingDirectory: temporaryParent,
      documentText: [
        `cat("ran", file = ${rString(markerPath)})\nif (TRUE) {\n`,
        "combined_only_frame <- data.frame(id = 1L)\n}\n"
      ]
    });
    try {
      try {
        await expect(transport.discoverVariables({ timeoutMs: 10_000 })).rejects.toThrow(
          /R cell 1 could not be parsed/u
        );
        await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await transport.dispose();
        expect(await readdir(temporaryParent)).toEqual([]);
      }
    } finally {
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

async function exportedCsv(transport: RProcessSessionTransport, sessionId: string): Promise<string> {
  return (await exportedBytes(transport, sessionId, "csv")).toString("utf8");
}

async function exportedBytes(
  transport: RProcessSessionTransport,
  sessionId: string,
  format: "csv" | "parquet",
  revision = 0
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  await transport.exportData(sessionId, revision, format, async (chunk) => {
    chunks.push(Uint8Array.from(chunk));
  });
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
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
