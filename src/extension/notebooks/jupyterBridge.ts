import * as vscode from "vscode";
import type { DataBackend, SessionSource } from "../../shared/protocol";
import { OpenWranglerPanel } from "../webviewPanel";
import { KernelBridge, shouldRegisterNotebookFormatters } from "./kernelBridge";
import { SessionCoordinator } from "../sessionCoordinator";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";
import {
  discoverNotebookVariables,
  NotebookVariableDiscoveryError,
  notebookVariablePresentation,
  type NotebookVariableDescriptor
} from "./notebookVariableDiscovery";

interface NotebookVariableArgument {
  name?: unknown;
  variableName?: unknown;
  expression?: unknown;
  title?: unknown;
  type?: unknown;
  fileName?: unknown;
  variable?: {
    name?: unknown;
    variableName?: unknown;
    type?: unknown;
  };
}

interface JupyterLikeApi {
  kernels: { getKernel(uri: vscode.Uri): Promise<unknown> | unknown };
}

interface NotebookVariableQuickPickItem extends vscode.QuickPickItem {
  readonly variable: NotebookVariableDescriptor;
}

export const registerNotebookCommands = (context: vscode.ExtensionContext, coordinator: SessionCoordinator): void => {
  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.launchDataViewer", async (...args: unknown[]) => {
      const notebookResolution = resolveNotebookAtCommandReceipt(args);
      const variableName = variableNameFromArgs(args);
      const backend = backendFromArgs(args);
      if (!variableName) {
        vscode.window.showWarningMessage("Open Wrangler could not determine the notebook variable name to open.");
        return;
      }
      if (!notebookResolution.notebook) {
        vscode.window.showWarningMessage(notebookResolution.error);
        return;
      }

      openLiveNotebookVariable(context, coordinator, variableName, notebookResolution.notebook, backend);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openNotebookVariable", async (...args: unknown[]) => {
      const notebookResolution = resolveInteractiveNotebookAtCommandReceipt(args);
      const notebook = notebookResolution.notebook;
      if (!notebook) {
        vscode.window.showWarningMessage(notebookResolution.error);
        return;
      }

      let discovered;
      try {
        discovered = await discoverNotebookVariables(notebook);
      } catch (error) {
        vscode.window.showWarningMessage(
          error instanceof NotebookVariableDiscoveryError
            ? error.message
            : "Open Wrangler could not inspect dataframe variables in the selected notebook kernel."
        );
        return;
      }
      if (discovered.variables.length === 0) {
        vscode.window.showInformationMessage(
          "Open Wrangler did not find a Pandas, Polars, PySpark, or DuckDB dataframe variable in the active kernel."
        );
        return;
      }

      const items = discovered.variables.map(notebookVariableQuickPickItem);
      const selected = await vscode.window.showQuickPick(items, {
        title: "Open Wrangler: Open Notebook Variable",
        placeHolder: discovered.truncated
          ? "Open Wrangler: Select a dataframe variable (discovery results truncated)"
          : "Open Wrangler: Select a dataframe variable from the active Jupyter kernel",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
      });
      if (!isExactOpenNotebook(notebook)) {
        vscode.window.showWarningMessage("The originating notebook is no longer open. Reopen it and try again.");
        return;
      }
      if (!selected || !items.includes(selected)) {
        return;
      }
      openLiveNotebookVariable(context, coordinator, selected.variable.name, notebook, selected.variable.backend);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.checkJupyterIntegration", async () => {
      const notebookResolution = resolveNotebookAtCommandReceipt([]);
      const jupyter = vscode.extensions.getExtension<JupyterLikeApi>("ms-toolsai.jupyter");
      if (!jupyter) {
        vscode.window.showInformationMessage(
          "Install the VS Code Jupyter extension to launch live notebook variables."
        );
        return;
      }
      const api = await jupyter.activate();
      const notebook = notebookResolution.notebook;
      if (notebook && !isExactOpenNotebook(notebook)) {
        vscode.window.showWarningMessage(
          "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
        );
        return;
      }
      const kernel = notebook ? await api.kernels.getKernel(notebook.uri) : undefined;
      if (notebook && !isExactOpenNotebook(notebook)) {
        vscode.window.showWarningMessage(
          "The originating notebook is no longer open. Reopen it and check the Jupyter integration again."
        );
        return;
      }
      vscode.window.showInformationMessage(
        kernel
          ? "Open Wrangler can access the selected Jupyter kernel."
          : "Open Wrangler found Jupyter, but no active notebook kernel is selected."
      );
    })
  );
};

function notebookVariableQuickPickItem(variable: NotebookVariableDescriptor): NotebookVariableQuickPickItem {
  const presentation = notebookVariablePresentation(variable.type);
  const detail =
    variable.backend === "pyspark"
      ? "Viewing only · First page loads without counting rows · PySpark 4.2.x required"
      : variable.backend === "duckdb"
        ? `${variable.type} · Live viewing-only session`
        : `${variable.type} · Live notebook session`;
  return {
    label: variable.name,
    description: `${presentation.family} · ${presentation.kind}`,
    detail,
    variable
  };
}

function openLiveNotebookVariable(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  variableName: string,
  notebook: vscode.NotebookDocument,
  backend?: DataBackend
): void {
  if (!isExactOpenNotebook(notebook)) {
    vscode.window.showWarningMessage("The originating notebook is no longer open. Reopen it and try again.");
    return;
  }

  const source: SessionSource = {
    kind: "notebookVariable",
    label: variableName,
    variableName,
    uri: notebook.uri.toString()
  };
  const bridge = coordinator.createBridge(
    new KernelBridge(context, notebook, shouldRegisterNotebookFormatters()),
    notebook
  );
  if (backend) {
    OpenWranglerPanel.create(context, bridge, source, backend);
  } else {
    OpenWranglerPanel.create(context, bridge, source);
  }
}

const PYSPARK_DATAFRAME_TYPES = new Set([
  "pyspark.sql.dataframe.DataFrame",
  "pyspark.sql.classic.dataframe.DataFrame",
  "pyspark.sql.connect.dataframe.DataFrame"
]);
const DUCKDB_RELATION_TYPES = new Set([
  "DuckDBPyRelation",
  "_duckdb.DuckDBPyRelation",
  "duckdb.duckdb.DuckDBPyRelation"
]);

function backendFromArgs(args: unknown[]): DataBackend | undefined {
  for (const arg of args) {
    if (typeof arg !== "object" || arg === null) continue;
    const candidate = arg as NotebookVariableArgument;
    for (const typeName of [candidate.type, candidate.variable?.type]) {
      if (typeof typeName === "string" && PYSPARK_DATAFRAME_TYPES.has(typeName)) return "pyspark";
      if (typeof typeName === "string" && DUCKDB_RELATION_TYPES.has(typeName)) return "duckdb";
    }
  }
  return undefined;
}

function variableNameFromArgs(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg === "string" && isPythonIdentifier(arg)) {
      return arg;
    }
    if (typeof arg !== "object" || arg === null) {
      continue;
    }
    const candidate = arg as NotebookVariableArgument;
    const value =
      stringValue(candidate.variableName) ??
      stringValue(candidate.name) ??
      stringValue(candidate.expression) ??
      stringValue(candidate.title) ??
      stringValue(candidate.variable?.variableName) ??
      stringValue(candidate.variable?.name);
    if (value && isPythonIdentifier(value)) {
      return value;
    }
  }
  return undefined;
}

type ExplicitNotebookOrigins = { kind: "none" } | { kind: "invalid" } | { kind: "uris"; uris: vscode.Uri[] };

function explicitNotebookOriginsFromArgs(args: unknown[]): ExplicitNotebookOrigins {
  const uris: vscode.Uri[] = [];
  for (const arg of args) {
    try {
      if (arg instanceof vscode.Uri) {
        uris.push(arg);
        continue;
      }
      if (typeof arg !== "object" || arg === null) {
        continue;
      }
      if (hasOwnPropertySafely(arg, "$mid")) {
        return { kind: "invalid" };
      }
      if (hasOwnPropertySafely(arg, "notebookUri") || hasOwnPropertySafely(arg, "uri")) {
        return { kind: "invalid" };
      }
      const candidate = arg as NotebookVariableArgument;
      if (candidate.fileName !== undefined) {
        const fileName = releasedJupyterFileNameUri(candidate.fileName);
        if (!fileName) {
          return { kind: "invalid" };
        }
        uris.push(fileName);
      }
    } catch {
      return { kind: "invalid" };
    }
  }
  return uris.length > 0 ? { kind: "uris", uris } : { kind: "none" };
}

const SERIALIZED_URI_KEYS = new Set([
  "$mid",
  "scheme",
  "authority",
  "path",
  "query",
  "fragment",
  "external",
  "fsPath",
  "_sep"
]);
const SERIALIZED_URI_MAX_CORE_LENGTH = 8 * 1024;
const SERIALIZED_URI_MAX_CORE_TOTAL_LENGTH = 16 * 1024;
const SERIALIZED_URI_MAX_CACHE_LENGTH = 64 * 1024;
const SERIALIZED_URI_MAX_TOTAL_LENGTH = 144 * 1024;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;

function releasedJupyterFileNameUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (!isCanonicalSerializedUriRecord(value)) {
    return undefined;
  }

  const scheme = serializedUriString(value, "scheme", true);
  const path = serializedUriString(value, "path", true);
  const authority = serializedUriString(value, "authority");
  const query = serializedUriString(value, "query");
  const fragment = serializedUriString(value, "fragment");
  const external = serializedUriString(value, "external");
  const fsPath = serializedUriString(value, "fsPath");
  if (
    value.$mid !== 1 ||
    !scheme ||
    !URI_SCHEME.test(scheme) ||
    !path ||
    authority === null ||
    query === null ||
    fragment === null ||
    external === null ||
    fsPath === null ||
    (value._sep !== undefined && (value._sep !== 1 || fsPath === undefined))
  ) {
    return undefined;
  }

  const coreStrings = [scheme, path, authority, query, fragment].filter(
    (component): component is string => component !== undefined
  );
  const cacheStrings = [external, fsPath].filter((component): component is string => component !== undefined);
  const coreByteLengths = coreStrings.map(serializedUriUtf8Length);
  const cacheByteLengths = cacheStrings.map(serializedUriUtf8Length);
  if (
    coreByteLengths.some((length) => length === undefined || length > SERIALIZED_URI_MAX_CORE_LENGTH) ||
    cacheByteLengths.some((length) => length === undefined || length > SERIALIZED_URI_MAX_CACHE_LENGTH)
  ) {
    return undefined;
  }
  const coreTotalLength = coreByteLengths.reduce<number>((total, length) => total + (length ?? 0), 0);
  const cacheTotalLength = cacheByteLengths.reduce<number>((total, length) => total + (length ?? 0), 0);
  if (
    coreTotalLength > SERIALIZED_URI_MAX_CORE_TOTAL_LENGTH ||
    coreTotalLength + cacheTotalLength > SERIALIZED_URI_MAX_TOTAL_LENGTH
  ) {
    return undefined;
  }

  try {
    const uri = vscode.Uri.from({ scheme, authority, path, query, fragment });
    if (
      uri.scheme !== scheme ||
      uri.authority !== (authority ?? "") ||
      uri.path !== path ||
      uri.query !== (query ?? "") ||
      uri.fragment !== (fragment ?? "")
    ) {
      return undefined;
    }
    if (external !== undefined) {
      void uri.toString();
    }
    if (fsPath !== undefined) {
      void uri.fsPath;
    }
    const canonical = JSON.parse(JSON.stringify(uri)) as unknown;
    if (!sameSerializedUriRecord(value, canonical)) {
      return undefined;
    }
    return uri;
  } catch {
    return undefined;
  }
}

function serializedUriUtf8Length(value: string): number | undefined {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return undefined;
    }
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        return undefined;
      }
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return undefined;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function sameSerializedUriRecord(expected: Record<string, unknown>, actual: unknown): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return false;
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualRecord = actual as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord).sort();
  return (
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every((key, index) => key === actualKeys[index] && expected[key] === actualRecord[key])
  );
}

function isCanonicalSerializedUriRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype) {
      return false;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    return (
      keys.length > 0 &&
      keys.every((key) => {
        const descriptor = descriptors[key];
        return (
          SERIALIZED_URI_KEYS.has(key) &&
          descriptor !== undefined &&
          descriptor.enumerable === true &&
          descriptor.configurable === true &&
          "value" in descriptor &&
          descriptor.writable === true
        );
      })
    );
  } catch {
    return false;
  }
}

function serializedUriString(value: Record<string, unknown>, key: string, required = false): string | undefined | null {
  const component = value[key];
  if (component === undefined) {
    return required || Object.hasOwn(value, key) ? null : undefined;
  }
  return typeof component === "string" && component.length > 0 ? component : null;
}

function hasOwnPropertySafely(value: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

type NotebookResolution = { notebook: vscode.NotebookDocument; error?: never } | { notebook?: never; error: string };

function resolveNotebookAtCommandReceipt(args: unknown[]): NotebookResolution {
  const explicitOrigins = explicitNotebookOriginsFromArgs(args);
  if (explicitOrigins.kind === "invalid") {
    return {
      error: "Open Wrangler received an invalid originating notebook. Launch the variable again from its notebook."
    };
  }
  if (explicitOrigins.kind === "uris") {
    const explicitUris = explicitOrigins.uris;
    const uriKeys = new Set(explicitUris.map((uri) => uri.toString()));
    if (uriKeys.size !== 1) {
      return {
        error: "Open Wrangler received more than one originating notebook. Launch the variable again from one notebook."
      };
    }
    const uriKey = explicitUris[0]?.toString();
    if (!uriKey) {
      return { error: "The originating notebook is no longer open. Reopen it and try again." };
    }
    const matches = vscode.workspace.notebookDocuments.filter(
      (document) => !document.isClosed && document.uri.toString() === uriKey
    );
    if (matches.length === 1 && matches[0]) return { notebook: matches[0] };
    if (matches.length > 1) {
      return {
        error:
          "Open Wrangler could not identify one originating notebook. Close duplicate notebook views and try again."
      };
    }
    return { error: "The originating notebook is no longer open. Reopen it and try again." };
  }

  return resolveActiveNotebookAtCommandReceipt();
}

function resolveInteractiveNotebookAtCommandReceipt(args: unknown[]): NotebookResolution {
  const explicitUris = args.filter((arg): arg is vscode.Uri => arg instanceof vscode.Uri);
  return resolveActiveNotebookAtCommandReceipt(explicitUris);
}

function resolveActiveNotebookAtCommandReceipt(explicitUris: vscode.Uri[] = []): NotebookResolution {
  const editorNotebook = vscode.window.activeNotebookEditor?.notebook;
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab && !(activeTab.input instanceof vscode.TabInputNotebook)) {
    return {
      error: "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    };
  }

  const tabUri = activeTab?.input instanceof vscode.TabInputNotebook ? activeTab.input.uri : undefined;
  const editorUri = editorNotebook?.uri;
  const originUris = [...explicitUris, ...(editorUri ? [editorUri] : []), ...(tabUri ? [tabUri] : [])];
  const uriKeys = new Set(originUris.map((uri) => uri.toString()));
  if (uriKeys.size > 1) {
    return {
      error: "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    };
  }

  const originUri = originUris[0];
  if (!originUri) {
    return { error: "Open a Jupyter notebook before launching a notebook variable in Open Wrangler." };
  }

  const uriKey = originUri.toString();
  const matches = vscode.workspace.notebookDocuments.filter(
    (document) => !document.isClosed && document.uri.toString() === uriKey
  );
  if (matches.length > 1) {
    return {
      error: "Open Wrangler could not identify one active notebook. Close duplicate notebook views and try again."
    };
  }
  const notebook = matches[0];
  if (
    !notebook ||
    notebook.notebookType !== "jupyter-notebook" ||
    (editorNotebook && editorNotebook !== notebook) ||
    (activeTab?.input instanceof vscode.TabInputNotebook && activeTab.input.notebookType !== notebook.notebookType)
  ) {
    return {
      error: "Open Wrangler could not identify one active notebook. Return to one notebook and try again."
    };
  }
  return { notebook };
}

function isExactOpenNotebook(notebook: vscode.NotebookDocument): boolean {
  return isSoleOpenNotebookDocument(notebook);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
