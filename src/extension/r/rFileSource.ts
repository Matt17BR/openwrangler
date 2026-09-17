import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { isSessionSource } from "../../shared/protocolValidation";
import { FileBackendUnavailableError } from "../dataBridge";
import { RKernelBridge } from "./rKernelBridge";
import { RProcessSessionTransport, supportsRCsvImportOptions, type RProcessFileSource } from "./rProcessTransport";
import { configuredRscriptPath, supportsRFileExecution } from "./rscriptPath";

/** Creates a lazy, exact-file native R owner; the coordinator owns opening and replay. */
export function createRFileBridge(context: vscode.ExtensionContext, source: SessionSource): RKernelBridge {
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before opening a file with R.");
  if (!supportsRFileExecution())
    throw new FileBackendUnavailableError("Opening files with native R is supported on Linux, macOS and Windows.");
  if (
    !isSessionSource(source) ||
    source.kind !== "file" ||
    !source.path ||
    !path.isAbsolute(source.path) ||
    !source.uri
  ) {
    throw new Error("Native R requires an exact local file source.");
  }
  const uri = vscode.Uri.parse(source.uri, true);
  if (uri.scheme !== "file") throw new FileBackendUnavailableError("Native R requires a local file source.");
  if (path.resolve(uri.fsPath) !== path.resolve(source.path)) {
    throw new Error("Native R requires a matching local file path and URI.");
  }
  if (!/\.(csv|tsv|parquet|jsonl|ndjson|xlsx|xls)$/iu.test(source.path))
    throw new FileBackendUnavailableError(
      "Native R supports CSV, TSV, Parquet, JSONL, NDJSON, XLSX and XLS file sources."
    );
  const options = source.importOptions ?? {};
  const extension = path.extname(source.path).toLowerCase();
  let fileSource: RProcessFileSource;
  if (extension === ".csv" || extension === ".tsv") {
    if (
      Object.keys(options).some(
        (key) => !["delimiter", "encoding", "quoteChar", "hasHeader", "lineEnding"].includes(key)
      )
    ) {
      throw new FileBackendUnavailableError("Native R CSV/TSV requires delimited-text import options.");
    }
    const encoding = (options.encoding ?? "utf-8").toLowerCase();
    fileSource = Object.freeze({
      path: source.path,
      format: "csv",
      header: options.hasHeader ?? true,
      delimiter: options.delimiter ?? (extension === ".tsv" ? "\t" : ","),
      encoding: encoding === "utf8" ? "utf-8" : encoding,
      quoteChar: options.quoteChar ?? '"'
    });
    if (!supportsRCsvImportOptions(fileSource.delimiter, fileSource.quoteChar, fileSource.encoding)) {
      throw new FileBackendUnavailableError(
        "Native R CSV/TSV requires a supported text encoding and different ASCII delimiter and quote characters."
      );
    }
  } else if (extension === ".xlsx" || extension === ".xls") {
    if (Object.keys(options).some((key) => key !== "sheetName" && key !== "sheetIndex")) {
      throw new FileBackendUnavailableError(
        "Native R Excel requires only an exact worksheet name or zero-based sheet index."
      );
    }
    fileSource = Object.freeze({
      path: source.path,
      format: "excel",
      ...(options.sheetName !== undefined ? { sheetName: options.sheetName } : { sheetIndex: options.sheetIndex ?? 0 })
    });
  } else {
    if (Object.keys(options).length > 0)
      throw new FileBackendUnavailableError("Native R Parquet and JSONL do not accept import options.");
    fileSource = Object.freeze({ path: source.path, format: extension === ".parquet" ? "parquet" : "jsonl" });
  }
  const pinnedSource: SessionSource = Object.freeze({
    ...source,
    ...(source.importOptions ? { importOptions: Object.freeze({ ...source.importOptions }) } : {})
  });
  const rscriptPath = configuredRscriptPath(uri);
  if (!rscriptPath)
    throw new FileBackendUnavailableError(
      "Open Wrangler could not find Rscript. Set Open Wrangler: Rscript Path to an installed Rscript executable."
    );
  const create = (): RKernelBridge => {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before opening a file with R.");
    const transport = new RProcessSessionTransport({
      runtimeRoot: context.asAbsolutePath("r/openwrangler_runtime"),
      rscriptPath,
      workingDirectory: path.dirname(fileSource.path),
      fileSource
    });
    const bridge = new RKernelBridge(
      context,
      transport,
      undefined,
      undefined,
      undefined,
      {},
      async () => create(),
      pinnedSource
    );
    bridge.reportDiagnostic(`R file runtime selected: ${JSON.stringify(rscriptPath)}.`);
    return bridge;
  };
  return create();
}
