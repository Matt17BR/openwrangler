import * as path from "path";
import * as vscode from "vscode";
import type { DataBackend, SessionSource } from "../../shared/protocol";
import { isSessionSource } from "../../shared/protocolValidation";
import { FileBackendUnavailableError, type CancellationTokenLike, type OpenWranglerBridge } from "../dataBridge";
import { OpenWranglerPanel } from "../webviewPanel";
import { getSetting } from "../configuration";
import { formatQuickPickName } from "../quickPickName";
import { confirmedFileConfiguration } from "./confirmedFileConfigurations";
import { detectImportOptions } from "./importOptions";
import { captureSessionSourceProtection, confirmSessionSourceProtection } from "./safeFileExport";

const CUSTOM_EDITOR_ID = "openWrangler.viewer";
type FileDataBackend = Extract<DataBackend, "polars" | "duckdb" | "pandas" | "r">;
export type RFileBridgeFactory = (
  source: SessionSource,
  bindDelegate?: (delegate: OpenWranglerBridge) => OpenWranglerBridge
) => Promise<OpenWranglerBridge>;

async function selectFileBridge(
  source: SessionSource,
  backend: FileDataBackend | undefined,
  pythonBridge: OpenWranglerBridge,
  createRBridge: RFileBridgeFactory | undefined,
  cancellation?: CancellationTokenLike
): Promise<{ bridge: OpenWranglerBridge; backend: FileDataBackend | undefined; isCurrent(): boolean }> {
  const current = (): boolean => vscode.workspace.isTrusted && !cancellation?.isCancellationRequested;
  const preflight =
    backend === undefined && createRBridge
      ? await pythonBridge.prepareFileAutoFallback?.(source, { cancellation })
      : undefined;
  const fallback = preflight && !("kind" in preflight) ? preflight : undefined;
  if (backend !== "r" && !fallback)
    return { bridge: pythonBridge, backend, isCurrent: () => !cancellation?.isCancellationRequested };
  if (!current() || (fallback && !fallback.isCurrent()))
    throw new Error("The file runtime selection changed. Open the file again.");
  if (!createRBridge) throw new Error("Native R file opening is unavailable in this extension host.");
  try {
    return {
      bridge: await createRBridge(source),
      backend: "r",
      isCurrent: () => current() && (!fallback || fallback.isCurrent())
    };
  } catch (error) {
    if (fallback && error instanceof FileBackendUnavailableError)
      return { bridge: pythonBridge, backend, isCurrent: () => current() && fallback.isCurrent() };
    throw error;
  }
}

export class OpenWranglerCustomEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: OpenWranglerBridge,
    private readonly createRBridge?: RFileBridgeFactory
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return {
      uri,
      dispose: () => undefined
    };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (token.isCancellationRequested) return;
    const valid = await validateFileTarget(document.uri, false, token);
    if (token.isCancellationRequested) return;
    if (!valid) {
      webviewPanel.dispose();
      return;
    }
    const confirmed = confirmedFileConfiguration(this.context.workspaceState, document.uri);
    const importOptions = confirmed?.importOptions ?? (await detectImportOptions(document.uri));
    if (token.isCancellationRequested) return;
    const source = fileSource(document.uri, importOptions);
    const configuredBackend = getConfiguredBackend();
    const backend = confirmed?.backend ?? backendPin(configuredBackend);
    let selected: Awaited<ReturnType<typeof selectFileBridge>> | undefined;
    let handedOff = false;
    try {
      selected = await selectFileBridge(
        source,
        backend as FileDataBackend | undefined,
        this.bridge,
        this.createRBridge,
        token
      );
      if (token.isCancellationRequested) return;
      if (!selected.isCurrent()) throw new Error("The file runtime selection changed. Open the file again.");
      new OpenWranglerPanel(
        webviewPanel,
        this.context,
        selected.bridge,
        source,
        selected.backend,
        true,
        confirmed?.backendPreference ?? configuredBackend
      );
      handedOff = true;
    } catch (error) {
      if (!token.isCancellationRequested) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        webviewPanel.dispose();
      }
    } finally {
      if (!handedOff && selected && selected.bridge !== this.bridge) selected.bridge.onIdle?.();
    }
  }
}

export const registerFileCommands = (
  context: vscode.ExtensionContext,
  bridge: OpenWranglerBridge,
  createRBridge?: RFileBridgeFactory
): void => {
  let disposed = false;
  const openSource = async (
    source: SessionSource,
    backendPreference: FileDataBackend | "auto",
    isCurrent: () => boolean = () => true
  ): Promise<void> => {
    if (!isCurrent()) return;
    let selected: Awaited<ReturnType<typeof selectFileBridge>> | undefined;
    let handedOff = false;
    try {
      selected = await selectFileBridge(source, backendPin(backendPreference), bridge, createRBridge, {
        get isCancellationRequested() {
          return !isCurrent();
        },
        onCancellationRequested: () => ({ dispose: () => undefined })
      });
      if (!isCurrent()) return;
      if (!selected.isCurrent()) throw new Error("The file runtime selection changed. Open the file again.");
      OpenWranglerPanel.create(context, selected.bridge, source, selected.backend, backendPreference);
      handedOff = true;
    } catch (error) {
      if (isCurrent()) await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (!handedOff && selected && selected.bridge !== bridge) selected.bridge.onIdle?.();
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "openWrangler.internal.openFileWithEngine",
      async (source: unknown, backend: unknown, isCurrent: unknown) => {
        if (
          !isSessionSource(source) ||
          source.kind !== "file" ||
          !source.path ||
          !path.isAbsolute(source.path) ||
          !source.uri ||
          typeof backend !== "string" ||
          !fileDataBackends.has(backend as FileDataBackend) ||
          typeof isCurrent !== "function"
        )
          return;
        const current = isCurrent as () => boolean;
        const captured = structuredClone(source);
        const uri = vscode.Uri.parse(captured.uri as string, true);
        if (
          !current() ||
          uri.scheme !== "file" ||
          path.resolve(uri.fsPath) !== path.resolve(captured.path as string) ||
          !(await validateFileTarget(uri)) ||
          !current()
        )
          return;
        await openSource(captured, backend as FileDataBackend, current);
      }
    )
  );
  const databaseOpens = new Set<vscode.CancellationTokenSource>();
  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      for (const attempt of databaseOpens) attempt.cancel();
    }
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openDuckDBTable", async () => {
      if (!vscode.workspace.isTrusted) {
        await vscode.window.showInformationMessage("Trust this workspace before opening a DuckDB database.");
        return;
      }
      const attempt = new vscode.CancellationTokenSource();
      const token = attempt.token;
      databaseOpens.add(attempt);
      try {
        const files = await vscode.window.showOpenDialog({
          title: "Open DuckDB Table",
          canSelectMany: false,
          canSelectFolders: false,
          canSelectFiles: true
        });
        const selected = files?.[0];
        if (!selected || token.isCancellationRequested) return;
        if (selected.scheme !== "file") {
          await vscode.window.showWarningMessage("Choose a local DuckDB database file.");
          return;
        }
        if (!(await validateRegularFileTarget(selected, token))) return;
        const protection = await captureSessionSourceProtection([selected]);
        if (!protection.available) {
          await vscode.window.showWarningMessage("Could not identify this database file. Choose it again.");
          return;
        }
        const source = fileSource(selected);
        const discovered = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Reading DuckDB tables",
            cancellable: true
          },
          async (_progress, cancellation) => {
            const subscription = cancellation.onCancellationRequested(() => attempt.cancel());
            try {
              return await bridge.discoverDuckDBTables?.(source, { cancellation: token });
            } finally {
              subscription.dispose();
            }
          }
        );
        if (token.isCancellationRequested || !discovered) return;
        if ("kind" in discovered) {
          await vscode.window.showErrorMessage(discovered.message);
          return;
        }
        const current = async (): Promise<boolean> => {
          const confirmed = await confirmSessionSourceProtection(protection);
          return confirmed.available && discovered.isCurrent() && !token.isCancellationRequested;
        };
        if (!(await current())) {
          await vscode.window.showWarningMessage(
            "The database file or Python runtime changed. Choose the database again."
          );
          return;
        }
        if (discovered.tables.length === 0) {
          await vscode.window.showInformationMessage(
            "This DuckDB database has no user tables. Views are not supported."
          );
          return;
        }
        const choices = discovered.tables.map((table) => ({
          label: formatQuickPickName(table.name),
          description: `Schema: ${formatQuickPickName(table.schema)}`,
          table
        }));
        const choice = await vscode.window.showQuickPick(
          choices,
          {
            title: "Open DuckDB Table",
            placeHolder: "Search shown names (JSON escapes). Database writers are blocked until the viewer closes.",
            matchOnDescription: true
          },
          token
        );
        if (!choice || token.isCancellationRequested) return;
        if (!(await current())) {
          await vscode.window.showWarningMessage(
            "The database file or Python runtime changed. Choose the database again."
          );
          return;
        }
        const selectedSource: SessionSource = {
          ...source,
          importOptions: { duckdbSchema: choice.table.schema, duckdbTable: choice.table.name }
        };
        let initialOpenComplete = false;
        const scopedBridge: OpenWranglerBridge = {
          ...bridge,
          request: async (request, options) => {
            if (request.kind !== "openSession" || initialOpenComplete) return bridge.request(request, options);
            if (
              request.source.kind !== "file" ||
              request.source.path !== selectedSource.path ||
              request.source.uri !== selectedSource.uri ||
              request.source.importOptions?.duckdbSchema !== selectedSource.importOptions?.duckdbSchema ||
              request.source.importOptions?.duckdbTable !== selectedSource.importOptions?.duckdbTable ||
              !(await current())
            )
              return {
                kind: "error",
                code: "duckdb_selection_changed",
                recoverable: true,
                message: "The database file or Python runtime changed. Choose the database again."
              };
            const response = await bridge.request(request, {
              ...options,
              requiredSourceProtection: protection,
              cancellation: {
                get isCancellationRequested() {
                  return !discovered.isCurrent() || Boolean(options?.cancellation?.isCancellationRequested);
                },
                onCancellationRequested: (listener) =>
                  options?.cancellation?.onCancellationRequested(listener) ?? { dispose: () => undefined }
              }
            });
            if (response.kind === "sessionOpened") initialOpenComplete = true;
            return response;
          }
        };
        OpenWranglerPanel.create(context, scopedBridge, selectedSource, "duckdb", "duckdb", "viewing");
      } finally {
        databaseOpens.delete(attempt);
        attempt.dispose();
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openFileWithPlan", async () => {
      const captured = bridge.captureActiveFilePlan?.();
      if (!captured) {
        await vscode.window.showInformationMessage(
          "Open a file with a confirmed cleaning plan before using it on another file."
        );
        return;
      }
      if ("kind" in captured) {
        await vscode.window.showInformationMessage(captured.message);
        return;
      }
      const enabledFileTypes = getEnabledFileTypes();
      if (enabledFileTypes.length === 0) {
        await vscode.window.showWarningMessage("Enable at least one Open Wrangler file type in Settings.");
        return;
      }
      const files = await vscode.window.showOpenDialog({
        title: "Open Another File with This Plan",
        canSelectMany: false,
        filters: { "Data files": enabledFileTypes }
      });
      const selected = files?.[0];
      if (!selected || disposed || !captured.isCurrent() || !(await validateFileTarget(selected))) return;
      const source = fileSource(selected, captured.importOptions);
      let targetBridge: OpenWranglerBridge | undefined;
      let handedOff = false;
      try {
        if (disposed || !captured.isCurrent()) return;
        if (captured.backend === "r") {
          if (!createRBridge) throw new Error("Native R file opening is unavailable in this extension host.");
          targetBridge = await createRBridge(source, captured.createBridge);
        } else targetBridge = captured.createBridge();
        if (disposed || !captured.isCurrent()) return;
        OpenWranglerPanel.create(context, targetBridge, source, captured.backend, captured.backend, "editing");
        handedOff = true;
      } catch (error) {
        if (!disposed) await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        if (!handedOff && captured.backend === "r") targetBridge?.onIdle?.();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.changeImportOptions", async () => {
      if (await OpenWranglerPanel.changeActiveImportOptions()) return;
      await vscode.window.showInformationMessage(
        "Open a CSV, TSV, XLSX, or XLS session in Open Wrangler before changing import options."
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openFile", async (resource?: unknown) => {
      const target = resolveFileTarget(resource);
      if (!target) {
        await vscode.commands.executeCommand("openWrangler.openPath");
        return;
      }
      if (!(await validateFileTarget(target))) return;

      const configuredBackend = getConfiguredBackend();
      await openSource(fileSource(target, await detectImportOptions(target)), configuredBackend);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openPath", async () => {
      const enabledFileTypes = getEnabledFileTypes();
      if (enabledFileTypes.length === 0) {
        await vscode.window.showWarningMessage("Enable at least one Open Wrangler file type in Settings.");
        return;
      }
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          "Data files": enabledFileTypes
        }
      });
      const selected = files?.[0];
      if (!selected) {
        return;
      }
      if (!(await validateFileTarget(selected))) return;

      const configuredBackend = getConfiguredBackend();
      await openSource(fileSource(selected, await detectImportOptions(selected)), configuredBackend);
    })
  );
};

const fileSource = (uri: vscode.Uri, importOptions?: SessionSource["importOptions"]): SessionSource => ({
  kind: "file",
  label: path.basename(uri.fsPath),
  path: uri.fsPath,
  uri: uri.toString(),
  ...(importOptions ? { importOptions } : {})
});

const fileDataBackends = new Set<FileDataBackend>(["polars", "duckdb", "pandas", "r"]);

const getConfiguredBackend = (): FileDataBackend | "auto" => {
  const configured = getSetting<unknown>("defaultBackend", "auto");
  return configured === "auto" ||
    (typeof configured === "string" && fileDataBackends.has(configured as FileDataBackend))
    ? (configured as FileDataBackend | "auto")
    : "auto";
};

const backendPin = (configured: FileDataBackend | "auto"): FileDataBackend | undefined =>
  configured === "auto" ? undefined : configured;

const allFileTypes = ["csv", "tsv", "parquet", "jsonl", "xlsx", "xls"] as const;
const configurableFileTypes = new Set<string>(allFileTypes);
const supportedFileTypes = new Set<string>([...allFileTypes, "ndjson"]);
const supportedSchemes = new Set(["file", "vscode-remote"]);

const getEnabledFileTypes = (): string[] => {
  const configured = getSetting<unknown>("enabledFileTypes", [...allFileTypes]);
  const enabledFileTypes: readonly string[] = Array.isArray(configured)
    ? configured.filter(
        (extension): extension is string => typeof extension === "string" && configurableFileTypes.has(extension)
      )
    : allFileTypes;
  return enabledFileTypes.flatMap((extension) => (extension === "jsonl" ? ["jsonl", "ndjson"] : [extension]));
};

const fileType = (uri: vscode.Uri): string => path.extname(uri.fsPath).slice(1).toLowerCase();

const resolveFileTarget = (resource: unknown): vscode.Uri | undefined => {
  if (resource instanceof vscode.Uri) return resource;

  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  if (input instanceof vscode.TabInputCustom && input.viewType !== CUSTOM_EDITOR_ID) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
};

const validateFileTarget = async (
  uri: vscode.Uri,
  requireEnabledType = true,
  cancellation?: vscode.CancellationToken
): Promise<boolean> => {
  if (uri.scheme === "untitled") {
    await vscode.window.showWarningMessage("Save this data file before opening it in Open Wrangler.");
    return false;
  }
  if (!supportedSchemes.has(uri.scheme)) {
    await vscode.window.showWarningMessage(
      "Open Wrangler can open local files and files in VS Code remote workspaces."
    );
    return false;
  }

  const extension = fileType(uri);
  if (!supportedFileTypes.has(extension)) {
    await vscode.window.showWarningMessage(
      "Open Wrangler supports CSV, TSV, Parquet, JSONL/NDJSON, XLSX, and XLS files."
    );
    return false;
  }
  if (requireEnabledType && !getEnabledFileTypes().includes(extension)) {
    await vscode.window.showWarningMessage(`.${extension} is disabled in Open Wrangler settings.`);
    return false;
  }

  return validateRegularFileTarget(uri, cancellation);
};

const validateRegularFileTarget = async (
  uri: vscode.Uri,
  cancellation?: vscode.CancellationToken
): Promise<boolean> => {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (cancellation?.isCancellationRequested) return false;
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      await vscode.window.showWarningMessage("Choose a data file, not a folder.");
      return false;
    }
    if ((stat.type & vscode.FileType.File) === 0) {
      await vscode.window.showWarningMessage("Choose a regular data file, not a special filesystem resource.");
      return false;
    }
  } catch {
    if (cancellation?.isCancellationRequested) return false;
    await vscode.window.showErrorMessage(`Open Wrangler could not access ${uri.toString()}.`);
    return false;
  }
  return true;
};
