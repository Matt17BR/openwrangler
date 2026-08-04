import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PythonBridge, TrustedPicklePythonPreflight } from "../pythonBridge";
import { beginAtomicFileTransaction, type AtomicFileTransaction } from "./safeFileExport";
import {
  runTrustedPickleWorker,
  TrustedPickleConversionCancelledError,
  TrustedPickleProcessTreeUnconfirmedError,
  type TrustedPickleWorkerOptions
} from "./trustedPickleWorker";

export const CONVERT_TRUSTED_PICKLE_COMMAND = "openWrangler.convertTrustedPickle";
const PICKLE_EXTENSIONS = new Set([".pkl", ".pickle"]);

interface PickleSourceAnchor {
  readonly uri: vscode.Uri;
  readonly canonicalPath: string;
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  };
}

interface TrustedPickleConversionOverrides {
  readonly beginTransaction?: typeof beginAtomicFileTransaction;
  readonly runWorker?: (options: TrustedPickleWorkerOptions) => Promise<void>;
}

export function registerTrustedPickleConversion(
  context: vscode.ExtensionContext,
  bridge: PythonBridge,
  overrides: TrustedPickleConversionOverrides = {}
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CONVERT_TRUSTED_PICKLE_COMMAND, async (resource?: unknown) => {
      const selected = await resolvePickleSource(resource);
      if (!selected) return false;
      return convertTrustedPickle(context, bridge, selected, overrides);
    })
  );
}

export async function convertTrustedPickle(
  context: vscode.ExtensionContext,
  bridge: PythonBridge,
  source: vscode.Uri,
  overrides: TrustedPickleConversionOverrides = {}
): Promise<boolean> {
  if (!(await requireTrustedWorkspace())) return false;

  let anchor: PickleSourceAnchor;
  try {
    anchor = await capturePickleSource(source);
  } catch (error) {
    void vscode.window.showErrorMessage(asError(error).message);
    return false;
  }

  const selectedDestination = await vscode.window.showSaveDialog({
    title: "Convert Trusted Pickle to Parquet",
    defaultUri: defaultParquetDestination(source),
    filters: { Parquet: ["parquet"] },
    saveLabel: "Save Parquet"
  });
  if (!selectedDestination) return false;
  if (selectedDestination.scheme !== "file" || !selectedDestination.fsPath) {
    void vscode.window.showErrorMessage("Pickle conversion currently requires a local Parquet destination.");
    return false;
  }
  const destinationExtension = path.extname(selectedDestination.fsPath);
  if (destinationExtension.toLocaleLowerCase("en-US") !== ".parquet") {
    void vscode.window.showErrorMessage("Save the converted dataframe as a .parquet file.");
    return false;
  }
  const destination = selectedDestination;
  if (!(await sourceStillCurrent(anchor))) return false;

  let preflight: TrustedPicklePythonPreflight;
  try {
    preflight = await bridge.preflightTrustedPickleConversion(source);
  } catch (error) {
    void vscode.window.showErrorMessage(asError(error).message);
    return false;
  }

  const sourceLabel = path.basename(source.fsPath);
  const choice = await vscode.window.showWarningMessage(
    `Convert ${sourceLabel} with ${preflight.executable}?`,
    {
      modal: true,
      detail:
        `Loading a pickle can run Python code with your user permissions. Continue only if you trust ${sourceLabel}, ` +
        `know where it came from, and know it has not been modified. Open Wrangler will use ${preflight.executable}. ` +
        "The conversion output goes to a separate Parquet file; Open Wrangler does not overwrite the pickle."
    },
    "Convert"
  );
  if (choice !== "Convert") return false;
  if (!(await operationStillCurrent(bridge, preflight, anchor))) return false;

  if (preflight.missing.length > 0) {
    try {
      const previousPreflight = preflight;
      const installed = await bridge.installTrustedPickleDependencies(previousPreflight);
      if (!installed || !(await requireTrustedWorkspace())) return false;
      await assertPickleSourceUnchanged(anchor);
      preflight = await bridge.preflightTrustedPickleConversion(source, previousPreflight);
      if (preflight.missing.length > 0) {
        throw new Error(`Pickle conversion still needs ${preflight.missing.join(", ")}.`);
      }
      if (!(await operationStillCurrent(bridge, preflight, anchor))) return false;
    } catch (error) {
      void vscode.window.showErrorMessage(asError(error).message);
      return false;
    }
  }

  let transaction: AtomicFileTransaction | undefined;
  let committed = false;
  let workerTreeUnconfirmed = false;
  try {
    transaction = await (overrides.beginTransaction ?? beginAtomicFileTransaction)({
      destination,
      protectedSources: [source]
    });
    if (!(await operationStillCurrent(bridge, preflight, anchor))) return false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Converting ${sourceLabel} to Parquet`,
        cancellable: true
      },
      async (_progress, token) => {
        const controller = new AbortController();
        if (token.isCancellationRequested) controller.abort();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          if (!(await bridge.revalidateTrustedPicklePreflight(preflight))) {
            throw new TrustedPickleSelectionChangedError();
          }
          if (!bridge.isTrustedPicklePreflightCurrent(preflight)) {
            throw new TrustedPickleSelectionChangedError();
          }
          await bridge.withTrustedPicklePreflightLease(preflight, () =>
            (overrides.runWorker ?? runTrustedPickleWorker)({
              executable: preflight.executable,
              helperPath: context.asAbsolutePath(
                path.join("python", "openwrangler_runtime", "trusted_pickle_to_parquet.py")
              ),
              sourcePath: source.fsPath,
              destinationPath: transaction!.temporaryPath,
              sourceFingerprint: anchor.identity,
              signal: controller.signal
            })
          );
        } finally {
          cancellation.dispose();
        }
      }
    );
    if (!(await sourceStillCurrent(anchor))) return false;
    await transaction.commit();
    committed = true;
  } catch (error) {
    if (error instanceof TrustedPickleConversionCancelledError) {
      void vscode.window.showInformationMessage("Pickle conversion was cancelled.");
    } else if (error instanceof TrustedPickleSelectionChangedError) {
      showPythonSelectionChanged();
    } else if (error instanceof TrustedPickleProcessTreeUnconfirmedError) {
      workerTreeUnconfirmed = true;
      void vscode.window.showErrorMessage(
        "Open Wrangler could not confirm that the pickle converter stopped. Its unpublished Parquet file was left in place because the converter may still be using it."
      );
    } else {
      void vscode.window.showErrorMessage(asError(error).message);
    }
    return false;
  } finally {
    if (transaction && !committed) {
      try {
        if (workerTreeUnconfirmed) await transaction.abandon();
        else await transaction.rollback();
      } catch (error) {
        const action = workerTreeUnconfirmed ? "close" : "clean";
        void vscode.window.showErrorMessage(
          `Open Wrangler could not ${action} its unpublished Parquet file: ${asError(error).message}`
        );
      }
    }
  }

  const action = await vscode.window.showInformationMessage(
    `Converted ${sourceLabel} to ${path.basename(destination.fsPath)}.`,
    "Open in Open Wrangler"
  );
  if (action === "Open in Open Wrangler") {
    await vscode.commands.executeCommand("openWrangler.openFile", destination);
  }
  return true;
}

async function resolvePickleSource(resource: unknown): Promise<vscode.Uri | undefined> {
  if (resource instanceof vscode.Uri) return resource;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText && isLocalPickle(input.uri)) return input.uri;
  if (input instanceof vscode.TabInputTextDiff && isLocalPickle(input.modified)) return input.modified;
  if (input instanceof vscode.TabInputCustom && isLocalPickle(input.uri)) return input.uri;
  if (isLocalPickle(vscode.window.activeTextEditor?.document.uri)) {
    return vscode.window.activeTextEditor?.document.uri;
  }
  return (
    await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Python pickle": ["pkl", "pickle"] },
      openLabel: "Choose trusted pickle"
    })
  )?.[0];
}

function isLocalPickle(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return Boolean(
    uri?.scheme === "file" &&
    uri.fsPath &&
    path.isAbsolute(uri.fsPath) &&
    PICKLE_EXTENSIONS.has(path.extname(uri.fsPath).toLocaleLowerCase("en-US"))
  );
}

async function requireTrustedWorkspace(): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage("Trust this workspace before converting a pickle.");
  return false;
}

async function operationStillCurrent(
  bridge: PythonBridge,
  preflight: TrustedPicklePythonPreflight,
  anchor: PickleSourceAnchor
): Promise<boolean> {
  if (!(await sourceStillCurrent(anchor))) return false;
  if (bridge.isTrustedPicklePreflightCurrent(preflight)) return true;
  showPythonSelectionChanged();
  return false;
}

async function sourceStillCurrent(anchor: PickleSourceAnchor): Promise<boolean> {
  if (!(await requireTrustedWorkspace())) return false;
  try {
    await assertPickleSourceUnchanged(anchor);
  } catch (error) {
    void vscode.window.showErrorMessage(asError(error).message);
    return false;
  }
  return true;
}

class TrustedPickleSelectionChangedError extends Error {
  constructor() {
    super("The selected Python runtime changed before pickle conversion started.");
    this.name = "TrustedPickleSelectionChangedError";
  }
}

function showPythonSelectionChanged(): void {
  void vscode.window.showInformationMessage(
    "The selected Python runtime changed while pickle conversion was being confirmed. Run the command again."
  );
}

async function capturePickleSource(uri: vscode.Uri): Promise<PickleSourceAnchor> {
  if (uri.scheme !== "file" || !uri.fsPath || !path.isAbsolute(uri.fsPath)) {
    throw new Error("Choose a local .pkl or .pickle file.");
  }
  if (!PICKLE_EXTENSIONS.has(path.extname(uri.fsPath).toLocaleLowerCase("en-US"))) {
    throw new Error("Choose a .pkl or .pickle file.");
  }
  if (uri.fsPath.includes("\0")) throw new Error("Pickle paths cannot contain NUL bytes.");
  const details = await lstat(uri.fsPath, { bigint: true });
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("Choose a regular pickle file, not a symlink or special filesystem entry.");
  }
  return {
    uri,
    canonicalPath: await realpath(uri.fsPath),
    identity: {
      dev: details.dev,
      ino: details.ino,
      size: details.size,
      mtimeNs: details.mtimeNs,
      ctimeNs: details.ctimeNs
    }
  };
}

async function assertPickleSourceUnchanged(anchor: PickleSourceAnchor): Promise<void> {
  const current = await capturePickleSource(anchor.uri);
  if (
    comparablePath(current.canonicalPath) !== comparablePath(anchor.canonicalPath) ||
    current.identity.dev !== anchor.identity.dev ||
    current.identity.ino !== anchor.identity.ino ||
    current.identity.size !== anchor.identity.size ||
    current.identity.mtimeNs !== anchor.identity.mtimeNs ||
    current.identity.ctimeNs !== anchor.identity.ctimeNs
  ) {
    throw new Error("The pickle changed while conversion was being confirmed. Run the command again.");
  }
}

function defaultParquetDestination(source: vscode.Uri): vscode.Uri {
  const extension = path.extname(source.fsPath);
  const stem = path.basename(source.fsPath, extension);
  return vscode.Uri.file(path.join(path.dirname(source.fsPath), `${stem}.parquet`));
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
