import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionSource } from "../../shared/protocol";
import { isSessionSource } from "../../shared/protocolValidation";
import { FileBackendUnavailableError } from "../dataBridge";
import { RKernelBridge } from "./rKernelBridge";
import { RProcessSessionTransport, type RProcessFileSource } from "./rProcessTransport";
import { configuredRscriptPath, supportsRscriptExecution } from "./rscriptPath";

/** Creates a lazy, exact-file native R owner; the coordinator owns opening and replay. */
export function createRFileBridge(context: vscode.ExtensionContext, source: SessionSource): RKernelBridge {
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before opening CSV or TSV with R.");
  if (!supportsRscriptExecution())
    throw new FileBackendUnavailableError(
      "Opening CSV or TSV with native R is supported on Linux and macOS. R notebooks remain available on Windows."
    );
  if (
    !isSessionSource(source) ||
    source.kind !== "file" ||
    !source.path ||
    !path.isAbsolute(source.path) ||
    !source.uri
  ) {
    throw new Error("Native R requires an exact local CSV or TSV file source.");
  }
  const uri = vscode.Uri.parse(source.uri, true);
  if (uri.scheme !== "file") throw new FileBackendUnavailableError("Native R requires a local file source.");
  if (path.resolve(uri.fsPath) !== path.resolve(source.path)) {
    throw new Error("Native R requires a matching local CSV or TSV path and URI.");
  }
  if (!/\.(csv|tsv)$/iu.test(source.path))
    throw new FileBackendUnavailableError("Native R supports CSV and TSV file sources.");
  const options = source.importOptions ?? {};
  if (
    Object.keys(options).some(
      (key) => !["delimiter", "encoding", "quoteChar", "hasHeader", "lineEnding"].includes(key)
    ) ||
    (options.encoding !== undefined && options.encoding !== "utf-8" && options.encoding !== "utf8") ||
    (options.quoteChar !== undefined && options.quoteChar !== '"') ||
    options.lineEnding === "cr"
  ) {
    throw new FileBackendUnavailableError(
      "Native R CSV/TSV uses strict UTF-8, double-quote escaping and LF or CRLF records. Choose compatible import options."
    );
  }
  const fileSource: RProcessFileSource = Object.freeze({
    path: source.path,
    header: options.hasHeader ?? true,
    delimiter: options.delimiter ?? (/\.tsv$/iu.test(source.path) ? "\t" : ",")
  });
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
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before opening CSV or TSV with R.");
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
