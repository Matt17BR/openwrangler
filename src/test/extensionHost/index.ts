import * as assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import * as vscode from "vscode";
import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type ElementHandle,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Response
} from "playwright-core";
import type { Jupyter, JupyterServerCollection, KernelStatus } from "@vscode/jupyter-extension";
import type { PythonExtension } from "@vscode/python-extension";
import { DEFAULT_SESSION_OPEN_TIMEOUT_MS, getSetting } from "../../extension/configuration";
import { IMPORT_DETECTION_SAMPLE_BYTES } from "../../extension/files/importDetection";
import { insertGeneratedNotebookCell } from "../../extension/notebooks/notebookInsertion";
import type { SessionSchedulerState } from "../../extension/sessionCoordinator";
import {
  normalizeNotebookOutputPayload,
  OPEN_WRANGLER_MIME_V2,
  type NotebookOutputPayload
} from "../../shared/notebookOutput";
import type {
  ColumnReference,
  GridPage,
  OpenWranglerRequest,
  OpenWranglerResponse,
  FilterModel,
  SessionMetadata,
  SessionSource,
  StepInspectionResponse,
  TransformStep
} from "../../shared/protocol";
import type { GridViewState, PersistedViewingState } from "../../shared/viewState";
import {
  acquirePreparedAcceptanceAction,
  activateReplaceableAcceptanceLocator,
  ignoreRetiredRendererProbeFailure,
  invokeAcceptanceActionOnceWithAuthoritativeReceipt,
  isRetiredRendererTarget,
  pollAcceptanceCondition,
  pressKeyboardKeyPairWithoutTransitionGap,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";
import { findExactActiveNotebookRendererButton } from "./notebookRendererFrame";
import {
  ACCEPTANCE_PROGRESS_PROTOCOL,
  failedAcceptanceProgressCheckpoint,
  writeAcceptanceProgressCheckpoint
} from "./progress";
import { readReleasedRemoteJupyterDescriptorToken } from "./remoteJupyterDescriptor";
import {
  releasedNotebookExecutionFailureMessage,
  releasedNotebookOutputClassification
} from "./releasedNotebookFailure";
import {
  PACKAGED_FIRST_USE_ROW_COUNT,
  PACKAGED_PANDAS_NOTEBOOK_OUTPUT,
  PACKAGED_PANDAS_NOTEBOOK_VIEWPORT,
  PACKAGED_SCREENSHOT_COLUMNS,
  PACKAGED_SCREENSHOT_FEATURED_COLUMNS,
  PACKAGED_SCREENSHOT_ROW_COUNT,
  PACKAGED_SCREENSHOT_VIEWPORT,
  packagedScreenshotFeaturedColumnWidths,
  packagedScreenshotFileName,
  packagedFirstUseAccountNoteKind,
  packagedFirstUseFixtureCsv,
  packagedScreenshotFixtureCsv,
  packagedScreenshotRow
} from "./screenshotEvidence";
import { prioritizeNewestRendererTargets } from "./webviewTargetOrdering";

interface TestApi {
  request(request: OpenWranglerRequest): Promise<OpenWranglerResponse>;
  setActiveSession(sessionId: string | undefined): void;
  activeSession():
    | {
        sessionId: string;
        metadata: SessionMetadata;
        code?: string;
        viewState: PersistedViewingState;
        stepInspection?: StepInspectionResponse;
      }
    | undefined;
  updateViewState(sessionId: string, state: GridViewState): Promise<void>;
  synchronizePanel(sessionId: string): Promise<boolean>;
  previewPanelStep(
    request: Extract<OpenWranglerRequest, { kind: "previewStep" }>
  ): Promise<Extract<OpenWranglerResponse, { kind: "sessionOpened" }> | undefined>;
  panelHydrated(sessionId: string): boolean;
  sessionSchedulerState(sessionId: string): SessionSchedulerState | undefined;
  panelOpenResponse(): OpenWranglerResponse | undefined;
  diagnostics(): {
    activeSessionId?: string;
    sessionCount: number;
    sessions: Array<{ publicId: string; runtimeId: string; sourceLabel: string }>;
  };
  restartRuntime(reason?: string): void;
  runtimeGeneration(): number;
  runtimeRunning(): boolean;
  runtimeEnvironment(): Readonly<{ executable: string; source: string; version: string }> | undefined;
  declineRuntimeDependencyInstallation(): Promise<boolean>;
  shutdownRuntimeBridgeForTesting(): Promise<void>;
  disposePanelForSession(sessionId: string): Promise<OpenWranglerResponse | undefined>;
  setCodeForExport(code: string): void;
  exportCodeTo(destination: vscode.Uri): Promise<void>;
  notebookInsertionStatus():
    | "applied"
    | "stale"
    | "indeterminate"
    | "rejected"
    | "untrusted"
    | "missing-code"
    | "unsupported-source"
    | "missing-notebook"
    | "dispatching"
    | undefined;
}

interface ExtensionApi {
  testing?: TestApi;
}

interface ReleasedJupyterVariableAction {
  readonly action: Locator;
  readonly documentRoot: Locator;
}

interface ReleasedJupyterDocumentRootElement {
  readonly dataset: { readonly openWranglerAcceptanceActivation?: string };
}

interface ReleasedJupyterActivationEvent {
  readonly detail?: number;
  readonly isTrusted?: boolean;
  readonly composedPath?: () => readonly unknown[];
}

interface ReleasedJupyterActivationPathElement {
  readonly tagName?: string;
}

interface FakeJupyterApi {
  testing: {
    execute(uri: vscode.Uri, code: string): Promise<string>;
    restart(uri: vscode.Uri, setupCode?: string): Promise<number>;
    setDenied(value: boolean): void;
    denialCalls(): number;
    stats(uri: vscode.Uri): { generation: number; executions: number } | undefined;
    lookupCalls(uri: vscode.Uri): number;
  };
}

const DUCKDB_FOREIGN_ENGINE_CONVERSION =
  /\b(?:pandas|polars|pyarrow)\b|(?:to|from)_(?:pandas|polars|arrow)\b|fetch_(?:df|pandas|arrow)\b|\.(?:arrow|df|pl)\s*\(/iu;
const GRID_COLUMN_WINDOW = { columnOffset: 0, columnLimit: 16 } as const;
const SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS = DEFAULT_SESSION_OPEN_TIMEOUT_MS + 15_000;
const WORKBENCH_PLAYWRIGHT_TIMEOUT_MS = 10_000;
const WORKBENCH_OPERATION_TIMEOUT_MS = 12_000;
const WORKBENCH_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const IMPORT_FOCUS_POLL_TIMEOUT_MS = WORKBENCH_PLAYWRIGHT_TIMEOUT_MS;
const IMPORT_FOCUS_POLL_INTERVAL_MS = 50;
const IMPORT_FOCUS_PROBE_TIMEOUT_MS = 1_000;
const NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS = 30_000;
const NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS = 1_000;
const NOTEBOOK_RENDERER_TARGET_LIMIT = 64;
const NOTEBOOK_RENDERER_DIAGNOSTIC_TARGET_LIMIT = 24;
const RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS = 120_000;
const RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS = 1_000;
const RELEASED_JUPYTER_EXTENSION_VERSION = "2025.9.1";
const RELEASED_DATA_WRANGLER_EXTENSION_VERSION = "1.24.2";
const RELEASED_JUPYTER_CONSENT_MESSAGE =
  "Do you want to grant Kernel access to the extension Open Wrangler (Matt17BR.openwrangler)?";
const RELEASED_JUPYTER_CONSENT_DETAIL = "This allows the extension to execute code against Jupyter Kernels.";
const NOTEBOOK_PREVIEW_CONFLICT_MESSAGE =
  "Open Wrangler and Data Wrangler can both render dataframe outputs. Which notebook preview should take priority?";
const NOTEBOOK_PREVIEW_CONFLICT_DETAIL =
  "You can change this later with “Open Wrangler: Choose Notebook Preview Provider”.";
const NOTEBOOK_PREVIEW_USE_OPEN_WRANGLER = "Use Open Wrangler";
const NOTEBOOK_PREVIEW_KEEP_DATA_WRANGLER = "Keep Data Wrangler";
const DATA_WRANGLER_COEXISTENCE_SETUP_RESULT = "__OW_DATA_WRANGLER_COEXISTENCE_SETUP__";
const DATA_WRANGLER_COEXISTENCE_VARIABLE = "coexist_frame";
const RELEASED_JUPYTER_VARIABLE_VIEWER_ACTION = "Show variable snapshot in data viewer";
const RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND = "openWrangler.openNotebookVariable";
const RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN = /^Open in Open Wrangler$/u;
const RELEASED_JUPYTER_EXPORT_COMMAND = "jupyter.notebookeditor.export";
const NOTEBOOK_TOOLBAR_MORE_COMMAND = "toolbar.toggle.more";
const RELEASED_JUPYTER_NOTEBOOK_VARIABLE_PICKER_TITLE = "Open Wrangler: Open Notebook Variable";
const RELEASED_JUPYTER_SETUP_RESULT = "__OW_RELEASED_SETUP__";
const RELEASED_JUPYTER_RESTART_RESULT = "__OW_RELEASED_RESTART__";
const RELEASED_JUPYTER_RUNTIME_RESULT = "__OW_RELEASED_RUNTIME__";
const RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT = "__OW_RELEASED_DUCKDB_ALIVE__";
const RELEASED_JUPYTER_SESSION_COUNT_RESULT = "__OW_RELEASED_SESSION_COUNT__";
const RELEASED_JUPYTER_PYSPARK_SETUP_RESULT = "__OW_RELEASED_PYSPARK_SETUP__";
const RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT = "__OW_RELEASED_PYSPARK_CLOSE__";
const RELEASED_JUPYTER_LOCAL_KERNEL_LABEL = "Python 3.12 (Open Wrangler)";
const RELEASED_JUPYTER_REMOTE_COLLECTION_LABEL = "Open Wrangler Remote Servers";
const RELEASED_JUPYTER_REMOTE_SERVER_LABEL = "Open Wrangler Container Server";
const RELEASED_JUPYTER_REMOTE_KERNEL_LABEL = "Open Wrangler Remote Acceptance";
const RELEASED_JUPYTER_REMOTE_KERNEL_NAME = "openwrangler-remote-acceptance";
const RELEASED_JUPYTER_REMOTE_DESCRIPTOR_PROTOCOL = "openwrangler-remote-jupyter-v1";
const OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS = 30_000;
const OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT = 64;
const OPEN_WRANGLER_WEBVIEW_DIAGNOSTIC_TARGET_LIMIT = 24;
const DEPENDENCY_GUARD_PROTOCOL = "openwrangler-dependency-guard-v1";
const DEPENDENCY_GUARD_ACCEPTANCE_TOKEN = "22222222-2222-4222-8222-222222222222";
const DEPENDENCY_GUARD_HOSTILE_TOKEN = "33333333-3333-4333-8333-333333333333";
const DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE = 197;
// sample.csv has only four data rows and fits in the native editor grid, so
// row zero is its only physically possible first visible row. The 80-row
// import-reconfiguration scenario separately proves nonzero row restoration.
const SHORT_FIXTURE_FIRST_VISIBLE_ROW = 0;
const PERSISTED_PANEL_STEP_ID = "packaged-visible-recovery-score";
const PERSISTED_PANEL_OUTPUT_COLUMN = "recovery_score";
const PERSISTED_PANEL_SELECTED_COLUMN = "gross_margin";
const PERSISTED_PANEL_COLUMN_WIDTH = 333;
const PERSISTED_PANEL_FIRST_VISIBLE_ROW = 400;
const PERSISTED_PANEL_SCROLL_LEFT = 1_400;

function persistedPanelFilterModel(): FilterModel {
  return {
    logic: "and",
    filters: [],
    sort: [
      { column: "revenue", direction: "desc", nulls: "last" },
      { column: "market", direction: "desc", nulls: "last" }
    ]
  };
}

function resolveAcceptanceTemporaryDirectory(directory: string): string {
  const isolatedTempRoot = path.resolve(tmpdir());
  const candidate = path.resolve(directory);
  const relative = path.relative(isolatedTempRoot, candidate);
  assert.ok(
    relative.length > 0 &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !relative.includes(path.sep),
    "Acceptance fixture directories must be direct children of the isolated editor temp root."
  );
  const metadata = lstatSync(candidate);
  assert.ok(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    "An acceptance fixture root must remain a real directory."
  );
  return candidate;
}

function cleanupAcceptanceTemporaryDirectory(directory: string): void {
  const ownedDirectory = resolveAcceptanceTemporaryDirectory(directory);
  if (process.platform === "win32") {
    const isolatedTempRoot = path.resolve(tmpdir());
    assert.equal(
      process.env.OPEN_WRANGLER_EXTENSION_TESTS,
      "1",
      "Windows fixture cleanup may be deferred only inside the editor acceptance harness."
    );
    assert.equal(
      path.basename(path.dirname(isolatedTempRoot)).toLowerCase(),
      "ow",
      "Deferred Windows acceptance fixtures require the runner-owned temp parent."
    );
    assert.match(
      path.basename(isolatedTempRoot),
      /^x-[A-Za-z0-9]+$/u,
      "Deferred Windows acceptance fixtures require the runner-owned random temp root."
    );
    assert.match(
      path.basename(ownedDirectory),
      /^openwrangler-[A-Za-z0-9-]+$/u,
      "Deferred Windows acceptance fixtures must use an Open Wrangler-owned random directory name."
    );
    // VS Code's Windows file service may retain a fixture-directory handle until
    // the workbench exits even after its custom editor and runtime are closed.
    // The outer acceptance runner owns this temp root and removes it only after
    // the Job Object is proven empty, which is the first safe deletion boundary.
    return;
  }
  rmSync(ownedDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function exerciseAcceptanceTemporaryDirectoryCleanupContract(): void {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-cleanup-contract-"));
  assert.throws(
    () => cleanupAcceptanceTemporaryDirectory(path.join(directory, "nested")),
    /direct children of the isolated editor temp root/u
  );
  cleanupAcceptanceTemporaryDirectory(directory);
  assert.equal(
    existsSync(directory),
    process.platform === "win32",
    "Windows retains fixture roots until job-empty cleanup; other platforms remove them immediately."
  );
}

function columnReference(metadata: SessionMetadata, name: string): ColumnReference {
  const column = metadata.schema.find((candidate) => candidate.name === name);
  assert.ok(column, `Expected ${name} in the opened session schema.`);
  return { id: column.id, name: column.name };
}

function columnReferenceAt(metadata: SessionMetadata, position: number): ColumnReference {
  const column = metadata.schema[position];
  assert.ok(column, `Expected a column at position ${position} in the opened session schema.`);
  return { id: column.id, name: column.name };
}

function gridColumnCells(page: GridPage, columnId: string): GridPage["rows"][number]["values"] {
  const position = page.columnIds.indexOf(columnId);
  assert.notEqual(position, -1, `Expected projected page column ${columnId}.`);
  return page.rows.map((row) => {
    const value = row.values[position];
    assert.ok(value, `Expected a cell for projected page column ${columnId}.`);
    return value;
  });
}

function gridColumnDisplays(page: GridPage, columnId: string): string[] {
  return gridColumnCells(page, columnId).map((value) => value.display);
}

export async function run(): Promise<void> {
  recordAcceptanceProgress("preflight:start");
  recordAcceptanceProgress("activation:start");
  const extension = vscode.extensions.getExtension<ExtensionApi>("matt17br.openwrangler");
  assert.ok(extension, "The Open Wrangler extension must be discoverable.");
  const extensionApi = await extension.activate();
  const testing = extensionApi?.testing;
  assert.ok(testing, "The isolated acceptance harness must enable the test-only extension API.");
  assert.equal(extension.isActive, true, "The extension must activate successfully.");
  exerciseAcceptanceTemporaryDirectoryCleanupContract();
  recordAcceptanceProgress("activation:complete");
  recordAcceptanceProgress("preflight:package");
  assert.equal(extension.packageJSON.name, "openwrangler");
  assert.equal(extension.packageJSON.displayName, "Open Wrangler");
  assert.match(extension.packageJSON.description, /open-source dataframe wrangler/i);
  assert.equal(extension.packageJSON.publisher, "Matt17BR");
  assert.equal(extension.packageJSON.icon, "media/icon.png");
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "icon.png"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "action-icon-dark.svg"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "action-icon-light.svg"));
  await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, "media", "activity-icon.svg"));
  const testPython = process.env.OPEN_WRANGLER_TEST_PYTHON;
  const phase = process.env.OPEN_WRANGLER_TEST_PHASE ?? "verify";
  if (testPython && phase !== "python-environment" && phase !== "remote-workspace") {
    await vscode.workspace
      .getConfiguration("openWrangler")
      .update("pythonPath", testPython, vscode.ConfigurationTarget.Global);
  }

  recordAcceptanceProgress("preflight:commands");
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "openWrangler.openPath",
    "openWrangler.openFile",
    "openWrangler.changeImportOptions",
    "openWrangler.launchDataViewer",
    "openWrangler.openNotebookVariable",
    "openWrangler.chooseNotebookPreviewProvider",
    "openWrangler.checkJupyterIntegration",
    "openWrangler.changeRuntime",
    "openWrangler.clearRuntime",
    "openWrangler.installRuntimeDependencies",
    "openWrangler.revalidateRuntimeDependencies",
    "openWrangler.startOperation",
    "openWrangler.applyStep",
    "openWrangler.discardStep",
    "openWrangler.editLatestStep",
    "openWrangler.selectStep",
    "openWrangler.undoStep",
    "openWrangler.copyCode",
    "openWrangler.exportCode",
    "openWrangler.insertNotebookCode",
    "openWrangler.exportData",
    "openWrangler.openSourceFile",
    "openWrangler.openWalkthrough",
    "openWrangler.openSettings",
    "openWrangler.reportIssue"
  ]) {
    assert.ok(commands.includes(command), `Expected registered command: ${command}`);
  }

  const packagedManifestBytes = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(extension.extensionUri, "package.json")
  );
  assert.ok(packagedManifestBytes.byteLength <= 1024 * 1024, "The packaged extension manifest must remain bounded.");
  const packagedManifest = JSON.parse(Buffer.from(packagedManifestBytes).toString("utf8")) as {
    contributes?: unknown;
  };
  const contributions = packagedManifest.contributes as {
    configurationDefaults?: Record<string, unknown>;
    commands?: Array<{
      command?: string;
      title?: string;
      shortTitle?: string;
      icon?: string | { light?: string; dark?: string };
    }>;
    viewsContainers?: {
      activitybar?: Array<{ id?: string; icon?: string }>;
      panel?: Array<{ id?: string; icon?: string }>;
    };
    views?: Record<string, Array<{ id?: string }>>;
    configuration?: { properties?: Record<string, unknown> };
    notebookRenderer?: Array<{ mimeTypes?: string[]; requiresMessaging?: string }>;
    keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }>;
    menus?: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
  };
  recordAcceptanceProgress("preflight:contributions");
  assert.ok(
    contributions.viewsContainers?.activitybar?.some(
      (container) => container.id === "openWrangler" && container.icon === "media/activity-icon.svg"
    )
  );
  assert.ok(
    contributions.viewsContainers?.panel?.some(
      (container) => container.id === "openWranglerCode" && container.icon === "media/activity-icon.svg"
    )
  );
  assert.deepEqual(
    contributions.views?.openWrangler?.map((view) => view.id),
    ["openWrangler.operations", "openWrangler.summary", "openWrangler.filters", "openWrangler.cleaningSteps"]
  );
  assert.ok(contributions.configuration?.properties?.["openWrangler.fetchBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.fetchColumnBlockSize"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.filterMode"]);
  assert.ok(contributions.configuration?.properties?.["openWrangler.sessionOpenTimeoutMs"]);
  const enabledFileTypes = contributions.configuration?.properties?.["openWrangler.enabledFileTypes"] as
    { items?: { enum?: string[] }; default?: string[] } | undefined;
  assert.ok(enabledFileTypes?.items?.enum?.includes("xls"));
  assert.ok(enabledFileTypes?.default?.includes("xls"));
  assert.deepEqual(contributions.configurationDefaults?.["cursor.general.pinnedTitleActions"], [
    "openWrangler.openFile",
    "openWrangler.changeImportOptions",
    "openWrangler.openNotebookVariable"
  ]);
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === "openWrangler.openFile"),
    {
      command: "openWrangler.openFile",
      title: "Open in Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    }
  );
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === "openWrangler.changeImportOptions"),
    {
      command: "openWrangler.changeImportOptions",
      title: "Open Wrangler: Change Import Options",
      shortTitle: "Change Import Options",
      icon: "$(settings-gear)"
    }
  );
  assert.deepEqual(
    contributions.commands?.find((command) => command.command === RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND),
    {
      command: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND,
      title: "Open in Open Wrangler",
      shortTitle: "Open in Open Wrangler",
      category: "Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    }
  );
  const fileResourcePredicate =
    "resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.(csv|tsv|parquet|jsonl|ndjson|xlsx|xls)$/i";
  const explorerContextItems = contributions.menus?.["explorer/context"] ?? [];
  assert.ok(
    explorerContextItems.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when === `!explorerResourceIsFolder && ${fileResourcePredicate}` &&
        item.group === "navigation@50"
    ),
    `Explorer data files must expose the canonical Open in Open Wrangler action. Loaded: ${JSON.stringify(explorerContextItems)}`
  );
  if (vscode.env.remoteName === "ssh-remote") {
    const loadedExplorerContextItems =
      (extension.packageJSON.contributes as typeof contributions).menus?.["explorer/context"] ?? [];
    const loadedRemoteAction = loadedExplorerContextItems.find(
      (item) => item.command === "openWrangler.openFile" && item.group === "navigation@50"
    );
    assert.ok(loadedRemoteAction, "Remote SSH must load the Open in Open Wrangler Explorer action.");
    assert.match(
      loadedRemoteAction.when ?? "",
      /resourceScheme =~ \/\^\(vscode-remote\|vscode-remote\)\$\//u,
      "VS Code must bind both packaged file-resource alternatives to the active remote scheme."
    );
    assert.match(
      loadedRemoteAction.when ?? "",
      /resourceExtname =~ \/\\\.\(csv\|tsv\|parquet\|jsonl\|ndjson\|xlsx\|xls\)\$\/i/u,
      "Remote SSH must preserve the supported data-file extension predicate."
    );
  }
  assert.ok(
    contributions.menus?.["editor/title"]?.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when ===
          `${fileResourcePredicate} && ` + "(!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)" &&
        item.group === "navigation@1"
    ),
    "Supported source editors must expose the Open Wrangler title action."
  );
  assert.ok(
    contributions.menus?.["editor/title"]?.some(
      (item) =>
        item.command === "openWrangler.changeImportOptions" &&
        item.when ===
          "openWrangler.canChangeImportOptions && (activeWebviewPanelId == openWrangler.session || activeCustomEditorId == openWrangler.viewer)" &&
        item.group === "navigation@2"
    ),
    "Configurable Open Wrangler file editors must expose the Change Import Options title action."
  );
  assert.ok(
    contributions.menus?.["editor/title/context"]?.some(
      (item) =>
        item.command === "openWrangler.openFile" &&
        item.when ===
          `${fileResourcePredicate} && (!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)` &&
        item.group === "navigation@50"
    ),
    "Supported source tabs must expose Open in Open Wrangler in their context menu."
  );
  assert.ok(
    contributions.menus?.["editor/title/context"]?.some(
      (item) =>
        item.command === "openWrangler.changeImportOptions" &&
        item.when ===
          "openWrangler.canChangeImportOptions && (activeWebviewPanelId == openWrangler.session || activeCustomEditorId == openWrangler.viewer)" &&
        item.group === "navigation@51"
    ),
    "Configurable Open Wrangler tabs must expose Change Import Options in their context menu."
  );
  assert.ok(
    contributions.menus?.commandPalette?.some(
      (item) => item.command === "openWrangler.launchDataViewer" && item.when === "false"
    ),
    "The argument-only Jupyter viewer command must stay out of the Command Palette."
  );
  const notebookVariableWhen = "notebookType == 'jupyter-notebook' && isWorkspaceTrusted";
  const notebookVariableWhenCompact =
    "notebookType == 'jupyter-notebook' && isWorkspaceTrusted && " +
    "(config.notebook.globalToolbar != true || openWrangler.forceNotebookEditorTitleAction)";
  for (const [menu, when] of [
    ["editor/title", notebookVariableWhenCompact],
    ["notebook/toolbar", notebookVariableWhen]
  ] as const) {
    assert.ok(
      contributions.menus?.[menu]?.some(
        (item) =>
          item.command === "openWrangler.openNotebookVariable" && item.when === when && item.group === "navigation@50"
      ),
      `${menu} must expose the manual Open Wrangler variable action for a real Jupyter kernel.`
    );
  }
  assert.deepEqual(
    contributions.keybindings?.map((binding) => ({
      command: binding.command,
      key: binding.key,
      mac: binding.mac,
      when: binding.when
    })),
    [
      {
        command: "openWrangler.applyStep",
        key: "ctrl+enter",
        mac: "cmd+enter",
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.hasDraft"
      },
      {
        command: "openWrangler.discardStep",
        key: "escape",
        mac: undefined,
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.hasDraft"
      },
      {
        command: "openWrangler.editLatestStep",
        key: "ctrl+shift+e",
        mac: "cmd+shift+e",
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.canChangePlan"
      },
      {
        command: "openWrangler.undoStep",
        key: "ctrl+alt+z",
        mac: "cmd+alt+z",
        when: "activeCustomEditorId == openWrangler.viewer && openWrangler.canChangePlan"
      }
    ]
  );
  assert.ok(
    contributions.menus?.["view/item/context"]?.some(
      (item) =>
        item.command === "openWrangler.editLatestStep" &&
        item.when ===
          "view == openWrangler.cleaningSteps && viewItem == openWrangler.latestCleaningStep && openWrangler.canChangePlan" &&
        item.group === "inline@10"
    ),
    "Edit Latest Step must be unavailable from the Cleaning Steps menu while a draft blocks plan changes."
  );
  assert.deepEqual(contributions.notebookRenderer?.[0]?.mimeTypes, ["application/vnd.openwrangler.viewer.v2+json"]);
  assert.equal(contributions.notebookRenderer?.[0]?.requiresMessaging, "optional");
  assert.ok(
    (extension.packageJSON.activationEvents as string[] | undefined)?.includes("onRenderer:openWrangler.renderer"),
    "The extension host must activate before optional renderer messages are delivered."
  );
  assert.ok(
    (extension.packageJSON.activationEvents as string[] | undefined)?.includes(
      "onCommand:openWrangler.changeImportOptions"
    ),
    "The Change Import Options command must activate the extension host."
  );
  assert.ok(
    extension.packageJSON.contributes.walkthroughs?.some(
      (walkthrough: { id?: string }) => walkthrough.id === "gettingStarted"
    )
  );

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "The extension-host fixture workspace must be open.");
  const fixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.csv");
  recordAcceptanceProgress("preflight:complete");
  if (isDataWranglerCoexistencePhase(phase)) {
    assert.ok(testPython, "Real Data Wrangler coexistence acceptance requires the private Jupyter environment.");
    recordAcceptanceProgress(`${phase}:start`);
    await exerciseReleasedDataWranglerCoexistence(testing, extension, phase, testPython);
    recordAcceptanceProgress(`${phase}:complete`);
    console.log(`Open Wrangler real Data Wrangler coexistence ${phase} acceptance passed.`);
    return;
  }
  if (
    phase === "jupyter-deny" ||
    phase === "jupyter-allow" ||
    phase === "jupyter-pyspark" ||
    phase === "jupyter-remote"
  ) {
    assert.ok(testPython, "Released Jupyter acceptance requires the runner-selected host Python environment.");
    recordAcceptanceProgress(`${phase}:start`);
    if (phase === "jupyter-pyspark") {
      await exerciseReleasedPySparkJupyterExtension(testing, extension, testPython);
    } else {
      await exerciseReleasedJupyterExtension(testing, extension, phase, testPython);
    }
    recordAcceptanceProgress(`${phase}:complete`);
    console.log(
      `Open Wrangler released Jupyter ${
        phase === "jupyter-deny"
          ? "denial"
          : phase === "jupyter-remote"
            ? "remote"
            : phase === "jupyter-pyspark"
              ? "PySpark"
              : "allow"
      } acceptance passed.`
    );
    return;
  }
  if (phase === "python-environment") {
    assert.ok(testPython, "Real Python-extension acceptance requires the runner-selected dependency environment.");
    recordAcceptanceProgress("python-environment:start");
    await exerciseRealPythonEnvironmentSelection(testing, workspace, fixture, testPython, extension.extensionPath);
    recordAcceptanceProgress("python-environment:complete");
    console.log("Open Wrangler real Python-environment selection acceptance passed.");
    return;
  }
  if (phase === "platform-smoke") {
    recordAcceptanceProgress("platform-smoke:start");
    const firstUseFixture = ensurePackagedFirstUseFixture(workspace);
    await exercisePackagedPlatformSmoke(testing, extension, firstUseFixture);
    if (process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS) {
      recordAcceptanceProgress("platform-smoke:screenshots");
      await capturePackagedEditorScreenshots(testing, process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS);
    }
    recordAcceptanceProgress("platform-smoke:complete");
    console.log("Open Wrangler packaged platform smoke passed.");
    return;
  }
  if (phase === "remote-workspace") {
    assert.ok(testPython, "Remote-workspace acceptance requires the pre-provisioned private Python environment.");
    recordAcceptanceProgress("remote-workspace:start");
    await exerciseRemoteWorkspace(testing, extension, workspace, testPython);
    recordAcceptanceProgress("remote-workspace:complete");
    console.log("Open Wrangler real Remote SSH workspace acceptance passed.");
    return;
  }
  if (phase === "seed") {
    recordAcceptanceProgress("seed:start");
    await seedPersistedPlan(testing, fixture, ensurePersistedRecoveryFixture(workspace));
    recordAcceptanceProgress("seed:complete");
    console.log("Open Wrangler extension-host persistence seed passed.");
    return;
  }

  const persistedRecoveryFixture = ensurePersistedRecoveryFixture(workspace);
  if (phase === "single") await seedPersistedPlan(testing, fixture, persistedRecoveryFixture);
  if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
    recordAcceptanceProgress("verify:visible-replay-recovery");
    await verifyVisiblePersistedReplayAndRecovery(testing, persistedRecoveryFixture);
  }
  recordAcceptanceProgress("verify:replay-recovery");
  await verifyPersistedReplayAndRecovery(testing, workspace, fixture);
  recordAcceptanceProgress("verify:custom-editor");
  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom && input.viewType === "openWrangler.viewer";
    },
    45_000,
    "the Open Wrangler custom editor"
  );

  const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(activeInput instanceof vscode.TabInputCustom);
  assert.equal(activeInput.viewType, "openWrangler.viewer");
  assert.equal(path.basename(activeInput.uri.fsPath), "sample.csv");
  await exercisePackagedStepInspection(testing, fixture);
  await vscode.commands.executeCommand("openWrangler.openSourceFile");
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    45_000,
    "Open Source File to reveal the active runtime session"
  );
  const sourceInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(sourceInput instanceof vscode.TabInputText, "Open Source File must resolve the active runtime session.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the custom-editor session to close"
  );

  if (testPython) {
    recordAcceptanceProgress("verify:runtime-and-file-inputs");
    await exerciseRuntimeSelectionCommands(testing, fixture, testPython);
    await exercisePackagedFileInputs(testing, workspace, testPython);
  }
  recordAcceptanceProgress("verify:viewing-queries");
  await exercisePackagedViewingQueries(testing, fixture);
  recordAcceptanceProgress("verify:wide-projection");
  await exerciseWideColumnProjection(testing);
  recordAcceptanceProgress("verify:operation-groups");
  await exercisePackagedOperationGroups(testing, fixture);
  recordAcceptanceProgress("verify:notebook-flows");
  await exercisePackagedNotebookFlows(testing);
  if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
    recordAcceptanceProgress("verify:file-launch-surfaces");
    const firstUseFixture = ensurePackagedFirstUseFixture(workspace);
    await exercisePackagedFileLaunchSurfaces(
      testing,
      firstUseFixture,
      process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS
    );
  }
  if (process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS) {
    recordAcceptanceProgress("verify:screenshots");
    await capturePackagedEditorScreenshots(testing, process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS);
  }
  if (testPython && process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
    recordAcceptanceProgress("verify:dependency-recovery");
    await exerciseDependencyMutationRecovery(
      testing,
      fixture,
      testPython,
      path.join(extension.extensionPath, "python", "openwrangler_runtime", "dependency_guard.py")
    );
    recordAcceptanceProgress("verify:dependency-install-shutdown");
    await exerciseDependencyInstallShutdownLifecycle(testing, testPython);
  }

  recordAcceptanceProgress("verify:complete");
  console.log("Open Wrangler extension-host acceptance passed.");
}

function ensurePackagedFirstUseFixture(workspace: vscode.Uri): vscode.Uri {
  return ensureDeterministicFirstUseFixture(workspace, "[Live] regional orders 2024-2025.csv");
}

function ensurePersistedRecoveryFixture(workspace: vscode.Uri): vscode.Uri {
  return ensureDeterministicFirstUseFixture(workspace, "[Recovery] persisted panel state.csv");
}

function ensureDeterministicFirstUseFixture(workspace: vscode.Uri, fileName: string): vscode.Uri {
  const fixture = vscode.Uri.joinPath(workspace, "fixtures", fileName);
  const expected = packagedFirstUseFixtureCsv();
  try {
    writeFileSync(fixture.fsPath, expected, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const descriptor = openSync(fixture.fsPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      assert.equal(opened.isFile(), true, "An existing first-use fixture must remain a regular file.");
      assert.equal(opened.nlink, 1n, "An existing first-use fixture must not be hard linked.");
      assert.equal(
        readFileSync(descriptor, "utf8"),
        expected,
        "An existing first-use fixture must retain the exact deterministic source bytes."
      );
      const completed = fstatSync(descriptor, { bigint: true });
      assert.equal(completed.dev, opened.dev, "The first-use fixture device changed while it was read.");
      assert.equal(completed.ino, opened.ino, "The first-use fixture identity changed while it was read.");
      assert.equal(completed.size, opened.size, "The first-use fixture size changed while it was read.");
      assert.equal(
        completed.mtimeNs,
        opened.mtimeNs,
        "The first-use fixture modification time changed while it was read."
      );
    } finally {
      closeSync(descriptor);
    }
  }
  return fixture;
}

let lastAcceptanceProgressCheckpoint: string | undefined;

function recordAcceptanceProgress(checkpoint: string): void {
  const progressPath = process.env.OPEN_WRANGLER_TEST_PROGRESS;
  if (!progressPath) {
    lastAcceptanceProgressCheckpoint = checkpoint;
    return;
  }
  const runId = process.env.OPEN_WRANGLER_TEST_RUN_ID;
  const phase = process.env.OPEN_WRANGLER_TEST_PHASE;
  if (!runId || !phase) {
    throw new Error("Editor acceptance progress requires the launched run ID and phase.");
  }
  writeAcceptanceProgressCheckpoint(progressPath, {
    protocol: ACCEPTANCE_PROGRESS_PROTOCOL,
    runId,
    phase,
    checkpoint
  });
  lastAcceptanceProgressCheckpoint = checkpoint;
}

type DataWranglerCoexistencePhase =
  | "jupyter-coexist-open-select"
  | "jupyter-coexist-open-restart"
  | "jupyter-coexist-data-select"
  | "jupyter-coexist-data-restart";

type ReleasedJupyterPhase =
  "jupyter-deny" | "jupyter-allow" | "jupyter-pyspark" | "jupyter-remote" | DataWranglerCoexistencePhase;

interface ReleasedJupyterKernelTarget {
  readonly label: string;
  readonly name: string;
  readonly routeLabels: readonly string[];
  readonly remote?: {
    readonly baseUrl: vscode.Uri;
    readonly token: string;
    readonly runId: string;
    readonly hostname: string;
  };
}

interface ReleasedVariableExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "pandas" | "polars" | "duckdb" | "pyspark";
  readonly firstValue: string;
  readonly notebookInsert?: boolean;
}

interface ReleasedDuckDbRecoverySession {
  readonly sessionId: string;
  readonly revision: number;
  readonly filterModel: FilterModel;
  readonly runtimeId: string;
  readonly schema: SessionMetadata["schema"];
  readonly viewState: GridViewState;
}

function isDataWranglerCoexistencePhase(phase: string): phase is DataWranglerCoexistencePhase {
  return (
    phase === "jupyter-coexist-open-select" ||
    phase === "jupyter-coexist-open-restart" ||
    phase === "jupyter-coexist-data-select" ||
    phase === "jupyter-coexist-data-restart"
  );
}

function dataWranglerCoexistenceExpectation(phase: DataWranglerCoexistencePhase): {
  provider: "openWrangler" | "dataWrangler";
  selection: boolean;
} {
  return {
    provider: phase.includes("-open-") ? "openWrangler" : "dataWrangler",
    selection: phase.endsWith("-select")
  };
}

async function exerciseReleasedDataWranglerCoexistence(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  phase: DataWranglerCoexistencePhase,
  testPython: string
): Promise<void> {
  assert.equal(
    testing.diagnostics().sessionCount,
    0,
    "Data Wrangler coexistence acceptance must start without an Open Wrangler session."
  );
  assert.ok(
    !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
    "Coexistence must not add a hard Jupyter dependency to Open Wrangler."
  );

  const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
  assert.equal(jupyterExtension.packageJSON.publisher, "ms-toolsai");
  assert.equal(jupyterExtension.packageJSON.name, "jupyter");
  assert.equal(jupyterExtension.packageJSON.version, RELEASED_JUPYTER_EXTENSION_VERSION);

  const dataWranglerExtension = vscode.extensions.getExtension("ms-toolsai.datawrangler");
  assert.ok(dataWranglerExtension, "The exact Microsoft Data Wrangler parity baseline must be installed.");
  assert.equal(dataWranglerExtension.packageJSON.publisher, "ms-toolsai");
  assert.equal(dataWranglerExtension.packageJSON.name, "datawrangler");
  assert.equal(
    dataWranglerExtension.packageJSON.version,
    RELEASED_DATA_WRANGLER_EXTENSION_VERSION,
    "Coexistence acceptance must not float to an unreviewed Data Wrangler version."
  );

  const expectation = dataWranglerCoexistenceExpectation(phase);
  if (expectation.provider === "dataWrangler") {
    await dataWranglerExtension.activate();
    assert.equal(dataWranglerExtension.isActive, true, "The selected real Data Wrangler extension must be active.");
  }
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const initialProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
    "notebookPreviewProvider"
  );
  if (expectation.selection) {
    assert.equal(initialProvider?.globalValue, undefined, "A fresh coexistence profile must not preselect a provider.");
    assert.equal(initialProvider?.workspaceValue, undefined);
    assert.equal(configuration.get("notebookPreviewProvider", "ask"), "ask");
  } else {
    assert.equal(
      initialProvider?.globalValue,
      expectation.provider,
      "The provider selected before editor restart must persist globally."
    );
    assert.equal(configuration.get("notebookPreviewProvider", "ask"), expectation.provider);
  }

  const kernelTarget = releasedJupyterKernelTarget(phase);
  const directory = mkdtempSync(path.join(tmpdir(), `openwrangler-data-wrangler-${phase}-`));
  const notebookPath = path.join(directory, `${phase}.ipynb`);
  writeDataWranglerCoexistenceNotebook(notebookPath, kernelTarget);
  const notebookUri = vscode.Uri.file(notebookPath);
  let notebook: vscode.NotebookDocument | undefined;
  try {
    recordAcceptanceProgress(`${phase}:notebook-open`);
    notebook = await vscode.workspace.openNotebookDocument(notebookUri);
    assertExactOpenNotebookDocument(notebook, "after opening the Data Wrangler coexistence fixture");
    const notebookEditor = await vscode.window.showNotebookDocument(notebook, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });
    assert.equal(notebookEditor.notebook, notebook);
    assertExactVisibleReleasedNotebookEditor(
      notebook,
      notebookEditor,
      "after showing the Data Wrangler coexistence fixture"
    );

    const workbench = await connectToEditorWorkbench();
    if (expectation.selection) {
      recordAcceptanceProgress(`${phase}:provider-prompt`);
      const conflict = await waitForNotebookPreviewConflict(workbench);
      assert.equal(
        configuration.get("notebookPreviewProvider", "ask"),
        "ask",
        "The conflict prompt must not mutate the preference before one explicit choice."
      );
      const action = expectation.provider === "openWrangler" ? conflict.useOpenWrangler : conflict.keepDataWrangler;
      await action.click();
      await conflict.dialog.waitFor({ state: "hidden", timeout: 10_000 });
      await waitFor(
        () =>
          vscode.workspace
            .getConfiguration("openWrangler")
            .inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">("notebookPreviewProvider")?.globalValue ===
          expectation.provider,
        10_000,
        "the selected notebook preview provider to persist globally"
      );
    } else {
      recordAcceptanceProgress(`${phase}:provider-persisted`);
      await assertNotebookPreviewConflictAbsent(
        workbench,
        1_500,
        "A persisted notebook preview provider must suppress the conflict prompt after editor restart."
      );
    }

    recordAcceptanceProgress(`${phase}:kernel-discovery`);
    await jupyterExtension.activate();
    assertExactOpenNotebookDocument(notebook, "after activating released Jupyter for coexistence");
    recordAcceptanceProgress(`${phase}:kernel-select`);
    await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);
    recordAcceptanceProgress(`${phase}:kernel-selected`);

    const setupExecution = executeReleasedNotebookCell(
      notebook,
      0,
      DATA_WRANGLER_COEXISTENCE_SETUP_RESULT,
      `${phase}:setup-cell`,
      notebookEditor
    );
    if (expectation.provider === "openWrangler") {
      recordAcceptanceProgress(`${phase}:open-wrangler-consent`);
      const consent = await waitForReleasedJupyterConsent(workbench, testing);
      await consent.allow.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    }
    await setupExecution;
    const initialKernel = dataWranglerCoexistenceSetupResult(notebook.cellAt(0));
    assert.equal(
      canonicalAcceptancePath(String(initialKernel.executable)),
      canonicalAcceptancePath(testPython),
      "Data Wrangler coexistence must use the private released-Jupyter interpreter."
    );
    assert.ok(Number.isSafeInteger(Number(initialKernel.pid)) && Number(initialKernel.pid) > 0);
    if (expectation.provider === "dataWrangler") {
      assert.equal(
        await visibleReleasedJupyterConsentCount(workbench),
        0,
        "Choosing Data Wrangler must not show Open Wrangler kernel consent."
      );
    }

    await assertDataWranglerCoexistenceOwnership(
      workbench,
      notebook,
      notebookEditor,
      expectation.provider,
      `${phase}:initial-provider`
    );
    await assertNotebookPreviewConflictAbsent(
      workbench,
      1_500,
      "The notebook preview conflict prompt must stay dismissed after the selected provider renders output."
    );

    if (!expectation.selection) {
      recordAcceptanceProgress(`${phase}:kernel-restart`);
      await restartReleasedJupyterKernelAndWait(notebook);
      await executeReleasedNotebookCell(
        notebook,
        0,
        DATA_WRANGLER_COEXISTENCE_SETUP_RESULT,
        `${phase}:restart-setup-cell`,
        notebookEditor
      );
      const replacementKernel = dataWranglerCoexistenceSetupResult(notebook.cellAt(0));
      assert.notEqual(
        Number(replacementKernel.pid),
        Number(initialKernel.pid),
        "The coexistence restart phase must exercise a replacement kernel process."
      );
      assert.equal(canonicalAcceptancePath(String(replacementKernel.executable)), canonicalAcceptancePath(testPython));
      await assertDataWranglerCoexistenceOwnership(
        workbench,
        notebook,
        notebookEditor,
        expectation.provider,
        `${phase}:restarted-provider`
      );
      await assertNotebookPreviewConflictAbsent(
        workbench,
        1_500,
        "Kernel restart must not repeat the resolved notebook preview conflict."
      );
    }

    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Automatic notebook preview coexistence must not create an Open Wrangler session panel."
    );
  } finally {
    await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function assertDataWranglerCoexistenceOwnership(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  notebookEditor: vscode.NotebookEditor,
  provider: "openWrangler" | "dataWrangler",
  checkpoint: string
): Promise<void> {
  if (provider === "openWrangler") {
    await executeReleasedNotebookCellUntilMime(notebook, 1, OPEN_WRANGLER_MIME_V2, checkpoint, notebookEditor);
    const mimes = notebook.cellAt(1).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(mimes.includes(OPEN_WRANGLER_MIME_V2));
    return;
  }

  await executeReleasedNotebookCell(notebook, 1, undefined, `${checkpoint}:dataframe-cell`, notebookEditor);
  const mimes = notebook.cellAt(1).outputs.flatMap((output) => output.items.map((item) => item.mime));
  assert.equal(
    mimes.includes(OPEN_WRANGLER_MIME_V2),
    false,
    "Choosing Data Wrangler must leave Open Wrangler's automatic notebook formatter unregistered."
  );
  assert.ok(
    mimes.includes("text/plain"),
    "The selected Data Wrangler path must retain the successful native Jupyter dataframe output."
  );
}

async function waitForNotebookPreviewConflict(workbench: Page): Promise<{
  dialog: Locator;
  useOpenWrangler: Locator;
  keepDataWrangler: Locator;
}> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    for (const frame of releasedWorkbenchFrames(workbench)) {
      const dialog = frame
        .locator(".monaco-dialog-box:visible")
        .filter({ hasText: NOTEBOOK_PREVIEW_CONFLICT_MESSAGE })
        .last();
      if ((await dialog.count().catch(() => 0)) === 0 || !(await dialog.isVisible().catch(() => false))) continue;
      const message = await dialog.locator(".dialog-message-text").innerText();
      const detail = await dialog.locator(".dialog-message-detail").innerText();
      assert.equal(message, NOTEBOOK_PREVIEW_CONFLICT_MESSAGE);
      assert.equal(detail, NOTEBOOK_PREVIEW_CONFLICT_DETAIL);
      const useOpenWrangler = dialog.getByRole("button", {
        name: NOTEBOOK_PREVIEW_USE_OPEN_WRANGLER,
        exact: true
      });
      const keepDataWrangler = dialog.getByRole("button", {
        name: NOTEBOOK_PREVIEW_KEEP_DATA_WRANGLER,
        exact: true
      });
      assert.equal(await useOpenWrangler.count(), 1);
      assert.equal(await keepDataWrangler.count(), 1);
      return { dialog, useOpenWrangler, keepDataWrangler };
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  const diagnostics = await boundedImportPromptDiagnostics(workbench);
  throw new Error(
    "Timed out waiting for the real Open Wrangler/Data Wrangler provider conflict prompt. " +
      `Dialogs: ${JSON.stringify(diagnostics.dialogs)}.`
  );
}

async function assertNotebookPreviewConflictAbsent(
  workbench: Page,
  observationMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + observationMs;
  do {
    let count = 0;
    for (const frame of releasedWorkbenchFrames(workbench)) {
      count += await frame
        .locator(".monaco-dialog-box:visible")
        .filter({ hasText: NOTEBOOK_PREVIEW_CONFLICT_MESSAGE })
        .count()
        .catch(() => 0);
    }
    assert.equal(count, 0, message);
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
}

function dataWranglerCoexistenceSetupResult(cell: vscode.NotebookCell): Record<string, unknown> {
  return releasedNotebookJsonResult(cell, DATA_WRANGLER_COEXISTENCE_SETUP_RESULT, "Data Wrangler coexistence setup");
}

function writeDataWranglerCoexistenceNotebook(notebookPath: string, target: ReleasedJupyterKernelTarget): void {
  const cell = (source: readonly string[]) => ({
    cell_type: "code",
    execution_count: null,
    metadata: {},
    outputs: [],
    source: source.map((line) => `${line}\n`)
  });
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        cell([
          "import json",
          "import os",
          "import sys",
          "import pandas as pd",
          `${DATA_WRANGLER_COEXISTENCE_VARIABLE} = pd.DataFrame({`,
          "    'order_id': [2400001, 2400002, 2400003, 2400004],",
          "    'market': ['DACH', 'Nordics', 'Iberia', 'France'],",
          "    'revenue': [620.50, 1840.75, 991.00, 2420.25],",
          "})",
          `print(${JSON.stringify(DATA_WRANGLER_COEXISTENCE_SETUP_RESULT)} + json.dumps({`,
          "    'executable': sys.executable,",
          "    'pid': os.getpid(),",
          "}, sort_keys=True))"
        ]),
        cell([DATA_WRANGLER_COEXISTENCE_VARIABLE])
      ],
      metadata: {
        kernelspec: {
          display_name: target.label,
          language: "python",
          name: target.name
        },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  );
}

async function exerciseReleasedJupyterExtension(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  phase: ReleasedJupyterPhase,
  testPython: string
): Promise<void> {
  assert.equal(
    testing.diagnostics().sessionCount,
    0,
    "Released Jupyter acceptance must start without a retained Open Wrangler session."
  );
  assert.ok(
    !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
    "File-backed Open Wrangler use must not acquire a hard Jupyter extension dependency."
  );

  const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
  assert.equal(jupyterExtension.packageJSON.publisher, "ms-toolsai");
  assert.equal(jupyterExtension.packageJSON.name, "jupyter");
  assert.equal(
    jupyterExtension.packageJSON.version,
    RELEASED_JUPYTER_EXTENSION_VERSION,
    "Released-kernel acceptance must not float to an unreviewed Jupyter build."
  );
  assert.notEqual(
    jupyterExtension.packageJSON.displayName,
    "Open Wrangler stable Jupyter API acceptance double",
    "The released-Jupyter phases must never load the local API double."
  );

  const kernelTarget = releasedJupyterKernelTarget(phase);
  const directory = mkdtempSync(path.join(tmpdir(), `openwrangler-released-jupyter-${phase}-`));
  const notebookPath = path.join(
    directory,
    phase === "jupyter-allow" && process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS
      ? "orders-analysis.ipynb"
      : `${phase}.ipynb`
  );
  const notebookUri = vscode.Uri.file(notebookPath);
  const setupMarker = `OPEN_WRANGLER_SETUP_${phase.replace("jupyter-", "").toUpperCase()}`;
  writeReleasedJupyterNotebook(notebookPath, setupMarker, kernelTarget, extension.extensionPath);
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const originalNotebookStartMode = configuration.get<"viewing" | "editing">("notebookStartMode", "viewing");
  const originalNotebookPreviewProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
    "notebookPreviewProvider"
  )?.workspaceValue;

  let notebook: vscode.NotebookDocument | undefined;
  let rendererLoadObserver: NotebookRendererLoadObserver | undefined;
  let remoteServerCollection: JupyterServerCollection | undefined;
  let duckdbRecoverySession: ReleasedDuckDbRecoverySession | undefined;
  let failureCheckpoint: string | undefined;
  try {
    await configuration.update("notebookPreviewProvider", "disabled", vscode.ConfigurationTarget.Workspace);
    recordAcceptanceProgress(`${phase}:notebook-open`);
    notebook = await vscode.workspace.openNotebookDocument(notebookUri);
    assertExactOpenNotebookDocument(notebook, "after opening the released-Jupyter fixture");
    const notebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
    assert.equal(
      notebookEditor.notebook,
      notebook,
      "The released-Jupyter fixture must retain its exact visible editor."
    );
    assertExactOpenNotebookDocument(notebook, "after showing the released-Jupyter fixture");

    const workbench = await connectToEditorWorkbench();
    rendererLoadObserver = observeNotebookRendererLoad(workbench);
    recordAcceptanceProgress(`${phase}:kernel-discovery`);
    const jupyterApi = await jupyterExtension.activate();
    assertExactOpenNotebookDocument(notebook, "after activating released Jupyter for kernel discovery");
    if (kernelTarget.remote) {
      remoteServerCollection = registerReleasedRemoteJupyterServer(jupyterApi, kernelTarget);
    }
    recordAcceptanceProgress(`${phase}:kernel-select`);
    await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);
    recordAcceptanceProgress(`${phase}:kernel-selected`);

    const variableNotebookEditor = await showExactReleasedNotebook(notebook);
    recordAcceptanceProgress(`${phase}:kernel-start`);
    await executeReleasedNotebookCell(
      notebook,
      3,
      RELEASED_JUPYTER_RESTART_RESULT,
      `${phase}:kernel-warmup-cell`,
      variableNotebookEditor
    );
    const warmKernel = releasedNotebookJsonResult(notebook.cellAt(3), RELEASED_JUPYTER_RESTART_RESULT, "kernel warmup");
    assert.equal(warmKernel.runtime, false, "The private kernel must not inherit Open Wrangler before bootstrap.");
    assert.equal(warmKernel.bootstrap, false, "The private kernel must not inherit Open Wrangler bootstrap state.");
    assert.equal(warmKernel.setup, null, "The private kernel warmup must run before the dataframe setup cell.");
    if (kernelTarget.remote) {
      assert.equal(warmKernel.remoteRunId, kernelTarget.remote.runId);
      assert.equal(warmKernel.hostname, kernelTarget.remote.hostname);
      assert.equal(warmKernel.hostExtensionVisible, false);
    }

    assert.equal(
      releasedJupyterSessionTabs().length,
      0,
      "Automatic notebook-preview preparation must begin without creating an Open Wrangler session panel."
    );
    recordAcceptanceProgress(`${phase}:proactive-formatter`);
    await configuration.update("notebookPreviewProvider", "openWrangler", vscode.ConfigurationTarget.Workspace);
    const consent = await waitForReleasedJupyterConsent(workbench, testing);
    assertExactOpenNotebookDocument(notebook, "while proactive formatter consent belongs to the fixture notebook");

    if (phase === "jupyter-deny") {
      recordAcceptanceProgress("jupyter-deny:consent");
      await consent.deny.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
      await waitForStableReleasedJupyterSessionCount(testing, 0, 2_000, 10_000);
      assert.equal(testing.diagnostics().sessionCount, 0);
      assert.equal(
        releasedJupyterSessionTabs().length,
        0,
        "Denying proactive formatter access must not leave a session panel."
      );

      recordAcceptanceProgress("jupyter-deny:persisted-denial");
      assertExactOpenNotebookDocument(notebook, "before retrying the denied released Jupyter permission");
      await withBoundedAcceptancePromise(
        vscode.commands.executeCommand("openWrangler.launchDataViewer", {
          name: "duckdb_relation",
          type: "_duckdb.DuckDBPyRelation",
          fileName: notebook.uri
        }),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the persisted released-Jupyter denial retry"
      );
      assertExactOpenNotebookDocument(notebook, "after retrying the denied released Jupyter permission");
      const denialError = await waitForReleasedJupyterTerminalPanelError(workbench, testing);
      assert.ok(denialError.length > 0, "The persisted Jupyter denial must publish a terminal panel error.");
      await waitForStableReleasedJupyterSessionCount(testing, 0, 2_000, 10_000);
      assert.equal(
        await visibleReleasedJupyterConsentCount(workbench),
        0,
        "A persisted Jupyter denial must fail without prompting again in the same isolated profile."
      );
      await closeReleasedJupyterSessionTabs();
      assert.equal(testing.diagnostics().sessionCount, 0);
      return;
    }

    recordAcceptanceProgress(`${phase}:consent`);
    await consent.allow.click();
    await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(
      releasedJupyterSessionTabs().length,
      0,
      "Allowing proactive formatter access must not create an Open Wrangler session panel."
    );

    await executeReleasedNotebookCell(notebook, 0, setupMarker, `${phase}:setup-cell`, variableNotebookEditor);
    assert.equal(
      jupyterExtension.isActive,
      true,
      "Executing the fixture must activate the released Jupyter extension."
    );
    const initialKernel = releasedNotebookSetupResult(notebook.cellAt(0));
    assertReleasedJupyterKernelIdentity(initialKernel, kernelTarget, testPython);
    assert.equal(initialKernel.pid, warmKernel.pid, "The formatter must remain on the exact warmed kernel.");
    assert.equal(initialKernel.setup, setupMarker);
    assert.equal(initialKernel.duckdbConversionGuards, true);

    recordAcceptanceProgress(`${phase}:proactive-mime-v2`);
    const renderedCell = new vscode.NotebookRange(1, 2);
    const executionEditor = await showExactReleasedNotebook(notebook);
    executionEditor.selection = renderedCell;
    executionEditor.selections = [renderedCell];
    executionEditor.revealRange(renderedCell, vscode.NotebookEditorRevealType.InCenter);
    await waitFor(
      () => executionEditor.visibleRanges.some((range) => range.start <= 1 && range.end > 1),
      WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
      "the released-Jupyter MIME cell to become visible before execution"
    );
    await executeReleasedNotebookCellUntilMime(
      notebook,
      1,
      OPEN_WRANGLER_MIME_V2,
      `${phase}:proactive-mime-cell`,
      executionEditor
    );
    const pandasOutputMimes = notebook.cellAt(1).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(
      pandasOutputMimes.includes(OPEN_WRANGLER_MIME_V2),
      "Proactive formatter installation must emit Open Wrangler MIME v2 before any Open Wrangler command. " +
        `Actual MIME types: ${JSON.stringify(pandasOutputMimes)}. ` +
        `Output: ${JSON.stringify(notebookCellOutputText(notebook.cellAt(1)).slice(0, 2_000))}.`
    );
    assert.equal(
      pandasOutputMimes.includes("text/html"),
      false,
      `Formatter registration must suppress competing default dataframe HTML. Actual MIME types: ${JSON.stringify(
        pandasOutputMimes
      )}.`
    );
    const pandasMimeItem = notebook
      .cellAt(1)
      .outputs.flatMap((output) => output.items)
      .find((item) => item.mime === OPEN_WRANGLER_MIME_V2);
    assert.ok(pandasMimeItem, "The released-Jupyter dataframe output must retain its MIME v2 item.");
    const pandasMimePayload = normalizeNotebookOutputPayload(
      JSON.parse(new TextDecoder().decode(pandasMimeItem.data)) as unknown
    );
    assert.ok(pandasMimePayload, "The released-Jupyter MIME v2 item must satisfy the saved-output contract.");
    assert.equal(pandasMimePayload.metadata.source.label, "orders_df");
    assert.equal(pandasMimePayload.metadata.source.variableName, "orders_df");
    assert.deepEqual(pandasMimePayload.metadata.shape, { rows: 100_000, columns: 15 });
    assert.ok(
      pandasMimePayload.page.rows.length > 0 && pandasMimePayload.page.rows.length < 100_000,
      "The portable MIME output must retain a bounded captured preview instead of embedding the complete live frame."
    );
    const capturedShowcaseFirstValue = pandasMimePayload.page.rows[0]?.values[0]?.display;
    assert.equal(capturedShowcaseFirstValue, "2400001");
    assert.deepEqual(
      pandasMimePayload.metadata.schema.map((column) => column.name),
      [
        "order_id",
        "market",
        "revenue",
        "fulfilled",
        "order_date",
        "segment",
        "channel",
        "product_family",
        "units",
        "unit_price",
        "discount_pct",
        "gross_margin",
        "priority",
        "renewal_date",
        "account_status"
      ]
    );
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Producing an automatic notebook preview must not implicitly open a dataframe session."
    );

    assertExactVisibleReleasedNotebookEditor(
      notebook,
      variableNotebookEditor,
      "immediately before opening the real Jupyter Variables view"
    );
    await vscode.commands.executeCommand("jupyter.openVariableView");
    assertExactOpenNotebookDocument(notebook, "after opening the real Jupyter Variables view");
    assertExactVisibleReleasedNotebookEditor(
      notebook,
      variableNotebookEditor,
      "after opening the real Jupyter Variables view"
    );

    assertExactOpenNotebookDocument(notebook, "before resolving the pandas_frame action from Jupyter Variables");

    recordAcceptanceProgress(`${phase}:variables-action`);
    await dispatchReleasedJupyterVariableAction(workbench, notebook, "pandas_frame", `${phase}:variables`);
    recordAcceptanceProgress(`${phase}:variables-delegation-dispatched`);
    recordAcceptanceProgress(`${phase}:variables-panel-created`);
    const pandasFrame = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      { name: "pandas_frame", type: "DataFrame", backend: "pandas", firstValue: "1" },
      "the Pandas DataFrame opened from the real Jupyter Variables view"
    );

    recordAcceptanceProgress(`${phase}:pandas-dataframe`);
    await assertReleasedSessionPage(testing, pandasFrame, "1", "released-jupyter-pandas-dataframe");
    if (kernelTarget.remote) {
      await assertReleasedRemoteRuntimeTransfer(notebook, kernelTarget, extension.extensionPath, phase);
    }
    await assertReleasedNotebookCodeInsertion(testing, notebook, pandasFrame, "pandas_frame", phase);
    await disposePackagedSessionPanel(testing, pandasFrame.sessionId, "the released-Jupyter Pandas DataFrame session");

    recordAcceptanceProgress(`${phase}:polars-series-toolbar`);
    await showExactReleasedNotebook(notebook);
    await invokeReleasedNotebookToolbarVariable(workbench, notebook, "polars_series");
    const polarsSeries = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      { name: "polars_series", type: "polars.series.series.Series", backend: "polars", firstValue: "7" },
      "the Polars Series opened from the real Open Wrangler notebook toolbar"
    );
    await assertReleasedSessionPage(testing, polarsSeries, "7", "released-jupyter-polars-series");
    assert.equal(polarsSeries.metadata.mode, "viewing", "Released notebook sessions must default to viewing mode.");
    await disposePackagedSessionPanel(testing, polarsSeries.sessionId, "the released-Jupyter Polars Series");

    const rendererEditor = await showExactReleasedNotebook(notebook);
    rendererEditor.selection = renderedCell;
    rendererEditor.selections = [renderedCell];
    rendererEditor.revealRange(renderedCell, vscode.NotebookEditorRevealType.InCenter);
    assertExactVisibleReleasedNotebookEditor(
      notebook,
      rendererEditor,
      "after revealing the released-Jupyter MIME renderer"
    );
    recordAcceptanceProgress(`${phase}:mime-renderer-revealed`);
    const screenshotOutput = process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS;
    const restoreScreenshotWorkbench =
      phase === "jupyter-allow" && screenshotOutput
        ? await prepareReleasedJupyterScreenshotWorkbench(workbench, notebook, rendererEditor)
        : undefined;
    try {
      let rendererButton: NotebookRendererButton;
      try {
        rendererButton = await waitForNotebookRendererButton(workbench, "orders_df", "Open in Open Wrangler");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Host: ${JSON.stringify(
            releasedNotebookRendererHostDiagnostics(notebook, 1)
          )} Browser: ${JSON.stringify(rendererLoadObserver.snapshot())}`
        );
      }
      if (phase === "jupyter-allow" && screenshotOutput) {
        await captureReleasedJupyterPandasPreview(workbench, rendererButton, screenshotOutput);
      }
      let liveShowcase: NonNullable<ReturnType<TestApi["activeSession"]>>;
      try {
        liveShowcase = await openReleasedRendererVariableSession(
          rendererButton,
          workbench,
          testing,
          notebook,
          { name: "orders_df", type: "DataFrame", backend: "pandas", firstValue: "2400001" },
          "the complete current orders_df opened from the primary MIME-v2 renderer action",
          `${phase}:orders-inline`
        );
      } finally {
        await rendererButton.dispose();
      }
      assert.equal(liveShowcase.metadata.mode, "viewing");
      assert.deepEqual(liveShowcase.metadata.shape, { rows: 100_000, columns: 15 });
      assert.deepEqual(liveShowcase.metadata.filteredShape, liveShowcase.metadata.shape);
      assert.equal(liveShowcase.metadata.capabilities.notebookInsert, true);
      await assertReleasedSessionPage(
        testing,
        liveShowcase,
        capturedShowcaseFirstValue,
        "released-jupyter-renderer-live-notebook-showcase"
      );
      await disposePackagedSessionPanel(
        testing,
        liveShowcase.sessionId,
        "the released-Jupyter live MIME-linked dataframe session"
      );
    } finally {
      await restoreScreenshotWorkbench?.();
    }

    recordAcceptanceProgress(`${phase}:duckdb-inline`);
    const duckdbCellRange = new vscode.NotebookRange(5, 6);
    const duckdbRendererEditor = await showExactReleasedNotebook(notebook);
    duckdbRendererEditor.selection = duckdbCellRange;
    duckdbRendererEditor.selections = [duckdbCellRange];
    duckdbRendererEditor.revealRange(duckdbCellRange, vscode.NotebookEditorRevealType.InCenter);
    await waitFor(
      () => duckdbRendererEditor.visibleRanges.some((range) => range.start <= 5 && range.end > 5),
      WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
      "the native DuckDB MIME cell to become visible before execution"
    );
    await executeReleasedNotebookCellUntilMime(
      notebook,
      5,
      OPEN_WRANGLER_MIME_V2,
      `${phase}:duckdb-mime-cell`,
      duckdbRendererEditor
    );
    const duckdbOutputMimes = notebook.cellAt(5).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(
      duckdbOutputMimes.includes(OPEN_WRANGLER_MIME_V2),
      `The exact DuckDB relation must emit Open Wrangler MIME v2. Actual MIME types: ${JSON.stringify(
        duckdbOutputMimes
      )}.`
    );
    assert.equal(
      duckdbOutputMimes.includes("text/html"),
      false,
      "The native DuckDB formatter must suppress the competing default HTML representation."
    );
    const duckdbMimeItem = notebook
      .cellAt(5)
      .outputs.flatMap((output) => output.items)
      .find((item) => item.mime === OPEN_WRANGLER_MIME_V2);
    assert.ok(duckdbMimeItem, "The exact DuckDB relation output must retain its MIME-v2 item.");
    const duckdbMimePayload = normalizeNotebookOutputPayload(
      JSON.parse(new TextDecoder().decode(duckdbMimeItem.data)) as unknown
    );
    assert.ok(duckdbMimePayload, "The DuckDB MIME-v2 item must satisfy the saved-output contract.");
    assert.equal(duckdbMimePayload.metadata.backend, "duckdb");
    assert.equal(duckdbMimePayload.metadata.source.label, "duckdb_relation");
    assert.equal(duckdbMimePayload.metadata.source.variableName, "duckdb_relation");
    assert.deepEqual(duckdbMimePayload.metadata.shape, { rows: 100_000, columns: 4 });
    assert.ok(
      duckdbMimePayload.page.rows.length > 0 && duckdbMimePayload.page.rows.length < 100_000,
      "The portable DuckDB table must remain a bounded inline preview before its live action is used."
    );

    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    try {
      const duckdbRendererButton = await waitForNotebookRendererButton(
        workbench,
        "duckdb_relation",
        "Open in Open Wrangler"
      );
      let duckdbRelation: NonNullable<ReturnType<TestApi["activeSession"]>>;
      try {
        duckdbRelation = await openReleasedRendererVariableSession(
          duckdbRendererButton,
          workbench,
          testing,
          notebook,
          {
            name: "duckdb_relation",
            type: "_duckdb.DuckDBPyRelation",
            backend: "duckdb",
            firstValue: "3400001",
            notebookInsert: false
          },
          "the complete connection-private DuckDB relation opened from its primary inline action",
          `${phase}:duckdb-inline`
        );
      } finally {
        await duckdbRendererButton.dispose();
      }
      assert.equal(
        duckdbRelation.metadata.mode,
        "viewing",
        "A live DuckDB relation must stay viewing-only even when notebook sessions default to editing."
      );
      assert.deepEqual(duckdbRelation.metadata.shape, { rows: 100_000, columns: 4 });
      assert.deepEqual(duckdbRelation.metadata.filteredShape, duckdbRelation.metadata.shape);
      assert.deepEqual(duckdbRelation.metadata.capabilities, {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      });
      await assertReleasedSessionPage(testing, duckdbRelation, "3400001", "released-jupyter-duckdb-native-page");

      const farDuckdbPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 4,
        viewRequestId: "released-jupyter-duckdb-native-far-page",
        sessionId: duckdbRelation.sessionId,
        revision: duckdbRelation.metadata.revision,
        offset: 99_990,
        limit: 10,
        filterModel: duckdbRelation.metadata.filterModel
      });
      assert.equal(farDuckdbPage.kind, "page");
      if (farDuckdbPage.kind !== "page") throw new Error("The far native DuckDB page did not resolve.");
      assert.equal(farDuckdbPage.page.totalRows, 100_000);
      assert.equal(farDuckdbPage.page.rows[0]?.values[0]?.display, "3499991");
      assert.equal(farDuckdbPage.page.rows[9]?.values[0]?.display, "3500000");

      const filteredDuckdbModel: FilterModel = {
        logic: "and",
        filters: [
          {
            column: "market",
            type: "string",
            logic: "and",
            predicates: [{ kind: "predicate", operator: "equals", value: "DACH" }]
          }
        ],
        sort: [
          { column: "order_id", direction: "desc", nulls: "last" },
          { column: "revenue", direction: "asc", nulls: "last" }
        ]
      };
      const filteredDuckdbPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 4,
        viewRequestId: "released-jupyter-duckdb-native-filter-sort",
        sessionId: duckdbRelation.sessionId,
        revision: farDuckdbPage.revision,
        offset: 0,
        limit: 10,
        filterModel: filteredDuckdbModel
      });
      assert.equal(filteredDuckdbPage.kind, "page");
      if (filteredDuckdbPage.kind !== "page") {
        throw new Error("The filtered and sorted native DuckDB page did not resolve.");
      }
      assert.equal(filteredDuckdbPage.page.totalRows, 25_000);
      assert.equal(filteredDuckdbPage.page.rows[0]?.values[0]?.display, "3499997");
      assert.equal(filteredDuckdbPage.page.rows[0]?.values[1]?.display, "DACH");

      const duckdbRevenue = columnReference(duckdbRelation.metadata, "revenue");
      const duckdbSummary = await testing.request({
        kind: "getSummary",
        sessionId: duckdbRelation.sessionId,
        revision: filteredDuckdbPage.revision,
        viewRequestId: "released-jupyter-duckdb-native-summary",
        filterModel: filteredDuckdbModel,
        columnIds: [duckdbRevenue.id]
      });
      assert.equal(duckdbSummary.kind, "summary");
      if (duckdbSummary.kind !== "summary") throw new Error("The native DuckDB summary did not resolve.");
      assert.equal(duckdbSummary.summaries[0]?.totalCount, 25_000);
      assert.equal(duckdbSummary.summaries[0]?.numeric?.min, 100.5);
      assert.equal(duckdbSummary.summaries[0]?.numeric?.max, 5_099.94);

      await disposePackagedSessionPanel(
        testing,
        duckdbRelation.sessionId,
        "the released-Jupyter native DuckDB relation session"
      );
      const duckdbAliveEditor = await showExactReleasedNotebook(notebook);
      await executeReleasedNotebookCell(
        notebook,
        6,
        RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
        `${phase}:duckdb-user-relation-after-close`,
        duckdbAliveEditor
      );
      const duckdbAlive = releasedNotebookJsonResult(
        notebook.cellAt(6),
        RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
        "DuckDB user relation after Open Wrangler close"
      );
      assert.equal(duckdbAlive.count, 100_000);
      assert.equal(duckdbAlive.connectionCount, 100_000);
      assert.equal(duckdbAlive.first, 3_400_001);
      assert.equal(duckdbAlive.conversionGuards, true);

      recordAcceptanceProgress(`${phase}:duckdb-variables-action`);
      const duckdbVariablesEditor = await showExactReleasedNotebook(notebook);
      assertExactVisibleReleasedNotebookEditor(
        notebook,
        duckdbVariablesEditor,
        "before opening the real Jupyter Variables action for DuckDB"
      );
      await vscode.commands.executeCommand("jupyter.openVariableView");
      await dispatchReleasedJupyterVariableAction(workbench, notebook, "duckdb_relation", `${phase}:duckdb-variables`);
      const duckdbVariablesRelation = await waitForReleasedVariableSession(
        workbench,
        testing,
        notebook,
        {
          name: "duckdb_relation",
          type: "_duckdb.DuckDBPyRelation",
          backend: "duckdb",
          firstValue: "3400001",
          notebookInsert: false
        },
        "the exact DuckDB relation opened from the real Jupyter Variables view"
      );
      assert.equal(duckdbVariablesRelation.metadata.mode, "viewing");
      assert.deepEqual(
        duckdbVariablesRelation.metadata.filterModel,
        filteredDuckdbModel,
        "Reopening the same live DuckDB variable must restore its confirmed viewing state."
      );
      assert.deepEqual(duckdbVariablesRelation.metadata.filteredShape, { rows: 25_000, columns: 4 });
      await assertReleasedSessionPage(
        testing,
        duckdbVariablesRelation,
        "3499997",
        "released-jupyter-duckdb-variables-restored-page"
      );

      const unfilteredDuckdbVariablesPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 4,
        viewRequestId: "released-jupyter-duckdb-variables-complete-page",
        sessionId: duckdbVariablesRelation.sessionId,
        revision: duckdbVariablesRelation.metadata.revision,
        offset: 0,
        limit: 10,
        filterModel: { logic: "and", filters: [], sort: [] }
      });
      assert.equal(unfilteredDuckdbVariablesPage.kind, "page");
      if (unfilteredDuckdbVariablesPage.kind !== "page") {
        throw new Error("The complete native DuckDB Variables page did not resolve.");
      }
      assert.equal(unfilteredDuckdbVariablesPage.page.totalRows, 100_000);
      assert.equal(unfilteredDuckdbVariablesPage.page.rows[0]?.values[0]?.display, "3400001");

      const recoveryDuckdbPage = await testing.request({
        kind: "getPage",
        columnOffset: 0,
        columnLimit: 4,
        viewRequestId: "released-jupyter-duckdb-native-recovery-view",
        sessionId: duckdbVariablesRelation.sessionId,
        revision: unfilteredDuckdbVariablesPage.revision,
        offset: 0,
        limit: 10,
        filterModel: filteredDuckdbModel
      });
      assert.equal(recoveryDuckdbPage.kind, "page");
      if (recoveryDuckdbPage.kind !== "page") {
        throw new Error("The native DuckDB recovery view did not resolve.");
      }
      assert.deepEqual(recoveryDuckdbPage.metadata.filterModel, filteredDuckdbModel);
      assert.deepEqual(recoveryDuckdbPage.metadata.filteredShape, { rows: 25_000, columns: 4 });
      assert.equal(recoveryDuckdbPage.page.rows[0]?.values[0]?.display, "3499997");
      assert.equal(recoveryDuckdbPage.page.rows[0]?.values[1]?.display, "DACH");
      const duckdbDiagnostic = testing
        .diagnostics()
        .sessions.find((session) => session.publicId === duckdbVariablesRelation.sessionId);
      assert.ok(duckdbDiagnostic, "The native DuckDB session must remain coordinated before kernel restart.");
      const recoveryDuckdbRevenue = columnReference(recoveryDuckdbPage.metadata, "revenue");
      const recoveryDuckdbViewState: GridViewState = {
        columnWidths: Object.fromEntries(
          recoveryDuckdbPage.metadata.schema.map((column) => [
            column.id,
            column.id === recoveryDuckdbRevenue.id ? 310 : 640
          ])
        ),
        selectedColumnId: recoveryDuckdbRevenue.id,
        viewport: { firstVisibleRow: 123, scrollLeft: 120 }
      };
      await waitFor(
        () => testing.panelHydrated(duckdbVariablesRelation.sessionId),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the native DuckDB recovery panel to hydrate before presentation injection"
      );
      assert.equal(
        await testing.synchronizePanel(duckdbVariablesRelation.sessionId),
        true,
        "The native DuckDB recovery panel must settle its default presentation before injection."
      );
      await testing.updateViewState(duckdbVariablesRelation.sessionId, recoveryDuckdbViewState);
      assert.equal(
        await testing.synchronizePanel(duckdbVariablesRelation.sessionId),
        true,
        "The native DuckDB recovery presentation must commit through the real renderer before restart."
      );
      assert.deepEqual(testing.activeSession()?.viewState, {
        ...recoveryDuckdbViewState,
        filterModel: filteredDuckdbModel
      });
      duckdbRecoverySession = {
        sessionId: duckdbVariablesRelation.sessionId,
        revision: recoveryDuckdbPage.revision,
        filterModel: filteredDuckdbModel,
        runtimeId: duckdbDiagnostic.runtimeId,
        schema: recoveryDuckdbPage.metadata.schema.map((column) => ({ ...column })),
        viewState: recoveryDuckdbViewState
      };
    } finally {
      await configuration.update("notebookStartMode", originalNotebookStartMode, vscode.ConfigurationTarget.Workspace);
    }

    recordAcceptanceProgress(`${phase}:pandas-series`);
    const pandasSeries = await openReleasedVariableSession(
      workbench,
      testing,
      notebook,
      { name: "pandas_series", type: "Series", backend: "pandas", firstValue: "5" },
      "the Pandas Series opened through the released viewer argument"
    );
    await assertReleasedSessionPage(testing, pandasSeries, "5", "released-jupyter-pandas-series");
    await disposePackagedSessionPanel(testing, pandasSeries.sessionId, "the released-Jupyter Pandas Series");

    recordAcceptanceProgress(`${phase}:polars-dataframe`);
    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    const polarsFrame = await openReleasedVariableSession(
      workbench,
      testing,
      notebook,
      {
        name: "polars_frame",
        type: "polars.dataframe.frame.DataFrame",
        backend: "polars",
        firstValue: "3"
      },
      "the Polars DataFrame opened through the released viewer argument"
    );
    assert.equal(
      polarsFrame.metadata.mode,
      "editing",
      "Changing the notebook start mode must make the next released-Jupyter session editable."
    );
    const polarsPage = await assertReleasedSessionPage(testing, polarsFrame, "3", "released-jupyter-polars-dataframe");
    await waitFor(
      () => testing.panelHydrated(polarsFrame.sessionId),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the exact released-Jupyter Polars panel to hydrate before its live preview",
      () =>
        JSON.stringify({
          sessionId: polarsFrame.sessionId,
          coordinator: testing.diagnostics(),
          activeTab: activeEditorTabDiagnostic()
        })
    );
    assert.equal(
      await withAcceptanceOperationDeadline(
        testing.synchronizePanel(polarsFrame.sessionId),
        OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
        "the exact released-Jupyter Polars panel synchronization"
      ),
      true,
      "The released-Jupyter Polars session must own a synchronized live dataframe panel before preview."
    );

    recordAcceptanceProgress(`${phase}:polars-plan`);
    const preview = await testing.previewPanelStep({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: polarsFrame.sessionId,
      revision: polarsPage.revision,
      step: {
        id: "released-jupyter-double",
        kind: "formula",
        params: {
          leftColumn: columnReference(polarsFrame.metadata, "units"),
          operator: "multiply",
          value: 2,
          newColumn: "double_units"
        }
      },
      offset: 0,
      limit: 10
    });
    assert.ok(preview, "The released-Jupyter Polars preview must publish through the live dataframe panel.");
    assert.equal(preview.metadata.draftStep?.id, "released-jupyter-double");
    if (phase === "jupyter-allow" && screenshotOutput) {
      await captureReleasedJupyterPolarsDraft(workbench, testing, polarsFrame.sessionId, screenshotOutput);
    }
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: polarsFrame.sessionId,
      revision: preview.metadata.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") throw new Error("The released-Jupyter Polars plan did not apply.");
    assert.equal(applied.metadata.steps.length, 1);

    recordAcceptanceProgress(`${phase}:pandas-recovery-session`);
    const pandasRecovery = await openReleasedVariableSession(
      workbench,
      testing,
      notebook,
      { name: "pandas_frame", type: "DataFrame", backend: "pandas", firstValue: "1" },
      "the concurrent Pandas DataFrame retained for released-Jupyter recovery"
    );
    const pandasRecoveryPage = await assertReleasedSessionPage(
      testing,
      pandasRecovery,
      "1",
      "released-jupyter-pandas-concurrent-recovery"
    );
    const duckdbRestartSession = duckdbRecoverySession;
    assert.ok(duckdbRestartSession, "The native DuckDB session must remain open for kernel restart recovery.");
    assert.equal(
      testing.diagnostics().sessionCount,
      3,
      "The Polars, Pandas, and DuckDB sessions must all remain open before restart."
    );

    recordAcceptanceProgress(`${phase}:restart`);
    await exerciseReleasedJupyterRestartReplay(
      testing,
      notebook,
      polarsFrame.sessionId,
      applied,
      {
        sessionId: pandasRecovery.sessionId,
        revision: pandasRecoveryPage.revision,
        filterModel: pandasRecovery.metadata.filterModel
      },
      duckdbRestartSession,
      Number(initialKernel.pid),
      setupMarker,
      phase,
      kernelTarget,
      extension.extensionPath
    );
    await disposePackagedSessionPanel(testing, polarsFrame.sessionId, "the recovered released-Jupyter Polars session");
    await disposePackagedSessionPanel(
      testing,
      pandasRecovery.sessionId,
      "the recovered released-Jupyter Pandas session"
    );
    await disposePackagedSessionPanel(
      testing,
      duckdbRestartSession.sessionId,
      "the recovered released-Jupyter DuckDB relation session"
    );
    const recoveredDuckdbAliveEditor = await showExactReleasedNotebook(notebook);
    await executeReleasedNotebookCell(
      notebook,
      6,
      RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
      `${phase}:duckdb-replacement-relation-after-close`,
      recoveredDuckdbAliveEditor
    );
    const recoveredDuckdbAlive = releasedNotebookJsonResult(
      notebook.cellAt(6),
      RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT,
      "DuckDB replacement relation after Open Wrangler recovery cleanup"
    );
    assert.equal(recoveredDuckdbAlive.count, 100_000);
    assert.equal(recoveredDuckdbAlive.connectionCount, 100_000);
    assert.equal(recoveredDuckdbAlive.first, 3_400_001);
    assert.equal(recoveredDuckdbAlive.conversionGuards, true);
    await executeReleasedNotebookCell(
      notebook,
      7,
      RELEASED_JUPYTER_SESSION_COUNT_RESULT,
      `${phase}:replacement-runtime-session-count`,
      await showExactReleasedNotebook(notebook)
    );
    const replacementRuntimeSessions = releasedNotebookJsonResult(
      notebook.cellAt(7),
      RELEASED_JUPYTER_SESSION_COUNT_RESULT,
      "replacement kernel runtime sessions after terminal cleanup"
    );
    assert.equal(
      replacementRuntimeSessions.count,
      0,
      "Terminal cleanup must leave no Open Wrangler session in the replacement kernel."
    );
    assert.equal(testing.diagnostics().sessionCount, 0);
  } catch (error) {
    failureCheckpoint = failedAcceptanceProgressCheckpoint(phase, lastAcceptanceProgressCheckpoint);
    throw error;
  } finally {
    try {
      rendererLoadObserver?.dispose();
      await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
      remoteServerCollection?.dispose();
      await configuration.update("notebookStartMode", originalNotebookStartMode, vscode.ConfigurationTarget.Workspace);
      await configuration.update(
        "notebookPreviewProvider",
        originalNotebookPreviewProvider,
        vscode.ConfigurationTarget.Workspace
      );
      cleanupAcceptanceTemporaryDirectory(directory);
    } finally {
      if (failureCheckpoint) recordAcceptanceProgress(failureCheckpoint);
    }
  }
}

async function exerciseReleasedPySparkJupyterExtension(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  testPython: string
): Promise<void> {
  const phase: ReleasedJupyterPhase = "jupyter-pyspark";
  assert.equal(
    testing.diagnostics().sessionCount,
    0,
    "Released PySpark acceptance must start without a retained Open Wrangler session."
  );
  assert.ok(
    !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
    "File-backed Open Wrangler use must not acquire a hard Jupyter extension dependency."
  );

  const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
  assert.equal(jupyterExtension.packageJSON.version, RELEASED_JUPYTER_EXTENSION_VERSION);

  const kernelTarget = releasedJupyterKernelTarget(phase);
  const screenshotOutput = process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS;
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-released-jupyter-pyspark-"));
  const notebookPath = path.join(directory, screenshotOutput ? "regional-orders-spark.ipynb" : "jupyter-pyspark.ipynb");
  const notebookUri = vscode.Uri.file(notebookPath);
  writeReleasedPySparkNotebook(notebookPath, extension.extensionPath);

  let notebook: vscode.NotebookDocument | undefined;
  let failureCheckpoint: string | undefined;
  try {
    recordAcceptanceProgress(`${phase}:notebook-open`);
    notebook = await vscode.workspace.openNotebookDocument(notebookUri);
    assertExactOpenNotebookDocument(notebook, "after opening the released PySpark fixture");
    const notebookEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
    assert.equal(notebookEditor.notebook, notebook);

    const workbench = await connectToEditorWorkbench();
    const jupyterApi = await jupyterExtension.activate();
    assertExactOpenNotebookDocument(notebook, "after activating released Jupyter for PySpark acceptance");
    recordAcceptanceProgress(`${phase}:kernel-select`);
    await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);

    const visibleNotebook = await showExactReleasedNotebook(notebook);
    await executeReleasedNotebookCell(
      notebook,
      0,
      RELEASED_JUPYTER_RESTART_RESULT,
      `${phase}:kernel-warmup`,
      visibleNotebook
    );
    const warmKernel = releasedNotebookJsonResult(
      notebook.cellAt(0),
      RELEASED_JUPYTER_RESTART_RESULT,
      "PySpark kernel warmup"
    );
    assertReleasedJupyterKernelIdentity(warmKernel, kernelTarget, testPython);
    assert.equal(warmKernel.runtime, false, "The PySpark kernel must start without Open Wrangler preloaded.");

    recordAcceptanceProgress(`${phase}:classic-variables`);
    await showExactReleasedNotebook(notebook);
    await vscode.commands.executeCommand("jupyter.openVariableView");
    const classicEditor = await showExactReleasedNotebook(notebook);
    await executeReleasedNotebookCell(
      notebook,
      1,
      RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
      `${phase}:classic-setup`,
      classicEditor
    );
    const classicSetup = releasedNotebookJsonResult(
      notebook.cellAt(1),
      RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
      "PySpark Classic setup"
    );
    assert.equal(classicSetup.sparkVersion, "4.2.0");
    const classicJavaMajor = Number(classicSetup.javaVersion);
    assert.ok(
      Number.isSafeInteger(classicJavaMajor) && classicJavaMajor >= 17,
      `PySpark 4.2 requires Java 17 or newer; the notebook reported ${JSON.stringify(classicSetup.javaVersion)}.`
    );
    assert.equal(classicSetup.module, "pyspark.sql.classic.dataframe");
    assert.equal(classicSetup.workerPythonPinned, true);

    await dispatchReleasedJupyterVariableAction(workbench, notebook, "spark_classic_frame", `${phase}:classic-action`);
    const consent = await waitForReleasedJupyterConsent(workbench, testing);
    await consent.allow.click();
    await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const classic = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      {
        name: "spark_classic_frame",
        type: "pyspark.sql.classic.dataframe.DataFrame",
        backend: "pyspark",
        firstValue: "",
        notebookInsert: false
      },
      "the PySpark Classic DataFrame opened from the real Jupyter Variables view"
    );
    assert.equal(classic.metadata.mode, "viewing");
    assert.deepEqual(classic.metadata.capabilities, {
      editable: false,
      lazy: false,
      cancel: false,
      exportCsv: false,
      exportParquet: false,
      notebookInsert: false
    });
    const classicPage = await assertReleasedPySparkPanelAndQueries(testing, classic, "classic");

    recordAcceptanceProgress(`${phase}:classic-restart`);
    await restartReleasedJupyterKernelAndWait(notebook);
    await executeReleasedNotebookCell(
      notebook,
      0,
      RELEASED_JUPYTER_RESTART_RESULT,
      `${phase}:classic-restart-probe`,
      await showExactReleasedNotebook(notebook)
    );
    const replacementKernel = releasedNotebookJsonResult(
      notebook.cellAt(0),
      RELEASED_JUPYTER_RESTART_RESULT,
      "PySpark replacement kernel"
    );
    assertReleasedJupyterKernelIdentity(replacementKernel, kernelTarget, testPython);
    assert.notEqual(
      Number(replacementKernel.pid),
      Number(classicSetup.pid),
      "Restarting the PySpark notebook must replace the kernel process."
    );
    assert.equal(
      replacementKernel.runtime,
      replacementKernel.bootstrap,
      "Runtime availability in the replacement PySpark kernel must come from its own Open Wrangler bootstrap."
    );

    recordAcceptanceProgress(`${phase}:classic-restart-setup`);
    await executeReleasedNotebookCell(
      notebook,
      1,
      RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
      `${phase}:classic-restart-setup`,
      await showExactReleasedNotebook(notebook)
    );
    const restartedClassicSetup = releasedNotebookJsonResult(
      notebook.cellAt(1),
      RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
      "restarted PySpark Classic setup"
    );
    assert.equal(Number(restartedClassicSetup.pid), Number(replacementKernel.pid));
    assert.equal(restartedClassicSetup.workerPythonPinned, true);
    assert.notEqual(
      restartedClassicSetup.sessionId,
      classicSetup.sessionId,
      "The replacement kernel must own a new user SparkSession."
    );

    recordAcceptanceProgress(`${phase}:classic-restart-replay`);
    const replayedClassic = await withBoundedAcceptancePromise(
      testing.request({
        kind: "getPage",
        ...GRID_COLUMN_WINDOW,
        viewRequestId: "released-jupyter-pyspark-classic-restart-replay",
        sessionId: classic.sessionId,
        revision: classicPage.revision,
        offset: 0,
        limit: 1,
        filterModel: classicPage.metadata.filterModel
      }),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the released-Jupyter PySpark Classic page after kernel replacement"
    );
    assert.equal(replayedClassic.kind, "page");
    if (replayedClassic.kind !== "page") {
      throw new Error("The released-Jupyter PySpark Classic restart replay did not return a page.");
    }
    assert.equal(
      replayedClassic.metadata.sessionId,
      classic.sessionId,
      "Kernel recovery must preserve the public Open Wrangler session identity."
    );
    assert.equal(replayedClassic.metadata.backend, "pyspark");
    const replayedRecordId = replayedClassic.metadata.schema.find((column) => column.name === "record_id");
    assert.ok(replayedRecordId);
    assert.deepEqual(gridColumnDisplays(replayedClassic.page, replayedRecordId.id), ["2"]);

    await disposePackagedSessionPanel(testing, classic.sessionId, "the released-Jupyter PySpark Classic session");

    recordAcceptanceProgress(`${phase}:classic-owner-session`);
    await executeReleasedNotebookCell(
      notebook,
      2,
      RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
      `${phase}:classic-owner-session`,
      await showExactReleasedNotebook(notebook)
    );
    const classicClose = releasedNotebookJsonResult(
      notebook.cellAt(2),
      RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
      "PySpark Classic close"
    );
    assert.equal(classicClose.sessionId, restartedClassicSetup.sessionId);
    assert.equal(classicClose.count, 3, "Closing Open Wrangler must leave the user's Classic SparkSession usable.");

    if (screenshotOutput) {
      recordAcceptanceProgress(`${phase}:orders-variables`);
      await showExactReleasedNotebook(notebook);
      await vscode.commands.executeCommand("jupyter.openVariableView");
      await showExactReleasedNotebook(notebook);
      await dispatchReleasedJupyterVariableAction(workbench, notebook, "spark_orders_frame", `${phase}:orders-action`);
      const orders = await waitForReleasedVariableSession(
        workbench,
        testing,
        notebook,
        {
          name: "spark_orders_frame",
          type: "pyspark.sql.classic.dataframe.DataFrame",
          backend: "pyspark",
          firstValue: "",
          notebookInsert: false
        },
        "the realistic PySpark Classic orders DataFrame opened from the real Jupyter Variables view"
      );
      assert.deepEqual(orders.metadata.shape, { rows: 100_000, columns: 15 });
      assert.equal(orders.metadata.mode, "viewing");
      assert.equal(orders.metadata.capabilities.editable, false);
      assert.equal(orders.metadata.capabilities.exportCsv, false);
      assert.equal(orders.metadata.capabilities.exportParquet, false);
      await captureReleasedJupyterPySparkLive(workbench, testing, orders, screenshotOutput);
      await disposePackagedSessionPanel(testing, orders.sessionId, "the released-Jupyter PySpark orders session");
    }

    recordAcceptanceProgress(`${phase}:connect-variables`);
    await showExactReleasedNotebook(notebook);
    await vscode.commands.executeCommand("jupyter.openVariableView");
    const connectEditor = await showExactReleasedNotebook(notebook);
    await executeReleasedNotebookCell(
      notebook,
      3,
      RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
      `${phase}:connect-setup`,
      connectEditor
    );
    const connectSetup = releasedNotebookJsonResult(
      notebook.cellAt(3),
      RELEASED_JUPYTER_PYSPARK_SETUP_RESULT,
      "local Spark Connect setup"
    );
    assert.equal(connectSetup.sparkVersion, "4.2.0");
    assert.equal(connectSetup.module, "pyspark.sql.connect.dataframe");
    assert.equal(connectSetup.workerPythonPinned, true);

    await dispatchReleasedJupyterVariableAction(workbench, notebook, "spark_connect_frame", `${phase}:connect-action`);
    const connect = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      {
        name: "spark_connect_frame",
        type: "pyspark.sql.connect.dataframe.DataFrame",
        backend: "pyspark",
        firstValue: "",
        notebookInsert: false
      },
      "the local Spark Connect DataFrame opened from the real Jupyter Variables view"
    );
    await assertReleasedPySparkPanelAndQueries(testing, connect, "connect");
    await disposePackagedSessionPanel(testing, connect.sessionId, "the released-Jupyter Spark Connect session");

    recordAcceptanceProgress(`${phase}:connect-owner-session`);
    await executeReleasedNotebookCell(
      notebook,
      4,
      RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
      `${phase}:connect-owner-session`,
      await showExactReleasedNotebook(notebook)
    );
    const connectClose = releasedNotebookJsonResult(
      notebook.cellAt(4),
      RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT,
      "local Spark Connect close"
    );
    assert.equal(connectClose.sessionId, connectSetup.sessionId);
    assert.equal(connectClose.count, 3, "Closing Open Wrangler must leave the user's Connect SparkSession usable.");
    assert.equal(testing.diagnostics().sessionCount, 0);
    assert.equal(releasedJupyterSessionTabs().length, 0);
    assert.ok(jupyterApi, "The released Jupyter API must remain active through PySpark cleanup.");
  } catch (error) {
    failureCheckpoint = failedAcceptanceProgressCheckpoint(phase, lastAcceptanceProgressCheckpoint);
    throw error;
  } finally {
    try {
      await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
      cleanupAcceptanceTemporaryDirectory(directory);
    } finally {
      if (failureCheckpoint) recordAcceptanceProgress(failureCheckpoint);
    }
  }
}

async function dispatchReleasedJupyterVariableAction(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  variableName: string,
  checkpoint: string
): Promise<void> {
  const viewerAction = await waitForReleasedJupyterVariableAction(workbench, variableName, checkpoint);
  assert.equal(
    releasedJupyterSessionTabs().length,
    0,
    `The real released-Jupyter Variables action for ${variableName} requires a zero-tab receipt baseline.`
  );
  assertExactOpenNotebookDocument(
    notebook,
    `immediately before dispatching the released-Jupyter Variables action for ${variableName}`
  );
  recordAcceptanceProgress(`${checkpoint}:dispatch`);
  await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
    description: `the real released-Jupyter Variables action for ${variableName}`,
    activate: () => viewerAction.action.press("Enter", { timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    receipt: async () => {
      assert.equal(
        await viewerAction.documentRoot.evaluate(
          (element) =>
            (element as unknown as ReleasedJupyterDocumentRootElement).dataset.openWranglerAcceptanceActivation
        ),
        "seen",
        `The real released-Jupyter Variables action for ${variableName} must receive one trusted keyboard activation.`
      );
      await waitForReleasedJupyterVariableActionReceipt(variableName);
    },
    authoritativeReceiptAfterActivationFailure: () => waitForReleasedJupyterVariableActionReceipt(variableName)
  });
  recordAcceptanceProgress(`${checkpoint}:receipt`);
}

async function waitForReleasedJupyterVariableActionReceipt(variableName: string): Promise<void> {
  await waitFor(
    () => releasedJupyterSessionTabs().length === 1,
    10_000,
    `the released Jupyter viewer delegation for ${variableName}`,
    () => JSON.stringify({ tabCount: releasedJupyterSessionTabs().length })
  );
}

async function assertReleasedPySparkPanelAndQueries(
  testing: TestApi,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  variant: "classic" | "connect"
): Promise<Extract<OpenWranglerResponse, { kind: "page" }>> {
  await waitFor(
    () => testing.panelHydrated(active.sessionId),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the released-Jupyter PySpark ${variant} panel to hydrate`,
    () => JSON.stringify(testing.diagnostics())
  );
  assert.equal(
    await withAcceptanceOperationDeadline(
      testing.synchronizePanel(active.sessionId),
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      `the released-Jupyter PySpark ${variant} panel synchronization`
    ),
    true
  );

  const filterModel: FilterModel = {
    logic: "and",
    filters: [
      {
        column: "category",
        type: "string",
        logic: "and",
        predicates: [{ kind: "predicate", operator: "equals", value: "alpha" }]
      }
    ],
    sort: [{ column: "amount", direction: "desc", nulls: "last" }]
  };
  const first = await withBoundedAcceptancePromise(
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `released-jupyter-pyspark-${variant}-page-0`,
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 1,
      filterModel
    }),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the released-Jupyter PySpark ${variant} filtered page`
  );
  assert.equal(first.kind, "page");
  if (first.kind !== "page") throw new Error(`The PySpark ${variant} filtered page did not resolve.`);
  assert.equal(first.page.totalRows, 2);
  assert.deepEqual(first.metadata.filterModel, filterModel);
  const recordId = first.metadata.schema.find((column) => column.name === "record_id");
  const amount = first.metadata.schema.find((column) => column.name === "amount");
  assert.ok(recordId);
  assert.ok(amount);
  assert.deepEqual(gridColumnDisplays(first.page, recordId.id), ["2"]);

  const second = await withBoundedAcceptancePromise(
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `released-jupyter-pyspark-${variant}-page-1`,
      sessionId: active.sessionId,
      revision: first.revision,
      offset: 1,
      limit: 1,
      filterModel
    }),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the released-Jupyter PySpark ${variant} second page`
  );
  assert.equal(second.kind, "page");
  if (second.kind !== "page") throw new Error(`The PySpark ${variant} second page did not resolve.`);
  assert.deepEqual(gridColumnDisplays(second.page, recordId.id), ["3"]);

  const summary = await withBoundedAcceptancePromise(
    testing.request({
      kind: "getSummary",
      viewRequestId: `released-jupyter-pyspark-${variant}-summary`,
      sessionId: active.sessionId,
      revision: second.revision,
      filterModel,
      columnIds: [amount.id]
    }),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the released-Jupyter PySpark ${variant} progressive summary`
  );
  assert.equal(summary.kind, "summary");
  if (summary.kind !== "summary") throw new Error(`The PySpark ${variant} summary did not resolve.`);
  assert.equal(summary.summaries.length, 1);
  assert.equal(summary.summaries[0]?.columnId, amount.id);
  assert.equal(summary.summaries[0]?.totalCount, 2);
  assert.equal(summary.summaries[0]?.numeric?.min, 20);
  assert.equal(summary.summaries[0]?.numeric?.max, 30);
  return second;
}

function readReleasedRemoteJupyterDescriptor(runId: string): {
  readonly baseUrl: string;
  readonly token: string;
  readonly hostname: string;
} {
  assert.equal(process.platform, "linux", "Container-isolated remote Jupyter acceptance is Linux-only.");
  const descriptorPath = process.env.OPEN_WRANGLER_TEST_REMOTE_JUPYTER_DESCRIPTOR;
  assert.ok(
    descriptorPath && path.isAbsolute(descriptorPath) && !/[\0\r\n]/u.test(descriptorPath),
    "Remote Jupyter acceptance requires one absolute private descriptor path."
  );
  const privateTemp = path.resolve(tmpdir());
  const resolvedDescriptor = path.resolve(descriptorPath);
  const contained = path.relative(privateTemp, resolvedDescriptor);
  assert.ok(
    contained.length > 0 && contained !== ".." && !contained.startsWith(`..${path.sep}`) && !path.isAbsolute(contained),
    "The remote Jupyter descriptor must stay inside the phase's private temporary root."
  );

  let descriptorFd: number | undefined;
  try {
    descriptorFd = openSync(
      resolvedDescriptor,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
    );
    const before = fstatSync(descriptorFd, { bigint: true });
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= 2_048n &&
        (before.mode & 0o777n) === 0o400n &&
        (typeof process.getuid !== "function" || before.uid === BigInt(process.getuid())),
      "The remote Jupyter descriptor must be one owned, mode-0400, single-link bounded regular file."
    );
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptorFd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, "The remote Jupyter descriptor ended before its recorded size.");
      offset += count;
    }
    const after = fstatSync(descriptorFd, { bigint: true });
    assert.deepEqual(
      {
        dev: after.dev,
        ino: after.ino,
        mode: after.mode,
        nlink: after.nlink,
        uid: after.uid,
        size: after.size,
        mtimeNs: after.mtimeNs
      },
      {
        dev: before.dev,
        ino: before.ino,
        mode: before.mode,
        nlink: before.nlink,
        uid: before.uid,
        size: before.size,
        mtimeNs: before.mtimeNs
      },
      "The remote Jupyter descriptor changed while it was read."
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(decoded);
    assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    const record = parsed as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ["baseUrl", "hostname", "protocol", "runId", "token"]);
    assert.equal(record.protocol, RELEASED_JUPYTER_REMOTE_DESCRIPTOR_PROTOCOL);
    assert.equal(record.runId, runId);
    assert.equal(record.hostname, `owr-${runId.replaceAll("-", "").slice(0, 12)}`);
    const token = readReleasedRemoteJupyterDescriptorToken(record.token);
    assert.ok(typeof record.baseUrl === "string" && record.baseUrl.length <= 64);
    return {
      baseUrl: record.baseUrl,
      token,
      hostname: String(record.hostname)
    };
  } catch (error) {
    throw new Error("Remote Jupyter acceptance could not validate its private connection descriptor.", {
      cause: error
    });
  } finally {
    if (descriptorFd !== undefined) closeSync(descriptorFd);
  }
}

function releasedJupyterKernelTarget(phase: ReleasedJupyterPhase): ReleasedJupyterKernelTarget {
  if (phase !== "jupyter-remote") {
    return {
      label: RELEASED_JUPYTER_LOCAL_KERNEL_LABEL,
      name: "openwrangler-acceptance",
      routeLabels: ["Jupyter Kernel...", "Jupyter", "Local Kernel Specs..."]
    };
  }
  const runId = process.env.OPEN_WRANGLER_TEST_RUN_ID;
  assert.ok(
    runId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId),
    "Remote Jupyter acceptance requires its correlated UUID run ID."
  );
  const descriptor = readReleasedRemoteJupyterDescriptor(runId);
  const serializedBaseUrl = descriptor.baseUrl;
  const parsed = new URL(serializedBaseUrl);
  assert.equal(parsed.protocol, "http:", "Remote Jupyter acceptance permits only a loopback HTTP server.");
  assert.equal(parsed.hostname, "127.0.0.1", "Remote Jupyter acceptance permits only the IPv4 loopback host.");
  assert.match(parsed.port, /^(?:[1-9][0-9]{0,4})$/u, "Remote Jupyter acceptance requires an explicit port.");
  assert.ok(Number(parsed.port) <= 65_535, "Remote Jupyter acceptance port exceeds the TCP range.");
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.pathname, "/");
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "");
  assert.equal(parsed.origin, serializedBaseUrl, "The remote Jupyter base URL must be one canonical origin.");
  return {
    label: RELEASED_JUPYTER_REMOTE_KERNEL_LABEL,
    name: RELEASED_JUPYTER_REMOTE_KERNEL_NAME,
    routeLabels: [RELEASED_JUPYTER_REMOTE_COLLECTION_LABEL, RELEASED_JUPYTER_REMOTE_SERVER_LABEL],
    remote: {
      baseUrl: vscode.Uri.parse(serializedBaseUrl, true),
      token: descriptor.token,
      runId,
      hostname: descriptor.hostname
    }
  };
}

function registerReleasedRemoteJupyterServer(
  jupyter: Jupyter,
  target: ReleasedJupyterKernelTarget
): JupyterServerCollection {
  assert.ok(target.remote, "A local released-Jupyter target cannot register the remote server collection.");
  const server = {
    id: `container-${target.remote.runId.replaceAll("-", "")}`,
    label: RELEASED_JUPYTER_REMOTE_SERVER_LABEL,
    connectionInformation: {
      baseUrl: target.remote.baseUrl,
      token: target.remote.token
    }
  } as const;
  return jupyter.createJupyterServerCollection(
    `openwrangler.remoteAcceptance.${target.remote.runId.replaceAll("-", "")}`,
    RELEASED_JUPYTER_REMOTE_COLLECTION_LABEL,
    {
      provideJupyterServers: () => [server],
      resolveJupyterServer: (candidate) => {
        assert.equal(candidate.id, server.id, "Released Jupyter resolved an unknown remote acceptance server.");
        return server;
      }
    }
  );
}

function assertReleasedJupyterKernelIdentity(
  result: Readonly<Record<string, unknown>>,
  target: ReleasedJupyterKernelTarget,
  hostPython: string
): void {
  assert.equal(result.setup === undefined, false, "The released-Jupyter setup result must include its marker.");
  if (!target.remote) {
    assert.equal(
      canonicalAcceptancePath(String(result.executable)),
      canonicalAcceptancePath(hostPython),
      "The local released Jupyter kernel must use the runner-selected private Python environment."
    );
    return;
  }
  assert.notEqual(
    canonicalAcceptancePath(String(result.executable)),
    canonicalAcceptancePath(hostPython),
    "The remote Jupyter kernel must not execute through the editor host's Python environment."
  );
  assert.equal(
    result.remoteRunId,
    target.remote.runId,
    "The selected kernel did not originate in the owned container."
  );
  assert.equal(
    result.hostname,
    target.remote.hostname,
    "The selected kernel reported an unexpected container hostname."
  );
  assert.equal(
    result.hostExtensionVisible,
    false,
    "The remote kernel must not be able to read the host extension installation."
  );
}

async function assertReleasedRemoteRuntimeTransfer(
  notebook: vscode.NotebookDocument,
  target: ReleasedJupyterKernelTarget,
  hostExtensionPath: string,
  phase: ReleasedJupyterPhase
): Promise<void> {
  assert.ok(target.remote, "Runtime-transfer attestation is reserved for the remote Jupyter phase.");
  await executeReleasedNotebookCell(notebook, 4, RELEASED_JUPYTER_RUNTIME_RESULT, `${phase}:runtime-transfer-cell`);
  const result = releasedNotebookJsonResult(notebook.cellAt(4), RELEASED_JUPYTER_RUNTIME_RESULT, "runtime transfer");
  assert.equal(result.remoteRunId, target.remote.runId);
  assert.equal(result.hostname, target.remote.hostname);
  assert.equal(result.hostExtensionVisible, false);
  const runtimeFile = String(result.runtimeFile);
  assert.match(
    runtimeFile,
    /^\/tmp\/openwrangler-runtime\/[0-9a-f]{16}\/openwrangler_runtime\/__init__\.py$/u,
    "Open Wrangler must transfer its runtime into the remote kernel's own temporary filesystem."
  );
  assert.equal(
    runtimeFile.startsWith(canonicalAcceptancePath(hostExtensionPath)),
    false,
    "The remote runtime must not resolve from the host extension installation."
  );
}

function writeReleasedPySparkNotebook(notebookPath: string, hostExtensionPath: string): void {
  const target = releasedJupyterKernelTarget("jupyter-pyspark");
  const cell = (source: readonly string[]) => ({
    cell_type: "code",
    execution_count: null,
    metadata: {},
    outputs: [],
    source: source.map((line) => `${line}\n`)
  });
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        cell([
          "import importlib.util",
          "import json",
          "import os",
          "import sys",
          `print(${JSON.stringify(RELEASED_JUPYTER_RESTART_RESULT)} + json.dumps({`,
          "    'executable': sys.executable,",
          "    'pid': os.getpid(),",
          "    'runtime': importlib.util.find_spec('openwrangler_runtime') is not None,",
          "    'bootstrap': ('__ow_bundle_root' in globals() and str(globals().get('__ow_bundle_root')) in sys.path),",
          "    'setup': None,",
          `    'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)}),`,
          "}, sort_keys=True))"
        ]),
        cell([
          "import json",
          "import os",
          "import sys",
          "os.environ['PYSPARK_PYTHON'] = sys.executable",
          "os.environ['PYSPARK_DRIVER_PYTHON'] = sys.executable",
          "from pyspark.sql import SparkSession",
          "from pyspark.sql import functions as F",
          "spark = (SparkSession.builder",
          "    .master('local[2]')",
          "    .appName('open-wrangler-packaged-classic')",
          "    .config('spark.ui.enabled', 'false')",
          "    .config('spark.driver.bindAddress', '127.0.0.1')",
          "    .config('spark.driver.host', '127.0.0.1')",
          "    .config('spark.sql.shuffle.partitions', '2')",
          "    .getOrCreate())",
          "spark.sparkContext.setLogLevel('ERROR')",
          "spark_classic_frame = spark.createDataFrame([",
          "    (1, 'beta', 10.0),",
          "    (2, 'alpha', 30.0),",
          "    (3, 'alpha', 20.0),",
          "    (4, 'gamma', None),",
          "], 'record_id long, category string, amount double').repartition(2)",
          "def _open_wrangler_label(values, index):",
          "    return F.element_at(",
          "        F.array(*[F.lit(value) for value in values]),",
          "        (F.pmod(index, F.lit(len(values))) + F.lit(1)).cast('int'),",
          "    )",
          "_open_wrangler_index = F.col('id')",
          "spark_orders_frame = spark.range(100000).select(",
          "    F.format_string('ORD-%07d', _open_wrangler_index + F.lit(2400001)).alias('order_id'),",
          "    _open_wrangler_label(['Benelux', 'DACH', 'France', 'Iberia', 'Italy', 'Nordics', 'UK & Ireland'], _open_wrangler_index).alias('market'),",
          "    F.when(",
          "        F.pmod(_open_wrangler_index + F.lit(29), F.lit(113)) == F.lit(0),",
          "        F.lit(None).cast('double'),",
          "    ).otherwise(",
          "        F.round(F.lit(620.50) + F.pmod(_open_wrangler_index * F.lit(7919), F.lit(1850000)) / F.lit(100.0), 2)",
          "    ).alias('revenue'),",
          "    (F.pmod(_open_wrangler_index, F.lit(7)) != F.lit(2)).alias('fulfilled'),",
          "    F.date_add(F.lit('2026-01-01').cast('date'), F.pmod(_open_wrangler_index, F.lit(365)).cast('int')).alias('order_date'),",
          "    _open_wrangler_label(['Enterprise', 'Mid-market', 'Public sector', 'Small business'], _open_wrangler_index).alias('segment'),",
          "    _open_wrangler_label(['Direct', 'Partner', 'Online'], _open_wrangler_index).alias('channel'),",
          "    _open_wrangler_label(['Analytics', 'Automation', 'Data platform', 'Operations', 'Planning'], _open_wrangler_index).alias('product_family'),",
          "    (F.pmod(_open_wrangler_index * F.lit(7) + F.lit(2), F.lit(12)) + F.lit(1)).cast('long').alias('units'),",
          "    F.round(F.lit(79.0) + F.pmod(_open_wrangler_index * F.lit(3571), F.lit(92000)) / F.lit(100.0), 2).alias('unit_price'),",
          "    F.round(F.pmod(_open_wrangler_index * F.lit(37), F.lit(1800)) / F.lit(100.0), 2).alias('discount_pct'),",
          "    F.round(F.lit(180.0) + F.pmod(_open_wrangler_index * F.lit(1451), F.lit(610000)) / F.lit(100.0), 2).alias('gross_margin'),",
          "    _open_wrangler_label(['High', 'Standard', 'Strategic'], _open_wrangler_index).alias('priority'),",
          "    F.date_add(F.lit('2027-01-01').cast('date'), F.pmod(_open_wrangler_index, F.lit(365)).cast('int')).alias('renewal_date'),",
          "    _open_wrangler_label(['Active', 'Expansion', 'Renewal review'], _open_wrangler_index).alias('account_status'),",
          ")",
          `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_SETUP_RESULT)} + json.dumps({`,
          "    'sparkVersion': spark.version,",
          "    'javaVersion': spark.sparkContext._jvm.java.lang.System.getProperty('java.specification.version'),",
          "    'module': type(spark_classic_frame).__module__,",
          "    'pid': os.getpid(),",
          "    'sessionId': f'{os.getpid()}:{id(spark)}',",
          "    'workerPythonPinned': (",
          "        os.environ.get('PYSPARK_PYTHON') == sys.executable",
          "        and os.environ.get('PYSPARK_DRIVER_PYTHON') == sys.executable",
          "    ),",
          "}, sort_keys=True))"
        ]),
        cell([
          "import json",
          "_open_wrangler_classic_count = spark.range(3).count()",
          `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT)} + json.dumps({`,
          "    'count': _open_wrangler_classic_count,",
          "    'sessionId': f'{os.getpid()}:{id(spark)}',",
          "}, sort_keys=True))"
        ]),
        cell([
          "import json",
          "import os",
          "import sys",
          "os.environ['PYSPARK_PYTHON'] = sys.executable",
          "os.environ['PYSPARK_DRIVER_PYTHON'] = sys.executable",
          "spark.stop()",
          "connect_spark = (SparkSession.builder",
          "    .remote('local[2]')",
          "    .config('spark.sql.shuffle.partitions', '2')",
          "    .getOrCreate())",
          "spark_connect_frame = connect_spark.createDataFrame([",
          "    (1, 'beta', 10.0),",
          "    (2, 'alpha', 30.0),",
          "    (3, 'alpha', 20.0),",
          "    (4, 'gamma', None),",
          "], 'record_id long, category string, amount double').repartition(2)",
          `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_SETUP_RESULT)} + json.dumps({`,
          "    'sparkVersion': connect_spark.version,",
          "    'module': type(spark_connect_frame).__module__,",
          "    'sessionId': str(id(connect_spark)),",
          "    'workerPythonPinned': (",
          "        os.environ.get('PYSPARK_PYTHON') == sys.executable",
          "        and os.environ.get('PYSPARK_DRIVER_PYTHON') == sys.executable",
          "    ),",
          "}, sort_keys=True))"
        ]),
        cell([
          "import json",
          "_open_wrangler_connect_count = connect_spark.range(3).count()",
          "_open_wrangler_connect_session_id = str(id(connect_spark))",
          "connect_spark.stop()",
          `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT)} + json.dumps({`,
          "    'count': _open_wrangler_connect_count,",
          "    'sessionId': _open_wrangler_connect_session_id,",
          "}, sort_keys=True))"
        ])
      ],
      metadata: {
        kernelspec: {
          display_name: target.label,
          language: "python",
          name: target.name
        },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  );
}

function writeReleasedJupyterNotebook(
  notebookPath: string,
  setupMarker: string,
  target: ReleasedJupyterKernelTarget,
  hostExtensionPath: string
): void {
  const setup = [
    "import importlib.util",
    "import json",
    "import os",
    "import socket",
    "import sys",
    "from datetime import date, timedelta",
    "import duckdb",
    "import pandas as pd",
    "import polars as pl",
    "pandas_frame = pd.DataFrame({'value': [1, 2], 'label': ['a', 'b']})",
    "pandas_series = pd.Series([5, 6], name='series_value')",
    "showcase_rows = 100000",
    "showcase_markets = ['DACH', 'Nordics', 'Iberia', 'France', 'Italy', 'Benelux', 'UK & Ireland']",
    "showcase_segments = ['Enterprise', 'Mid-market', 'Public sector', 'Small business']",
    "showcase_channels = ['Direct', 'Partner', 'Online']",
    "showcase_products = ['Analytics', 'Automation', 'Data platform', 'Operations', 'Planning']",
    "showcase_priorities = ['High', 'Standard', 'Strategic']",
    "showcase_statuses = ['Active', 'Expansion', 'Renewal review']",
    "orders_df = pd.DataFrame({",
    "    'order_id': list(range(2400001, 2400001 + showcase_rows)),",
    "    'market': [showcase_markets[index % len(showcase_markets)] for index in range(showcase_rows)],",
    "    'revenue': [round(620.50 + ((index * 7919) % 1850000) / 100, 2) for index in range(showcase_rows)],",
    "    'fulfilled': [index % 7 != 2 for index in range(showcase_rows)],",
    "    'order_date': pd.to_datetime('2026-01-01') + pd.to_timedelta([index % 365 for index in range(showcase_rows)], unit='D'),",
    "    'segment': [showcase_segments[index % len(showcase_segments)] for index in range(showcase_rows)],",
    "    'channel': [showcase_channels[index % len(showcase_channels)] for index in range(showcase_rows)],",
    "    'product_family': [showcase_products[index % len(showcase_products)] for index in range(showcase_rows)],",
    "    'units': [1 + ((index * 7 + 2) % 12) for index in range(showcase_rows)],",
    "    'unit_price': [round(79 + ((index * 3571) % 92000) / 100, 2) for index in range(showcase_rows)],",
    "    'discount_pct': [round(((index * 37) % 1800) / 100, 2) for index in range(showcase_rows)],",
    "    'gross_margin': [round(180 + ((index * 1451) % 610000) / 100, 2) for index in range(showcase_rows)],",
    "    'priority': [showcase_priorities[index % len(showcase_priorities)] for index in range(showcase_rows)],",
    "    'renewal_date': pd.to_datetime('2027-01-01') + pd.to_timedelta([index % 365 for index in range(showcase_rows)], unit='D'),",
    "    'account_status': [showcase_statuses[index % len(showcase_statuses)] for index in range(showcase_rows)],",
    "})",
    "polars_frame = pl.DataFrame({",
    "    'units': [1 + ((index * 7 + 2) % 12) for index in range(showcase_rows)],",
    "    'order_id': list(range(2400001, 2400001 + showcase_rows)),",
    "    'market': [showcase_markets[index % len(showcase_markets)] for index in range(showcase_rows)],",
    "    'revenue': [round(620.50 + ((index * 6151) % 1250000) / 100, 2) for index in range(showcase_rows)],",
    "    'fulfilled': [index % 7 != 2 for index in range(showcase_rows)],",
    "    'order_date': [date(2026, 1, 1) + timedelta(days=index % 365) for index in range(showcase_rows)],",
    "    'segment': [showcase_segments[index % len(showcase_segments)] for index in range(showcase_rows)],",
    "    'channel': [showcase_channels[index % len(showcase_channels)] for index in range(showcase_rows)],",
    "    'product_family': [showcase_products[index % len(showcase_products)] for index in range(showcase_rows)],",
    "    'unit_price': [round(79 + ((index * 3571) % 92000) / 100, 2) for index in range(showcase_rows)],",
    "    'discount_pct': [round(((index * 37) % 1800) / 100, 2) for index in range(showcase_rows)],",
    "    'gross_margin': [round(180 + ((index * 1451) % 610000) / 100, 2) for index in range(showcase_rows)],",
    "    'priority': [showcase_priorities[index % len(showcase_priorities)] for index in range(showcase_rows)],",
    "    'renewal_date': [date(2027, 1, 1) + timedelta(days=index % 365) for index in range(showcase_rows)],",
    "    'account_status': [showcase_statuses[index % len(showcase_statuses)] for index in range(showcase_rows)],",
    "})",
    "polars_series = pl.Series('series_value', [7, 8])",
    "duckdb_connection = duckdb.connect()",
    'duckdb_connection.execute(f"CREATE TABLE private_duck_orders AS SELECT ' +
      "3400001 + row_index AS order_id, " +
      "CASE row_index % 4 WHEN 0 THEN 'DACH' WHEN 1 THEN 'Nordics' WHEN 2 THEN 'Iberia' ELSE 'Benelux' END AS market, " +
      "CAST(100.50 + ((row_index * 17) % 500000) / 100.0 AS DECIMAL(18,2)) AS revenue, " +
      "DATE '2026-01-01' + CAST(row_index % 365 AS INTEGER) AS order_date " +
      'FROM range({showcase_rows}) AS source(row_index)")',
    "duckdb_relation = duckdb_connection.table('private_duck_orders')",
    "def _open_wrangler_forbid_duckdb_conversion(*_args, **_kwargs):",
    "    raise AssertionError('DuckDB notebook acceptance forbids conversion through Pandas, Polars, or Arrow')",
    "for _duckdb_conversion_name in ('df', 'to_df', 'fetchdf', 'pl', 'arrow'):",
    "    setattr(duckdb.DuckDBPyRelation, _duckdb_conversion_name, _open_wrangler_forbid_duckdb_conversion)",
    `openwrangler_restart_marker = ${JSON.stringify(setupMarker)}`,
    `print(${JSON.stringify(RELEASED_JUPYTER_SETUP_RESULT)} + json.dumps({` +
      "'executable': sys.executable, 'pid': os.getpid(), " +
      "'runtime': importlib.util.find_spec('openwrangler_runtime') is not None, " +
      "'duckdbConversionGuards': all(" +
      "getattr(duckdb.DuckDBPyRelation, name) is _open_wrangler_forbid_duckdb_conversion " +
      "for name in ('df', 'to_df', 'fetchdf', 'pl', 'arrow')), " +
      "'remoteRunId': os.environ.get('OPEN_WRANGLER_REMOTE_RUN_ID'), " +
      "'hostname': socket.gethostname(), " +
      `'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)}), ` +
      "'setup': openwrangler_restart_marker" +
      "}, sort_keys=True))"
  ];
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: setup.map((line) => `${line}\n`)
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["# Explore recent orders in Open Wrangler\n", "orders_df\n", "\n"]
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["polars_frame\n"]
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: [
            "import importlib.util, json, os, socket, sys\n",
            `print(${JSON.stringify(RELEASED_JUPYTER_RESTART_RESULT)} + json.dumps({` +
              "'pid': os.getpid(), " +
              "'runtime': importlib.util.find_spec('openwrangler_runtime') is not None, " +
              "'bootstrap': ('__ow_bundle_root' in globals() and str(globals().get('__ow_bundle_root')) in sys.path), " +
              "'remoteRunId': os.environ.get('OPEN_WRANGLER_REMOTE_RUN_ID'), " +
              "'hostname': socket.gethostname(), " +
              `'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)}), ` +
              "'setup': globals().get('openwrangler_restart_marker')" +
              "}, sort_keys=True))\n"
          ]
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: [
            "import json, os, socket\n",
            "import openwrangler_runtime\n",
            `print(${JSON.stringify(RELEASED_JUPYTER_RUNTIME_RESULT)} + json.dumps({` +
              "'runtimeFile': openwrangler_runtime.__file__, " +
              "'remoteRunId': os.environ.get('OPEN_WRANGLER_REMOTE_RUN_ID'), " +
              "'hostname': socket.gethostname(), " +
              `'hostExtensionVisible': os.path.exists(${JSON.stringify(hostExtensionPath)})` +
              "}, sort_keys=True))\n"
          ]
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["duckdb_relation\n"]
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: [
            "import json\n",
            `print(${JSON.stringify(RELEASED_JUPYTER_DUCKDB_ALIVE_RESULT)} + json.dumps({` +
              "'count': duckdb_relation.aggregate('count(*) AS count').fetchone()[0], " +
              "'connectionCount': duckdb_connection.execute(" +
              "'SELECT count(*) FROM private_duck_orders').fetchone()[0], " +
              "'first': duckdb_relation.order('order_id').limit(1).fetchone()[0], " +
              "'conversionGuards': all(" +
              "getattr(duckdb.DuckDBPyRelation, name) is _open_wrangler_forbid_duckdb_conversion " +
              "for name in ('df', 'to_df', 'fetchdf', 'pl', 'arrow'))" +
              "}, sort_keys=True))\n"
          ]
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: [
            "import json\n",
            "import openwrangler_runtime.kernel_agent as __ow_kernel_agent\n",
            `print(${JSON.stringify(RELEASED_JUPYTER_SESSION_COUNT_RESULT)} + json.dumps({` +
              "'count': len(__ow_kernel_agent._manager.sessions)" +
              "}, sort_keys=True))\n"
          ]
        }
      ],
      metadata: {
        kernelspec: {
          display_name: target.label,
          language: "python",
          name: target.name
        },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  );
}

function assertExactOpenNotebookDocument(notebook: vscode.NotebookDocument, checkpoint: string): void {
  const matches = vscode.workspace.notebookDocuments.filter(
    (candidate) => !candidate.isClosed && candidate.uri.toString() === notebook.uri.toString()
  );
  assert.equal(matches.length, 1, `The released-Jupyter notebook URI must identify one document ${checkpoint}.`);
  assert.equal(matches[0], notebook, `The released-Jupyter notebook object changed ${checkpoint}.`);
  assert.equal(notebook.isClosed, false, `The released-Jupyter notebook closed ${checkpoint}.`);
}

async function showExactReleasedNotebook(notebook: vscode.NotebookDocument): Promise<vscode.NotebookEditor> {
  assertExactOpenNotebookDocument(notebook, "before showing its exact editor");
  const editor = await vscode.window.showNotebookDocument(notebook, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
    preview: false
  });
  assert.equal(editor.notebook, notebook, "Showing a released-Jupyter notebook must retain its exact editor.");
  assertExactOpenNotebookDocument(notebook, "after showing its exact editor");
  assertExactVisibleReleasedNotebookEditor(notebook, editor, "after showing its exact editor");
  return editor;
}

function assertExactVisibleReleasedNotebookEditor(
  notebook: vscode.NotebookDocument,
  editor: vscode.NotebookEditor,
  checkpoint: string
): void {
  const sameUriEditors = vscode.window.visibleNotebookEditors.filter(
    (candidate) => candidate.notebook.uri.toString() === notebook.uri.toString()
  );
  assert.equal(sameUriEditors.length, 1, `The released-Jupyter notebook must have one visible editor ${checkpoint}.`);
  assert.equal(sameUriEditors[0], editor, `The released-Jupyter visible editor changed ${checkpoint}.`);
  assert.equal(editor.notebook, notebook, `The released-Jupyter visible editor changed document ${checkpoint}.`);
  assert.equal(
    vscode.window.activeNotebookEditor,
    editor,
    `The released-Jupyter notebook was not active ${checkpoint}.`
  );
}

async function selectReleasedJupyterKernel(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  notebookEditor: vscode.NotebookEditor,
  phase: ReleasedJupyterPhase,
  targetKernel: ReleasedJupyterKernelTarget
): Promise<void> {
  assertExactOpenNotebookDocument(notebook, "before selecting its released Jupyter kernel");
  assert.equal(notebookEditor.notebook, notebook, "The released-Jupyter kernel picker must keep its captured editor.");
  const selection = vscode.commands.executeCommand("notebook.selectKernel", {
    notebookEditor
  });
  type SelectionState = { kind: "pending" } | { kind: "fulfilled" } | { kind: "rejected"; error: unknown };
  let selectionState: SelectionState = { kind: "pending" };
  const readSelectionState = (): SelectionState => selectionState;
  const observedSelection = Promise.resolve(selection).then(
    () => {
      selectionState = { kind: "fulfilled" };
      return selectionState;
    },
    (error: unknown) => {
      selectionState = { kind: "rejected", error };
      return selectionState;
    }
  );
  const deadline = Date.now() + 30_000;
  const traversed = new Set<string>();
  let filterForTarget = false;
  try {
    do {
      assertExactOpenNotebookDocument(notebook, "while selecting its released Jupyter kernel");
      const currentSelectionState = readSelectionState();
      if (currentSelectionState.kind === "rejected") throw currentSelectionState.error;
      const quickInput = await visibleReleasedJupyterQuickInput(workbench);
      if (!quickInput) {
        if (currentSelectionState.kind === "fulfilled") {
          throw new Error("The released-Jupyter kernel picker closed before the private kernel was selected.");
        }
        await workbench.waitForTimeout(50);
        continue;
      }
      const target = await releasedJupyterQuickPickRow(quickInput, targetKernel.label);
      if (target) {
        recordAcceptanceProgress(`${phase}:kernel-picker-target`);
        await target.click();
        const outcome = await withBoundedAcceptancePromise(
          observedSelection,
          60_000,
          "the released-Jupyter kernel selection"
        );
        if (outcome.kind === "rejected") throw outcome.error;
        assertExactOpenNotebookDocument(notebook, "after selecting its released Jupyter kernel");
        assert.equal(notebookEditor.notebook, notebook, "The released-Jupyter kernel selection changed its editor.");
        await waitForReleasedJupyterKernelLabel(workbench, targetKernel.label);
        return;
      }

      if (filterForTarget) {
        const stillOnRoutePicker = await releasedJupyterRouteLabel(quickInput, targetKernel.routeLabels);
        if (!stillOnRoutePicker) {
          const input = quickInput.locator(".quick-input-box input:visible").first();
          if ((await input.count()) > 0) {
            await input.fill(targetKernel.label);
            filterForTarget = false;
            await workbench.waitForTimeout(100);
            continue;
          }
        }
      }

      let advanced = false;
      for (const label of ["Select Another Kernel...", ...targetKernel.routeLabels]) {
        if (traversed.has(label)) continue;
        const row = await releasedJupyterQuickPickRow(quickInput, label);
        if (!row) continue;
        traversed.add(label);
        recordAcceptanceProgress(
          `${phase}:kernel-picker-${label
            .toLowerCase()
            .replaceAll(/[^a-z]+/gu, "-")
            .replaceAll(/^-|-$/gu, "")}`
        );
        await row.click();
        filterForTarget = targetKernel.routeLabels.includes(label);
        await workbench.waitForTimeout(100);
        advanced = true;
        break;
      }
      if (!advanced) await workbench.waitForTimeout(100);
    } while (Date.now() < deadline);

    const diagnostics = await releasedJupyterQuickInputDiagnostics(workbench);
    throw new Error(
      `Timed out selecting released-Jupyter kernel ${JSON.stringify(targetKernel.label)}. ` +
        `Quick-input labels: ${JSON.stringify(diagnostics)}`
    );
  } catch (error) {
    await dismissReleasedJupyterKernelPicker(workbench, observedSelection);
    throw error;
  }
}

async function releasedJupyterRouteLabel(
  quickInput: Locator,
  routeLabels: readonly string[]
): Promise<string | undefined> {
  for (const label of ["Select Another Kernel...", ...routeLabels]) {
    if (await releasedJupyterQuickPickRow(quickInput, label)) return label;
  }
  return undefined;
}

async function dismissReleasedJupyterKernelPicker(
  workbench: Page,
  selection: Promise<{ kind: "fulfilled" } | { kind: "rejected"; error: unknown }>
): Promise<void> {
  for (const frame of releasedWorkbenchFrames(workbench)) {
    const quickInputs = frame.locator(".quick-input-widget:visible");
    const count = Math.min(await quickInputs.count().catch(() => 0), 8);
    for (let index = 0; index < count; index += 1) {
      const quickInput = quickInputs.nth(index);
      const input = quickInput.locator(".quick-input-box input:visible").first();
      if ((await input.count().catch(() => 0)) > 0) {
        await input.press("Escape").catch(() => {});
      } else {
        await quickInput.press("Escape").catch(() => {});
      }
    }
  }
  await Promise.race([selection, workbench.waitForTimeout(2_000)]).catch(() => {});
}

async function waitForReleasedJupyterKernelLabel(workbench: Page, expectedLabel: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    let exactMatches = 0;
    for (const frame of releasedWorkbenchFrames(workbench)) {
      const labels = frame.locator(".kernel-action-view-item .kernel-label:visible");
      const count = Math.min(await labels.count().catch(() => 0), 16);
      for (let index = 0; index < count; index += 1) {
        if (
          (
            await labels
              .nth(index)
              .innerText()
              .catch(() => "")
          ).trim() === expectedLabel
        )
          exactMatches += 1;
      }
    }
    if (exactMatches === 1) return;
    assert.ok(exactMatches < 2, `The workbench exposed duplicate ${JSON.stringify(expectedLabel)} kernel labels.`);
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`The workbench did not confirm selected kernel ${JSON.stringify(expectedLabel)}.`);
}

async function visibleReleasedJupyterQuickInput(workbench: Page): Promise<Locator | undefined> {
  for (const frame of releasedWorkbenchFrames(workbench)) {
    const quickInput = frame.locator(".quick-input-widget:visible").last();
    if ((await quickInput.count().catch(() => 0)) > 0 && (await quickInput.isVisible().catch(() => false))) {
      return quickInput;
    }
  }
  return undefined;
}

async function releasedJupyterQuickPickRow(quickInput: Locator, label: string): Promise<Locator | undefined> {
  const labels = quickInput.locator(".quick-input-list [role='option'] .label-name:visible");
  const count = await labels.count();
  assert.ok(count <= 256, "The released-Jupyter kernel picker exceeded its bounded visible option count.");
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = labels.nth(index);
    if ((await candidate.innerText()).trim() === label) {
      matches.push(candidate.locator("xpath=ancestor::*[@role='option'][1]"));
    }
  }
  assert.ok(matches.length < 2, `The released-Jupyter kernel picker exposed duplicate ${JSON.stringify(label)} rows.`);
  return matches[0];
}

async function releasedJupyterQuickInputDiagnostics(workbench: Page): Promise<string[]> {
  const diagnostics: string[] = [];
  for (const frame of releasedWorkbenchFrames(workbench)) {
    const labels = frame.locator(".quick-input-widget:visible [role='option'] .label-name:visible");
    const count = Math.min(await labels.count().catch(() => 0), 64);
    for (let index = 0; index < count; index += 1) {
      diagnostics.push(
        (
          await labels
            .nth(index)
            .innerText()
            .catch(() => "")
        )
          .trim()
          .slice(0, 256)
      );
    }
  }
  return diagnostics;
}

async function executeReleasedNotebookCell(
  notebook: vscode.NotebookDocument,
  index: number,
  expectedText: string | undefined,
  checkpoint: string,
  expectedEditor?: vscode.NotebookEditor
): Promise<void> {
  assertExactOpenNotebookDocument(notebook, `before executing cell ${index}`);
  if (expectedEditor) {
    assertExactVisibleReleasedNotebookEditor(notebook, expectedEditor, `before executing cell ${index}`);
  }
  assert.ok(index >= 0 && index < notebook.cellCount, `Released-Jupyter cell ${index} must exist.`);
  const cell = notebook.cellAt(index);
  let observedFreshExecutionSummary = false;
  let outputAttachmentFailure: string | undefined;
  const executionListener = vscode.workspace.onDidChangeNotebookDocument((event) => {
    if (event.notebook !== notebook) return;
    for (const change of event.cellChanges) {
      if (change.cell !== cell) continue;
      if (change.executionSummary !== undefined) observedFreshExecutionSummary = true;
      if (change.outputs !== undefined && expectedEditor) {
        try {
          assertExactVisibleReleasedNotebookEditor(notebook, expectedEditor, `while cell ${index} published output`);
        } catch (error) {
          outputAttachmentFailure = error instanceof Error ? error.message : String(error);
        }
      }
    }
  });
  try {
    const deadline = Date.now() + 120_000;
    recordAcceptanceProgress(`${checkpoint}:dispatch`);
    if (expectedEditor) {
      assertExactVisibleReleasedNotebookEditor(
        notebook,
        expectedEditor,
        `immediately before dispatching cell ${index}`
      );
    }
    const command = Promise.resolve(
      vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [{ start: index, end: index + 1 }],
        document: notebook.uri
      })
    );
    type CommandState = { kind: "pending" } | { kind: "fulfilled" } | { kind: "rejected"; error: unknown };
    let commandState: CommandState = { kind: "pending" };
    const readCommandState = (): CommandState => commandState;
    void command.then(
      () => {
        commandState = { kind: "fulfilled" };
      },
      (error: unknown) => {
        commandState = { kind: "rejected", error };
      }
    );
    recordAcceptanceProgress(`${checkpoint}:dispatched`);
    let publishedExecutionObservation = false;
    do {
      assertExactOpenNotebookDocument(notebook, `while waiting for cell ${index}`);
      if (expectedEditor) {
        assertExactVisibleReleasedNotebookEditor(notebook, expectedEditor, `while waiting for cell ${index}`);
      }
      assert.equal(outputAttachmentFailure, undefined, outputAttachmentFailure);
      const currentCommandState = readCommandState();
      if (currentCommandState.kind === "rejected") {
        recordAcceptanceProgress(`${checkpoint}:command-rejected`);
        throw currentCommandState.error;
      }
      if (observedFreshExecutionSummary && !publishedExecutionObservation) {
        publishedExecutionObservation = true;
        recordAcceptanceProgress(`${checkpoint}:execution-observed`);
      }
      if (observedFreshExecutionSummary && cell.executionSummary?.success === true) {
        if (expectedText === undefined || notebookCellOutputText(cell).includes(expectedText)) {
          recordAcceptanceProgress(`${checkpoint}:output-complete`);
          await withBoundedAcceptancePromise(command, 10_000, `released-Jupyter cell ${index} command completion`);
          if (expectedEditor) {
            assertExactVisibleReleasedNotebookEditor(notebook, expectedEditor, `after completing cell ${index}`);
          }
          recordAcceptanceProgress(`${checkpoint}:complete`);
          return;
        }
      }
      if (observedFreshExecutionSummary && cell.executionSummary?.success === false) {
        recordAcceptanceProgress(`${checkpoint}:execution-failed`);
        throw new Error(releasedNotebookExecutionFailureMessage(index, cell.outputs));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    recordAcceptanceProgress(`${checkpoint}:timeout`);
    throw new Error(
      `Timed out waiting for a fresh released-Jupyter execution of cell ${index}. ` +
        `Command: ${readCommandState().kind}. Output: ${releasedNotebookOutputClassification(cell.outputs)}.`
    );
  } finally {
    executionListener.dispose();
  }
}

async function executeReleasedNotebookCellUntilMime(
  notebook: vscode.NotebookDocument,
  index: number,
  mime: string,
  checkpoint: string,
  expectedEditor: vscode.NotebookEditor
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  let observedMimes: string[] = [];
  do {
    attempt += 1;
    await executeReleasedNotebookCell(notebook, index, undefined, `${checkpoint}:attempt-${attempt}`, expectedEditor);
    observedMimes = notebook.cellAt(index).outputs.flatMap((output) => output.items.map((item) => item.mime));
    if (observedMimes.includes(mime)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out waiting for proactive notebook formatter MIME ${JSON.stringify(mime)}. ` +
      `Observed: ${JSON.stringify(observedMimes)}.`
  );
}

function notebookCellOutputText(cell: vscode.NotebookCell): string {
  return cell.outputs
    .flatMap((output) => output.items)
    .map((item) => Buffer.from(item.data).toString("utf8"))
    .join("\n");
}

function releasedNotebookSetupResult(cell: vscode.NotebookCell): Record<string, unknown> {
  return releasedNotebookJsonResult(cell, RELEASED_JUPYTER_SETUP_RESULT, "setup");
}

function releasedNotebookJsonResult(
  cell: vscode.NotebookCell,
  marker: string,
  description: string
): Record<string, unknown> {
  const text = notebookCellOutputText(cell);
  const markerIndex = text.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, `The notebook ${description} omitted its result marker: ${JSON.stringify(text)}`);
  const serialized = text
    .slice(markerIndex + marker.length)
    .trim()
    .split(/\r?\n/u)[0];
  assert.ok(serialized, `The notebook ${description} returned an empty result.`);
  const parsed: unknown = JSON.parse(serialized);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function canonicalAcceptancePath(candidate: string): string {
  const resolved = path.normalize(path.resolve(candidate));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function waitForReleasedJupyterVariableAction(
  workbench: Page,
  variableName: string,
  checkpoint: string
): Promise<ReleasedJupyterVariableAction> {
  recordAcceptanceProgress(`${checkpoint}:wait`);
  const viewerAction = await acquirePreparedAcceptanceAction({
    timeoutMs: RELEASED_JUPYTER_VARIABLE_DISCOVERY_TIMEOUT_MS,
    intervalMs: 100,
    acquire: async () => {
      for (const frame of releasedWorkbenchFrames(workbench)) {
        try {
          const table = frame.getByRole("table", { name: "Variables", exact: true }).first();
          if ((await table.count()) === 0 || !(await table.isVisible())) continue;
          const cell = table.locator(`[role="cell"][title=${JSON.stringify(variableName)}]`).first();
          if ((await cell.count()) === 0 || !(await cell.isVisible())) continue;
          const row = cell.locator("xpath=ancestor::*[@role='row'][1]");
          const actions = row.getByRole("button", {
            name: RELEASED_JUPYTER_VARIABLE_VIEWER_ACTION,
            exact: true
          });
          if ((await actions.count()) !== 1) continue;
          const action = actions.first();
          await action.waitFor({
            state: "visible",
            timeout: RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS
          });
          return { action, documentRoot: frame.locator("html") };
        } catch (error) {
          if (!isReleasedJupyterVariableActionReplacement(error)) {
            // Jupyter may retire a scanned child target while its real kernel
            // refreshes. Ignore the probe only after the shared lifecycle
            // guard proves this is a retired non-workbench target; a live
            // frame, detached workbench main frame, or disconnected browser
            // must still fail immediately.
            ignoreRetiredRendererProbeFailure(workbench, workbench.context().browser(), frame.page(), frame, error);
          }
          // The Variables view can replace a row or retire its child frame
          // while its real kernel refreshes.
        }
      }
      return undefined;
    },
    prepare: async ({ action, documentRoot }) => {
      const [visible, enabled] = await withReleasedJupyterVariableActionPrepareDeadline(
        Promise.all([
          action.isVisible(),
          action.isEnabled({ timeout: RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS })
        ]),
        "visibility and enabled-state probes"
      );
      if (!visible || !enabled) {
        throw new ReleasedJupyterVariableActionReplacementError();
      }
      await withReleasedJupyterVariableActionPrepareDeadline(
        action.focus({ timeout: RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS }),
        "focus"
      );
      const focusState = await withReleasedJupyterVariableActionPrepareDeadline(
        action.evaluate((element) => ({
          connected:
            typeof element === "object" && element !== null && "isConnected" in element && element.isConnected === true,
          focused:
            typeof element === "object" &&
            element !== null &&
            "ownerDocument" in element &&
            element.ownerDocument.activeElement === element
        })),
        "focus assertion"
      );
      if (!focusState.connected) throw new ReleasedJupyterVariableActionReplacementError();
      assert.equal(
        focusState.focused,
        true,
        `The released Jupyter Variables action for ${variableName} must accept keyboard focus.`
      );
      const listenerAttached = await withReleasedJupyterVariableActionPrepareDeadline(
        action.evaluate((element) => {
          if (
            typeof element !== "object" ||
            element === null ||
            !("isConnected" in element) ||
            element.isConnected !== true ||
            !("ownerDocument" in element) ||
            !("addEventListener" in element) ||
            typeof element.addEventListener !== "function"
          ) {
            return false;
          }
          const root = element.ownerDocument.documentElement;
          root.dataset.openWranglerAcceptanceActivation = "pending";
          root.addEventListener(
            "click",
            (event: unknown) => {
              const candidateEvent = event as unknown as ReleasedJupyterActivationEvent;
              const composedPath = candidateEvent.composedPath?.() ?? [];
              const keyboardButtonActivation =
                candidateEvent.isTrusted === true &&
                candidateEvent.detail === 0 &&
                composedPath.some((candidate: unknown) => {
                  if (typeof candidate !== "object" || candidate === null) return false;
                  return (candidate as ReleasedJupyterActivationPathElement).tagName === "BUTTON";
                });
              if (keyboardButtonActivation) {
                root.dataset.openWranglerAcceptanceActivation = "seen";
              }
            },
            { capture: true }
          );
          return true;
        }),
        "click-listener setup"
      );
      if (!listenerAttached) throw new ReleasedJupyterVariableActionReplacementError();
      assert.equal(
        await documentRoot.evaluate(
          (element) =>
            (element as unknown as ReleasedJupyterDocumentRootElement).dataset.openWranglerAcceptanceActivation
        ),
        "pending",
        `The released Jupyter Variables action for ${variableName} must arm its trusted keyboard receipt.`
      );
    },
    dispose: async () => undefined,
    isRetryablePreparationError: isReleasedJupyterVariableActionReplacement,
    wait: (durationMs) => workbench.waitForTimeout(durationMs)
  });

  if (viewerAction) {
    recordAcceptanceProgress(`${checkpoint}:ready`);
    return viewerAction;
  }

  const diagnostics = await releasedWorkbenchDiagnostics(workbench, variableName);
  throw new Error(
    `Timed out waiting for ${variableName} in the released Jupyter Variables view: ${JSON.stringify(diagnostics)}`
  );
}

class ReleasedJupyterVariableActionReplacementError extends Error {}

function isReleasedJupyterVariableActionReplacement(error: unknown): boolean {
  if (error instanceof ReleasedJupyterVariableActionReplacementError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /(?:element|node).*(?:detached|not attached|not connected)/iu.test(message) ||
    ((error as { name?: unknown } | undefined)?.name === "TimeoutError" &&
      /^(?:elementHandle|locator)\.(?:elementHandle|focus|hover|isEnabled|waitFor): Timeout \d+ms exceeded/u.test(
        message
      ))
  );
}

async function withReleasedJupyterVariableActionPrepareDeadline<T>(
  operation: PromiseLike<T>,
  description: string
): Promise<T> {
  try {
    return await withAcceptanceOperationDeadline(
      operation,
      RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS,
      `the released Jupyter Variables action ${description}`
    );
  } catch (error) {
    if (isReleasedJupyterVariableActionReplacement(error)) throw error;
    if (
      error instanceof Error &&
      error.message ===
        `Timed out waiting for the released Jupyter Variables action ${description} after ${RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS} ms.`
    ) {
      throw new ReleasedJupyterVariableActionReplacementError();
    }
    throw error;
  }
}

function releasedWorkbenchFrames(workbench: Page): Frame[] {
  const browser = workbench.context().browser();
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  return pages.flatMap((page) => page.frames());
}

async function releasedWorkbenchDiagnostics(workbench: Page, variableName: string): Promise<unknown> {
  return Promise.all(
    releasedWorkbenchFrames(workbench).map(async (frame) => ({
      url: frame.url(),
      variableCells: await frame
        .locator(`[role="cell"][title=${JSON.stringify(variableName)}]`)
        .count()
        .catch(() => -1),
      tables: await frame
        .getByRole("table", { name: "Variables", exact: true })
        .allInnerTexts()
        .catch(() => [])
    }))
  );
}

async function waitForReleasedJupyterConsent(
  workbench: Page,
  testing: TestApi
): Promise<{ dialog: Locator; allow: Locator; deny: Locator }> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  let dialog: Locator | undefined;
  do {
    for (const frame of releasedWorkbenchFrames(workbench)) {
      const candidate = frame
        .locator(".monaco-dialog-box:visible")
        .filter({ hasText: RELEASED_JUPYTER_CONSENT_MESSAGE })
        .last();
      if ((await candidate.count().catch(() => 0)) > 0 && (await candidate.isVisible().catch(() => false))) {
        dialog = candidate;
        break;
      }
    }
    if (dialog) break;
    const panelError = await visibleOpenWranglerPanelAlert(workbench);
    if (panelError) {
      throw new Error(`Open Wrangler failed before released Jupyter displayed kernel consent: ${panelError}`);
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  if (!dialog) {
    throw new Error(
      "Timed out waiting for released Jupyter kernel consent during proactive formatter preparation. " +
        `State: ${JSON.stringify({
          tabCount: releasedJupyterSessionTabs().length,
          coordinator: testing.diagnostics(),
          webviewFrames: releasedWorkbenchFrames(workbench).filter(
            (frame) => classifyRendererUrl(frame.url()).isOpenWranglerWebview
          ).length
        })}`
    );
  }
  const text = await dialog.innerText();
  assert.ok(text.includes(RELEASED_JUPYTER_CONSENT_MESSAGE), "The Jupyter consent message must name Open Wrangler.");
  assert.ok(
    text.includes(RELEASED_JUPYTER_CONSENT_DETAIL),
    "The Jupyter consent must explain kernel execution access."
  );
  const allow = dialog.getByRole("button", { name: "Allow", exact: true });
  const deny = dialog.getByRole("button", { name: "Deny", exact: true });
  const learnMore = dialog.getByRole("button", { name: "Learn more", exact: true });
  assert.equal(await allow.count(), 1, "The released Jupyter consent must expose one Allow action.");
  assert.equal(await deny.count(), 1, "The released Jupyter consent must expose one Deny action.");
  assert.equal(await learnMore.count(), 1, "The released Jupyter consent must expose one Learn More action.");
  return { dialog, allow, deny };
}

async function visibleReleasedJupyterConsentCount(workbench: Page): Promise<number> {
  let count = 0;
  for (const frame of releasedWorkbenchFrames(workbench)) {
    count += await frame
      .locator(".monaco-dialog-box:visible")
      .filter({ hasText: RELEASED_JUPYTER_CONSENT_MESSAGE })
      .count()
      .catch(() => 0);
  }
  return count;
}

async function waitForReleasedJupyterTerminalPanelError(workbench: Page, testing: TestApi): Promise<string> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    const panelError = await visibleOpenWranglerPanelAlert(workbench);
    if (panelError) return panelError;
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  const diagnostics = await boundedImportPromptDiagnostics(workbench);
  const browser = workbench.context().browser();
  const openWranglerFrames = openWranglerWebviewTargets(
    workbench,
    browser,
    OPEN_WRANGLER_WEBVIEW_DIAGNOSTIC_TARGET_LIMIT
  );
  const frameDiagnostics = await Promise.all(
    openWranglerFrames.map(async (target) => ({
      ...rendererTargetDiagnostic(target, {}),
      apps: await target.frame
        .locator("main.app")
        .count()
        .catch(() => -1),
      text: (
        await target.frame
          .locator("main.app")
          .first()
          .innerText()
          .catch(() => "")
      )
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 2_000),
      alerts: (
        await target.frame
          .locator("main.app")
          .first()
          .getByRole("alert")
          .allInnerTexts()
          .catch(() => [])
      ).slice(0, 8)
    }))
  );
  throw new Error(
    "Timed out waiting for the persisted released-Jupyter denial to reach a terminal panel error. " +
      `State: ${JSON.stringify({
        sessionTabs: releasedJupyterSessionTabs().map((tab) => tab.label),
        coordinator: testing.diagnostics(),
        webviewFrames: frameDiagnostics,
        ui: diagnostics
      })}`
  );
}

async function visibleOpenWranglerPanelAlert(workbench: Page): Promise<string | undefined> {
  const browser = workbench.context().browser();
  assertOpenWranglerWebviewLifecycle(workbench, browser);
  for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
    if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
    try {
      const app = target.frame.locator("main.app").first();
      if ((await app.count()) === 0 || !(await app.isVisible())) continue;
      const alert = app.getByRole("alert").first();
      if ((await alert.count()) === 0 || !(await alert.isVisible())) continue;
      const message = (await alert.innerText()).trim();
      if (message.length > 0) return message;
    } catch (error) {
      ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
    }
  }
  return undefined;
}

async function waitForStableReleasedJupyterSessionCount(
  testing: TestApi,
  expected: number,
  stableForMs: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = testing.diagnostics().sessionCount === expected ? Date.now() : undefined;
  do {
    if (testing.diagnostics().sessionCount === expected) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableForMs) return;
    } else {
      stableSince = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out waiting for released-Jupyter session count ${expected}: ${JSON.stringify(testing.diagnostics())}`
  );
}

async function withBoundedAcceptancePromise<T>(
  promise: Thenable<T>,
  timeoutMs: number,
  description: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForReleasedVariableSession(
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  expected: ReleasedVariableExpectation,
  description: string
): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> {
  try {
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.kind === "notebookVariable" &&
          active.metadata.source.variableName === expected.name &&
          active.metadata.source.uri === notebook.uri.toString()
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      description,
      () => JSON.stringify(testing.diagnostics())
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `Released-Jupyter panel state: ${JSON.stringify({
          alert: await visibleOpenWranglerPanelAlert(workbench),
          sessionTabs: releasedJupyterSessionTabs().map((tab) => tab.label),
          coordinator: testing.diagnostics(),
          ui: await boundedImportPromptDiagnostics(workbench)
        })}`
    );
  }
  assertExactOpenNotebookDocument(notebook, `after opening ${expected.name}`);
  const active = testing.activeSession();
  assert.ok(active, `${description} must publish an active session.`);
  assert.equal(active.metadata.backend, expected.backend);
  assert.equal(active.metadata.source.kind, "notebookVariable");
  assert.equal(active.metadata.source.variableName, expected.name);
  assert.equal(active.metadata.source.uri, notebook.uri.toString());
  assert.equal(active.metadata.capabilities.notebookInsert, expected.notebookInsert ?? true);
  return active;
}

async function openReleasedRendererVariableSession(
  action: NotebookRendererButton,
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  expected: ReleasedVariableExpectation,
  description: string,
  checkpoint: string
): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> {
  recordAcceptanceProgress(`${checkpoint}:button-ready`);
  const receipt = async (): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> => {
    const active = await waitForReleasedVariableSession(workbench, testing, notebook, expected, description);
    recordAcceptanceProgress(`${checkpoint}:receipt`);
    return active;
  };
  return invokeAcceptanceActionOnceWithAuthoritativeReceipt({
    description,
    activate: async () => {
      recordAcceptanceProgress(`${checkpoint}:activate`);
      await withAcceptanceOperationDeadline(
        action.click(),
        WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
        "the exact notebook renderer action to receive one Playwright click"
      );
    },
    receipt,
    authoritativeReceiptAfterActivationFailure: receipt
  });
}

async function openReleasedVariableSession(
  workbench: Page,
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  expected: ReleasedVariableExpectation,
  description: string
): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> {
  assertExactOpenNotebookDocument(notebook, `before opening ${expected.name}`);
  const notebookEditor = await showExactReleasedNotebook(notebook);
  assertExactVisibleReleasedNotebookEditor(notebook, notebookEditor, `immediately before dispatching ${expected.name}`);
  await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
    name: expected.name,
    type: expected.type,
    fileName: notebook.uri
  });
  assertExactOpenNotebookDocument(notebook, `after dispatching ${expected.name}`);
  return waitForReleasedVariableSession(workbench, testing, notebook, expected, description);
}

async function assertReleasedSessionPage(
  testing: TestApi,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  firstValue: string,
  viewRequestId: string
): Promise<Extract<OpenWranglerResponse, { kind: "page" }>> {
  recordAcceptanceProgress(`${viewRequestId}:request`);
  const response = await withBoundedAcceptancePromise(
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId,
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    }),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `released-Jupyter page ${viewRequestId}`
  );
  recordAcceptanceProgress(`${viewRequestId}:response`);
  assert.equal(response.kind, "page");
  if (response.kind !== "page") throw new Error(`Released-Jupyter page ${viewRequestId} did not resolve.`);
  assert.equal(response.page.rows[0]?.values[0]?.display, firstValue);
  return response;
}

async function assertReleasedNotebookCodeInsertion(
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  variableName: string,
  phase: ReleasedJupyterPhase
): Promise<void> {
  assert.equal(active.metadata.source.kind, "notebookVariable");
  const code = `# released Jupyter exact origin ${Date.now()}\ndef clean_data(df):\n    return df\n`;
  const before = Array.from({ length: notebook.cellCount }, (_, index) => notebook.cellAt(index).document.getText());
  const decoyPath = path.join(path.dirname(notebook.uri.fsPath), "released-jupyter-insertion-decoy.ipynb");
  writeFileSync(
    decoyPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["decoy_value = 99\n"]
        }
      ],
      metadata: {
        kernelspec: {
          display_name: "Python 3.12 (Open Wrangler)",
          language: "python",
          name: "openwrangler-acceptance"
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  );
  const decoy = await vscode.workspace.openNotebookDocument(vscode.Uri.file(decoyPath));
  try {
    recordAcceptanceProgress(`${phase}:insertion-decoy`);
    await vscode.window.showNotebookDocument(decoy, { viewColumn: vscode.ViewColumn.One });
    assertExactOpenNotebookDocument(decoy, "after showing the insertion decoy");
    const decoyBefore = Array.from({ length: decoy.cellCount }, (_, index) => decoy.cellAt(index).document.getText());

    testing.setActiveSession(active.sessionId);
    testing.setCodeForExport(code);
    recordAcceptanceProgress(`${phase}:insertion-decoy-active`);
    assertExactOpenNotebookDocument(notebook, "before released-Jupyter generated-code insertion");
    assertExactOpenNotebookDocument(decoy, "before insertion while the decoy remained open");
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      decoy,
      "Released-Jupyter insertion acceptance must keep a different notebook active."
    );
    recordAcceptanceProgress(`${phase}:insertion-dispatch`);
    let insertionResult: boolean | undefined;
    try {
      insertionResult = await withBoundedAcceptancePromise(
        vscode.commands.executeCommand<boolean>("openWrangler.insertNotebookCode"),
        30_000,
        "released-Jupyter generated-code insertion"
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
          `Diagnostics: ${JSON.stringify(
            await releasedNotebookInsertionDiagnostics(testing, notebook, code, variableName)
          )}`
      );
    }
    if (insertionResult !== true) {
      throw new Error(
        `Released-Jupyter generated-code insertion returned ${JSON.stringify(insertionResult)}. ` +
          `Diagnostics: ${JSON.stringify(
            await releasedNotebookInsertionDiagnostics(testing, notebook, code, variableName)
          )}`
      );
    }
    recordAcceptanceProgress(`${phase}:insertion-complete`);
    assertExactOpenNotebookDocument(notebook, "after released-Jupyter generated-code insertion");
    assertExactOpenNotebookDocument(decoy, "after insertion while the decoy remained open");
    assert.deepEqual(
      Array.from({ length: decoy.cellCount }, (_, index) => decoy.cellAt(index).document.getText()),
      decoyBefore,
      "Released-Jupyter insertion must not target a different active notebook."
    );
    const inserted = Array.from({ length: notebook.cellCount }, (_, index) => index).filter((index) => {
      const cell = notebook.cellAt(index);
      return cell.document.getText() === code && cell.metadata.openWrangler?.source === variableName;
    });
    assert.equal(inserted.length, 1, "Released-Jupyter insertion must add one uniquely marked cell.");
    const insertedIndex = inserted[0];
    assert.notEqual(insertedIndex, undefined);
    assert.deepEqual(
      Array.from({ length: notebook.cellCount }, (_, index) => index)
        .filter((index) => index !== insertedIndex)
        .map((index) => notebook.cellAt(index).document.getText()),
      before,
      "Released-Jupyter insertion must not rewrite any originating cell."
    );
  } finally {
    const decoyTab = notebookTab(decoy.uri);
    if (decoyTab) await vscode.window.tabGroups.close(decoyTab, true);
  }
}

async function releasedNotebookInsertionDiagnostics(
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  code: string,
  variableName: string
): Promise<unknown> {
  const matchingCells = Array.from({ length: notebook.cellCount }, (_, index) => notebook.cellAt(index)).filter(
    (cell) => cell.document.getText() === code && cell.metadata.openWrangler?.source === variableName
  );
  let workbench: ImportPromptDiagnostics | string = "unavailable";
  try {
    workbench = await boundedImportPromptDiagnostics(await connectToEditorWorkbench());
  } catch {
    // The notebook state remains useful when CDP diagnostics cannot connect.
  }
  return {
    insertionStatus: testing.notebookInsertionStatus(),
    notebookVersion: notebook.version,
    notebookCellCount: notebook.cellCount,
    matchingCells: matchingCells.length,
    activeOrigin: vscode.window.activeNotebookEditor?.notebook === notebook,
    exactOpen: vscode.workspace.notebookDocuments.filter((candidate) => candidate === notebook).length,
    workbench
  };
}

async function invokeReleasedNotebookToolbarVariable(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  variableName: string
): Promise<void> {
  assertExactOpenNotebookDocument(notebook, "before invoking the Open Wrangler notebook toolbar");
  assert.equal(
    vscode.window.activeNotebookEditor?.notebook,
    notebook,
    "The exact released-Jupyter notebook must be active before its Open Wrangler toolbar action."
  );
  const picker = await activateReleasedNotebookVariableAction(workbench, notebook);
  assertActiveNotebookTab(
    notebook,
    "The exact released-Jupyter notebook tab must remain active after its toolbar action opens the variable picker."
  );
  const deadline = Date.now() + 10_000;
  let row: Locator | undefined;
  do {
    row = await releasedJupyterQuickPickRow(picker, variableName);
    if (row) break;
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  assert.ok(row, `The Open Wrangler notebook-variable picker did not expose ${JSON.stringify(variableName)}.`);
  await row.click();
  assertExactOpenNotebookDocument(notebook, "after submitting the Open Wrangler notebook toolbar variable");
}

interface ReleasedNotebookPreparedAction {
  readonly activate: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly overflowMenu?: ElementHandle<unknown>;
  readonly abandonBeforeDispatch?: () => Promise<void>;
  readonly description: string;
}

async function activateReleasedNotebookVariableAction(
  workbench: Page,
  notebook: vscode.NotebookDocument
): Promise<Locator> {
  assertReleasedNotebookActionLabelOwnership();
  const cursorHost = process.env.OPEN_WRANGLER_TEST_EDITOR === "cursor";
  const globalToolbar = vscode.workspace.getConfiguration("notebook").get<boolean>("globalToolbar");
  if (cursorHost) {
    const pinnedTitleActions = vscode.workspace
      .getConfiguration("cursor.general")
      .inspect<string[]>("pinnedTitleActions");
    assert.ok(pinnedTitleActions, "Cursor must register its pinned-title-action setting.");
    assert.ok(
      pinnedTitleActions.defaultValue?.includes(RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND),
      "The packaged Cursor default must pin the canonical notebook-variable action."
    );
    assert.equal(
      pinnedTitleActions.globalValue,
      undefined,
      "Cursor notebook acceptance must not persist a user-level title-action setting."
    );
    assert.equal(
      pinnedTitleActions.workspaceValue,
      undefined,
      "Cursor notebook acceptance must not persist a workspace title-action setting."
    );
  }
  const prepared =
    cursorHost || globalToolbar !== true
      ? await resolveReleasedNotebookEditorTitleAction(workbench)
      : await resolveReleasedNotebookToolbarAction(workbench);
  let dispatchStarted = false;
  try {
    assertExactOpenNotebookDocument(notebook, "immediately before activating its Open Wrangler notebook action");
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      notebook,
      "The exact released-Jupyter notebook must remain active after resolving its Open Wrangler action."
    );
    assertActiveNotebookTab(
      notebook,
      "The exact released-Jupyter notebook tab must remain active before activating its Open Wrangler action."
    );
    dispatchStarted = true;
    return await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
      description: prepared.description,
      activate: prepared.activate,
      receipt: () => waitForReleasedNotebookVariablePicker(workbench),
      authoritativeReceiptAfterActivationFailure: () => waitForReleasedNotebookVariablePicker(workbench),
      naturalDismissal: prepared.overflowMenu
        ? () => prepared.overflowMenu!.waitForElementState("hidden", { timeout: 2_000 })
        : undefined
    });
  } finally {
    if (!dispatchStarted && prepared.abandonBeforeDispatch) {
      await prepared.abandonBeforeDispatch();
    } else {
      await Promise.allSettled([prepared.dispose(), prepared.overflowMenu?.dispose()]);
    }
  }
}

function assertReleasedNotebookActionLabelOwnership(): void {
  const owners: Array<{ extensionId: string; command: string }> = [];
  for (const extension of vscode.extensions.all) {
    const contributions = (
      extension.packageJSON as {
        contributes?: {
          commands?: unknown;
          menus?: { "notebook/toolbar"?: unknown };
        };
      }
    ).contributes;
    const commands = contributions?.commands;
    if (!Array.isArray(commands)) continue;
    const toolbarItems = contributions?.menus?.["notebook/toolbar"];
    if (!Array.isArray(toolbarItems)) continue;
    const toolbarCommands = new Set(
      toolbarItems.flatMap((candidate) => {
        if (typeof candidate !== "object" || candidate === null) return [];
        const command = (candidate as { command?: unknown }).command;
        return typeof command === "string" ? [command] : [];
      })
    );
    for (const candidate of commands) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const command = candidate as { command?: unknown; title?: unknown; shortTitle?: unknown };
      if (
        typeof command.command === "string" &&
        toolbarCommands.has(command.command) &&
        ((typeof command.title === "string" &&
          RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN.test(command.title)) ||
          (typeof command.shortTitle === "string" &&
            RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN.test(command.shortTitle)))
      ) {
        owners.push({ extensionId: extension.id.toLowerCase(), command: command.command });
      }
    }
  }
  owners.sort((left, right) =>
    left.extensionId === right.extensionId
      ? left.command.localeCompare(right.command)
      : left.extensionId.localeCompare(right.extensionId)
  );
  assert.deepEqual(
    owners,
    [{ extensionId: "matt17br.openwrangler", command: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND }],
    "The rendered notebook-action label must belong uniquely to the installed Open Wrangler command."
  );
}

function assertActiveNotebookTab(notebook: vscode.NotebookDocument, message: string): void {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(input instanceof vscode.TabInputNotebook, message);
  assert.equal(input.uri.toString(), notebook.uri.toString(), message);
  assert.equal(input.notebookType, notebook.notebookType, message);
}

async function resolveReleasedNotebookEditorTitleAction(workbench: Page): Promise<ReleasedNotebookPreparedAction> {
  const deadline = Date.now() + 20_000;
  do {
    for (const frame of releasedWorkbenchFrames(workbench)) {
      try {
        const titleActions = frame.locator(".part.editor .editor-group-container.active .editor-actions:visible");
        const commandItems = notebookToolbarCommandItems(titleActions, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
        const commandCount = await commandItems.count();
        assert.ok(commandCount < 2, "The active editor title exposed duplicate Open Wrangler notebook actions.");
        const byLabel = titleActions.getByRole("button", {
          name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
        });
        const labelCount = await byLabel.count();
        assert.ok(labelCount < 2, "The active editor title exposed duplicate labeled Open Wrangler actions.");

        const action =
          commandCount === 1
            ? releasedCommandOwnedAction(titleActions, commandItems.first(), "button")
            : labelCount === 1
              ? byLabel.first()
              : undefined;
        const actionCount = action ? await action.count() : 0;
        assert.ok(actionCount < 2, "The active editor title exposed duplicate command-owned actions.");
        if (actionCount === 1 && action && (await action.isVisible()) && (await action.isEnabled())) {
          await assertReleasedNotebookActionLabel(action, "active notebook editor title");
          const overflow = await probeReleasedNotebookToolbarOverflow(workbench);
          const surfaceMatches = await withReleasedNotebookOverflow(overflow, () =>
            releasedNotebookLaunchSurfaceMatches(workbench, "editor-title", overflow.inventory.visible)
          );
          if (!surfaceMatches) continue;
          const refreshedTitleActions = frame.locator(
            ".part.editor .editor-group-container.active .editor-actions:visible"
          );
          const refreshedItems = notebookToolbarCommandItems(
            refreshedTitleActions,
            RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND
          );
          const refreshedCommandCount = await refreshedItems.count();
          const refreshedByLabel = refreshedTitleActions.getByRole("button", {
            name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
          });
          const refreshedLabelCount = await refreshedByLabel.count();
          if (refreshedCommandCount > 1 || refreshedLabelCount > 1) {
            throw new ReleasedNotebookSurfaceTerminalError(
              [],
              "The active editor title exposed duplicate refreshed Open Wrangler actions."
            );
          }
          const refreshedAction =
            refreshedCommandCount === 1
              ? releasedCommandOwnedAction(refreshedTitleActions, refreshedItems.first(), "button")
              : refreshedLabelCount === 1
                ? refreshedByLabel.first()
                : undefined;
          if (
            !refreshedAction ||
            (await refreshedAction.count()) !== 1 ||
            !(await refreshedAction.isVisible()) ||
            !(await refreshedAction.isEnabled())
          ) {
            continue;
          }
          await assertReleasedNotebookActionLabel(refreshedAction, "refreshed active notebook editor title");
          return {
            activate: () => activateReplaceableAcceptanceLocator(refreshedAction, WORKBENCH_PLAYWRIGHT_TIMEOUT_MS),
            dispose: async () => undefined,
            description: "the real Open Wrangler action in the active notebook editor title"
          };
        }
      } catch (error) {
        if (isReleasedNotebookSurfaceTerminalError(error)) throw error;
        // The active editor title can rerender after the selected kernel changes.
      }
    }
    await workbench.waitForTimeout(100);
  } while (Date.now() < deadline);

  const diagnostics = await releasedNotebookToolbarDiagnostics(workbench, "none", {
    total: 0,
    visible: 0,
    enabled: 0
  });
  throw new Error(
    "Timed out resolving the real Open Wrangler action in the active notebook editor title. " +
      `Structure: ${JSON.stringify(diagnostics)}`
  );
}

async function resolveReleasedNotebookToolbarAction(workbench: Page): Promise<ReleasedNotebookPreparedAction> {
  const deadline = Date.now() + 20_000;
  let lastStructuralFailure: "none" | "transient-toolbar-rerender" = "none";
  let observedOverflowAction = { total: 0, visible: 0, enabled: 0 };
  do {
    for (const frame of releasedWorkbenchFrames(workbench)) {
      try {
        const toolbar = frame.locator(".notebook-editor:visible .notebook-toolbar-container:visible");
        const directItems = notebookToolbarCommandItems(toolbar, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
        const directCount = await directItems.count();
        assert.ok(directCount < 2, "The notebook toolbar exposed duplicate Open Wrangler variable actions.");
        const directByLabel = toolbar.getByRole("button", {
          name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
        });
        const directLabelCount = await directByLabel.count();
        assert.ok(directLabelCount < 2, "The notebook toolbar exposed duplicate labeled Open Wrangler actions.");
        let directAction: Locator | undefined;
        if (directCount === 1) {
          const direct = releasedCommandOwnedAction(toolbar, directItems.first(), "button");
          const directOwnedCount = await direct.count();
          assert.ok(directOwnedCount < 2, "The notebook toolbar exposed duplicate command-owned actions.");
          if (directOwnedCount === 1) directAction = direct;
        } else if (directLabelCount === 1) {
          directAction = directByLabel.first();
        }
        if (directAction && (await directAction.isVisible()) && (await directAction.isEnabled())) {
          await assertReleasedNotebookActionLabel(directAction, "released Jupyter notebook toolbar");
          const overflow = await probeReleasedNotebookToolbarOverflow(workbench);
          observedOverflowAction = {
            total: Math.max(observedOverflowAction.total, overflow.inventory.total),
            visible: Math.max(observedOverflowAction.visible, overflow.inventory.visible),
            enabled: Math.max(observedOverflowAction.enabled, overflow.inventory.enabled)
          };
          const surfaceMatches = await withReleasedNotebookOverflow(overflow, () =>
            releasedNotebookLaunchSurfaceMatches(workbench, "notebook-toolbar", overflow.inventory.visible)
          );
          if (!surfaceMatches) continue;
          const refreshedToolbar = frame.locator(".notebook-editor:visible .notebook-toolbar-container:visible");
          const refreshedItems = notebookToolbarCommandItems(
            refreshedToolbar,
            RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND
          );
          const refreshedCommandCount = await refreshedItems.count();
          const refreshedByLabel = refreshedToolbar.getByRole("button", {
            name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
          });
          const refreshedLabelCount = await refreshedByLabel.count();
          if (refreshedCommandCount > 1 || refreshedLabelCount > 1) {
            throw new ReleasedNotebookSurfaceTerminalError(
              [],
              "The notebook toolbar exposed duplicate refreshed Open Wrangler actions."
            );
          }
          const refreshedAction =
            refreshedCommandCount === 1
              ? releasedCommandOwnedAction(refreshedToolbar, refreshedItems.first(), "button")
              : refreshedLabelCount === 1
                ? refreshedByLabel.first()
                : undefined;
          if (
            !refreshedAction ||
            (await refreshedAction.count()) !== 1 ||
            !(await refreshedAction.isVisible()) ||
            !(await refreshedAction.isEnabled())
          ) {
            continue;
          }
          await assertReleasedNotebookActionLabel(refreshedAction, "refreshed released Jupyter notebook toolbar");
          return {
            activate: () => activateReplaceableAcceptanceLocator(refreshedAction, WORKBENCH_PLAYWRIGHT_TIMEOUT_MS),
            dispose: async () => undefined,
            description: "the real Open Wrangler action in the released Jupyter notebook toolbar"
          };
        }

        const overflow = await probeReleasedNotebookToolbarOverflow(workbench);
        observedOverflowAction = {
          total: Math.max(observedOverflowAction.total, overflow.inventory.total),
          visible: Math.max(observedOverflowAction.visible, overflow.inventory.visible),
          enabled: Math.max(observedOverflowAction.enabled, overflow.inventory.enabled)
        };
        if (
          overflow.action &&
          overflow.menu &&
          overflow.actionState.visible === 1 &&
          overflow.actionState.enabled === 1
        ) {
          let surfaceMatches: boolean;
          try {
            surfaceMatches = await releasedNotebookLaunchSurfaceMatches(
              workbench,
              "notebook-toolbar",
              overflow.inventory.visible
            );
          } catch (error) {
            try {
              await releaseReleasedNotebookOverflowAfterInspection(overflow);
            } catch (cleanupError) {
              throw new ReleasedNotebookSurfaceTerminalError(
                [error, cleanupError],
                "Notebook launch-surface inspection and exact overflow cleanup both failed."
              );
            }
            throw error;
          }
          if (surfaceMatches) {
            return {
              activate: () =>
                overflow.action!.click({
                  timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS
                }),
              dispose: () => overflow.action!.dispose(),
              overflowMenu: overflow.menu,
              abandonBeforeDispatch: () => releaseReleasedNotebookOverflowAfterInspection(overflow),
              description: "the real Open Wrangler action in the released Jupyter notebook-toolbar overflow"
            };
          }
        }
        await releaseReleasedNotebookOverflowAfterInspection(overflow);
      } catch (error) {
        if (isReleasedNotebookSurfaceTerminalError(error)) throw error;
        lastStructuralFailure = "transient-toolbar-rerender";
        // The notebook toolbar can rerender after the selected kernel changes.
      }
    }
    await workbench.waitForTimeout(100);
  } while (Date.now() < deadline);
  const diagnostics = await releasedNotebookToolbarDiagnostics(
    workbench,
    lastStructuralFailure,
    observedOverflowAction
  );
  throw new Error(
    "Timed out clicking the real Open Wrangler action in the released Jupyter notebook toolbar. " +
      `Structure: ${JSON.stringify(diagnostics)}`
  );
}

function notebookToolbarCommandItems(container: Locator, command: string): Locator {
  return container.locator(`.action-item[data-command-id="${command}"]`);
}

function notebookToolbarCommandAction(item: Locator, command: string): Locator {
  return item.locator(`:scope > .action-label[data-command-id="${command}"]`);
}

function releasedCommandOwnedAction(
  container: Locator,
  commandItem: Locator,
  role: "button" | "menuitem",
  includeHidden = false
): Locator {
  const actions = container.getByRole(role, { includeHidden });
  return commandItem.and(actions).or(commandItem.getByRole(role));
}

async function assertReleasedNotebookActionLabel(action: Locator, surface: string): Promise<void> {
  const evidence = await releasedNotebookActionLabelEvidence(action);
  const accessibleName = evidence.ariaLabel || evidence.title || evidence.text;
  assert.match(
    accessibleName,
    RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN,
    `The ${surface} command must expose the exact accessible name ` +
      `${JSON.stringify(RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN.source)}. ` +
      `Observed: ${JSON.stringify(evidence)}`
  );
}

async function releasedNotebookActionLabelEvidence(
  action: Locator
): Promise<{ ariaLabel: string; title: string; text: string }> {
  const bounded = (value: string | null): string => (value ?? "").trim().slice(0, 160);
  return {
    ariaLabel: bounded(await action.getAttribute("aria-label").catch(() => null)),
    title: bounded(await action.getAttribute("title").catch(() => null)),
    text: bounded(await action.textContent().catch(() => null))
  };
}

async function releasedNotebookLaunchSurfaceMatches(
  workbench: Page,
  expected: "notebook-toolbar" | "editor-title",
  notebookToolbarOverflow = 0
): Promise<boolean> {
  let notebookToolbar = 0;
  let editorTitle = 0;
  for (const frame of releasedWorkbenchFrames(workbench)) {
    const toolbar = frame.locator(".notebook-editor:visible .notebook-toolbar-container:visible");
    const title = frame.locator(".part.editor .editor-group-container.active .editor-actions:visible");
    notebookToolbar += await releasedVisibleOwnedActionCount(toolbar, "button");
    editorTitle += await releasedVisibleOwnedActionCount(title, "button");
  }
  notebookToolbar += notebookToolbarOverflow;
  assert.ok(
    notebookToolbar <= 1 && editorTitle <= 1 && notebookToolbar + editorTitle <= 1,
    "Released notebook launch exposed duplicate Open Wrangler actions across native surfaces."
  );
  return expected === "notebook-toolbar"
    ? notebookToolbar === 1 && editorTitle === 0
    : notebookToolbar === 0 && editorTitle === 1;
}

interface ReleasedNotebookOverflowProbe {
  readonly inventory: ReleasedLocatorState;
  readonly actionState: ReleasedLocatorState;
  readonly action?: ElementHandle<unknown>;
  readonly menu?: ElementHandle<unknown>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

class ReleasedNotebookSurfaceTerminalError extends AggregateError {}

function isReleasedNotebookSurfaceTerminalError(error: unknown): boolean {
  return (
    error instanceof ReleasedNotebookSurfaceTerminalError ||
    (error as { code?: unknown } | undefined)?.code === "ERR_ASSERTION"
  );
}

async function withReleasedNotebookOverflow<T>(
  overflow: ReleasedNotebookOverflowProbe,
  operation: () => Promise<T>
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await releaseReleasedNotebookOverflowAfterInspection(overflow);
    } catch (cleanupError) {
      throw new ReleasedNotebookSurfaceTerminalError(
        [error, cleanupError],
        "Notebook launch-surface inspection and exact overflow cleanup both failed."
      );
    }
    throw error;
  }
  try {
    await releaseReleasedNotebookOverflowAfterInspection(overflow);
  } catch (cleanupError) {
    throw new ReleasedNotebookSurfaceTerminalError(
      [cleanupError],
      "The exact notebook overflow menu could not be closed after launch-surface inspection."
    );
  }
  return result;
}

async function releaseReleasedNotebookOverflowAfterInspection(overflow: ReleasedNotebookOverflowProbe): Promise<void> {
  try {
    await overflow.close();
  } finally {
    await overflow.dispose();
  }
}

async function probeReleasedNotebookToolbarOverflow(workbench: Page): Promise<ReleasedNotebookOverflowProbe> {
  for (const frame of releasedWorkbenchFrames(workbench)) {
    const toolbar = frame.locator(".notebook-editor:visible .notebook-toolbar-container:visible");
    const moreItems = notebookToolbarCommandItems(toolbar, NOTEBOOK_TOOLBAR_MORE_COMMAND);
    const moreCount = await moreItems.count();
    assert.ok(moreCount < 2, "The notebook toolbar exposed duplicate More Actions buttons.");
    const moreByLabel = toolbar.getByRole("button", { name: /^More Actions(?:\.\.\.)?$/u });
    const moreLabelCount = moreCount === 0 ? await moreByLabel.count() : 0;
    assert.ok(moreLabelCount < 2, "The notebook toolbar exposed duplicate labeled More Actions buttons.");
    if (moreCount !== 1 && moreLabelCount !== 1) continue;

    const more =
      moreCount === 1
        ? notebookToolbarCommandAction(moreItems.first(), NOTEBOOK_TOOLBAR_MORE_COMMAND)
        : moreByLabel.first();
    if (!(await more.isVisible())) continue;
    const visibleMenus = frame.locator(".context-view.monaco-menu-container:visible");
    assert.equal(
      await visibleMenus.count(),
      0,
      "Notebook overflow discovery requires no pre-existing visible workbench menu."
    );
    await more.click({ timeout: 2_000 });
    const menuContainer = visibleMenus.first();
    let openedMenu: ElementHandle<unknown> | undefined;
    let pinnedAction: ElementHandle<unknown> | undefined;
    let closed = false;
    let disposed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      if (openedMenu && !(await openedMenu.isVisible())) {
        closed = true;
        return;
      }
      if (!openedMenu && (await visibleMenus.count()) === 0) {
        closed = true;
        return;
      }
      await frame.locator("body").press("Escape");
      if (openedMenu) {
        await openedMenu.waitForElementState("hidden", { timeout: 2_000 });
      } else {
        await visibleMenus.waitFor({ state: "hidden", timeout: 2_000 });
      }
      closed = true;
    };
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([pinnedAction?.dispose(), openedMenu?.dispose()]);
    };
    try {
      // VS Code delays overflow-action mouseup registration for 100 ms so the
      // pointer that opened a menu cannot also invoke an action.
      await workbench.waitForTimeout(150);
      await menuContainer.waitFor({ state: "visible", timeout: 2_000 });
      assert.equal(await visibleMenus.count(), 1, "The More Actions button must open exactly one workbench menu.");
      openedMenu = (await menuContainer.elementHandle()) ?? undefined;
      assert.ok(openedMenu, "The exact opened notebook overflow menu must remain addressable.");

      const menuItems = notebookToolbarCommandItems(menuContainer, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
      const commandState = await releasedLocatorState(menuItems);
      const menuByLabel = menuContainer.getByRole("menuitem", {
        name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
      });
      const labelState = await releasedLocatorState(menuByLabel);
      const commandOwned =
        commandState.total === 1 ? releasedCommandOwnedAction(menuContainer, menuItems.first(), "menuitem") : undefined;
      const commandOwnedState = commandOwned
        ? await releasedLocatorState(commandOwned)
        : { total: 0, visible: 0, enabled: 0 };
      assert.ok(commandState.total < 2, "The notebook overflow exposed duplicate Open Wrangler variable actions.");
      assert.ok(labelState.total < 2, "The notebook overflow exposed duplicate labeled Open Wrangler actions.");
      assert.ok(commandOwnedState.total < 2, "The notebook overflow exposed duplicate command-owned actions.");
      const inventory = commandState.total === 0 ? labelState : commandState;
      const actionState = commandState.total === 0 ? labelState : commandOwnedState;
      const ownedAction =
        commandState.total === 0 ? (labelState.total === 1 ? menuByLabel.first() : undefined) : commandOwned;
      if (actionState.total === 1 && actionState.visible === 1 && actionState.enabled === 1) {
        assert.ok(ownedAction, "The manifest-owned notebook overflow action must remain addressable.");
        await assertReleasedNotebookActionLabel(ownedAction, "released Jupyter notebook-toolbar overflow");
        pinnedAction = (await ownedAction?.elementHandle()) ?? undefined;
        assert.ok(pinnedAction, "The manifest-owned notebook overflow action must remain addressable.");
        assert.equal(
          await pinnedAction.evaluate(
            (action, menu) =>
              typeof menu === "object" &&
              menu !== null &&
              "contains" in menu &&
              typeof (menu as { contains?: unknown }).contains === "function" &&
              (menu as { contains(candidate: unknown): boolean }).contains(action),
            openedMenu
          ),
          true,
          "The pinned Open Wrangler action must belong to the exact opened notebook overflow menu."
        );
      }
      return {
        inventory,
        actionState,
        action: pinnedAction,
        menu: openedMenu,
        close,
        dispose
      };
    } catch (error) {
      try {
        await close();
      } catch (cleanupError) {
        await dispose();
        throw new ReleasedNotebookSurfaceTerminalError(
          [error, cleanupError],
          "Notebook overflow inspection and exact-menu cleanup both failed."
        );
      }
      await dispose();
      throw error;
    }
  }
  return {
    inventory: { total: 0, visible: 0, enabled: 0 },
    actionState: { total: 0, visible: 0, enabled: 0 },
    close: async () => undefined,
    dispose: async () => undefined
  };
}

async function releasedVisibleOwnedActionCount(container: Locator, role: "button" | "menuitem"): Promise<number> {
  const commandItems = notebookToolbarCommandItems(container, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
  const commandState = await releasedLocatorState(commandItems);
  if (commandState.total > 0) return commandState.visible;
  return (
    await releasedLocatorState(
      container.getByRole(role, {
        name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
      })
    )
  ).visible;
}

interface ReleasedLocatorState {
  total: number;
  visible: number;
  enabled: number;
}

async function releasedLocatorState(locator: Locator): Promise<ReleasedLocatorState> {
  const total = await locator.count().catch(() => -1);
  if (total <= 0) return { total, visible: 0, enabled: 0 };
  let visible = 0;
  let enabled = 0;
  for (let index = 0; index < Math.min(total, 8); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      visible += 1;
      if (await candidate.isEnabled().catch(() => false)) enabled += 1;
    }
  }
  return { total, visible, enabled };
}

async function releasedNotebookToolbarDiagnostics(
  workbench: Page,
  lastStructuralFailure: "none" | "transient-toolbar-rerender",
  observedOverflowAction: ReleasedLocatorState
): Promise<unknown> {
  const registeredCommands = await vscode.commands.getCommands(true);
  const jupyter = vscode.extensions.getExtension("ms-toolsai.jupyter");
  const frames = await Promise.all(
    releasedWorkbenchFrames(workbench)
      .slice(0, NOTEBOOK_RENDERER_TARGET_LIMIT)
      .map(async (frame) => {
        const notebookEditors = frame.locator(".notebook-editor");
        const toolbars = frame.locator(".notebook-editor .notebook-toolbar-container");
        const directCommand = notebookToolbarCommandItems(toolbars, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
        const directCommandState = await releasedLocatorState(directCommand);
        const directActionLocator =
          directCommandState.total === 1
            ? releasedCommandOwnedAction(toolbars, directCommand.first(), "button", true)
            : toolbars.getByRole("button", {
                name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN,
                includeHidden: true
              });
        const directAction = await releasedLocatorState(directActionLocator);
        const directActionLabel =
          directAction.total === 1 ? await releasedNotebookActionLabelEvidence(directActionLocator) : undefined;
        const editorTitles = frame.locator(".part.editor .editor-group-container.active .editor-actions");
        const editorTitleCommand = notebookToolbarCommandItems(editorTitles, RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND);
        const editorTitleCommandState = await releasedLocatorState(editorTitleCommand);
        const editorTitleActionLocator =
          editorTitleCommandState.total === 1
            ? releasedCommandOwnedAction(editorTitles, editorTitleCommand.first(), "button", true)
            : editorTitles.getByRole("button", {
                name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN,
                includeHidden: true
              });
        const editorTitleAction = await releasedLocatorState(editorTitleActionLocator);
        const editorTitleActionLabel =
          editorTitleAction.total === 1
            ? await releasedNotebookActionLabelEvidence(editorTitleActionLocator)
            : undefined;
        const jupyterExport = notebookToolbarCommandItems(toolbars, RELEASED_JUPYTER_EXPORT_COMMAND);
        return {
          notebookEditors: await releasedLocatorState(notebookEditors),
          toolbars: await releasedLocatorState(toolbars),
          toolbarButtons: await releasedLocatorState(toolbars.getByRole("button", { includeHidden: true })),
          directAction,
          directActionLabel,
          editorTitleAction,
          editorTitleActionLabel,
          jupyterExport: await releasedLocatorState(jupyterExport),
          tableIcons: await toolbars
            .locator(".codicon-table")
            .count()
            .catch(() => -1)
        };
      })
  );
  const totals = frames.reduce(
    (result, frame) => ({
      notebookEditors: result.notebookEditors + Math.max(frame.notebookEditors.total, 0),
      visibleNotebookEditors: result.visibleNotebookEditors + frame.notebookEditors.visible,
      toolbars: result.toolbars + Math.max(frame.toolbars.total, 0),
      visibleToolbars: result.visibleToolbars + frame.toolbars.visible,
      directActions: result.directActions + Math.max(frame.directAction.total, 0),
      visibleDirectActions: result.visibleDirectActions + frame.directAction.visible,
      enabledDirectActions: result.enabledDirectActions + frame.directAction.enabled,
      editorTitleActions: result.editorTitleActions + Math.max(frame.editorTitleAction.total, 0),
      visibleEditorTitleActions: result.visibleEditorTitleActions + frame.editorTitleAction.visible,
      enabledEditorTitleActions: result.enabledEditorTitleActions + frame.editorTitleAction.enabled,
      labelMismatches:
        result.labelMismatches +
        [frame.directActionLabel, frame.editorTitleActionLabel].filter(
          (evidence) =>
            evidence !== undefined &&
            !RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN.test(
              evidence.ariaLabel || evidence.title || evidence.text
            )
        ).length,
      toolbarButtons: result.toolbarButtons + Math.max(frame.toolbarButtons.total, 0),
      jupyterExports: result.jupyterExports + Math.max(frame.jupyterExport.total, 0),
      tableIcons: result.tableIcons + Math.max(frame.tableIcons, 0)
    }),
    {
      notebookEditors: 0,
      visibleNotebookEditors: 0,
      toolbars: 0,
      visibleToolbars: 0,
      directActions: 0,
      visibleDirectActions: 0,
      enabledDirectActions: 0,
      editorTitleActions: 0,
      visibleEditorTitleActions: 0,
      enabledEditorTitleActions: 0,
      labelMismatches: 0,
      toolbarButtons: 0,
      jupyterExports: 0,
      tableIcons: 0
    }
  );
  const nativeActions = totals.directActions + totals.editorTitleActions;
  const visibleNativeActions = totals.visibleDirectActions + totals.visibleEditorTitleActions;
  const enabledNativeActions = totals.enabledDirectActions + totals.enabledEditorTitleActions;
  const classification =
    totals.visibleNotebookEditors === 0
      ? "notebook-missing"
      : nativeActions + observedOverflowAction.total > 1
        ? "duplicate"
        : nativeActions > 0 && visibleNativeActions === 0
          ? "action-hidden"
          : visibleNativeActions > 0 && enabledNativeActions === 0
            ? "action-disabled"
            : totals.labelMismatches > 0
              ? "label-mismatch"
              : totals.toolbars === 0
                ? "toolbar-missing"
                : totals.visibleToolbars === 0
                  ? "toolbar-hidden"
                  : totals.jupyterExports === 0
                    ? "scoped-context-unavailable"
                    : totals.tableIcons > 0
                      ? "icon-only-action-unresolved"
                      : lastStructuralFailure !== "none"
                        ? "race"
                        : registeredCommands.includes("openWrangler.openNotebookVariable")
                          ? "contribution-suppressed"
                          : "ambiguous";
  return {
    classification,
    lastStructuralFailure,
    framesInspected: frames.length,
    globalToolbar: vscode.workspace.getConfiguration("notebook").get<boolean>("globalToolbar"),
    workspaceTrusted: vscode.workspace.isTrusted,
    activeNotebookType: vscode.window.activeNotebookEditor?.notebook.notebookType,
    jupyterInstalled: jupyter !== undefined,
    jupyterActive: jupyter?.isActive ?? false,
    commandRegistered: registeredCommands.includes("openWrangler.openNotebookVariable"),
    observedOverflowAction,
    totals
  };
}

async function waitForReleasedNotebookVariablePicker(workbench: Page): Promise<Locator> {
  const deadline = Date.now() + 10_000;
  do {
    const matches: Locator[] = [];
    for (const frame of releasedWorkbenchFrames(workbench)) {
      const widgets = frame.locator(".quick-input-widget:visible");
      const count = Math.min(await widgets.count().catch(() => 0), 8);
      for (let index = 0; index < count; index += 1) {
        const widget = widgets.nth(index);
        const title = (
          await widget
            .locator(".quick-input-title")
            .first()
            .textContent()
            .catch(() => "")
        )?.trim();
        if (title !== RELEASED_JUPYTER_NOTEBOOK_VARIABLE_PICKER_TITLE) continue;
        const input = widget.locator(".quick-input-box input").first();
        if ((await input.count()) > 0 && (await input.isVisible())) matches.push(widget);
      }
    }
    if (matches.length === 1) return matches[0]!;
    assert.ok(
      matches.length < 2,
      "The notebook-toolbar action exposed multiple visible Open Wrangler variable pickers."
    );
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  const diagnostics = await boundedImportPromptDiagnostics(workbench);
  throw new Error(
    "Timed out waiting for the Open Wrangler notebook-toolbar variable picker. " +
      `Quick inputs: ${JSON.stringify(diagnostics.quickInputs)}. ` +
      `Notifications: ${JSON.stringify(diagnostics.notifications)}. ` +
      `Dialogs: ${JSON.stringify(diagnostics.dialogs)}. ` +
      `Active tabs: ${JSON.stringify(diagnostics.activeTabs)}.`
  );
}

async function exerciseReleasedJupyterRestartReplay(
  testing: TestApi,
  notebook: vscode.NotebookDocument,
  sessionId: string,
  applied: Extract<OpenWranglerResponse, { kind: "planUpdated" }>,
  pandas: { sessionId: string; revision: number; filterModel: FilterModel },
  duckdb: ReleasedDuckDbRecoverySession,
  priorPid: number,
  setupMarker: string,
  phase: ReleasedJupyterPhase,
  target: ReleasedJupyterKernelTarget,
  hostExtensionPath: string
): Promise<void> {
  await restartReleasedJupyterKernelAndWait(notebook);

  recordAcceptanceProgress(`${phase}:restart-probe`);
  await showExactReleasedNotebook(notebook);
  await executeReleasedNotebookCell(notebook, 3, RELEASED_JUPYTER_RESTART_RESULT, `${phase}:restart-probe-cell`);
  const replacement = releasedNotebookJsonResult(notebook.cellAt(3), RELEASED_JUPYTER_RESTART_RESULT, "restart probe");
  assert.notEqual(Number(replacement.pid), priorPid, "A released-Jupyter restart must replace the kernel process.");
  assert.equal(replacement.setup, null, "The replacement kernel must not retain the prior setup marker.");
  assert.equal(
    replacement.runtime,
    replacement.bootstrap,
    "Runtime availability in the replacement process must come from its own Open Wrangler bootstrap."
  );
  if (target.remote) {
    assert.equal(replacement.remoteRunId, target.remote.runId);
    assert.equal(replacement.hostname, target.remote.hostname);
    assert.equal(replacement.hostExtensionVisible, false);
  }

  recordAcceptanceProgress(`${phase}:restart-setup`);
  await executeReleasedNotebookCell(notebook, 0, setupMarker, `${phase}:restart-setup-cell`);
  const restoredSetup = releasedNotebookSetupResult(notebook.cellAt(0));
  assert.equal(restoredSetup.setup, setupMarker);
  assert.equal(
    restoredSetup.pid,
    replacement.pid,
    "The recreated DuckDB relation must belong to the exact observed replacement kernel."
  );
  assert.equal(
    restoredSetup.duckdbConversionGuards,
    true,
    "The replacement kernel must arm DuckDB conversion traps before session recovery."
  );
  if (target.remote) {
    assert.equal(restoredSetup.remoteRunId, target.remote.runId);
    assert.equal(restoredSetup.hostname, target.remote.hostname);
    assert.equal(restoredSetup.hostExtensionVisible, false);
  }

  recordAcceptanceProgress(`${phase}:restart-replay`);
  const [polarsReplayed, pandasReplayed, duckdbReplayed] = await Promise.all([
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "released-jupyter-polars-restart-replay",
      sessionId,
      revision: applied.revision,
      offset: 0,
      limit: 10,
      filterModel: applied.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "released-jupyter-pandas-restart-replay",
      sessionId: pandas.sessionId,
      revision: pandas.revision,
      offset: 0,
      limit: 10,
      filterModel: pandas.filterModel
    }),
    testing.request({
      kind: "getPage",
      columnOffset: 0,
      columnLimit: 4,
      viewRequestId: "released-jupyter-duckdb-restart-replay",
      sessionId: duckdb.sessionId,
      revision: duckdb.revision,
      offset: 0,
      limit: 10,
      filterModel: duckdb.filterModel
    })
  ]);
  assert.equal(polarsReplayed.kind, "page", "The released-Jupyter Polars plan must replay after kernel replacement.");
  if (polarsReplayed.kind !== "page") throw new Error("Released-Jupyter Polars restart replay did not return a page.");
  const doubled = polarsReplayed.metadata.schema.find((column) => column.name === "double_units");
  assert.ok(doubled, "Recovered released-Jupyter metadata must retain the applied formula output.");
  assert.deepEqual(gridColumnDisplays(polarsReplayed.page, doubled.id), [
    "6",
    "20",
    "10",
    "24",
    "14",
    "4",
    "18",
    "8",
    "22",
    "12"
  ]);
  assert.equal(polarsReplayed.metadata.steps.length, 1);
  assert.equal(
    pandasReplayed.kind,
    "page",
    "The concurrent released-Jupyter Pandas session must recover after kernel replacement."
  );
  if (pandasReplayed.kind !== "page") throw new Error("Released-Jupyter Pandas restart replay did not return a page.");
  assert.deepEqual(gridColumnDisplays(pandasReplayed.page, pandasReplayed.metadata.schema[0]?.id ?? ""), ["1", "2"]);
  assert.equal(pandasReplayed.metadata.backend, "pandas");
  assert.equal(
    duckdbReplayed.kind,
    "page",
    "The concurrent native DuckDB relation must recover after kernel replacement."
  );
  if (duckdbReplayed.kind !== "page") {
    throw new Error("Released-Jupyter DuckDB restart replay did not return a page.");
  }
  assert.equal(
    duckdbReplayed.metadata.sessionId,
    duckdb.sessionId,
    "DuckDB recovery must preserve the public Open Wrangler session identity."
  );
  assert.equal(duckdbReplayed.metadata.backend, "duckdb");
  assert.equal(duckdbReplayed.metadata.mode, "viewing");
  assert.deepEqual(duckdbReplayed.metadata.capabilities, {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false
  });
  assert.deepEqual(duckdbReplayed.metadata.filterModel, duckdb.filterModel);
  assert.deepEqual(duckdbReplayed.metadata.filteredShape, { rows: 25_000, columns: 4 });
  assert.deepEqual(
    duckdbReplayed.metadata.schema,
    duckdb.schema,
    "DuckDB recovery must preserve the exact ordered public schema."
  );
  assert.equal(duckdbReplayed.page.totalRows, 25_000);
  assert.equal(duckdbReplayed.page.rows[0]?.values[0]?.display, "3499997");
  assert.equal(duckdbReplayed.page.rows[0]?.values[1]?.display, "DACH");

  const duckdbRevenue = columnReference(duckdbReplayed.metadata, "revenue");
  const duckdbSummary = await testing.request({
    kind: "getSummary",
    sessionId: duckdb.sessionId,
    revision: duckdbReplayed.revision,
    viewRequestId: "released-jupyter-duckdb-restart-summary",
    filterModel: duckdb.filterModel,
    columnIds: [duckdbRevenue.id]
  });
  assert.equal(duckdbSummary.kind, "summary");
  if (duckdbSummary.kind !== "summary") {
    throw new Error("Released-Jupyter DuckDB restart summary did not resolve.");
  }
  assert.equal(duckdbSummary.summaries[0]?.totalCount, 25_000);
  assert.equal(duckdbSummary.summaries[0]?.numeric?.min, 100.5);
  assert.equal(duckdbSummary.summaries[0]?.numeric?.max, 5_099.94);
  const recoveredDuckdbDiagnostic = testing
    .diagnostics()
    .sessions.find((session) => session.publicId === duckdb.sessionId);
  assert.ok(recoveredDuckdbDiagnostic, "The recovered native DuckDB session must remain coordinated.");
  assert.notEqual(
    recoveredDuckdbDiagnostic.runtimeId,
    duckdb.runtimeId,
    "Kernel recovery must replace DuckDB's private runtime identity."
  );
  testing.setActiveSession(duckdb.sessionId);
  const activeDuckdb = testing.activeSession();
  assert.ok(activeDuckdb, "The recovered DuckDB session must remain selectable.");
  assert.equal(activeDuckdb.sessionId, duckdb.sessionId);
  assert.deepEqual(activeDuckdb.viewState, {
    ...duckdb.viewState,
    filterModel: duckdb.filterModel
  });
  if (target.remote) {
    await assertReleasedRemoteRuntimeTransfer(notebook, target, hostExtensionPath, phase);
  }
}

async function restartReleasedJupyterKernelAndWait(notebook: vscode.NotebookDocument): Promise<void> {
  const extension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
  assert.ok(extension, "The released Jupyter extension must remain installed for restart acceptance.");
  assertExactOpenNotebookDocument(notebook, "before acquiring its released Jupyter kernel for restart");
  const api = await extension.activate();
  assertExactOpenNotebookDocument(notebook, "after activating released Jupyter for restart observation");
  const originalKernel = await api.kernels.getKernel(notebook.uri);
  assertExactOpenNotebookDocument(notebook, "after acquiring its released Jupyter kernel for restart");
  assert.ok(originalKernel, "The released Jupyter kernel must remain available before restart.");

  let restartDispatched = false;
  let observedRestart = false;
  const statuses = new Set<KernelStatus>();
  const recordStatus = (status: KernelStatus): void => {
    statuses.add(status);
    if (restartDispatched && status !== "idle") observedRestart = true;
  };
  recordStatus(originalKernel.status);
  const statusListener = originalKernel.onDidChangeStatus(recordStatus);
  try {
    restartDispatched = true;
    await vscode.commands.executeCommand("jupyter.restartkernel", notebook.uri);
    assertExactOpenNotebookDocument(notebook, "after dispatching the released Jupyter kernel restart");

    const deadline = Date.now() + 90_000;
    do {
      assertExactOpenNotebookDocument(notebook, "while waiting for its released Jupyter kernel restart");
      const currentKernel = await api.kernels.getKernel(notebook.uri);
      assertExactOpenNotebookDocument(notebook, "after polling its released Jupyter kernel restart");
      if (!currentKernel) {
        observedRestart = true;
      } else {
        recordStatus(currentKernel.status);
        if (currentKernel !== originalKernel) observedRestart = true;
        if (observedRestart && currentKernel.status === "idle") return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(
      `Timed out waiting for the released Jupyter kernel to restart and return idle. ` +
        `Observed statuses: ${JSON.stringify([...statuses])}`
    );
  } finally {
    statusListener.dispose();
  }
}

async function closeReleasedJupyterSessionTabs(): Promise<void> {
  const tabs = releasedJupyterSessionTabs();
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
}

function releasedJupyterSessionTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isOpenWranglerSessionTab);
}

function isOpenWranglerSessionTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  return (
    tab.label.startsWith("Open Wrangler: ") ||
    (typeof input === "object" &&
      input !== null &&
      "viewType" in input &&
      (input as { viewType?: unknown }).viewType === "openWrangler.session")
  );
}

async function bestEffortReleasedJupyterCleanup(
  testing: TestApi,
  notebook: vscode.NotebookDocument | undefined,
  phase: ReleasedJupyterPhase
): Promise<void> {
  recordAcceptanceProgress(`${phase}:cleanup-start`);
  for (const session of [...testing.diagnostics().sessions]) {
    try {
      await withBoundedAcceptancePromise(
        testing.disposePanelForSession(session.publicId),
        10_000,
        `released-Jupyter session ${session.publicId} cleanup`
      );
    } catch {
      // Preserve the first released-Jupyter acceptance failure.
    }
  }
  recordAcceptanceProgress(`${phase}:cleanup-sessions`);
  try {
    await withBoundedAcceptancePromise(
      closeReleasedJupyterSessionTabs(),
      10_000,
      "released-Jupyter session-tab cleanup"
    );
  } catch {
    // The isolated editor process remains the bounded final cleanup owner.
  }
  recordAcceptanceProgress(`${phase}:cleanup-session-tabs`);
  if (notebook) {
    const tab = notebookTab(notebook.uri);
    if (tab) {
      try {
        await withBoundedAcceptancePromise(
          vscode.window.tabGroups.close(tab, true),
          10_000,
          "released-Jupyter notebook-tab cleanup"
        );
      } catch {
        // Preserve the first released-Jupyter acceptance failure.
      }
    }
  }
  recordAcceptanceProgress(`${phase}:cleanup-complete`);
}

async function exercisePackagedStepInspection(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.source.path === fixture.fsPath &&
        active.metadata.steps.some((step) => step.id === "packaged-score")
      );
    },
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the packaged custom editor to restore its applied cleaning step"
  );
  await waitForSettledViewState(testing, "the confirmed packaged-editor view before step selection");

  const beforeSelection = testing.activeSession();
  assert.ok(beforeSelection, "The packaged custom editor must publish its active session.");
  assert.equal(beforeSelection.stepInspection, undefined);
  const confirmedMetadata = structuredClone(beforeSelection.metadata);
  const confirmedView = structuredClone(beforeSelection.viewState);
  const confirmedCode = beforeSelection.code;

  await vscode.commands.executeCommand("openWrangler.selectStep", "packaged-score");
  await waitFor(
    () => testing.activeSession()?.stepInspection?.stepId === "packaged-score",
    30_000,
    "the packaged editor to inspect the selected applied step"
  );

  const selected = testing.activeSession();
  assert.ok(selected?.stepInspection, "Selecting an applied step must publish its inspection snapshot.");
  const inspection = selected.stepInspection;
  assert.equal(inspection.revision, confirmedMetadata.revision, "Inspection must not advance the session revision.");
  assert.equal(inspection.stepIndex, 0);
  assert.deepEqual(
    inspection.inputSchema.map((column) => column.name),
    ["city", "year", "sales", "active"]
  );
  assert.deepEqual(
    inspection.outputSchema.map((column) => column.name),
    ["city", "year", "sales", "active", "score"]
  );
  assert.deepEqual(inspection.diff.addedColumns, ["score"]);
  assert.deepEqual(inspection.diff.removedColumns, []);
  assert.equal(inspection.diff.truncated, false);
  assert.match(inspection.code, /def clean_data\(df\):/u);
  assert.match(inspection.code, /score/u);
  assert.deepEqual(selected.metadata, confirmedMetadata, "Inspection must leave the confirmed metadata unchanged.");
  assert.deepEqual(selected.viewState, confirmedView, "Inspection must leave the confirmed view unchanged.");

  await vscode.commands.executeCommand("openWrangler.selectStep");
  await waitFor(
    () => testing.activeSession()?.stepInspection === undefined,
    10_000,
    "Original Data to clear the selected applied-step inspection"
  );
  await waitForSettledViewState(testing, "the confirmed packaged-editor view after clearing step selection");

  const restored = testing.activeSession();
  assert.ok(restored, "Clearing an inspection must retain the active dataframe session.");
  assert.equal(restored.stepInspection, undefined);
  assert.deepEqual(restored.metadata, confirmedMetadata, "Clearing must restore the exact confirmed metadata.");
  assert.deepEqual(
    restored.viewState,
    confirmedView,
    "Clearing must restore filters, sorts, widths, selection, and viewport exactly."
  );
  assert.equal(restored.code, confirmedCode, "Clearing must restore the full-plan generated code.");
}

async function exercisePackagedPlatformSmoke(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  fixture: vscode.Uri
): Promise<void> {
  const editorKey = process.env.OPEN_WRANGLER_TEST_EDITOR;
  assert.equal(
    editorKey === "vscode" || editorKey === "cursor",
    true,
    "The bounded packaged journey requires VS Code or Cursor."
  );
  const editorName = editorKey === "cursor" ? "Cursor" : "VS Code";
  const sourceBytes = await vscode.workspace.fs.readFile(fixture);
  const page = await connectToEditorWorkbench();
  const activeEditorGroup = page.locator(".part.editor .editor-group-container.active");

  recordAcceptanceProgress("platform-smoke:gallery-icon");
  await vscode.commands.executeCommand("workbench.view.extensions");
  const installedExtension = page
    .locator(".part.sidebar .monaco-list-row, .part.sidebar [role=treeitem]")
    .filter({ hasText: "Open Wrangler" })
    .first();
  await installedExtension.waitFor({ state: "visible", timeout: 10_000 });
  const galleryIcon = installedExtension.locator("img").first();
  await galleryIcon.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await galleryIcon.evaluate((image: unknown) => {
      const candidate = image as { complete?: unknown; naturalWidth?: unknown; tagName?: unknown };
      return candidate.tagName === "IMG" && candidate.complete === true && Number(candidate.naturalWidth) > 0;
    }),
    true,
    "The installed Open Wrangler gallery entry must render its packaged icon."
  );
  const screenshotOutput = process.env.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS;
  if (screenshotOutput) {
    const commands = new Set(await vscode.commands.getCommands(true));
    const auxiliaryBar = page.locator(".part.auxiliarybar");
    if ((await auxiliaryBar.count()) > 0 && (await auxiliaryBar.isVisible())) {
      const closeAuxiliaryBar = commands.has("workbench.action.closeAuxiliaryBar")
        ? "workbench.action.closeAuxiliaryBar"
        : commands.has("workbench.action.toggleAuxiliaryBar")
          ? "workbench.action.toggleAuxiliaryBar"
          : undefined;
      if (closeAuxiliaryBar) {
        await vscode.commands.executeCommand(closeAuxiliaryBar);
        await auxiliaryBar.waitFor({ state: "hidden", timeout: 10_000 });
      }
    }
    const sidebar = page.locator(".part.sidebar");
    if ((await sidebar.count()) > 0 && (await sidebar.isVisible())) {
      const closeSidebar = commands.has("workbench.action.closeSidebar")
        ? "workbench.action.closeSidebar"
        : commands.has("workbench.action.toggleSidebarVisibility")
          ? "workbench.action.toggleSidebarVisibility"
          : undefined;
      if (closeSidebar) {
        await vscode.commands.executeCommand(closeSidebar);
        await sidebar.waitFor({ state: "hidden", timeout: 10_000 });
      }
    }
    await clearReleasedJupyterScreenshotTransientUi(page);
  }

  recordAcceptanceProgress("platform-smoke:file-action");
  await vscode.commands.executeCommand("vscode.open", fixture, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    `the CSV source editor before the ${editorName} title action`
  );
  await page.bringToFront();
  const titleAction = activeEditorGroup.locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible').first();
  await titleAction.waitFor({ state: "visible", timeout: 10_000 });
  if (screenshotOutput) {
    recordAcceptanceProgress("platform-smoke:file-action:screenshots");
    mkdirSync(screenshotOutput, { recursive: true });
    await titleAction.hover();
    await page
      .locator(".monaco-hover:visible")
      .filter({ hasText: "Open in Open Wrangler" })
      .waitFor({ state: "visible", timeout: 2_000 })
      .catch(() => {});
    await captureWorkbenchScreenshot(page, path.resolve(screenshotOutput, `${editorKey}-file-title-action.png`));
    await page.keyboard.press("Escape");

    const sourceTab = activeEditorGroup
      .locator(".tabs-container .tab.active")
      .filter({ hasText: path.basename(fixture.fsPath) })
      .last();
    const { menu } = await openEditorTabContextMenu(page, sourceTab, "Open in Open Wrangler");
    await captureWorkbenchScreenshot(page, path.resolve(screenshotOutput, `${editorKey}-tab-context-menu.png`));
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden", timeout: 3_000 });
    await titleAction.waitFor({ state: "visible", timeout: 3_000 });
  }
  await titleAction.click();
  await waitForAutomaticDelimitedImport(page, testing, fixture, "platform-smoke:import");
  await waitFor(
    () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    `the ${editorName} CSV action to open a dataframe session`
  );
  const active = testing.activeSession();
  assert.ok(active, `The ${editorName} journey must publish an active dataframe session.`);
  assert.equal(active.metadata.source.path, fixture.fsPath);
  assert.deepEqual(active.metadata.shape, {
    rows: PACKAGED_FIRST_USE_ROW_COUNT,
    columns: PACKAGED_SCREENSHOT_COLUMNS.length
  });
  assert.equal(active.metadata.backend, "polars");
  assert.deepEqual(active.metadata.source.importOptions, {
    delimiter: ";",
    encoding: "utf-8",
    quoteChar: '"',
    hasHeader: true
  });

  recordAcceptanceProgress("platform-smoke:grid");
  const gridTarget = await waitForOpenWranglerGridTarget(page, testing, active.metadata.sessionId);
  const grid = gridTarget.frame.getByRole("grid", { name: `Data grid for ${active.metadata.source.label}` });
  await grid.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await grid.getAttribute("aria-colcount"), String(PACKAGED_SCREENSHOT_COLUMNS.length + 1));
  const firstCell = gridTarget.frame.locator('td[data-grid-row="0"][data-grid-column="0"]').first();
  await firstCell.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await firstCell.innerText()).trim(), "2400001");
  await firstCell.focus();
  await firstCell.press("ArrowRight");
  await gridTarget.frame
    .locator('td[data-grid-row="0"][data-grid-column="1"]:focus')
    .waitFor({ state: "visible", timeout: 5_000 });

  await exercisePrimarySortJourney(
    testing,
    page,
    gridTarget.frame,
    active.metadata.sessionId,
    "platform-smoke:sort-journey"
  );
  await exercisePackagedFirstUseInteractionJourney(
    testing,
    page,
    gridTarget.frame,
    active.metadata.sessionId,
    fixture,
    sourceBytes
  );

  recordAcceptanceProgress("platform-smoke:theme");
  const themeAttestation = await gridTarget.frame.locator("main.app").evaluate((element) => {
    const window = element.ownerDocument.defaultView;
    if (!window) throw new Error("The packaged editor webview did not expose a live window.");
    const computed = window.getComputedStyle(element);
    const root = window.getComputedStyle(element.ownerDocument.documentElement);
    const probe = element.ownerDocument.createElement("span");
    probe.style.color = "var(--vscode-foreground)";
    probe.style.backgroundColor = "var(--vscode-editor-background)";
    element.appendChild(probe);
    const expected = window.getComputedStyle(probe);
    const result = {
      color: computed.color,
      background: root.backgroundColor,
      expectedColor: expected.color,
      expectedBackground: expected.backgroundColor,
      foregroundToken: root.getPropertyValue("--vscode-foreground").trim(),
      backgroundToken: root.getPropertyValue("--vscode-editor-background").trim(),
      fontToken: root.getPropertyValue("--vscode-font-family").trim(),
      fontFamily: computed.fontFamily
    };
    probe.remove();
    return result;
  });
  assert.ok(themeAttestation.foregroundToken, `${editorName} must provide the VS Code foreground token.`);
  assert.ok(themeAttestation.backgroundToken, `${editorName} must provide the VS Code editor-background token.`);
  assert.ok(themeAttestation.fontToken, `${editorName} must provide the VS Code font token.`);
  assert.equal(themeAttestation.color, themeAttestation.expectedColor);
  assert.equal(themeAttestation.background, themeAttestation.expectedBackground);
  assert.ok(themeAttestation.fontFamily);

  recordAcceptanceProgress("platform-smoke:native-views");
  await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
  const activityAction = page.getByRole("tab", { name: /Open Wrangler/iu }).first();
  await activityAction.waitFor({ state: "visible", timeout: 10_000 });
  const sidebar = page.locator(".part.sidebar:visible");
  for (const label of ["Operations", "Summary", "Filters / Sorts", "Cleaning Steps"]) {
    await sidebar.getByText(label, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  assert.equal(extension.isActive, true);

  await exercisePackagedReopenAndUndoJourney(testing, page, fixture, sourceBytes, editorName);

  recordAcceptanceProgress("platform-smoke:cleanup");
  assert.deepEqual(await vscode.workspace.fs.readFile(fixture), sourceBytes);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    `the ${editorName} journey session and Python runtime to terminate`
  );
  assert.deepEqual(testing.diagnostics().sessions, []);
}

async function exerciseRemoteWorkspace(
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  workspace: vscode.Uri,
  testPython: string
): Promise<void> {
  assert.equal(
    process.env.OPEN_WRANGLER_TEST_EDITOR,
    "vscode-remote-ssh",
    "Remote-workspace acceptance is reserved for the pinned official VS Code and Remote SSH chain."
  );
  assert.equal(vscode.env.remoteName, "ssh-remote", "The acceptance extension host must execute over Remote SSH.");
  assert.equal(
    workspace.scheme,
    "file",
    "A workspace-extension process must receive its Remote SSH filesystem as a host-local file URI."
  );
  assert.equal(workspace.authority, "");
  assert.equal(extension.isActive, true);
  for (const loaderVariable of ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_BIND_NOW", "LD_AUDIT"]) {
    assert.equal(
      process.env[loaderVariable],
      undefined,
      `The remote extension host must not inherit ${loaderVariable}.`
    );
  }

  const configuredPython = vscode.workspace.getConfiguration("openWrangler", workspace).inspect<string>("pythonPath");
  assert.equal(
    configuredPython?.workspaceFolderValue,
    testPython,
    "The remote workspace must pin its private Python through resource-scoped configuration."
  );
  assert.equal(vscode.workspace.getConfiguration("openWrangler", workspace).get<string>("pythonPath"), testPython);

  const fixture = vscode.Uri.joinPath(workspace, "remote.csv");
  const sourceBytes = await vscode.workspace.fs.readFile(fixture);
  recordAcceptanceProgress("remote-workspace:open");
  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the Remote SSH CSV source to open in the real Open Wrangler grid",
    () =>
      JSON.stringify({
        coordinator: testing.diagnostics(),
        runtimeRunning: testing.runtimeRunning(),
        runtimeEnvironment: testing.runtimeEnvironment(),
        panelOpenResponse: testing.panelOpenResponse()
      })
  );
  const active = testing.activeSession();
  assert.ok(active, "The Remote SSH workspace must publish one active dataframe grid.");
  assert.equal(active.metadata.backend, "polars");
  assert.deepEqual(active.metadata.shape, { rows: 3, columns: 2 });
  await waitFor(
    () => testing.panelHydrated(active.metadata.sessionId),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the exact Remote SSH panel to finish opening and acknowledge its current renderer snapshot"
  );
  assert.equal(
    await testing.synchronizePanel(active.metadata.sessionId),
    true,
    "The remote dataframe session must own a synchronized Open Wrangler grid panel."
  );

  const runtimeEnvironment = testing.runtimeEnvironment();
  assert.ok(runtimeEnvironment, "The remote grid must start its Python runtime.");
  assert.equal(runtimeEnvironment.executable, testPython);
  assert.equal(runtimeEnvironment.source, "configuration");
  assert.match(runtimeEnvironment.version, /^3\.(?:1[0-4])\./u);

  const filterModel: FilterModel = {
    logic: "and",
    filters: [
      {
        column: "city",
        type: "string",
        logic: "and",
        predicates: [{ kind: "predicate", operator: "equals", value: "Milan" }]
      }
    ],
    sort: []
  };
  recordAcceptanceProgress("remote-workspace:filter");
  const filtered = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    viewRequestId: "remote-workspace-filter",
    sessionId: active.metadata.sessionId,
    revision: active.metadata.revision,
    offset: 0,
    limit: 20,
    filterModel
  });
  assert.equal(filtered.kind, "page");
  if (filtered.kind !== "page") return;
  assert.equal(filtered.page.totalRows, 1);
  assert.equal(filtered.page.rows.length, 1);
  assert.equal(filtered.page.rows[0]?.values[0]?.display, "Milan");
  assert.equal(filtered.page.rows[0]?.values[1]?.display, "42");
  assert.deepEqual(testing.activeSession()?.viewState.filterModel, filterModel);
  assert.deepEqual(
    await vscode.workspace.fs.readFile(fixture),
    sourceBytes,
    "A remote viewing filter must leave the source CSV bytes unchanged."
  );

  recordAcceptanceProgress("remote-workspace:cleanup");
  await testing.disposePanelForSession(active.metadata.sessionId);
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    15_000,
    "the Remote SSH session and private Python runtime to terminate"
  );
  assert.deepEqual(testing.diagnostics().sessions, []);
  assert.equal(testing.runtimeEnvironment(), undefined);
  assert.deepEqual(await vscode.workspace.fs.readFile(fixture), sourceBytes);
}

async function waitForOpenWranglerGridTarget(
  workbench: Page,
  testing: TestApi,
  expectedSessionId: string
): Promise<OpenWranglerWebviewTarget> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    const browser = workbench.context().browser();
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
      if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
      try {
        const app = await exactSessionApp(target.frame, expectedSessionId);
        if (!app) continue;
        const grid = app.locator('[data-testid="data-grid-scroller"] [role="grid"]').first();
        if ((await grid.count()) > 0 && (await grid.isVisible())) return target;
      } catch (error) {
        ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  assertOpenWranglerWebviewLifecycle(workbench, browser);
  const diagnostics = await openWranglerGridDiagnostics(workbench, browser, expectedSessionId);
  const active = testing.activeSession();
  throw new Error(
    "The editor journey did not expose the expected live Open Wrangler grid. " +
      `State: ${JSON.stringify({
        expectedSessionId,
        activeSession:
          active === undefined
            ? undefined
            : {
                sessionId: active.sessionId,
                sourceLabel: active.metadata.source.label,
                revision: active.metadata.revision
              },
        coordinator: testing.diagnostics(),
        panelHydrated: testing.panelHydrated(expectedSessionId),
        activeTab: activeEditorTabDiagnostic(),
        webviews: diagnostics
      })}`
  );
}

async function exactSessionApp(frame: Frame, expectedSessionId: string): Promise<Locator | undefined> {
  const apps = frame.locator("main.app[data-session-id]");
  const count = await apps.count();
  for (let index = 0; index < count; index += 1) {
    const app = apps.nth(index);
    if ((await app.getAttribute("data-session-id")) === expectedSessionId) return app;
  }
  return undefined;
}

async function waitForExactSessionWebviewButton(
  workbench: Page,
  testing: TestApi,
  expectedSessionId: string,
  name: string,
  requireEnabled = false
): Promise<Locator> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  do {
    const browser = workbench.context().browser();
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
      if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
      try {
        const app = await exactSessionApp(target.frame, expectedSessionId);
        if (!app) continue;
        const grid = app.locator('[data-testid="data-grid-scroller"] [role="grid"]').first();
        if ((await grid.count()) === 0 || !(await grid.isVisible())) continue;
        const button = app.getByRole("button", { name, exact: true }).first();
        if ((await button.count()) === 0 || !(await button.isVisible())) continue;
        if (requireEnabled && !(await button.isEnabled())) continue;
        return button;
      } catch (error) {
        ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  assertOpenWranglerWebviewLifecycle(workbench, browser);
  const diagnostics = await openWranglerGridDiagnostics(workbench, browser, expectedSessionId);
  throw new Error(
    `The editor journey did not expose the exact Open Wrangler session ${JSON.stringify(name)} button. ` +
      `State: ${JSON.stringify({
        expectedSessionId,
        requireEnabled,
        activeSession: testing.activeSession()?.sessionId,
        coordinator: testing.diagnostics(),
        panelHydrated: testing.panelHydrated(expectedSessionId),
        activeTab: activeEditorTabDiagnostic(),
        webviews: diagnostics
      })}`
  );
}

async function focusAndSynchronizeExactSessionPanel(
  workbench: Page,
  testing: TestApi,
  expectedSessionId: string,
  expectedSourceLabel: string
): Promise<Locator> {
  const expectedTabLabel = `Open Wrangler: ${expectedSourceLabel}`;
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await waitFor(
    () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return Boolean(tab && tab.label === expectedTabLabel && isOpenWranglerSessionTab(tab));
    },
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the exact Open Wrangler custom editor to remain active after its import Quick Input closed",
    () =>
      JSON.stringify({
        expectedSessionId,
        expectedTabLabel,
        activeTab: activeEditorTabDiagnostic(),
        panelHydrated: testing.panelHydrated(expectedSessionId),
        coordinator: testing.diagnostics()
      })
  );

  // Cursor may temporarily retire a custom-editor renderer while its final
  // Quick Input closes. Focusing is one non-mutating user action; require the
  // exact session's physical grid before asking the host for a fresh,
  // authoritative renderer acknowledgement.
  await waitForExactSessionWebviewButton(workbench, testing, expectedSessionId, "Import options");
  await waitFor(
    () => testing.panelHydrated(expectedSessionId),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the exact import-reconfigured renderer to acknowledge its current host snapshot",
    () =>
      JSON.stringify({
        expectedSessionId,
        activeTab: activeEditorTabDiagnostic(),
        panelHydrated: testing.panelHydrated(expectedSessionId),
        coordinator: testing.diagnostics()
      })
  );
  assert.equal(
    await testing.synchronizePanel(expectedSessionId),
    true,
    "The focused import-reconfigured renderer must acknowledge one authoritative synchronization."
  );
  return waitForExactSessionWebviewButton(workbench, testing, expectedSessionId, "Import options", true);
}

async function exercisePrimarySortJourney(
  testing: TestApi,
  workbench: Page,
  frame: Frame,
  sessionId: string,
  checkpoint: string
): Promise<void> {
  recordAcceptanceProgress(checkpoint);
  const marketHeader = frame.locator('th[data-column="market"]').first();
  const marketMenu = marketHeader.locator("details.columnMenu").first();
  await marketMenu.getByLabel("Column actions for market").click();
  await marketMenu.getByRole("button", { name: "Sort descending", exact: true }).click();
  assert.equal(
    await marketMenu.evaluate((element) => element.hasAttribute("open")),
    false,
    "A quick-sort choice must close its column menu."
  );
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 1 && sort[0]?.column === "market" && sort[0].direction === "desc" && sort[0].nulls === "last"
      );
    },
    10_000,
    "the market quick sort to become the highest-priority viewing sort"
  );
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="1"]')
    .filter({ hasText: "UK & Ireland" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2400005" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await marketHeader.getByRole("button", { name: /Clear sort for market; currently descending/u }).waitFor({
    state: "visible",
    timeout: 10_000
  });

  const revenueHeader = frame.locator('th[data-column="revenue"]').first();
  const revenueMenu = revenueHeader.locator("details.columnMenu").first();
  await revenueMenu.getByLabel("Column actions for revenue").click();
  await revenueMenu.getByRole("button", { name: "Sort descending", exact: true }).click();
  assert.equal(
    await revenueMenu.evaluate((element) => element.hasAttribute("open")),
    false,
    "A later quick sort must also close its column menu."
  );
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 2 &&
        sort[0]?.column === "revenue" &&
        sort[0].direction === "desc" &&
        sort[0].nulls === "last" &&
        sort[1]?.column === "market" &&
        sort[1].direction === "desc" &&
        sort[1].nulls === "last"
      );
    },
    10_000,
    "the revenue quick sort to become priority 1 while retaining market as its tie-breaker"
  );
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2409089" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await marketHeader
    .getByRole("button", { name: /Clear sort for market; currently descending, priority 2 of 2/u })
    .waitFor({ state: "visible", timeout: 10_000 });
  const clearRevenueSort = revenueHeader.getByRole("button", {
    name: /Clear sort for revenue; currently descending, priority 1 of 2/u
  });
  await clearRevenueSort.waitFor({ state: "visible", timeout: 10_000 });

  await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
  const sidebar = workbench.locator(".part.sidebar:visible");
  const filtersTree = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  if (!(await filtersTree.isVisible().catch(() => false))) {
    const filtersHeader = sidebar.getByText("Filters / Sorts", { exact: true }).first();
    await filtersHeader.waitFor({ state: "visible", timeout: 10_000 });
    await filtersHeader.click();
  }
  await filtersTree.waitFor({ state: "visible", timeout: 10_000 });

  const revenuePriorityOne = filtersTree
    .getByRole("treeitem", {
      name: /^revenue, Priority 1 · Descending · nulls last/u
    })
    .first();
  const marketPriorityTwo = filtersTree
    .getByRole("treeitem", {
      name: /^market, Priority 2 · Descending · nulls last/u
    })
    .first();
  await revenuePriorityOne.waitFor({ state: "visible", timeout: 10_000 });
  await marketPriorityTwo.waitFor({ state: "visible", timeout: 10_000 });
  await marketPriorityTwo.hover();
  const moveMarketUp = marketPriorityTwo.getByRole("button", { name: /Move View Sort Up$/u }).first();
  await moveMarketUp.waitFor({ state: "visible", timeout: 5_000 });
  await moveMarketUp.click();
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 2 &&
        sort[0]?.column === "market" &&
        sort[0].direction === "desc" &&
        sort[0].nulls === "last" &&
        sort[1]?.column === "revenue" &&
        sort[1].direction === "desc" &&
        sort[1].nulls === "last"
      );
    },
    10_000,
    "the real Filters / Sorts move-up action to make market priority 1"
  );
  await filtersTree
    .getByRole("treeitem", {
      name: /^market, Priority 1 · Descending · nulls last/u
    })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await filtersTree
    .getByRole("treeitem", {
      name: /^revenue, Priority 2 · Descending · nulls last/u
    })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  const marketFirstTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  await marketFirstTarget.frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2400488" })
    .waitFor({ state: "visible", timeout: 10_000 });

  const marketPriorityOne = filtersTree
    .getByRole("treeitem", {
      name: /^market, Priority 1 · Descending · nulls last/u
    })
    .first();
  await marketPriorityOne.hover();
  const moveMarketDown = marketPriorityOne.getByRole("button", { name: /Move View Sort Down$/u }).first();
  await moveMarketDown.waitFor({ state: "visible", timeout: 5_000 });
  await moveMarketDown.click();
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 2 &&
        sort[0]?.column === "revenue" &&
        sort[0].direction === "desc" &&
        sort[0].nulls === "last" &&
        sort[1]?.column === "market" &&
        sort[1].direction === "desc" &&
        sort[1].nulls === "last"
      );
    },
    10_000,
    "the real Filters / Sorts move-down action to restore revenue as priority 1"
  );
  await filtersTree
    .getByRole("treeitem", {
      name: /^revenue, Priority 1 · Descending · nulls last/u
    })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await filtersTree
    .getByRole("treeitem", {
      name: /^market, Priority 2 · Descending · nulls last/u
    })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });

  const restoredTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  frame = restoredTarget.frame;
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2409089" })
    .waitFor({ state: "visible", timeout: 10_000 });
  const restoredRevenueHeader = frame.locator('th[data-column="revenue"]').first();
  const restoredMarketHeader = frame.locator('th[data-column="market"]').first();
  const restoredClearRevenueSort = restoredRevenueHeader.getByRole("button", {
    name: /Clear sort for revenue; currently descending, priority 1 of 2/u
  });
  await restoredClearRevenueSort.waitFor({ state: "visible", timeout: 10_000 });
  await restoredClearRevenueSort.click();
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return sort?.length === 1 && sort[0]?.column === "market" && sort[0].direction === "desc";
    },
    10_000,
    "clearing the primary revenue sort to retain the market tie-breaker as priority 1"
  );
  const revenueSortIndicator = restoredRevenueHeader.getByRole("button", { name: /Clear sort for revenue/u });
  await revenueSortIndicator.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(
    await revenueSortIndicator.count(),
    0,
    "Clearing one sort key must remove only that column's indicator."
  );
  const clearMarketSort = restoredMarketHeader.getByRole("button", {
    name: "Clear sort for market; currently descending",
    exact: true
  });
  await clearMarketSort.waitFor({ state: "visible", timeout: 10_000 });
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2400005" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await clearMarketSort.click();
  await waitFor(
    () => testing.activeSession()?.viewState.filterModel.sort.length === 0,
    10_000,
    "clearing the final market sort"
  );
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "2400001" })
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function exercisePackagedFirstUseInteractionJourney(
  testing: TestApi,
  workbench: Page,
  frame: Frame,
  sessionId: string,
  fixture: vscode.Uri,
  sourceBytes: Uint8Array
): Promise<void> {
  let app = await exactSessionApp(frame, sessionId);
  assert.ok(app, "The first-use journey requires the exact active Open Wrangler application.");
  const rediscoverApp = async (phase: string): Promise<Locator> => {
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const current = await exactSessionApp(target.frame, sessionId);
    assert.ok(current, `${phase} requires the exact visible Open Wrangler renderer for the active session.`);
    return current;
  };
  assert.equal(
    await app.getByRole("region", { name: "Cleaning plan" }).count(),
    0,
    "A new dataframe must not waste vertical space on an empty cleaning-plan bar."
  );
  await app.getByRole("button", { name: "Export", exact: true }).waitFor({ state: "visible", timeout: 10_000 });

  recordAcceptanceProgress("platform-smoke:column-search");
  const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await columnSearch.fill("revenue");
  const revenueOption = app.getByRole("option", { name: "revenue, Number column", exact: true });
  await revenueOption.waitFor({ state: "visible", timeout: 10_000 });
  await revenueOption.getByRole("img", { name: "Number column type" }).waitFor({ state: "visible", timeout: 10_000 });
  await columnSearch.press("Enter");
  const revenue = columnReference(testing.activeSession()!.metadata, "revenue");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === revenue.id,
    10_000,
    "column search to navigate to the selected numeric column"
  );

  recordAcceptanceProgress("platform-smoke:insights");
  const insightsToggle = app.getByRole("button", { name: "Column profiles and filters" });
  await insightsToggle.click();
  const drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
  await drawer.waitFor({ state: "visible", timeout: 10_000 });
  await drawer.getByRole("heading", { name: "revenue", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await waitForLocatorText(
    drawer,
    (text) =>
      !text.includes("Profiling selected column") &&
      ["Exact statistics", "Min", "Max", "Mean", "Median"].every((label) => text.includes(label)) &&
      (text.includes("Exact distribution") || text.includes("Sampled distribution")),
    30_000,
    "complete exact revenue insights"
  );
  const histogramBars = drawer.locator('[role="graphics-symbol"]');
  assert.ok(await histogramBars.count(), "Numeric insights must expose keyboard-focusable histogram bins.");
  assert.match(
    (await histogramBars.first().getAttribute("aria-label")) ?? "",
    /: [\d,.]+ rows?$/u,
    "Every histogram bin must expose its exact row count."
  );
  assert.equal(
    await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    "The Insights drawer must not clip content horizontally."
  );

  recordAcceptanceProgress("platform-smoke:text-insights");
  const accountNote = columnReference(testing.activeSession()!.metadata, "account_note");
  await columnSearch.fill("account_note");
  const accountNoteOption = app.getByRole("option", { name: "account_note, Text column", exact: true });
  await accountNoteOption.waitFor({ state: "visible", timeout: 10_000 });
  await accountNoteOption.getByRole("img", { name: "Text column type" }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await columnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === accountNote.id,
    10_000,
    "column search to navigate to the realistic text column"
  );
  await drawer.getByRole("heading", { name: "account_note", exact: true }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await waitForLocatorText(
    drawer,
    (text) =>
      !text.includes("Profiling selected column") &&
      ["Exact statistics", "Null", "Empty", "Min length", "Max length", "Mean length"].every((label) =>
        text.includes(label)
      ),
    30_000,
    "complete exact account-note insights"
  );

  // Inspect exact values only after the user-facing profile has completed, so
  // the acceptance assertion cannot contend with or mask the renderer request.
  const accountNoteProfile = await testing.request({
    kind: "getSummary",
    sessionId,
    revision: testing.activeSession()!.metadata.revision,
    viewRequestId: "platform-smoke-account-note-summary",
    filterModel: testing.activeSession()!.viewState.filterModel,
    columnIds: [accountNote.id]
  });
  assert.equal(accountNoteProfile.kind, "summary", "The realistic text profile must complete natively.");
  if (accountNoteProfile.kind !== "summary") throw new Error("The realistic text profile did not resolve.");
  const accountNoteSummary = accountNoteProfile.summaries[0];
  assert.equal(accountNoteSummary?.columnId, accountNote.id);
  const accountNotePosition = PACKAGED_SCREENSHOT_COLUMNS.length - 1;
  assert.equal(PACKAGED_SCREENSHOT_COLUMNS[accountNotePosition], "account_note");
  const sourceNotes = Array.from({ length: PACKAGED_FIRST_USE_ROW_COUNT }, (_, index) => ({
    kind: packagedFirstUseAccountNoteKind(index),
    value: packagedScreenshotRow(index)[accountNotePosition]!
  }));
  const presentNotes = sourceNotes.filter((item) => item.kind !== "null").map((item) => item.value);
  const lengths = presentNotes.map((value) => [...value].length);
  const expectedNullCount = sourceNotes.filter((item) => item.kind === "null").length;
  const expectedEmptyCount = sourceNotes.filter((item) => item.kind === "empty").length;
  assert.equal(accountNoteSummary?.nullCount, expectedNullCount);
  assert.equal(accountNoteSummary?.text?.emptyCount, expectedEmptyCount);
  assert.equal(accountNoteSummary?.text?.minLength, Math.min(...lengths));
  assert.equal(accountNoteSummary?.text?.maxLength, Math.max(...lengths));
  assert.ok(
    Math.abs(
      (accountNoteSummary?.text?.meanLength ?? Number.NaN) -
        lengths.reduce((sum, length) => sum + length, 0) / lengths.length
    ) < 1e-10,
    "The realistic text profile must publish its exact mean Unicode code-point length."
  );
  const accountNoteText = accountNoteSummary?.text;
  assert.ok(accountNoteText, "The realistic text column must publish exact text metrics.");

  assert.equal(await drawer.locator("dt", { hasText: /^NaN$/u }).count(), 0);
  const expectedVisibleMetrics = new Map<string, string>([
    ["Null", expectedNullCount.toLocaleString()],
    ["Empty", expectedEmptyCount.toLocaleString()],
    ["Min length", accountNoteText.minLength!.toLocaleString(undefined, { maximumFractionDigits: 4 })],
    ["Max length", accountNoteText.maxLength!.toLocaleString(undefined, { maximumFractionDigits: 4 })],
    ["Mean length", accountNoteText.meanLength!.toLocaleString(undefined, { maximumFractionDigits: 4 })]
  ]);
  for (const [label, expectedValue] of expectedVisibleMetrics) {
    const value = drawer
      .locator("dt", { hasText: new RegExp(`^${label}$`, "u") })
      .locator("xpath=following-sibling::dd[1]");
    await value.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      (await value.innerText()).trim(),
      expectedValue,
      `${label} must match the exact native profile for the realistic text column.`
    );
  }
  assert.equal(
    await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    "The text Insights drawer must not clip content horizontally."
  );

  recordAcceptanceProgress("platform-smoke:filter");
  await drawer.getByRole("tab", { name: "Filters", exact: true }).click();
  const filterPanel = drawer.locator(".filterSortPanel").first();
  await filterPanel.waitFor({ state: "visible", timeout: 10_000 });
  await filterPanel.getByLabel("Filter column", { exact: true }).selectOption({ label: "revenue" });
  await filterPanel.getByLabel("Predicate operator").selectOption("gte");
  await filterPanel.getByLabel("gte predicate value").fill("20000");
  await filterPanel.getByRole("button", { name: "Add predicate", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.viewState.filterModel.filters.length === 1 &&
        active.metadata.filteredShape.rows > 0 &&
        active.metadata.filteredShape.rows < PACKAGED_FIRST_USE_ROW_COUNT
      );
    },
    30_000,
    "the realistic numeric filter to update the visible dataframe"
  );
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The filtered host state must be acknowledged by its exact renderer before visible values are inspected."
  );
  // Text profiling intentionally navigated to the far-right account_note
  // column. Return to revenue before inspecting its virtualized grid cell;
  // off-screen columns are correctly absent from the DOM.
  await columnSearch.fill("revenue");
  await app.getByRole("option", { name: "revenue, Number column", exact: true }).waitFor({
    state: "visible",
    timeout: 10_000
  });
  await columnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === revenue.id,
    10_000,
    "column search to return to the filtered numeric column"
  );
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The revenue navigation must be acknowledged before its virtualized cell is inspected."
  );
  const visibleRevenueCell = frame.locator('td[data-grid-row="0"][data-grid-column="2"]').first();
  await waitForLocatorText(
    visibleRevenueCell,
    (text) => {
      const value = Number(text.replaceAll(",", ""));
      return Number.isFinite(value) && value >= 20_000;
    },
    10_000,
    "the first visible revenue to satisfy the chosen predicate"
  );
  const visibleRevenue = Number((await visibleRevenueCell.innerText()).replaceAll(",", ""));
  assert.ok(
    Number.isFinite(visibleRevenue) && visibleRevenue >= 20_000,
    `The first visible filtered revenue must satisfy the chosen predicate, received ${visibleRevenue}.`
  );
  await filterPanel.getByRole("button", { name: "Clear all", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.viewState.filterModel.filters.length === 0 &&
        active.viewState.filterModel.sort.length === 0 &&
        active.metadata.filteredShape.rows === PACKAGED_FIRST_USE_ROW_COUNT
      );
    },
    30_000,
    "Clear all to restore the complete dataframe view"
  );
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The restored host view must be acknowledged by its exact renderer before the next operation."
  );
  await drawer.getByRole("button", { name: "Close panel" }).click();
  await drawer.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(
    await insightsToggle.evaluate((element) => element.ownerDocument.activeElement === element),
    true,
    "Closing Insights must restore focus to its toolbar toggle."
  );

  recordAcceptanceProgress("platform-smoke:draft-discard");
  await previewUppercaseMarket(app, testing, "market_upper");
  const draftCodePreview = await waitForCodePreview(workbench, "market_upper");
  const draftCodePreviewText = await draftCodePreview.innerText();
  assert.match(draftCodePreviewText, /import polars as pl/u);
  assert.match(draftCodePreviewText, /market_upper/u);
  // `view.focus` resolves independently from the workbench's asynchronous
  // panel-title layout. VS Code can briefly report no title while Cursor
  // mirrors the same visible title in both the panel and view headers. The
  // rendered Code Preview webview above is the cross-editor source of truth;
  // rediscover the exact dataframe renderer afterwards to prove that opening
  // the panel did not replace or hide the custom editor.
  app = await rediscoverApp("Code Preview reveal validation");
  await app.locator('[data-testid="data-grid-scroller"] [role="grid"]').first().waitFor({
    state: "visible",
    timeout: 10_000
  });
  const discardedDraft = testing.activeSession();
  assert.ok(discardedDraft, "The uppercase preview must retain the active dataframe session.");
  assert.equal(discardedDraft.metadata.draftStep?.kind, "upperText");
  assert.ok(
    discardedDraft.metadata.schema.some((column) => column.name === "market_upper"),
    "The draft grid must preview its added output column."
  );
  const draftReview = app.getByRole("region", { name: "Draft review" });
  await draftReview.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await draftReview.count(), 1, "A pending operation must expose exactly one compact draft review.");
  assert.equal(
    await app.getByRole("region", { name: "Cleaning plan" }).count(),
    0,
    "A pending operation must not duplicate its controls in the applied cleaning-plan bar."
  );
  await draftReview.getByText("Uppercase", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const draftDiff = draftReview.locator('[aria-label="Data diff summary"]');
  await draftDiff.getByText("+1 column", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await draftDiff.getByText(/values added in this block$/u).waitFor({ state: "visible", timeout: 10_000 });
  const discardDraft = draftReview.getByRole("button", { name: "Discard", exact: true });
  const applyDraft = draftReview.getByRole("button", { name: "Apply step", exact: true });
  await discardDraft.waitFor({ state: "visible", timeout: 10_000 });
  await applyDraft.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await app.getByRole("button", { name: "Discard", exact: true }).count(), 1);
  assert.equal(await app.getByRole("button", { name: "Apply step", exact: true }).count(), 1);
  assert.equal(
    await draftDiff.getByText(/0 changed cells/u).count(),
    0,
    "An added-column preview must not misleadingly report zero changed cells."
  );
  assert.equal(
    await app.locator(".draftCode").count(),
    0,
    "Generated cleaning code must remain in the native Code Preview instead of being duplicated inline."
  );
  assert.equal(
    await app.getByLabel("Generated Python code preview").count(),
    0,
    "The compact draft review must not render a second generated-code surface."
  );
  const addedHeader = app.locator('th[data-column="market_upper"]').first();
  try {
    await addedHeader.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const revealDiagnostics = await app.evaluate((root: unknown) => {
      const queryRoot = root as {
        querySelector(selector: string): unknown;
        querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null }> & {
          length: number;
        };
      };
      const scroller = queryRoot.querySelector('[data-testid="data-grid-scroller"]') as {
        scrollLeft: number;
        scrollWidth: number;
        clientWidth: number;
      } | null;
      const search = queryRoot.querySelector('input[aria-label="Column"]') as { value: string } | null;
      const renderedHeaders = Array.from(queryRoot.querySelectorAll("th[data-column]"));
      return {
        selectedSearchValue: search?.value ?? null,
        renderedColumnCount: renderedHeaders.length,
        renderedLastColumn: renderedHeaders.at(-1)?.getAttribute("data-column") ?? null,
        scrollLeft: scroller?.scrollLeft ?? null,
        scrollWidth: scroller?.scrollWidth ?? null,
        clientWidth: scroller?.clientWidth ?? null
      };
    });
    throw new Error(`The generated column was not revealed: ${JSON.stringify(revealDiagnostics)}`, {
      cause: error
    });
  }
  const addedHeaderVisibility = await addedHeader.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const scroller = element.closest('[data-testid="data-grid-scroller"]');
    if (!scroller) return { visible: false };
    const viewport = scroller.getBoundingClientRect();
    return {
      visible: bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1,
      headerLeft: bounds.left,
      headerRight: bounds.right,
      viewportLeft: viewport.left,
      viewportRight: viewport.right,
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth
    };
  });
  assert.equal(
    addedHeaderVisibility.visible,
    true,
    `Previewing a new column must automatically reveal its complete grid header: ${JSON.stringify(
      addedHeaderVisibility
    )}`
  );
  await app
    .locator('td[data-grid-row="0"][data-grid-column="15"]')
    .filter({ hasText: "BENELUX" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await discardDraft.click();
  await waitFor(
    () =>
      testing.activeSession()?.metadata.draftStep === undefined &&
      testing.activeSession()?.metadata.steps.length === 0 &&
      testing.activeSession()?.metadata.schema.some((column) => column.name === "market") === true &&
      testing.activeSession()?.metadata.schema.some((column) => column.name === "market_upper") === false,
    30_000,
    "discarding the preview to restore the confirmed dataframe"
  );
  await draftReview.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(await draftReview.count(), 0, "Discarding the only draft must remove the compact draft-review region.");

  recordAcceptanceProgress("platform-smoke:draft-apply");
  await previewUppercaseMarket(app, testing, "market_upper");
  app = await rediscoverApp("Draft-apply validation");
  await app
    .getByRole("region", { name: "Draft review" })
    .getByRole("button", { name: "Apply step", exact: true })
    .click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      if (!active) return false;
      return (
        active.metadata.draftStep === undefined &&
        active.metadata.steps.length === 1 &&
        active.metadata.schema.some((column) => column.name === "market") &&
        active.metadata.schema.some((column) => column.name === "market_upper")
      );
    },
    30_000,
    "applying the previewed uppercase step"
  );
  const appliedPlan = app.getByRole("region", { name: "Cleaning plan" });
  await appliedPlan.getByText("1 applied step").waitFor({ state: "visible", timeout: 10_000 });
  assert.match(testing.activeSession()?.code ?? "", /import polars as pl/u);
  assert.match(testing.activeSession()?.code ?? "", /market_upper/u);

  recordAcceptanceProgress("platform-smoke:export");
  const exportDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-first-use-export-"));
  const exportPath = path.join(exportDirectory, "regional-orders-cleaned.csv");
  try {
    await exportCleanedDataThroughWorkbench(app, workbench, exportPath);
    await waitFor(() => existsSync(exportPath), 30_000, "the cleaned CSV export to appear");
    const exportedHeader = readFileSync(exportPath, "utf8").split(/\r?\n/u, 1)[0] ?? "";
    assert.match(exportedHeader, /(?:^|,)market(?:,|$)/u);
    assert.match(exportedHeader, /(?:^|,)market_upper(?:,|$)/u);
    assert.equal(
      readFileSync(exportPath, "utf8").split(/\r?\n/u).filter(Boolean).length,
      PACKAGED_FIRST_USE_ROW_COUNT + 1,
      "The exported CSV must contain every cleaned row plus its header."
    );
  } finally {
    cleanupAcceptanceTemporaryDirectory(exportDirectory);
  }
  assert.deepEqual(await vscode.workspace.fs.readFile(fixture), sourceBytes);
  await clearReleasedJupyterScreenshotTransientUi(workbench);
}

async function previewUppercaseMarket(app: Locator, testing: TestApi, newColumn: string): Promise<void> {
  await app.getByRole("button", { name: "Add step", exact: true }).click();
  const dialog = app.getByRole("dialog", { name: "Add cleaning step" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("Search operations").fill("uppercase");
  await dialog.getByRole("button", { name: /^Uppercase/u }).click();
  const textColumn = dialog.getByLabel("Text column", { exact: true });
  await textColumn.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(
    (await textColumn.locator("option:checked").innerText()).trim(),
    /^market, column \d+$/u,
    "The Uppercase form should default to the first compatible text column."
  );
  await dialog.getByLabel("Output column (blank replaces in place)", { exact: true }).fill(newColumn);
  const commands = new Set(await vscode.commands.getCommands(true));
  if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
  if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
  await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
  await waitFor(
    () =>
      testing.activeSession()?.metadata.draftStep?.kind === "upperText" &&
      testing.activeSession()?.metadata.schema.some((column) => column.name === newColumn) === true,
    30_000,
    `the uppercase preview for ${newColumn}`
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

async function exportCleanedDataThroughWorkbench(app: Locator, workbench: Page, destination: string): Promise<void> {
  await app.getByRole("button", { name: "Export", exact: true }).click();
  const formatPicker = workbench
    .locator(".quick-input-widget:visible")
    .filter({ hasText: "Export Cleaned Data" })
    .last();
  await formatPicker.waitFor({ state: "visible", timeout: 10_000 });
  await formatPicker.getByRole("option").filter({ hasText: /^CSV/u }).first().click();
  assert.equal(
    await pollAcceptanceCondition(
      async () =>
        workbench
          .locator(".quick-input-widget:visible")
          .filter({ hasText: "Export Cleaned Data" })
          .last()
          .locator(".quick-input-box input")
          .first()
          .inputValue()
          .then((value) => /\.cleaned\.csv$/u.test(value))
          .catch(() => false),
      { timeoutMs: 10_000, intervalMs: 50 }
    ),
    true,
    "The cleaned-data Save dialog must retain the suggested .cleaned.csv destination."
  );
  const saveDialog = workbench.locator(".quick-input-widget:visible").filter({ hasText: "Export Cleaned Data" }).last();
  const saveInput = saveDialog.locator(".quick-input-box input").first();
  await saveInput.fill(path.resolve(destination));
  await saveInput.press("Enter");
  await saveDialog.waitFor({ state: "hidden", timeout: 30_000 });
  await workbench
    .locator(".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible")
    .filter({ hasText: "Exporting cleaned data…" })
    .waitFor({ state: "hidden", timeout: 30_000 });
}

async function exercisePackagedReopenAndUndoJourney(
  testing: TestApi,
  workbench: Page,
  fixture: vscode.Uri,
  sourceBytes: Uint8Array,
  editorName: string
): Promise<void> {
  recordAcceptanceProgress("platform-smoke:reopen");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    15_000,
    `the ${editorName} first-use session to close before recovery`
  );
  await vscode.commands.executeCommand("vscode.open", fixture, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    `the CSV source editor before the ${editorName} recovery action`
  );
  const activeEditorGroup = workbench.locator(".part.editor .editor-group-container.active");
  const titleAction = activeEditorGroup.locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible').first();
  await titleAction.waitFor({ state: "visible", timeout: 10_000 });
  await titleAction.click();
  await waitForAutomaticDelimitedImport(workbench, testing, fixture, "platform-smoke:reopen-import");
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.source.uri === fixture.toString() &&
        active.metadata.steps.length === 1 &&
        active.metadata.schema.some((column) => column.name === "market_upper")
      );
    },
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the applied cleaning plan to replay after closing and reopening the source"
  );
  const reopened = testing.activeSession();
  assert.ok(reopened, "Reopening the source must publish its recovered dataframe session.");
  const reopenedTarget = await waitForOpenWranglerGridTarget(workbench, testing, reopened.sessionId);
  const reopenedApp = await exactSessionApp(reopenedTarget.frame, reopened.sessionId);
  assert.ok(reopenedApp, "The recovered session must expose its exact Open Wrangler application.");
  await reopenedApp
    .getByRole("region", { name: "Cleaning plan" })
    .getByText("1 applied step")
    .waitFor({ state: "visible", timeout: 10_000 });

  recordAcceptanceProgress("platform-smoke:undo");
  await reopenedApp.getByRole("button", { name: "Undo", exact: true }).click();
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.steps.length === 0 &&
        active.metadata.draftStep === undefined &&
        active.metadata.schema.some((column) => column.name === "market") &&
        !active.metadata.schema.some((column) => column.name === "market_upper")
      );
    },
    30_000,
    "Undo to restore the original schema"
  );
  const reopenedCleaningPlan = reopenedApp.getByRole("region", { name: "Cleaning plan" });
  await reopenedCleaningPlan.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(
    await reopenedCleaningPlan.count(),
    0,
    "Undoing the only applied step must remove the empty cleaning-plan bar."
  );
  assert.deepEqual(await vscode.workspace.fs.readFile(fixture), sourceBytes);
}

async function waitForLocatorText(
  locator: Locator,
  predicate: (text: string) => boolean,
  timeoutMs: number,
  expectation: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate(await locator.innerText())) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${expectation}.`);
}

async function waitForLocatorCount(
  locator: Locator,
  expectedCount: number,
  timeoutMs: number,
  expectation: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await locator.count()) === expectedCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${expectation}; found ${await locator.count()}.`);
}

async function waitForSettledViewState(testing: TestApi, expectation: string): Promise<void> {
  const started = Date.now();
  // The coordinator snapshot can become active before the newly mounted Electron
  // webview reports its browser-quantized physical scroll position. Wait across
  // the webview debounce and a full render quiet period so inspection compares
  // two confirmed UI states rather than racing that initial report.
  const stableForMs = 1_200;
  let previous = "";
  let unchangedSince = started;
  while (Date.now() - started <= 10_000) {
    const active = testing.activeSession();
    const current = active ? JSON.stringify(active.viewState) : "";
    if (current !== previous) {
      previous = current;
      unchangedSince = Date.now();
    } else if (active && Date.now() - unchangedSince >= stableForMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expectation}.`);
}

async function exercisePackagedFileLaunchSurfaces(
  testing: TestApi,
  fixture: vscode.Uri,
  outputDirectory?: string
): Promise<void> {
  recordAcceptanceProgress("verify:file-launch:setup");
  const sourceBytes = readFileSync(fixture.fsPath);
  const page = await connectToEditorWorkbench();
  const editor = process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor";
  const activeEditorGroup = page.locator(".part.editor .editor-group-container.active");
  const titleAction = activeEditorGroup.locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible');

  if (editor === "cursor") {
    const pinnedTitleActions = vscode.workspace
      .getConfiguration("cursor.general")
      .inspect<string[]>("pinnedTitleActions");
    assert.ok(pinnedTitleActions, "Cursor must register its pinned-title-action setting.");
    assert.ok(
      pinnedTitleActions.defaultValue?.includes("openWrangler.openFile"),
      "The packaged Cursor default must pin the canonical file action."
    );
    assert.equal(
      pinnedTitleActions.globalValue,
      undefined,
      "Cursor acceptance must not persist a user-level title-action setting."
    );
    assert.equal(
      pinnedTitleActions.workspaceValue,
      undefined,
      "Cursor acceptance must not persist a workspace title-action setting."
    );
  }

  const availableCommands = new Set(await vscode.commands.getCommands(true));
  const auxiliaryBar = page.locator(".part.auxiliarybar");
  if ((await auxiliaryBar.count()) > 0 && (await auxiliaryBar.isVisible())) {
    const closeAuxiliaryBar = availableCommands.has("workbench.action.closeAuxiliaryBar")
      ? "workbench.action.closeAuxiliaryBar"
      : availableCommands.has("workbench.action.toggleAuxiliaryBar")
        ? "workbench.action.toggleAuxiliaryBar"
        : undefined;
    if (closeAuxiliaryBar) await vscode.commands.executeCommand(closeAuxiliaryBar);
  }
  if (availableCommands.has("notifications.clearAll")) {
    await vscode.commands.executeCommand("notifications.clearAll");
  }
  if (availableCommands.has("notifications.hideList")) {
    await vscode.commands.executeCommand("notifications.hideList");
  }

  recordAcceptanceProgress("verify:file-launch:explorer-context:source");
  await vscode.commands.executeCommand("vscode.open", fixture, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    "the exact source text editor before revealing its Explorer row"
  );
  assert.ok(
    availableCommands.has("workbench.files.action.showActiveFileInExplorer"),
    "The installed editor must expose its native active-file Explorer reveal command."
  );
  await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
  await page.bringToFront();
  const explorer = page.locator(".part.sidebar .explorer-folders-view:visible").first();
  await explorer.waitFor({ state: "visible", timeout: 10_000 });
  const explorerRows = explorer
    .locator('.monaco-list-row[role="treeitem"]:visible')
    .filter({ hasText: path.basename(fixture.fsPath) });
  await waitForLocatorCount(explorerRows, 1, 10_000, "one exact deterministic fixture row in Explorer");
  const explorerRow = explorerRows.first();
  assert.equal(
    (await explorerRow.innerText()).replace(/\s+/gu, " ").trim(),
    path.basename(fixture.fsPath),
    "The Explorer context journey must target the exact copied fixture row."
  );
  recordAcceptanceProgress("verify:file-launch:explorer-context:menu");
  const { menu: explorerContextMenu, action: explorerMenuAction } = await openWorkbenchContextMenu(
    page,
    explorerRow,
    "Open in Open Wrangler",
    "Explorer row"
  );
  assert.ok(explorerMenuAction, "The Explorer row must expose Open in Open Wrangler.");
  assert.equal(
    await explorerContextMenu.getByRole("menuitem", { name: "Open in Open Wrangler", exact: true }).count(),
    1,
    "The Explorer context menu must expose exactly one canonical Open in Open Wrangler action."
  );
  assert.equal((await explorerMenuAction.innerText()).trim(), "Open in Open Wrangler");
  recordAcceptanceProgress("verify:file-launch:explorer-context:open");
  await explorerMenuAction.click();
  await waitForAutomaticDelimitedImport(page, testing, fixture, "verify:file-launch:explorer-context:import");
  await waitFor(
    () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the physical Explorer context action to open its exact copied fixture"
  );
  const explorerSession = testing.activeSession();
  assert.ok(explorerSession);
  assert.deepEqual(explorerSession.metadata.shape, {
    rows: PACKAGED_FIRST_USE_ROW_COUNT,
    columns: PACKAGED_SCREENSHOT_COLUMNS.length
  });
  assert.deepEqual(explorerSession.metadata.source.importOptions, {
    delimiter: ";",
    encoding: "utf-8",
    quoteChar: '"',
    hasHeader: true
  });
  await waitFor(
    () => testing.panelHydrated(explorerSession.sessionId),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the Explorer-launched dataframe renderer to acknowledge its exact session"
  );
  assert.equal(await testing.synchronizePanel(explorerSession.sessionId), true);
  const explorerGridTarget = await waitForOpenWranglerGridTarget(page, testing, explorerSession.sessionId);
  const explorerGrid = explorerGridTarget.frame.getByRole("grid", {
    name: `Data grid for ${explorerSession.metadata.source.label}`
  });
  await explorerGrid.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await explorerGrid.getAttribute("aria-colcount"), String(PACKAGED_SCREENSHOT_COLUMNS.length + 1));
  assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes, "The Explorer action must not modify its source.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the Explorer context launch session to dispose"
  );
  assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes, "Explorer launch cleanup must preserve source bytes.");

  recordAcceptanceProgress("verify:file-launch:title-action:source");
  await vscode.commands.executeCommand("vscode.open", fixture, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    "the source text editor before file-launch interaction"
  );
  await page.bringToFront();
  try {
    await titleAction.first().waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const visibleEditorLabels = await page
      .locator(".part.editor .editor-group-container.active [aria-label]:visible")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
    const moreActions = activeEditorGroup.locator('[aria-label="More Actions..."]:visible').first();
    let overflowItems: string[] = [];
    if ((await moreActions.count()) > 0) {
      await moreActions.click();
      overflowItems = await page
        .locator('.context-view.monaco-menu-container [role="menuitem"]:visible')
        .allInnerTexts();
      await page.keyboard.press("Escape");
    }
    throw new Error(
      `Open Wrangler editor-title action was not visible. Visible editor labels: ${JSON.stringify(visibleEditorLabels)}. Editor overflow items: ${JSON.stringify(overflowItems)}`,
      { cause: error }
    );
  }
  if (outputDirectory) {
    recordAcceptanceProgress("verify:file-launch:title-action:screenshot");
    mkdirSync(outputDirectory, { recursive: true });
    await titleAction.first().hover();
    await page
      .locator(".monaco-hover:visible")
      .filter({ hasText: "Open in Open Wrangler" })
      .waitFor({ state: "visible", timeout: 2_000 })
      .catch(() => {});
    await captureWorkbenchScreenshot(page, path.resolve(outputDirectory, `${editor}-file-title-action.png`));
    await page.keyboard.press("Escape");
  }

  recordAcceptanceProgress("verify:file-launch:title-action:open");
  await titleAction.first().click();
  await waitForAutomaticDelimitedImport(page, testing, fixture, "verify:file-launch:title-action:import");
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the editor-title action to open the selected source"
  );
  const active = testing.activeSession();
  assert.ok(active, "The editor-title action must publish its dataframe session.");
  assert.deepEqual(
    active.metadata.shape,
    { rows: PACKAGED_FIRST_USE_ROW_COUNT, columns: PACKAGED_SCREENSHOT_COLUMNS.length },
    "The file-launch journey must exercise the complete realistic first-use dataframe."
  );
  assert.deepEqual(
    active.metadata.schema.map((column) => column.name),
    [...PACKAGED_SCREENSHOT_COLUMNS],
    "The file-launch journey must retain every realistic first-use column before interaction."
  );
  await waitFor(
    () => testing.panelHydrated(active.metadata.sessionId),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the exact editor-title panel to finish opening and acknowledge its current renderer snapshot",
    () =>
      JSON.stringify({
        sessionId: active.metadata.sessionId,
        coordinator: testing.diagnostics(),
        activeTab: activeEditorTabDiagnostic()
      })
  );
  assert.equal(
    await withAcceptanceOperationDeadline(
      testing.synchronizePanel(active.metadata.sessionId),
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the exact editor-title Open Wrangler panel synchronization"
    ),
    true,
    "The editor-title session must own a synchronized Open Wrangler grid panel."
  );
  await waitFor(
    () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return Boolean(
        tab && isOpenWranglerSessionTab(tab) && tab.label === `Open Wrangler: ${active.metadata.source.label}`
      );
    },
    10_000,
    "the editor-title Open Wrangler session tab to remain active",
    () => JSON.stringify(activeEditorTabDiagnostic())
  );
  const gridTarget = await waitForOpenWranglerGridTarget(page, testing, active.metadata.sessionId);
  await exercisePrimarySortJourney(
    testing,
    page,
    gridTarget.frame,
    active.metadata.sessionId,
    "verify:file-launch:title-action:sort-journey"
  );
  assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes, "The editor-title action must not modify its source.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the editor-title launch session to dispose"
  );

  recordAcceptanceProgress("verify:file-launch:tab-context:menu");
  const sourceTab = page
    .locator(".part.editor .tabs-container .tab")
    .filter({ hasText: path.basename(fixture.fsPath) })
    .last();
  const activeSourceTab = page
    .locator(".part.editor .editor-group-container.active .tabs-container .tab.active")
    .filter({ hasText: path.basename(fixture.fsPath) })
    .last();
  await sourceTab.waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.bringToFront();
  await sourceTab.click();
  await activeSourceTab.waitFor({ state: "visible", timeout: 10_000 });
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
    },
    10_000,
    "the source tab to become active before opening its context menu"
  );
  const { menu: tabContextMenu, action: tabMenuAction } = await openEditorTabContextMenu(
    page,
    activeSourceTab,
    "Open in Open Wrangler"
  );
  assert.ok(tabMenuAction, "The source-tab context menu must expose Open in Open Wrangler.");
  assert.equal(
    (await tabMenuAction.innerText()).trim(),
    "Open in Open Wrangler",
    "The editor-tab context action must use the compact product label."
  );
  if (outputDirectory) {
    recordAcceptanceProgress("verify:file-launch:tab-context:screenshot");
    await tabContextMenu.waitFor({ state: "visible", timeout: 1_000 });
    await captureWorkbenchScreenshot(page, path.resolve(outputDirectory, `${editor}-tab-context-menu.png`));
  }
  recordAcceptanceProgress("verify:file-launch:tab-context:open");
  await tabMenuAction.click();
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the editor-tab context action to open the selected source"
  );
  assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes, "The editor-tab action must not modify its source.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the editor-tab launch session to dispose"
  );

  // A custom-editor tab becomes active in the extension host before Electron
  // has necessarily rebound editor/title actions to that tab's resource. Drop
  // the prior source tab so a still-rendering action can never retain its URI,
  // then require the third-party webview itself before clicking the action.
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => vscode.window.tabGroups.all.every((group) => group.tabs.length === 0),
    10_000,
    "all prior file-launch tabs to close before third-party editor routing"
  );
  await page.bringToFront();
  await activeEditorGroup.locator(".tabs-container .tab.active").last().waitFor({ state: "hidden", timeout: 10_000 });
  await titleAction.first().waitFor({ state: "hidden", timeout: 10_000 });

  recordAcceptanceProgress("verify:file-launch:third-party-editor:source");
  const customEditorFixture = vscode.Uri.file(path.join(path.dirname(fixture.fsPath), "sample.csv"));
  const customEditorSourceBytes = readFileSync(customEditorFixture.fsPath);
  await vscode.commands.executeCommand(
    "vscode.openWith",
    customEditorFixture,
    "openwrangler-tests.csvEditor",
    vscode.ViewColumn.One
  );
  await waitFor(
    () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return (
        input instanceof vscode.TabInputCustom &&
        input.viewType === "openwrangler-tests.csvEditor" &&
        input.uri.toString() === customEditorFixture.toString()
      );
    },
    10_000,
    "the third-party CSV custom editor before file-launch interaction"
  );
  await page.bringToFront();
  const customEditorTitleAction = await waitForThirdPartyCustomEditorWorkbench(
    page,
    activeEditorGroup,
    customEditorFixture
  );
  recordAcceptanceProgress("verify:file-launch:third-party-editor:open");
  await customEditorTitleAction.click();
  recordAcceptanceProgress("verify:file-launch:third-party-editor:import");
  const importCheckpoint = "verify:file-launch:third-party-editor:import";
  await waitForAutomaticDelimitedImport(page, testing, customEditorFixture, importCheckpoint);
  recordAcceptanceProgress(`${importCheckpoint}:options-complete`);
  recordAcceptanceProgress(`${importCheckpoint}:session-open`);
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === customEditorFixture.fsPath,
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the third-party custom-editor title action to open the selected CSV source"
  );
  recordAcceptanceProgress(`${importCheckpoint}:opened`);
  assert.deepEqual(testing.activeSession()?.metadata.source.importOptions, {
    delimiter: ",",
    encoding: "utf-8",
    quoteChar: '"',
    hasHeader: true
  });
  assert.deepEqual(
    readFileSync(customEditorFixture.fsPath),
    customEditorSourceBytes,
    "The third-party custom-editor title action must not modify its source."
  );
  recordAcceptanceProgress(`${importCheckpoint}:close`);
  await withAcceptanceOperationDeadline(
    vscode.commands.executeCommand("workbench.action.closeActiveEditor"),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the third-party CSV session editor to close"
  );
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the third-party custom-editor launch session to dispose"
  );
  recordAcceptanceProgress(`${importCheckpoint}:closed`);

  recordAcceptanceProgress("verify:file-launch:duplicate-action-guards");
  await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the custom editor before duplicate-action verification"
  );
  await page.bringToFront();
  await page.waitForTimeout(250);
  assert.equal(await titleAction.count(), 0, "The Open Wrangler custom editor must not offer a duplicate open action.");
  const openWranglerTab = activeEditorGroup
    .locator(".tabs-container .tab.active")
    .filter({ hasText: path.basename(fixture.fsPath) })
    .last();
  const { menu: openWranglerContextMenu } = await openEditorTabContextMenu(page, openWranglerTab);
  assert.equal(
    await openWranglerContextMenu.getByRole("menuitem", { name: "Open in Open Wrangler", exact: true }).count(),
    0,
    "The Open Wrangler custom-editor tab must not offer a duplicate open action."
  );
  await page.keyboard.press("Escape");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the launch-surface custom editor to dispose"
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  recordAcceptanceProgress("verify:file-launch:complete");
}

interface ContextMenuDiagnostic {
  attempt: number;
  menus: Array<{
    text: string;
    items: Array<{ role: string | null; text: string; ariaLabel: string | null; labelAriaLabel: string | null }>;
  }>;
}

async function openEditorTabContextMenu(
  page: Page,
  tab: Locator,
  requiredActionName?: string
): Promise<{ menu: Locator; action?: Locator }> {
  return openWorkbenchContextMenu(page, tab, requiredActionName, "editor tab");
}

async function openWorkbenchContextMenu(
  page: Page,
  target: Locator,
  requiredActionName: string | undefined,
  surface: string
): Promise<{ menu: Locator; action?: Locator }> {
  const diagnostics: ContextMenuDiagnostic[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.keyboard.press("Escape");
    const visibleMenus = page.locator(".context-view.monaco-menu-container:visible");
    await visibleMenus.waitFor({ state: "hidden", timeout: 1_000 }).catch(() => {});
    await target.click({ button: "right" });

    const menu = visibleMenus.last();
    const action = requiredActionName
      ? menu.getByRole("menuitem", { name: requiredActionName, exact: true }).last()
      : undefined;
    try {
      await menu.waitFor({ state: "visible", timeout: 3_000 });
      if (action) await action.waitFor({ state: "visible", timeout: 3_000 });
      // VS Code intentionally attaches a menu item's mouse-up handler after a
      // 100 ms guard so the click that opened the menu cannot also invoke it.
      await page.waitForTimeout(200);
      return { menu, action };
    } catch (error) {
      lastError = error;
      diagnostics.push({ attempt, menus: await inspectVisibleContextMenus(page) });
    }
  }

  throw new Error(
    `The ${surface} context menu did not expose ${
      requiredActionName ? JSON.stringify(requiredActionName) : "a visible HTML menu"
    } after two right-click attempts. Visible menu diagnostics: ${JSON.stringify(diagnostics)}`,
    { cause: lastError }
  );
}

async function inspectVisibleContextMenus(page: Page): Promise<ContextMenuDiagnostic["menus"]> {
  return page.locator(".context-view.monaco-menu-container:visible").evaluateAll((menus) =>
    menus.map((menu) => ({
      text: (menu.textContent ?? "").replace(/\s+/gu, " ").trim(),
      items: Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((item) => {
        const element = item as typeof menu;
        return {
          role: element.getAttribute("role"),
          text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
          ariaLabel: element.getAttribute("aria-label"),
          labelAriaLabel: element.querySelector(".action-label")?.getAttribute("aria-label") ?? null
        };
      })
    }))
  );
}

interface CustomEditorFrameDiagnostic {
  page: string;
  frame: string;
  markerCount: number;
  visibleMarkerCount: number;
}

async function waitForThirdPartyCustomEditorWorkbench(
  page: Page,
  activeEditorGroup: Locator,
  fixture: vscode.Uri
): Promise<Locator> {
  const activeTab = activeEditorGroup
    .locator(".tabs-container .tab.active")
    .filter({ hasText: path.basename(fixture.fsPath) })
    .last();
  const titleAction = activeEditorGroup.locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible');
  const deadline = Date.now() + 10_000;
  do {
    const frames = await inspectThirdPartyCustomEditorFrames(page);
    if (
      (await activeTab.isVisible().catch(() => false)) &&
      frames.some((frame) => frame.visibleMarkerCount === 1) &&
      (await titleAction.count()) === 1
    ) {
      return titleAction.first();
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);

  const activeTabs = await page
    .locator(".part.editor .tabs-container .tab.active:visible")
    .allInnerTexts()
    .catch(() => []);
  const visibleEditorLabels = await activeEditorGroup
    .locator("[aria-label]:visible")
    .evaluateAll((elements) => elements.slice(0, 64).map((element) => element.getAttribute("aria-label")))
    .catch(() => []);
  throw new Error(
    `The third-party CSV editor did not become renderer-active before its title action was used. ` +
      `Expected URI: ${JSON.stringify(fixture.toString())}. Active workbench tabs: ${JSON.stringify(activeTabs)}. ` +
      `Visible editor labels: ${JSON.stringify(visibleEditorLabels)}. Webview frames: ${JSON.stringify(await inspectThirdPartyCustomEditorFrames(page))}.`
  );
}

async function inspectThirdPartyCustomEditorFrames(page: Page): Promise<CustomEditorFrameDiagnostic[]> {
  const browser = page.context().browser();
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [page];
  const diagnostics = await Promise.all(
    pages.slice(0, 16).flatMap((candidate) =>
      candidate
        .frames()
        .slice(0, 32)
        .map(async (frame) => {
          const markers = frame.locator('[aria-label="Acceptance CSV Editor"]');
          const markerCount = await markers.count().catch(() => 0);
          let visibleMarkerCount = 0;
          for (let index = 0; index < markerCount; index += 1) {
            if (
              await markers
                .nth(index)
                .isVisible()
                .catch(() => false)
            )
              visibleMarkerCount += 1;
          }
          return {
            page: candidate.url(),
            frame: frame.url(),
            markerCount,
            visibleMarkerCount
          };
        })
    )
  );
  return diagnostics.filter((diagnostic) => diagnostic.markerCount > 0);
}

async function waitForAutomaticDelimitedImport(
  page: Page,
  testing: TestApi,
  expectedSource: vscode.Uri,
  checkpointPrefix: string
): Promise<void> {
  recordAcceptanceProgress(`${checkpointPrefix}:automatic-detection`);
  const deadline = Date.now() + SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS;
  do {
    const quickInputs = page.locator(".quick-input-widget:visible");
    const count = await quickInputs.count().catch(() => 0);
    if (count > 0) {
      const labels = await quickInputs
        .allInnerTexts()
        .then((values) => values.slice(0, 8).map((value) => value.replace(/\s+/gu, " ").trim()))
        .catch(() => []);
      throw new Error(
        `Opening ${JSON.stringify(expectedSource.toString())} exposed an initial Quick Input instead of using automatic import detection. Visible Quick Inputs: ${JSON.stringify(labels)}.`
      );
    }
    if (testing.activeSession()?.metadata.source.uri === expectedSource.toString()) {
      recordAcceptanceProgress(`${checkpointPrefix}:automatic-detection-complete`);
      return;
    }
    await page.waitForTimeout(25);
  } while (Date.now() < deadline);
  throw new Error(
    `Automatic import detection did not open ${JSON.stringify(expectedSource.toString())} before the launch deadline.`
  );
}

async function boundedImportOptionDiagnostics(quickInput: Locator): Promise<unknown> {
  try {
    return await withAcceptanceOperationDeadline(
      quickInput.getByRole("option").evaluateAll((options) =>
        options.map((candidate) => ({
          label: candidate.getAttribute("aria-label"),
          className: candidate.getAttribute("class")
        }))
      ),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "import-option diagnostics"
    );
  } catch {
    return "unavailable within the diagnostics deadline";
  }
}

type ImportFocusRelationship = "contains" | "exact";

async function waitForImportNaturalKeyboardFocus(
  target: Locator,
  title: string,
  relationship: ImportFocusRelationship
): Promise<void> {
  const focused = await withAcceptanceOperationDeadline(
    pollAcceptanceCondition(
      () =>
        target.evaluate(
          (element, expectedRelationship) => {
            const activeElement = element.ownerDocument.activeElement;
            return expectedRelationship === "exact" ? element === activeElement : element.contains(activeElement);
          },
          relationship,
          { timeout: IMPORT_FOCUS_PROBE_TIMEOUT_MS }
        ),
      {
        timeoutMs: IMPORT_FOCUS_POLL_TIMEOUT_MS,
        intervalMs: IMPORT_FOCUS_POLL_INTERVAL_MS
      }
    ),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${title} natural keyboard focus`
  );
  if (focused) return;

  const diagnostics = await boundedImportFocusDiagnostics(target, relationship);
  throw new Error(
    `${title} did not naturally receive keyboard focus within ${IMPORT_FOCUS_POLL_TIMEOUT_MS} ms. ` +
      `Structural focus diagnostics: ${JSON.stringify(diagnostics)}`
  );
}

async function boundedImportFocusDiagnostics(target: Locator, relationship: ImportFocusRelationship): Promise<unknown> {
  try {
    return await withAcceptanceOperationDeadline(
      target.evaluate(
        (element, expectedRelationship) => {
          const activeElement = element.ownerDocument.activeElement;
          return {
            targetConnected: element.isConnected,
            targetOwnsFocus:
              expectedRelationship === "exact" ? element === activeElement : element.contains(activeElement),
            activeElement:
              activeElement === null
                ? null
                : {
                    tagName: activeElement.tagName.slice(0, 32),
                    role: activeElement.getAttribute("role")?.slice(0, 64) ?? null,
                    classTokens: Array.from(activeElement.classList as ArrayLike<string>)
                      .slice(0, 8)
                      .map((token) => token.slice(0, 64))
                  }
          };
        },
        relationship,
        { timeout: WORKBENCH_DIAGNOSTIC_TIMEOUT_MS }
      ),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "import focus diagnostics"
    );
  } catch {
    return "unavailable within the diagnostics deadline";
  }
}

async function waitForImportQuickInput(
  page: Page,
  testing: TestApi,
  expectedSource: vscode.Uri,
  title: string,
  existingSessionId?: string
): Promise<Locator> {
  const quickInput = page.locator(".quick-input-widget:visible").filter({ hasText: title }).last();
  const deadline = Date.now() + 10_000;
  do {
    if (
      await withAcceptanceOperationDeadline(
        quickInput.isVisible(),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        `${title} prompt visibility`
      )
    ) {
      return quickInput;
    }
    const active = testing.activeSession();
    if (active && active.sessionId !== existingSessionId) {
      throw new Error(
        `The import-options action created a dataframe session before the ${JSON.stringify(title)} prompt appeared. ` +
          `Expected source: ${JSON.stringify(expectedSource.fsPath)}. Actual source: ${JSON.stringify(active.metadata.source.path)}.`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  const compactText = (value: string): string => value.replace(/\s+/gu, " ").trim().slice(0, 1_000);
  const diagnostics = await boundedImportPromptDiagnostics(page);
  const hostInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const activeSession = testing.activeSession();
  throw new Error(
    `The ${JSON.stringify(title)} import prompt did not appear after the import-options action. ` +
      `Expected source: ${JSON.stringify(expectedSource.toString())}. ` +
      `Active host input: ${JSON.stringify(describeTabInput(hostInput))}. ` +
      `Active dataframe source: ${JSON.stringify(activeSession?.metadata.source.uri)}. ` +
      `Visible quick inputs: ${JSON.stringify(diagnostics.quickInputs.map(compactText))}. ` +
      `Notifications: ${JSON.stringify(diagnostics.notifications.map(compactText))}. ` +
      `Dialogs: ${JSON.stringify(diagnostics.dialogs.map(compactText))}. ` +
      `Active workbench tabs: ${JSON.stringify(diagnostics.activeTabs.map(compactText))}. ` +
      `Webview frames: ${JSON.stringify(diagnostics.frames)}.`
  );
}

interface ImportPromptDiagnostics {
  quickInputs: string[];
  notifications: string[];
  dialogs: string[];
  activeTabs: string[];
  frames: CustomEditorFrameDiagnostic[] | string;
}

async function boundedImportPromptDiagnostics(page: Page): Promise<ImportPromptDiagnostics> {
  const unavailable: ImportPromptDiagnostics = {
    quickInputs: [],
    notifications: [],
    dialogs: [],
    activeTabs: [],
    frames: "unavailable within the diagnostics deadline"
  };
  try {
    return await withAcceptanceOperationDeadline(
      Promise.all([
        page.locator(".quick-input-widget:visible").allInnerTexts(),
        page
          .locator(
            ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
          )
          .allInnerTexts(),
        page.locator(".monaco-dialog-box:visible").allInnerTexts(),
        page.locator(".part.editor .tabs-container .tab.active:visible").allInnerTexts(),
        inspectThirdPartyCustomEditorFrames(page)
      ]).then(([quickInputs, notifications, dialogs, activeTabs, frames]) => ({
        quickInputs: quickInputs.slice(0, 8),
        notifications: notifications.slice(0, 8),
        dialogs: dialogs.slice(0, 8),
        activeTabs: activeTabs.slice(0, 8),
        frames
      })),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "import-prompt diagnostics"
    );
  } catch {
    return unavailable;
  }
}

function describeTabInput(input: unknown): unknown {
  if (input instanceof vscode.TabInputText) return { kind: "text", uri: input.uri.toString() };
  if (input instanceof vscode.TabInputTextDiff) {
    return { kind: "textDiff", original: input.original.toString(), modified: input.modified.toString() };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { kind: "custom", viewType: input.viewType, uri: input.uri.toString() };
  }
  return input === undefined ? undefined : { kind: typeof input };
}

let editorWorkbenchPage: Promise<Page> | undefined;

async function connectToEditorWorkbench(): Promise<Page> {
  editorWorkbenchPage ??= connectToEditorWorkbenchOnce();
  return editorWorkbenchPage;
}

async function connectToEditorWorkbenchOnce(): Promise<Page> {
  const cdpPort = Number(process.env.OPEN_WRANGLER_EDITOR_CDP_PORT);
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, "Editor workbench interaction requires a CDP port.");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const page of pages) {
    if ((await page.locator(".monaco-workbench").count()) > 0) return page;
  }
  const workbench = pages.find((page) => page.url().includes("workbench"));
  assert.ok(workbench, "The editor CDP endpoint must expose its workbench page.");
  return workbench;
}

async function waitForVisibleEditorDialog(workbench: Page, text: string): Promise<{ page: Page; dialog: Locator }> {
  const deadline = Date.now() + 10_000;
  do {
    const browser = workbench.context().browser();
    const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
    for (const page of pages) {
      const dialog = page.locator(".monaco-dialog-box:visible").filter({ hasText: text }).last();
      if ((await dialog.count()) > 0 && (await dialog.isVisible())) return { page, dialog };
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  const diagnostics = await Promise.all(
    pages.map(async (page) => ({
      url: page.url(),
      title: await page.title().catch(() => ""),
      dialogs: await page.locator(".monaco-dialog-box:visible").allInnerTexts()
    }))
  );
  throw new Error(
    `Timed out waiting for the real editor dialog containing ${JSON.stringify(text)}: ${JSON.stringify(diagnostics)}`
  );
}

async function captureWorkbenchScreenshot(page: Page, destination: string, maximumHeight?: number): Promise<void> {
  if (
    maximumHeight !== undefined &&
    (!Number.isSafeInteger(maximumHeight) || maximumHeight < 1 || maximumHeight > PACKAGED_SCREENSHOT_VIEWPORT.height)
  ) {
    throw new TypeError("A workbench screenshot maximum height must be one bounded positive integer.");
  }
  await page.bringToFront();
  const viewport = await page.evaluate(() => {
    const pageWindow = globalThis as unknown as {
      innerWidth: number;
      innerHeight: number;
      devicePixelRatio: number;
    };
    return {
      width: pageWindow.innerWidth,
      height: pageWindow.innerHeight,
      scale: Math.max(1, pageWindow.devicePixelRatio)
    };
  });
  const workbenchOffsets: number[] = [];
  for (const selector of [".monaco-workbench", ".part.sidebar", ".part.editor", ".part.activitybar"]) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    const bounds = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (bounds && bounds.y > 0) workbenchOffsets.push(bounds.y);
  }
  const screenshotWidth = Math.ceil(viewport.width * viewport.scale);
  const screenshotHeight = Math.ceil(viewport.height * viewport.scale);
  const titleBarHeight = Math.ceil(Math.min(...workbenchOffsets, Number.POSITIVE_INFINITY) * viewport.scale);
  const screenshotOptions = {
    path: destination,
    animations: "disabled" as const,
    timeout: 60_000,
    ...(Number.isFinite(titleBarHeight) && titleBarHeight > 0 && titleBarHeight < viewport.height
      ? {
          clip: {
            x: 0,
            y: titleBarHeight,
            width: screenshotWidth,
            height: Math.min(screenshotHeight - titleBarHeight, maximumHeight ?? Number.POSITIVE_INFINITY)
          }
        }
      : {})
  };
  try {
    await page.screenshot(screenshotOptions);
  } catch (error) {
    await page.bringToFront();
    await page.waitForTimeout(500);
    try {
      await page.screenshot(screenshotOptions);
    } catch {
      throw error;
    }
  }
  const image = readFileSync(destination);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
}

async function prepareReleasedJupyterScreenshotWorkbench(
  workbench: Page,
  notebook: vscode.NotebookDocument,
  editor: vscode.NotebookEditor
): Promise<() => Promise<void>> {
  if (process.platform !== "linux") return async () => {};
  const previousViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  const previousThemeKind = vscode.window.activeColorTheme.kind;
  await workbench.setViewportSize(PACKAGED_PANDAS_NOTEBOOK_VIEWPORT);
  const viewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  assert.deepEqual(
    viewport,
    PACKAGED_PANDAS_NOTEBOOK_VIEWPORT,
    "Notebook README evidence requires the deterministic packaged-editor viewport."
  );

  const workbenchConfiguration = vscode.workspace.getConfiguration("workbench");
  const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const settings = [
    { configuration: windowConfiguration, key: "autoDetectColorScheme" },
    { configuration: windowConfiguration, key: "autoDetectHighContrast" },
    { configuration: windowConfiguration, key: "commandCenter" },
    { configuration: windowConfiguration, key: "title" },
    { configuration: workbenchConfiguration, key: "colorTheme" },
    { configuration: workbenchConfiguration, key: "statusBar.visible" },
    { configuration: breadcrumbs, key: "enabled" }
  ] as const;
  const previousSettings = settings.map(({ configuration, key }) => ({
    configuration,
    key,
    value: configuration.inspect(key)?.globalValue
  }));
  await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
  await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
  await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
  await windowConfiguration.update(
    "title",
    "${activeEditorShort}${separator}Open Wrangler",
    vscode.ConfigurationTarget.Global
  );
  await workbenchConfiguration.update(
    "colorTheme",
    releasedJupyterScreenshotTheme(),
    vscode.ConfigurationTarget.Global
  );
  await workbenchConfiguration.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
  await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
  await waitFor(
    () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
    10_000,
    "the dark notebook screenshot theme"
  );

  await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
    "workbench.action.closeSidebar",
    "workbench.action.toggleSidebarVisibility"
  ]);
  await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.toggleAuxiliaryBar"
  ]);
  await closeVisibleWorkbenchPart(workbench, ".part.panel", [
    "workbench.action.closePanel",
    "workbench.action.togglePanel"
  ]);
  await clearReleasedJupyterScreenshotTransientUi(workbench);
  const visibleEditor = await showExactReleasedNotebook(notebook);
  assert.equal(visibleEditor, editor, "Notebook screenshot preparation must retain the exact originating editor.");
  const renderedCell = new vscode.NotebookRange(1, 2);
  editor.selection = renderedCell;
  editor.selections = [renderedCell];
  editor.revealRange(renderedCell, vscode.NotebookEditorRevealType.AtTop);
  await workbench.waitForTimeout(600);
  return async () => {
    for (const { configuration, key, value } of previousSettings.reverse()) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await workbench.setViewportSize(previousViewport);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === previousThemeKind,
      10_000,
      "the notebook workbench to restore its prior color theme"
    );
    await workbench.waitForTimeout(1_000);
  };
}

async function captureReleasedJupyterPandasPreview(
  workbench: Page,
  rendererButton: NotebookRendererButton,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  assert.equal(path.isAbsolute(outputDirectory), true, "Notebook screenshot output must be one absolute directory.");
  const preview = await rendererButton.evaluate((element) => {
    type PreviewElement = {
      readonly textContent: string | null;
      closest(selector: string): PreviewElement | null;
      getBoundingClientRect(): { width: number; height: number };
      querySelector(selector: string): PreviewElement | null;
      querySelectorAll(selector: string): ArrayLike<PreviewElement>;
    };
    const button = element as PreviewElement;
    const section = button.closest("section.openwrangler-notebook");
    if (!section) return null;
    const bounds = section.getBoundingClientRect();
    return {
      title: section.querySelector("header > span")?.textContent?.trim() ?? "",
      headers: Array.from(section.querySelectorAll("thead th"), (header) => header.textContent?.trim() ?? ""),
      rows: section.querySelectorAll("tbody tr").length,
      width: bounds.width,
      height: bounds.height
    };
  });
  assert.ok(preview, "The Pandas notebook action must remain inside its exact rendered preview.");
  assert.deepEqual(preview, {
    title: "Open Wrangler preview: orders_df (pandas) - 100000 x 15",
    headers: [
      "order_id",
      "market",
      "revenue",
      "fulfilled",
      "order_date",
      "segment",
      "channel",
      "product_family",
      "units",
      "unit_price",
      "discount_pct",
      "gross_margin",
      "priority",
      "renewal_date",
      "account_status"
    ],
    rows: 20,
    width: preview?.width,
    height: preview?.height
  });
  assert.ok(
    preview.width > 0 && preview.height > 0,
    `The Pandas notebook preview must be fully laid out: ${JSON.stringify({
      width: preview.width,
      height: preview.height
    })}`
  );
  await clearReleasedJupyterScreenshotTransientUi(workbench);
  mkdirSync(outputDirectory, { recursive: true });
  recordAcceptanceProgress("jupyter-allow:screenshot:pandas");
  const destination = path.resolve(
    outputDirectory,
    packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-pandas", "dark")
  );
  await captureWorkbenchScreenshot(workbench, destination, PACKAGED_PANDAS_NOTEBOOK_OUTPUT.height);
  const screenshot = readFileSync(destination);
  assert.equal(
    screenshot.readUInt32BE(16),
    PACKAGED_PANDAS_NOTEBOOK_OUTPUT.width,
    "The Pandas README screenshot must retain its dedicated readable width."
  );
  assert.equal(
    screenshot.readUInt32BE(20),
    PACKAGED_PANDAS_NOTEBOOK_OUTPUT.height,
    "The Pandas README screenshot must retain its dedicated readable height."
  );
}

async function captureReleasedJupyterPolarsDraft(
  workbench: Page,
  testing: TestApi,
  sessionId: string,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  await workbench.setViewportSize(PACKAGED_SCREENSHOT_VIEWPORT);
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId, "The Polars notebook screenshot requires the exact live session.");
  assert.ok(active, "The Polars notebook screenshot requires one active dataframe session.");
  assert.equal(active.metadata.backend, "polars");
  assert.equal(active.metadata.source.kind, "notebookVariable");
  assert.equal(active.metadata.source.variableName, "polars_frame");
  assert.equal(active.metadata.draftStep?.id, "released-jupyter-double");

  const doubleUnits = columnReference(active.metadata, "double_units");
  const baselineWidths = Object.fromEntries(active.metadata.schema.map((column) => [column.id, 230]));
  const doubleUnitsPosition = active.metadata.schema.findIndex((column) => column.id === doubleUnits.id);
  assert.ok(doubleUnitsPosition >= 0, "The Polars notebook screenshot requires the draft output column.");
  await testing.updateViewState(sessionId, {
    ...active.viewState,
    columnWidths: baselineWidths,
    selectedColumnId: columnReference(active.metadata, "units").id,
    viewport: { firstVisibleRow: 0, scrollLeft: 0 }
  });
  assert.equal(await testing.synchronizePanel(sessionId), true);
  await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
    "workbench.action.closeSidebar",
    "workbench.action.toggleSidebarVisibility"
  ]);
  await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
    "workbench.action.closeAuxiliaryBar",
    "workbench.action.toggleAuxiliaryBar"
  ]);
  await vscode.commands.executeCommand("openWrangler.codePreview.focus");
  const panel = workbench.locator(".part.panel:visible").first();
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    await panel.getByText("Code Preview", { exact: true }).count(),
    1,
    "The Polars notebook screenshot must open the Code Preview panel."
  );
  const codePreview = await waitForCodePreview(workbench, "double_units");
  const codeText = await codePreview.innerText();
  assert.ok(codeText.includes("import polars as pl"), "The Polars notebook screenshot must show its native import.");
  assert.ok(
    codeText.includes("pl.col('units') * pl.lit(2)"),
    "The Polars notebook screenshot must show its native formula expression."
  );
  assert.ok(
    codeText.includes(".alias('double_units')"),
    "The Polars notebook screenshot must show the generated output alias."
  );
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The Polars notebook screenshot requires the exact live Open Wrangler renderer.");
  const backendBadge = app.locator(".backendBadge").first();
  await backendBadge.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await backendBadge.innerText()).trim(), "POLARS");
  await app.getByRole("button", { name: "Apply step" }).waitFor({ state: "visible", timeout: 10_000 });
  await app.getByRole("button", { name: "Discard" }).waitFor({ state: "visible", timeout: 10_000 });
  const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });
  await columnSearch.fill("double_units");
  await app.getByRole("option", { name: /^double_units,/u }).waitFor({ state: "visible", timeout: 10_000 });
  await columnSearch.press("Enter");
  await waitFor(
    () => testing.activeSession()?.viewState.selectedColumnId === doubleUnits.id,
    10_000,
    "the Polars notebook screenshot to navigate to its computed draft column"
  );
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The Polars notebook screenshot must synchronize after navigating to the draft column."
  );
  const headerProfiles = app.getByRole("button", { name: "Header profiles", exact: true });
  await headerProfiles.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await headerProfiles.getAttribute("aria-pressed"), "true");
  await headerProfiles.click();
  assert.equal(await headerProfiles.getAttribute("aria-pressed"), "false");

  const firstVisibleColumn = columnReference(active.metadata, "product_family");
  const firstVisibleColumnPosition = active.metadata.schema.findIndex((column) => column.id === firstVisibleColumn.id);
  assert.ok(
    firstVisibleColumnPosition >= 0 && firstVisibleColumnPosition < doubleUnitsPosition,
    "The Polars notebook screenshot requires product_family before its computed draft output."
  );
  assert.equal(
    doubleUnitsPosition,
    active.metadata.schema.length - 1,
    "The Polars notebook screenshot requires the computed draft output to remain the final column."
  );
  const gridScroller = app.getByTestId("data-grid-scroller");
  const measuredGrid = await gridScroller.evaluate((element) => {
    const scroller = element as {
      clientWidth: number;
      querySelector(selector: string): { getBoundingClientRect(): { width: number } } | null;
    };
    const rowHeader = scroller.querySelector("th.rowHeader");
    return {
      clientWidth: scroller.clientWidth,
      rowHeaderWidth: rowHeader?.getBoundingClientRect().width ?? 0
    };
  });
  const rowHeaderWidth = Math.round(measuredGrid.rowHeaderWidth);
  const visibleDataWidth = measuredGrid.clientWidth - rowHeaderWidth;
  const visibleColumnCount = doubleUnitsPosition - firstVisibleColumnPosition + 1;
  const alignedBaseWidth = Math.floor(visibleDataWidth / visibleColumnCount);
  const alignedWidthRemainder = visibleDataWidth % visibleColumnCount;
  assert.ok(
    Number.isSafeInteger(visibleDataWidth) &&
      visibleDataWidth > 0 &&
      rowHeaderWidth > 0 &&
      alignedBaseWidth >= 80 &&
      alignedBaseWidth + Number(alignedWidthRemainder > 0) <= 640,
    `The native Polars grid cannot fit its complete gallery suffix: ${JSON.stringify({
      ...measuredGrid,
      rowHeaderWidth,
      visibleDataWidth,
      visibleColumnCount,
      alignedBaseWidth,
      alignedWidthRemainder
    })}`
  );
  const alignedWidths = Object.fromEntries(
    active.metadata.schema.map((column) => {
      if (column.position < firstVisibleColumnPosition) return [column.id, 230];
      const visiblePosition = column.position - firstVisibleColumnPosition;
      return [column.id, alignedBaseWidth + Number(visiblePosition < alignedWidthRemainder)];
    })
  );
  const alignedScrollLeft = active.metadata.schema
    .slice(0, firstVisibleColumnPosition)
    .reduce((total, column) => total + (alignedWidths[column.id] ?? 0), 0);
  const alignedViewState = testing.activeSession()?.viewState;
  assert.ok(alignedViewState, "The Polars notebook screenshot requires its confirmed presentation state.");
  await testing.updateViewState(sessionId, {
    ...alignedViewState,
    columnWidths: alignedWidths,
    selectedColumnId: doubleUnits.id,
    viewport: { firstVisibleRow: 0, scrollLeft: alignedScrollLeft }
  });
  assert.equal(
    await testing.synchronizePanel(sessionId),
    true,
    "The Polars notebook screenshot must synchronize its column-aligned gallery viewport."
  );

  const addedCells = app.locator(`td[data-grid-column="${doubleUnitsPosition}"][data-grid-row]`);
  await addedCells.nth(5).waitFor({ state: "visible", timeout: 10_000 });
  assert.deepEqual(
    (await addedCells.allInnerTexts()).slice(0, 6).map((value) => value.trim()),
    ["6", "20", "10", "24", "14", "4"],
    "The Polars notebook screenshot page must contain six computed draft values."
  );
  assert.deepEqual(
    await Promise.all(Array.from({ length: 6 }, (_, index) => addedCells.nth(index).getAttribute("data-diff-state"))),
    Array(6).fill("added"),
    "The computed Polars draft values must retain their added-column diff state."
  );
  const gridViewport = await gridScroller.boundingBox();
  assert.ok(gridViewport, "The Polars notebook screenshot requires a measurable grid viewport.");
  const rowHeader = await app.locator("th.rowHeader").first().boundingBox();
  const firstVisibleHeader = await app.locator('th[data-column="product_family"]').boundingBox();
  const precedingHeader = await app.locator('th[data-column="channel"]').boundingBox();
  const doubleUnitsHeader = await app.locator('th[data-column="double_units"]').boundingBox();
  assert.ok(rowHeader, "The Polars notebook screenshot requires a measurable row header.");
  assert.ok(firstVisibleHeader, "The first visible Polars data column must have measurable geometry.");
  assert.ok(doubleUnitsHeader, "The computed Polars draft header must have measurable geometry.");
  const dataViewportLeft = rowHeader.x + rowHeader.width;
  const gridViewportRight = gridViewport.x + gridViewport.width;
  assert.ok(
    Math.abs(firstVisibleHeader.x - dataViewportLeft) <= 1,
    "The Polars notebook screenshot must begin at the complete product_family column boundary."
  );
  assert.ok(
    !precedingHeader || precedingHeader.x + precedingHeader.width <= dataViewportLeft + 1,
    "No partially visible data column may remain to the left of product_family in the Polars screenshot."
  );
  assert.ok(
    doubleUnitsHeader.x >= dataViewportLeft - 1 &&
      doubleUnitsHeader.x + doubleUnitsHeader.width <= gridViewportRight + 1,
    "The complete computed double_units header must remain inside the Polars screenshot viewport."
  );
  for (let index = 0; index < 3; index += 1) {
    const cell = await addedCells.nth(index).boundingBox();
    assert.ok(cell, `Computed Polars draft row ${index + 1} must have measurable geometry.`);
    assert.ok(
      cell.x >= gridViewport.x &&
        cell.y >= gridViewport.y &&
        cell.x + cell.width <= gridViewport.x + gridViewport.width &&
        cell.y + cell.height <= gridViewport.y + gridViewport.height,
      `Computed Polars draft row ${index + 1} must be fully inside the captured grid viewport.`
    );
  }
  await vscode.commands.executeCommand("openWrangler.codePreview.focus");
  await codePreview.focus();
  await clearReleasedJupyterScreenshotTransientUi(workbench);
  assert.equal(
    testing.activeSession()?.metadata.draftStep?.id,
    "released-jupyter-double",
    "Screenshot cleanup must not discard the Polars draft."
  );
  mkdirSync(outputDirectory, { recursive: true });
  recordAcceptanceProgress("jupyter-allow:screenshot:polars");
  await captureWorkbenchScreenshot(
    workbench,
    path.resolve(
      outputDirectory,
      packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-polars", "dark")
    ),
    760
  );
  await workbench.setViewportSize({ width: 1_920, height: 1_080 });
  await workbench.waitForTimeout(500);
}

async function captureReleasedJupyterPySparkLive(
  workbench: Page,
  testing: TestApi,
  active: NonNullable<ReturnType<TestApi["activeSession"]>>,
  outputDirectory: string
): Promise<void> {
  if (process.platform !== "linux") return;
  assert.equal(path.isAbsolute(outputDirectory), true, "PySpark screenshot output must be one absolute directory.");
  assert.equal(active.metadata.backend, "pyspark");
  assert.equal(active.metadata.source.kind, "notebookVariable");
  assert.equal(active.metadata.source.variableName, "spark_orders_frame");
  assert.deepEqual(active.metadata.shape, { rows: 100_000, columns: 15 });

  const previousViewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  const previousThemeKind = vscode.window.activeColorTheme.kind;
  const workbenchConfiguration = vscode.workspace.getConfiguration("workbench");
  const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const settings = [
    { configuration: windowConfiguration, key: "autoDetectColorScheme" },
    { configuration: windowConfiguration, key: "autoDetectHighContrast" },
    { configuration: windowConfiguration, key: "commandCenter" },
    { configuration: windowConfiguration, key: "title" },
    { configuration: workbenchConfiguration, key: "colorTheme" },
    { configuration: workbenchConfiguration, key: "statusBar.visible" },
    { configuration: breadcrumbs, key: "enabled" }
  ] as const;
  const previousSettings = settings.map(({ configuration, key }) => ({
    configuration,
    key,
    value: configuration.inspect(key)?.globalValue
  }));

  try {
    await workbench.setViewportSize(PACKAGED_SCREENSHOT_VIEWPORT);
    await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "title",
      "${activeEditorShort}${separator}Open Wrangler",
      vscode.ConfigurationTarget.Global
    );
    await workbenchConfiguration.update(
      "colorTheme",
      releasedJupyterScreenshotTheme(),
      vscode.ConfigurationTarget.Global
    );
    await workbenchConfiguration.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
    await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
      10_000,
      "the dark PySpark notebook screenshot theme"
    );
    await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
    await closeVisibleWorkbenchPart(workbench, ".part.auxiliarybar", [
      "workbench.action.closeAuxiliaryBar",
      "workbench.action.toggleAuxiliaryBar"
    ]);
    await closeVisibleWorkbenchPart(workbench, ".part.panel", [
      "workbench.action.closePanel",
      "workbench.action.togglePanel"
    ]);
    await clearReleasedJupyterScreenshotTransientUi(workbench);

    const selectedColumn = columnReference(active.metadata, "revenue");
    const baselineColumnWidths = Object.fromEntries(
      active.metadata.schema.map((column) => [
        column.id,
        ["order_id", "market", "revenue", "fulfilled", "order_date"].includes(column.name)
          ? 204
          : ["segment", "channel"].includes(column.name)
            ? 197
            : 170
      ])
    );
    await testing.updateViewState(active.sessionId, {
      ...active.viewState,
      columnWidths: baselineColumnWidths,
      selectedColumnId: selectedColumn.id,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(await testing.synchronizePanel(active.sessionId), true);

    const target = await waitForOpenWranglerGridTarget(workbench, testing, active.sessionId);
    const app = await exactSessionApp(target.frame, active.sessionId);
    assert.ok(app, "The PySpark screenshot requires the exact live Open Wrangler renderer.");
    const backendBadge = app.locator(".backendBadge").first();
    await backendBadge.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal((await backendBadge.innerText()).trim().toUpperCase(), "PYSPARK");
    const experimentalBadge = app.locator(".experimentalBadge").first();
    const modeBadge = app.locator(".modeBadge").first();
    assert.equal((await experimentalBadge.innerText()).trim(), "EXPERIMENTAL");
    assert.equal((await modeBadge.innerText()).trim(), "VIEWING ONLY");
    const toolbarBox = await app.locator(".toolbar").boundingBox();
    const badgeBoxes = await Promise.all([
      experimentalBadge.boundingBox(),
      modeBadge.boundingBox(),
      backendBadge.boundingBox()
    ]);
    assert.ok(toolbarBox, "The PySpark media scene requires a measurable workbench toolbar.");
    assert.ok(
      badgeBoxes.every(
        (badge) =>
          badge !== null && badge.x >= toolbarBox.x && badge.x + badge.width <= toolbarBox.x + toolbarBox.width + 1
      ),
      "The PySpark engine, maturity, and viewing-only badges must remain fully inside the workbench toolbar."
    );
    assert.equal(await app.getByRole("button", { name: "Add step" }).count(), 0);
    assert.equal(await app.getByRole("button", { name: "Apply step" }).count(), 0);

    const insightsToggle = app.getByRole("button", { name: "Column profiles and filters" });
    if ((await insightsToggle.getAttribute("aria-expanded")) !== "true") await insightsToggle.click();
    const drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("heading", { name: "revenue" }).waitFor({ state: "visible", timeout: 10_000 });
    const insightsDeadline = Date.now() + 60_000;
    let insightsReady = false;
    let summary = "";
    while (Date.now() < insightsDeadline) {
      summary = await drawer.innerText();
      if (
        summary.includes("Rows\n100,000") &&
        !summary.includes("Profiling selected column") &&
        ["Min", "Max", "Mean", "Median"].every((label) => new RegExp(`\\b${label}\\b`, "u").test(summary))
      ) {
        insightsReady = true;
        break;
      }
      await workbench.waitForTimeout(50);
    }
    if (!insightsReady) {
      throw new Error(`PySpark selected-column Insights did not finish: ${JSON.stringify(summary.slice(0, 2_000))}`);
    }

    const featuredColumns = ["order_id", "market", "revenue", "fulfilled", "order_date", "segment", "channel"];
    assert.deepEqual(
      active.metadata.schema.slice(0, featuredColumns.length).map((column) => column.name),
      featuredColumns,
      "The PySpark media scene requires its featured columns to remain the schema prefix."
    );
    const gridScroller = app.getByTestId("data-grid-scroller");
    const measuredGrid = await gridScroller.evaluate((element) => {
      const scroller = element as {
        clientWidth: number;
        querySelector(selector: string): { getBoundingClientRect(): { width: number } } | null;
      };
      const rowHeader = scroller.querySelector("th.rowHeader");
      return {
        clientWidth: scroller.clientWidth,
        rowHeaderWidth: rowHeader?.getBoundingClientRect().width ?? 0
      };
    });
    const rowHeaderWidth = Math.round(measuredGrid.rowHeaderWidth);
    const featuredDataWidth = measuredGrid.clientWidth - rowHeaderWidth;
    const featuredBaseWidth = Math.floor(featuredDataWidth / featuredColumns.length);
    const featuredWidthRemainder = featuredDataWidth % featuredColumns.length;
    assert.ok(
      Number.isSafeInteger(featuredDataWidth) &&
        featuredDataWidth > 0 &&
        rowHeaderWidth > 0 &&
        featuredBaseWidth >= 80 &&
        featuredBaseWidth + Number(featuredWidthRemainder > 0) <= 640,
      `The native PySpark grid cannot fit its complete featured prefix: ${JSON.stringify({
        ...measuredGrid,
        rowHeaderWidth,
        featuredDataWidth,
        featuredBaseWidth,
        featuredWidthRemainder
      })}`
    );
    const alignedColumnWidths = Object.fromEntries(
      active.metadata.schema.map((column) => [
        column.id,
        column.position < featuredColumns.length
          ? featuredBaseWidth + Number(column.position < featuredWidthRemainder)
          : 170
      ])
    );
    const confirmedViewState = testing.activeSession()?.viewState;
    assert.ok(confirmedViewState, "The PySpark media scene requires its confirmed presentation state.");
    await testing.updateViewState(active.sessionId, {
      ...confirmedViewState,
      columnWidths: alignedColumnWidths,
      selectedColumnId: selectedColumn.id,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(
      await testing.synchronizePanel(active.sessionId),
      true,
      "The PySpark media scene must synchronize its exact featured-column fit."
    );
    const channelColumn = columnReference(active.metadata, "channel");
    const firstPassGridBox = await gridScroller.boundingBox();
    const firstPassChannelBox = await app.locator('th[data-column="channel"]').boundingBox();
    assert.ok(firstPassGridBox, "The first PySpark media fit requires a measurable grid viewport.");
    assert.ok(firstPassChannelBox, "The first PySpark media fit requires a measurable channel header.");
    const widthCorrection = Math.round(
      firstPassGridBox.x + firstPassGridBox.width - (firstPassChannelBox.x + firstPassChannelBox.width)
    );
    if (Math.abs(widthCorrection) > 1) {
      const correctedChannelWidth = alignedColumnWidths[channelColumn.id] + widthCorrection;
      assert.ok(
        correctedChannelWidth >= 80 && correctedChannelWidth <= 640,
        `The native PySpark grid produced an invalid final-column correction: ${JSON.stringify({
          widthCorrection,
          correctedChannelWidth
        })}`
      );
      const correctedViewState = testing.activeSession()?.viewState;
      assert.ok(correctedViewState, "The PySpark media correction requires its confirmed presentation state.");
      await testing.updateViewState(active.sessionId, {
        ...correctedViewState,
        columnWidths: { ...alignedColumnWidths, [channelColumn.id]: correctedChannelWidth },
        selectedColumnId: selectedColumn.id,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      });
      assert.equal(
        await testing.synchronizePanel(active.sessionId),
        true,
        "The PySpark media scene must synchronize its native final-column correction."
      );
    }

    const headerProfiles = app.getByRole("button", { name: "Header profiles", exact: true });
    assert.equal(
      await headerProfiles.getAttribute("aria-pressed"),
      "false",
      "The PySpark media scene must not enable multi-column grid profiling."
    );
    assert.equal(
      await headerProfiles.getAttribute("title"),
      "Runs Spark profiling queries for the visible columns.",
      "The PySpark header-profile toggle must retain its explicit cost warning."
    );
    const loadedRows = app.getByRole("status", { name: "Visible rows" });
    assert.equal(await loadedRows.count(), 1, "The PySpark media scene must expose one visible-row status.");
    assert.match(
      (await loadedRows.innerText()).trim(),
      /^Rows 1\u2013\d+ of 100,000$/u,
      "The PySpark media scene must show the live 100,000-row source."
    );
    const gridBox = await gridScroller.boundingBox();
    const rowHeaderBox = await app.locator("th.rowHeader").first().boundingBox();
    const orderIdBox = await app.locator('th[data-column="order_id"]').boundingBox();
    const channelBox = await app.locator('th[data-column="channel"]').boundingBox();
    assert.ok(gridBox, "The PySpark media scene requires a measurable grid viewport.");
    assert.ok(rowHeaderBox, "The PySpark media scene requires a measurable row header.");
    assert.ok(orderIdBox, "The PySpark media scene requires the complete order_id header.");
    assert.ok(channelBox, "The PySpark media scene requires the complete channel header.");
    const dataViewportLeft = rowHeaderBox.x + rowHeaderBox.width;
    const gridRight = gridBox.x + gridBox.width;
    const channelRight = channelBox.x + channelBox.width;
    assert.ok(
      Math.abs(orderIdBox.x - dataViewportLeft) <= 1,
      "The PySpark media scene must begin cleanly at the complete order_id column."
    );
    assert.ok(
      Math.abs(gridRight - channelRight) <= 1,
      "The PySpark media scene must end cleanly after the complete channel column."
    );
    const nextColumnBox = await app.locator('th[data-column="product_family"]').boundingBox();
    assert.ok(
      !nextColumnBox || nextColumnBox.x >= gridRight,
      "The PySpark media scene must not show a clipped product_family column."
    );

    const commands = new Set(await vscode.commands.getCommands(true));
    if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
    if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
    await workbench.mouse.move(Math.floor(PACKAGED_SCREENSHOT_VIEWPORT.width * 0.75), 40);
    await workbench.waitForTimeout(500);
    const transient = await workbench
      .locator(
        ".quick-input-widget:visible, .monaco-dialog-box:visible, .context-view.monaco-menu-container:visible, " +
          ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible, " +
          ".monaco-hover:visible"
      )
      .allInnerTexts();
    assert.deepEqual(
      transient.map((text) => text.replace(/\s+/gu, " ").trim().slice(0, 500)),
      [],
      "PySpark screenshot capture must not retain transient workbench UI."
    );

    mkdirSync(outputDirectory, { recursive: true });
    recordAcceptanceProgress("jupyter-pyspark:screenshot:classic");
    await captureWorkbenchScreenshot(
      workbench,
      path.resolve(
        outputDirectory,
        packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-pyspark", "dark")
      ),
      640
    );
  } finally {
    for (const { configuration, key, value } of previousSettings.reverse()) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await workbench.setViewportSize(previousViewport);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === previousThemeKind,
      10_000,
      "the PySpark notebook workbench to restore its prior color theme"
    );
    await workbench.waitForTimeout(500);
  }
}

async function waitForCodePreview(workbench: Page, expectedCode: string): Promise<Locator> {
  const deadline = Date.now() + 10_000;
  do {
    for (const frame of workbench.frames()) {
      const content = frame.locator('[aria-label="Editable generated Python code preview"]');
      if ((await content.count()) === 0 || !(await content.isVisible().catch(() => false))) continue;
      if ((await content.innerText().catch(() => "")).includes(expectedCode)) return content;
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`The generated code preview did not expose ${JSON.stringify(expectedCode)}.`);
}

async function closeVisibleWorkbenchPart(
  workbench: Page,
  selector: string,
  commandCandidates: readonly string[]
): Promise<void> {
  const part = workbench.locator(selector).first();
  if ((await part.count()) === 0 || !(await part.isVisible())) return;
  const commands = new Set(await vscode.commands.getCommands(true));
  const command = commandCandidates.find((candidate) => commands.has(candidate));
  assert.ok(command, `The screenshot workbench cannot close visible part ${selector}.`);
  await vscode.commands.executeCommand(command);
  await part.waitFor({ state: "hidden", timeout: 10_000 });
}

async function clearReleasedJupyterScreenshotTransientUi(workbench: Page): Promise<void> {
  const commands = new Set(await vscode.commands.getCommands(true));
  if (commands.has("notifications.clearAll")) await vscode.commands.executeCommand("notifications.clearAll");
  if (commands.has("notifications.hideList")) await vscode.commands.executeCommand("notifications.hideList");
  await workbench.keyboard.press("Escape");
  await workbench.mouse.move(Math.floor(PACKAGED_SCREENSHOT_VIEWPORT.width * 0.75), 40);
  assert.equal(
    await pollAcceptanceCondition(async () => (await workbench.locator(".monaco-hover:visible").count()) === 0, {
      timeoutMs: 3_000,
      intervalMs: 50
    }),
    true,
    "Notebook screenshot capture must dismiss every workbench hover."
  );
  const transientUi = workbench.locator(
    ".quick-input-widget:visible, .monaco-dialog-box:visible, .context-view.monaco-menu-container:visible, " +
      ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
  );
  await pollAcceptanceCondition(async () => (await transientUi.count()) === 0, {
    timeoutMs: 3_000,
    intervalMs: 50
  });
  const transient = await transientUi.allInnerTexts();
  assert.deepEqual(
    transient.map((text) => text.replace(/\s+/gu, " ").trim().slice(0, 500)),
    [],
    "Notebook screenshot capture must not retain transient workbench UI."
  );
}

function releasedJupyterScreenshotTheme(): string {
  return "Default Dark Modern";
}

async function capturePackagedEditorScreenshots(testing: TestApi, outputDirectory: string): Promise<void> {
  if (process.platform !== "linux") return;
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-screenshot-evidence-"));
  const fixture = vscode.Uri.file(path.join(fixtureDirectory, "regional-orders-2024-2025.csv"));
  writeFileSync(fixture.fsPath, packagedScreenshotFixtureCsv(), { encoding: "utf8", flag: "wx" });
  const workbench = vscode.workspace.getConfiguration("workbench");
  const breadcrumbs = vscode.workspace.getConfiguration("breadcrumbs");
  const windowConfiguration = vscode.workspace.getConfiguration("window");
  const scm = vscode.workspace.getConfiguration("scm");
  const typescript = vscode.workspace.getConfiguration("typescript");
  const javascript = vscode.workspace.getConfiguration("javascript");
  const originalTheme = workbench.get<string>("colorTheme");
  const originalStatusBarVisible = workbench.get<boolean>("statusBar.visible");
  const originalBreadcrumbsEnabled = breadcrumbs.get<boolean>("enabled");
  const originalZoom = windowConfiguration.get<number>("zoomLevel");
  const originalTitle = windowConfiguration.get<string>("title");
  const originalCommandCenter = windowConfiguration.get<boolean>("commandCenter");
  const originalAutoDetectColorScheme = windowConfiguration.get<boolean>("autoDetectColorScheme");
  const originalAutoDetectHighContrast = windowConfiguration.get<boolean>("autoDetectHighContrast");
  const originalScmCountBadge = scm.get<string>("countBadge");
  const originalTypescriptValidation = typescript.get<boolean>("validate.enable");
  const originalJavascriptValidation = javascript.get<boolean>("validate.enable");
  const editor = process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor";
  let capturePage: Page;
  try {
    capturePage = await connectToEditorWorkbench();
    await capturePage.setViewportSize(PACKAGED_SCREENSHOT_VIEWPORT);
    const captureViewport = await capturePage.evaluate(() => {
      const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
      return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
    });
    assert.deepEqual(
      captureViewport,
      PACKAGED_SCREENSHOT_VIEWPORT,
      `README evidence requires the deterministic ${PACKAGED_SCREENSHOT_VIEWPORT.width} by ${PACKAGED_SCREENSHOT_VIEWPORT.height} packaged-editor viewport.`
    );
    await prepareWorkbenchForEvidence();
    await hideCodePreviewPanel();
    await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
    recordAcceptanceProgress("verify:screenshots:open");
    mkdirSync(outputDirectory, { recursive: true });
    await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () => testing.activeSession()?.metadata.source.path === fixture.fsPath,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the custom editor before screenshot capture"
    );
    const opened = testing.activeSession();
    assert.ok(opened, "The screenshot fixture must publish one active session.");
    assert.deepEqual(opened.metadata.shape, {
      rows: PACKAGED_SCREENSHOT_ROW_COUNT,
      columns: PACKAGED_SCREENSHOT_COLUMNS.length
    });
    assert.deepEqual(opened.metadata.filterModel, { logic: "and", filters: [], sort: [] });
    assert.deepEqual(opened.metadata.steps, []);
    assert.equal(opened.metadata.draftStep, undefined);
    assert.deepEqual(opened.viewState, {
      filterModel: { logic: "and", filters: [], sort: [] },
      columnWidths: {},
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    await waitFor(
      () => testing.panelHydrated(opened.sessionId),
      OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
      "the screenshot fixture panel to hydrate"
    );
    assert.equal(
      await testing.synchronizePanel(opened.sessionId),
      true,
      "The clean screenshot fixture must publish its initial renderer snapshot."
    );
    const gridTarget = await waitForOpenWranglerGridTarget(capturePage, testing, opened.sessionId);
    const app = await exactSessionApp(gridTarget.frame, opened.sessionId);
    assert.ok(app, "The screenshot fixture must expose its exact live application root.");
    const revenue = columnReference(opened.metadata, "revenue");
    await testing.updateViewState(opened.sessionId, {
      ...opened.viewState,
      selectedColumnId: revenue.id
    });
    assert.equal(
      await testing.synchronizePanel(opened.sessionId),
      true,
      "The screenshot fixture must synchronize its selected revenue column."
    );
    assert.equal(testing.activeSession()?.viewState.selectedColumnId, revenue.id);
  } catch (error) {
    const active = testing.activeSession();
    if (active?.metadata.source.path === fixture.fsPath) {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        "the failed screenshot session and runtime to close"
      );
    }
    if (testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning()) {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  const darkTheme = contributedTheme("vs-dark", "Default Dark Modern");
  const lightTheme = contributedTheme("vs", "Default Light Modern");
  const highContrastTheme = contributedTheme("hc-black", "Default High Contrast");
  try {
    recordAcceptanceProgress("verify:screenshots:prepare");
    await workbench.update("statusBar.visible", false, vscode.ConfigurationTarget.Global);
    await breadcrumbs.update("enabled", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "title",
      "${activeEditorShort}${separator}Open Wrangler",
      vscode.ConfigurationTarget.Global
    );
    await windowConfiguration.update("commandCenter", false, vscode.ConfigurationTarget.Global);
    await scm.update("countBadge", "off", vscode.ConfigurationTarget.Global);
    await typescript.update("validate.enable", false, vscode.ConfigurationTarget.Global);
    await javascript.update("validate.enable", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectColorScheme", false, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("autoDetectHighContrast", false, vscode.ConfigurationTarget.Global);
    await prepareWorkbenchForEvidence();
    await hideCodePreviewPanel();
    const hero = testing.activeSession();
    assert.ok(hero, "The screenshot fixture must remain active while selected-column Insights is composed.");
    await closeVisibleWorkbenchPart(capturePage, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
    await openSelectedColumnInsights(hero.sessionId, "revenue");
    assert.equal(
      await testing.synchronizePanel(hero.sessionId),
      true,
      "Selected-column Insights must synchronize with the exact renderer."
    );
    await fitFeaturedGridColumns(hero.sessionId, columnReference(hero.metadata, "revenue").id);
    recordAcceptanceProgress("verify:screenshots:hero-dark");
    await captureTheme(
      darkTheme,
      vscode.ColorThemeKind.Dark,
      0,
      packagedScreenshotFileName(editor, "hero", "dark"),
      "hero"
    );
    recordAcceptanceProgress("verify:screenshots:hero-light");
    await captureTheme(
      lightTheme,
      vscode.ColorThemeKind.Light,
      0,
      packagedScreenshotFileName(editor, "hero", "light"),
      "hero"
    );
    recordAcceptanceProgress("verify:screenshots:high-contrast");
    await captureTheme(
      highContrastTheme,
      vscode.ColorThemeKind.HighContrast,
      4,
      `${editor}-high-contrast-zoom-200.png`,
      "responsive"
    );
    recordAcceptanceProgress("verify:screenshots:restore");
  } finally {
    await workbench.update("colorTheme", originalTheme, vscode.ConfigurationTarget.Global);
    await workbench.update("statusBar.visible", originalStatusBarVisible, vscode.ConfigurationTarget.Global);
    await breadcrumbs.update("enabled", originalBreadcrumbsEnabled, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("zoomLevel", originalZoom, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("title", originalTitle, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("commandCenter", originalCommandCenter, vscode.ConfigurationTarget.Global);
    await scm.update("countBadge", originalScmCountBadge, vscode.ConfigurationTarget.Global);
    await typescript.update("validate.enable", originalTypescriptValidation, vscode.ConfigurationTarget.Global);
    await javascript.update("validate.enable", originalJavascriptValidation, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update(
      "autoDetectColorScheme",
      originalAutoDetectColorScheme,
      vscode.ConfigurationTarget.Global
    );
    await windowConfiguration.update(
      "autoDetectHighContrast",
      originalAutoDetectHighContrast,
      vscode.ConfigurationTarget.Global
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the screenshot session and runtime to close"
    );
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
  recordAcceptanceProgress("verify:screenshots:complete");

  async function captureTheme(
    theme: string,
    expectedKind: vscode.ColorThemeKind,
    zoomLevel: number,
    fileName: string,
    scene?: "hero" | "responsive"
  ): Promise<void> {
    await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("zoomLevel", zoomLevel, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === expectedKind,
      10_000,
      `${theme} to activate before screenshot capture`
    );
    await clearNotifications();
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const destination = path.resolve(outputDirectory, fileName);
    await capturePage.bringToFront();
    const viewport = await capturePage.evaluate(() => {
      const pageWindow = globalThis as unknown as {
        innerWidth: number;
        innerHeight: number;
        devicePixelRatio: number;
      };
      return {
        width: pageWindow.innerWidth,
        height: pageWindow.innerHeight,
        scale: Math.max(1, pageWindow.devicePixelRatio)
      };
    });
    await capturePage.keyboard.press("Escape");
    await capturePage.mouse.move(Math.max(1, Math.floor(viewport.width * 0.75)), 40);
    await clearNotifications();
    assert.equal(
      await pollAcceptanceCondition(async () => (await capturePage.locator(".monaco-hover:visible").count()) === 0, {
        timeoutMs: 3_000,
        intervalMs: 50
      }),
      true,
      "Screenshot capture must dismiss every workbench hover."
    );
    const transientUi = await inspectCaptureTransientUi();
    assert.equal(
      transientUi.length,
      0,
      `A packaged screenshot must not contain transient workbench UI: ${JSON.stringify(transientUi)}`
    );
    if (scene === "hero") await assertPackagedScreenshotScene(scene);
    if (scene === "responsive") await assertResponsivePackagedControls();
    await captureWorkbenchScreenshot(capturePage, destination);
  }

  async function inspectCaptureTransientUi(): Promise<Array<{ kind: string; text: string }>> {
    const selectors = [
      ["hover", ".monaco-hover:visible"],
      ["quick input", ".quick-input-widget:visible"],
      ["dialog", ".monaco-dialog-box:visible"],
      ["menu", ".context-view.monaco-menu-container:visible"],
      [
        "notification",
        ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
      ]
    ] as const;
    const entries = await Promise.all(
      selectors.map(async ([kind, selector]) =>
        (await capturePage.locator(selector).allInnerTexts()).map((text) => ({
          kind,
          text: text.replace(/\s+/gu, " ").trim().slice(0, 500)
        }))
      )
    );
    return entries.flat();
  }

  async function fitFeaturedGridColumns(sessionId: string, selectedColumnId: string): Promise<Record<string, number>> {
    const active = testing.activeSession();
    assert.equal(active?.sessionId, sessionId, "Screenshot grid fitting requires the exact active session.");
    assert.ok(active, "Screenshot grid fitting requires one active dataframe session.");
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "Screenshot grid fitting requires the exact live Open Wrangler renderer.");
    const gridDimensions = await app.locator('[data-testid="data-grid-scroller"]').evaluate((scroller) => {
      const rowHeader = scroller.querySelector("th.rowHeader");
      if (!rowHeader) throw new Error("The screenshot grid row header is unavailable.");
      return {
        clientWidth: scroller.clientWidth,
        rowHeaderWidth: rowHeader.getBoundingClientRect().width
      };
    });
    const widthsByName = packagedScreenshotFeaturedColumnWidths(
      gridDimensions.clientWidth,
      gridDimensions.rowHeaderWidth
    );
    let columnWidths = Object.fromEntries(
      active.metadata.schema
        .filter((column) => column.name in widthsByName)
        .map((column) => [column.id, widthsByName[column.name as keyof typeof widthsByName]])
    );
    await testing.updateViewState(sessionId, {
      columnWidths,
      selectedColumnId,
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    });
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The fitted screenshot grid must synchronize with its exact renderer."
    );
    const orderDate = columnReference(active.metadata, "order_date");
    const trailingGap = await app.evaluate((root, columnName) => {
      type ScreenshotRect = { readonly right: number };
      type ScreenshotElement = {
        readonly dataset: Readonly<Record<string, string | undefined>>;
        getBoundingClientRect(): ScreenshotRect;
        querySelector(selector: string): ScreenshotElement | null;
        querySelectorAll(selector: string): ArrayLike<ScreenshotElement>;
      };
      const appRoot = root as unknown as ScreenshotElement;
      const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
      const header = Array.from(appRoot.querySelectorAll("th[data-column]")).find(
        (candidate) => candidate.dataset.column === columnName
      );
      if (!scroller || !header) throw new Error("The screenshot grid fit geometry is incomplete.");
      return scroller.getBoundingClientRect().right - header.getBoundingClientRect().right;
    }, orderDate.name);
    assert.ok(trailingGap >= -1, "The final featured screenshot column must not extend beyond the live grid.");
    if (trailingGap > 1) {
      const adjustedWidth = (columnWidths[orderDate.id] ?? widthsByName.order_date) + Math.floor(trailingGap);
      assert.ok(adjustedWidth <= 640, "The live screenshot grid fit must retain the maximum column width.");
      columnWidths = { ...columnWidths, [orderDate.id]: adjustedWidth };
      await testing.updateViewState(sessionId, {
        columnWidths,
        selectedColumnId,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      });
      assert.equal(
        await testing.synchronizePanel(sessionId),
        true,
        "The final measured screenshot grid fit must synchronize with its exact renderer."
      );
    }
    assert.deepEqual(testing.activeSession()?.viewState.columnWidths, columnWidths);
    assert.equal(testing.activeSession()?.viewState.selectedColumnId, selectedColumnId);
    return columnWidths;
  }

  async function openSelectedColumnInsights(sessionId: string, expectedColumn: string): Promise<void> {
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "Selected-column Insights requires the exact live Open Wrangler renderer.");
    const toggle = app.getByRole("button", { name: "Column profiles and filters" });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const drawer = app.getByRole("complementary", { name: "Column profiles and filters" });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("tab", { name: "Column" }).waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByRole("heading", { name: expectedColumn }).waitFor({ state: "visible", timeout: 10_000 });
    const deadline = Date.now() + 30_000;
    do {
      const summary = await drawer.innerText();
      if (
        !summary.includes("Profiling selected column") &&
        ["Min", "Max", "Mean", "Median"].every((label) => new RegExp(`\\b${label}\\b`, "u").test(summary))
      ) {
        return;
      }
      await capturePage.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new Error(`Selected-column Insights did not publish complete numeric statistics for ${expectedColumn}.`);
  }

  async function assertPackagedScreenshotScene(scene: "hero"): Promise<void> {
    assert.equal(
      await capturePage.locator(".part.sidebar:visible").count(),
      0,
      "The compact hero must not retain a competing native sidebar."
    );
    const active = testing.activeSession();
    assert.ok(active, "Screenshot geometry requires the active packaged dataframe session.");
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, active.sessionId);
    const app = await exactSessionApp(target.frame, active.sessionId);
    assert.ok(app, "Screenshot geometry requires the exact live Open Wrangler renderer.");
    const deadline = Date.now() + 15_000;
    let measurement:
      | {
          workspaceOverflow: number;
          gridOverflow: number;
          gridScrollLeft: number;
          renderedColumns: string[];
          missingFeaturedColumns: string[];
          partialColumns: string[];
          clippedColumnTitles: string[];
          clippedColumnStats: string[];
          clippedColumnVisualizations: string[];
          clippedCells: number;
          clippedControls: string[];
          revenueSummary: string;
          insightsHeading: string;
          insightsStats: Record<string, string>;
          insightsOverflow: number;
          insightsContained: boolean;
          draftVisible: boolean;
          columnSearchOpen: boolean;
        }
      | undefined;
    do {
      measurement = await app.evaluate(
        (root, expected) => {
          type ScreenshotRect = {
            readonly bottom: number;
            readonly left: number;
            readonly right: number;
            readonly top: number;
          };
          type ScreenshotElement = {
            readonly className: string;
            readonly clientWidth: number;
            readonly dataset: Readonly<Record<string, string | undefined>>;
            readonly innerText: string;
            readonly scrollLeft: number;
            readonly scrollWidth: number;
            getBoundingClientRect(): ScreenshotRect;
            querySelector(selector: string): ScreenshotElement | null;
            querySelectorAll(selector: string): ArrayLike<ScreenshotElement>;
          };
          const appRoot = root as unknown as ScreenshotElement;
          const workspace = appRoot.querySelector(".layout");
          const scroller = appRoot.querySelector('[data-testid="data-grid-scroller"]');
          if (!workspace || !scroller) throw new Error("The packaged screenshot layout is incomplete.");
          const scrollerBounds = scroller.getBoundingClientRect();
          const headers = Array.from(appRoot.querySelectorAll("th[data-column]"));
          const renderedColumns = headers.map((header) => header.dataset.column ?? "");
          const featuredHeaders = expected.featured.map((name) =>
            headers.find((header) => header.dataset.column === name)
          );
          const nextHeader = headers.find((header) => header.dataset.column === expected.nextColumn);
          const partialColumns = headers
            .filter((header) => {
              const bounds = header.getBoundingClientRect();
              const intersects = bounds.right > scrollerBounds.left + 1 && bounds.left < scrollerBounds.right - 1;
              const contained = bounds.left >= scrollerBounds.left - 1 && bounds.right <= scrollerBounds.right + 1;
              return intersects && !contained;
            })
            .map((header) => header.dataset.column ?? "");
          if (nextHeader) {
            const bounds = nextHeader.getBoundingClientRect();
            if (bounds.left < scrollerBounds.right - 1 && bounds.right > scrollerBounds.left + 1) {
              partialColumns.push(expected.nextColumn);
            }
          }
          const clippedColumnTitles = featuredHeaders.flatMap((header, index) => {
            const title = header?.querySelector(".columnTitle");
            return title && title.scrollWidth > title.clientWidth + 1 ? [expected.featured[index] ?? ""] : [];
          });
          const clippedColumnStats = featuredHeaders.flatMap((header, index) => {
            const clipped = Array.from(header?.querySelectorAll(".exactSummaryStats span") ?? []).some(
              (item) => item.scrollWidth > item.clientWidth + 1
            );
            return clipped ? [expected.featured[index] ?? ""] : [];
          });
          const clippedColumnVisualizations = featuredHeaders.flatMap((header, index) => {
            if (!header) return [];
            const headerBounds = header.getBoundingClientRect();
            const clipped = Array.from(
              header.querySelectorAll(
                ".categoryMiniRow small, .datetimeMiniChart span, .numericMiniChart text, .booleanMiniChart span"
              )
            ).some((item) => {
              const bounds = item.getBoundingClientRect();
              return (
                item.scrollWidth > item.clientWidth + 1 ||
                bounds.left < headerBounds.left - 1 ||
                bounds.right > headerBounds.right + 1
              );
            });
            return clipped ? [expected.featured[index] ?? ""] : [];
          });
          const visibleCells = Array.from(appRoot.querySelectorAll("td[data-grid-column]")).filter((cell) => {
            const bounds = cell.getBoundingClientRect();
            return bounds.right > scrollerBounds.left && bounds.left < scrollerBounds.right;
          });
          const controls = Array.from(appRoot.querySelectorAll(".toolbar, .cleaningBar, .gridStatusBar, .draftReview"));
          const clippedControls = controls
            .filter((element) => element.scrollWidth > element.clientWidth + 1)
            .map((element) => element.className);
          const revenueHeader = headers.find((header) => header.dataset.column === "revenue");
          const insights = appRoot.querySelector("#openwrangler-insights-panel");
          const insightLabels = Array.from(insights?.querySelectorAll(".summaryStatGrid dt") ?? []);
          const insightValues = Array.from(insights?.querySelectorAll(".summaryStatGrid dd") ?? []);
          const insightsBounds = insights?.getBoundingClientRect();
          const workspaceBounds = workspace.getBoundingClientRect();
          const draft = appRoot.querySelector('.draftReview[aria-label="Draft review"]');
          const columnSearch = appRoot.querySelector(".columnSearchPopup");
          return {
            workspaceOverflow: workspace.scrollWidth - workspace.clientWidth,
            gridOverflow: scroller.scrollWidth - scroller.clientWidth,
            gridScrollLeft: scroller.scrollLeft,
            renderedColumns,
            missingFeaturedColumns: expected.featured.filter((_, index) => !featuredHeaders[index]),
            partialColumns: [...new Set(partialColumns)],
            clippedColumnTitles,
            clippedColumnStats,
            clippedColumnVisualizations,
            clippedCells: visibleCells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
            clippedControls,
            revenueSummary: revenueHeader?.querySelector(".exactSummaryStats")?.innerText ?? "",
            insightsHeading: insights?.querySelector(".summaryColumnHeader h2")?.innerText ?? "",
            insightsStats: Object.fromEntries(
              insightLabels.map((label, index) => [label.innerText, insightValues[index]?.innerText ?? ""])
            ),
            insightsOverflow: insights ? insights.scrollWidth - insights.clientWidth : Number.POSITIVE_INFINITY,
            insightsContained: Boolean(
              insightsBounds &&
              insightsBounds.left >= workspaceBounds.left - 1 &&
              insightsBounds.right <= workspaceBounds.right + 1
            ),
            draftVisible: Boolean(draft),
            columnSearchOpen: Boolean(columnSearch)
          };
        },
        {
          featured: [...PACKAGED_SCREENSHOT_FEATURED_COLUMNS],
          nextColumn: PACKAGED_SCREENSHOT_COLUMNS[PACKAGED_SCREENSHOT_FEATURED_COLUMNS.length]
        }
      );
      const ready =
        measurement.workspaceOverflow <= 1 &&
        measurement.gridOverflow > 0 &&
        measurement.gridScrollLeft <= 1 &&
        measurement.missingFeaturedColumns.length === 0 &&
        measurement.partialColumns.length === 0 &&
        measurement.clippedColumnTitles.length === 0 &&
        measurement.clippedColumnStats.length === 0 &&
        measurement.clippedColumnVisualizations.length === 0 &&
        measurement.clippedCells === 0 &&
        measurement.clippedControls.length === 0 &&
        /\bMin\b/u.test(measurement.revenueSummary) &&
        /\bMax\b/u.test(measurement.revenueSummary) &&
        measurement.insightsHeading === "revenue" &&
        ["Min", "Max", "Mean", "Median"].every((label) => {
          const value = measurement?.insightsStats[label];
          return typeof value === "string" && value.length > 0 && value !== "n/a";
        }) &&
        measurement.insightsOverflow <= 1 &&
        measurement.insightsContained &&
        !measurement.draftVisible &&
        !measurement.columnSearchOpen;
      if (ready) return;
      await capturePage.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new Error(`The ${scene} screenshot scene is clipped or incomplete: ${JSON.stringify(measurement)}`);
  }

  async function assertResponsivePackagedControls(): Promise<void> {
    const active = testing.activeSession();
    assert.ok(active, "Responsive screenshot geometry requires the active packaged dataframe session.");
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, active.sessionId);
    const app = await exactSessionApp(target.frame, active.sessionId);
    assert.ok(app, "Responsive screenshot geometry requires the exact live Open Wrangler renderer.");
    const measurement = await app.evaluate((root) => {
      const appBounds = root.getBoundingClientRect();
      const toolbar = root.querySelector(".toolbar");
      const toolbarActions = root.querySelector(".toolbarActions");
      const gridStatusBar = root.querySelector(".gridStatusBar");
      if (!toolbar || !toolbarActions || !gridStatusBar) {
        throw new Error("Responsive screenshot controls are incomplete.");
      }
      const clippedChildren = (containerSelector: string, selector: string): string[] => {
        const container = root.querySelector(containerSelector);
        if (!container) return [`Missing ${containerSelector}`];
        const containerBounds = container.getBoundingClientRect();
        return [...container.querySelectorAll(selector)]
          .filter((element) => {
            const style = element.ownerDocument.defaultView?.getComputedStyle(element);
            if (!style || style.display === "none" || style.visibility === "hidden") return false;
            const bounds = element.getBoundingClientRect();
            return (
              bounds.left < Math.max(appBounds.left, containerBounds.left) - 1 ||
              bounds.right > Math.min(appBounds.right, containerBounds.right) + 1 ||
              bounds.top < containerBounds.top - 1 ||
              bounds.bottom > containerBounds.bottom + 1
            );
          })
          .map(
            (element) =>
              element.getAttribute("aria-label") ?? element.textContent?.replace(/\s+/gu, " ").trim() ?? element.tagName
          );
      };
      return {
        appOverflow: root.scrollWidth - root.clientWidth,
        toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
        toolbarActionsOverflow: toolbarActions.scrollWidth - toolbarActions.clientWidth,
        gridStatusBarOverflow: gridStatusBar.scrollWidth - gridStatusBar.clientWidth,
        clippedToolbarControls: clippedChildren(".toolbarActions", ":scope > *"),
        clippedGridStatusBar: clippedChildren(".gridStatusBar", ":scope > *")
      };
    });
    assert.ok(
      measurement.appOverflow <= 1 &&
        measurement.toolbarOverflow <= 1 &&
        measurement.toolbarActionsOverflow <= 1 &&
        measurement.gridStatusBarOverflow <= 1,
      `The 200% zoom layout must not overflow horizontally: ${JSON.stringify(measurement)}`
    );
    assert.deepEqual(
      measurement.clippedToolbarControls,
      [],
      "Every toolbar action must remain completely visible at 200% zoom."
    );
    assert.deepEqual(
      measurement.clippedGridStatusBar,
      [],
      "Every grid status control and the visible-row range must remain completely visible at 200% zoom."
    );
  }

  async function prepareWorkbenchForEvidence(): Promise<void> {
    const commands = new Set(await vscode.commands.getCommands(true));
    const auxiliaryBar = capturePage.locator(".part.auxiliarybar");
    if ((await auxiliaryBar.count()) > 0 && (await auxiliaryBar.isVisible())) {
      const closeCommand = commands.has("workbench.action.closeAuxiliaryBar")
        ? "workbench.action.closeAuxiliaryBar"
        : commands.has("workbench.action.toggleAuxiliaryBar")
          ? "workbench.action.toggleAuxiliaryBar"
          : undefined;
      if (closeCommand) {
        await vscode.commands.executeCommand(closeCommand);
        await auxiliaryBar.waitFor({ state: "hidden", timeout: 10_000 });
      }
    }
    await clearNotifications(commands);
  }

  async function hideCodePreviewPanel(): Promise<void> {
    const panel = capturePage.locator(".part.panel").first();
    if ((await panel.count()) === 0 || !(await panel.isVisible())) return;
    const commands = new Set(await vscode.commands.getCommands(true));
    assert.equal(
      commands.has("workbench.action.closePanel"),
      true,
      "The workbench must expose its panel close command."
    );
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await panel.waitFor({ state: "hidden", timeout: 10_000 });
  }

  async function clearNotifications(commands?: Set<string>): Promise<void> {
    const availableCommands = commands ?? new Set(await vscode.commands.getCommands(true));
    if (availableCommands.has("notifications.clearAll")) {
      await vscode.commands.executeCommand("notifications.clearAll");
    }
    if (availableCommands.has("notifications.hideList")) {
      await vscode.commands.executeCommand("notifications.hideList");
    }
    const notificationItems = capturePage.locator(
      ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
    );
    await capturePage
      .locator(
        ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
      )
      .first()
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(async (error: unknown) => {
        const visible = (await notificationItems.allInnerTexts()).map((text) =>
          text.replace(/\s+/gu, " ").trim().slice(0, 500)
        );
        throw new Error(
          `Visible notifications remained after deterministic workbench cleanup: ${JSON.stringify(visible)}`,
          {
            cause: error
          }
        );
      });
  }

  function contributedTheme(uiTheme: string, fallback: string): string {
    const themes = vscode.extensions.all.flatMap(
      (extension) =>
        (extension.packageJSON.contributes?.themes ?? []) as Array<{
          id?: string;
          label?: string;
          uiTheme?: string;
        }>
    );
    const candidates = themes.filter((theme) => theme.uiTheme === uiTheme);
    if (editor === "cursor") {
      const cursorTheme = candidates.find((theme) =>
        uiTheme === "vs-dark"
          ? theme.label === "Cursor Dark"
          : uiTheme === "vs"
            ? theme.label === "Cursor Light"
            : theme.label === "Cursor Dark High Contrast"
      );
      if (cursorTheme) return cursorTheme.id ?? cursorTheme.label ?? fallback;
    }
    const preferred = candidates.find((theme) => /default|modern/i.test(theme.label ?? theme.id ?? ""));
    return preferred?.id ?? preferred?.label ?? candidates[0]?.id ?? candidates[0]?.label ?? fallback;
  }
}

async function exercisePackagedNotebookFlows(testing: TestApi): Promise<void> {
  recordAcceptanceProgress("verify:notebook:fixture");
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-notebook-"));
  const notebookPath = path.join(directory, "notebook-acceptance.ipynb");
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const originalMode = configuration.get<"viewing" | "editing">("notebookStartMode", "viewing");
  const originalWorkspacePreviewProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
    "notebookPreviewProvider"
  )?.workspaceValue;
  let previewProviderOverridden = false;
  const page: GridPage = {
    offset: 0,
    limit: 1,
    totalRows: 1,
    columnIds: ["c:0"],
    rows: [
      {
        id: "r:0",
        rowNumber: 0,
        values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
      }
    ]
  };
  const schema: SessionMetadata["schema"] = [
    { id: "c:0", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }
  ];
  const currentPayload: NotebookOutputPayload = {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "snapshot",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: {
        kind: "notebookOutput",
        label: "renderer provenance A",
        variableName: "renderer_frame"
      },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 1, columns: 1 },
      filteredShape: { rows: 1, columns: 1 },
      schema,
      filterModel: { filters: [], sort: [] },
      steps: []
    },
    page,
    summaries: []
  };
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: {
                "text/plain": ["Open Wrangler saved output"],
                [OPEN_WRANGLER_MIME_V2]: currentPayload
              }
            }
          ],
          source: ["value = 1"]
        }
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5
    })
  );

  try {
    recordAcceptanceProgress("verify:notebook:document-open");
    await configuration.update("notebookStartMode", "editing", vscode.ConfigurationTarget.Workspace);
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(notebookPath));
    await vscode.window.showNotebookDocument(notebook);
    const outputMimes = notebook.cellAt(0).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(outputMimes.includes(OPEN_WRANGLER_MIME_V2), "MIME v2 output must be registered in a real notebook.");

    recordAcceptanceProgress("verify:notebook:direct-insertion");
    const inserted = await insertGeneratedNotebookCell(notebook, 1, "def clean_data(df):\n    return df\n", {
      source: "df",
      backend: "polars"
    });
    assert.deepEqual(inserted, { status: "applied" });
    assert.equal(notebook.cellCount, 2);
    assert.equal(notebook.cellAt(1).document.getText(), "def clean_data(df):\n    return df\n");
    assert.deepEqual(notebook.cellAt(1).metadata.openWrangler, {
      source: "df",
      backend: "polars",
      generated: true,
      insertionId: notebook.cellAt(1).metadata.openWrangler.insertionId
    });
    assert.equal(typeof notebook.cellAt(1).metadata.openWrangler.insertionId, "string");

    recordAcceptanceProgress("verify:notebook:jupyter-activate");
    const jupyterExtension = vscode.extensions.getExtension<FakeJupyterApi>("ms-toolsai.jupyter");
    assert.ok(jupyterExtension, "The stable Jupyter API acceptance extension must be available.");
    const jupyter = await jupyterExtension.activate();
    const setupCode = [
      "import pandas as pd",
      "import polars as pl",
      "pandas_frame = pd.DataFrame({'value': [1, 2], 'label': ['a', 'b']})",
      "duplicate_frame = pd.DataFrame([[2, 10.26, 'a', 'red', 'x', '2024-01-02', '2020-05-06'], [1, 20.74, 'b', 'blue', 'y', '2024-02-03', '2021-06-07'], [2, 10.26, 'c', 'red', 'z', '2024-03-04', '2022-07-08'], [2, None, 'd', 'green', 'x', '2024-04-05', '2023-08-09']], columns=['duplicate', 'duplicate', 7, 'category', 'category', 'when', 'when'])",
      "duplicate_frame_source = duplicate_frame.copy(deep=True)",
      "structural_frame = duplicate_frame.copy(deep=True)",
      "structural_frame_source = structural_frame.copy(deep=True)",
      "identity_frame = duplicate_frame.copy(deep=True)",
      "identity_frame.iloc[:, 2] = ['alpha', 'bravo', 'charlie', 'delta']",
      "identity_frame_source = identity_frame.copy(deep=True)",
      "polars_frame = pl.DataFrame({'value': [3, 4], 'label': ['c', 'd']})",
      "renderer_frame = pl.DataFrame({'value': [101]})"
    ].join("\n");
    recordAcceptanceProgress("verify:notebook:kernel-setup");
    await jupyter.testing.execute(notebook.uri, setupCode);

    recordAcceptanceProgress("verify:notebook:pandas-basic:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "pandas_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "pandas_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged Pandas notebook variable session"
    );
    let active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    assert.equal(active?.metadata.capabilities.notebookInsert, true);
    if (!active) throw new Error("Pandas notebook session did not become active.");
    recordAcceptanceProgress("verify:notebook:pandas-basic:page");
    const pandasPage = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-page",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(pandasPage.kind, "page");
    if (pandasPage.kind !== "page") throw new Error("Pandas notebook page did not resolve.");
    assert.equal(pandasPage.page.rows[1]?.values[0]?.display, "2");
    recordAcceptanceProgress("verify:notebook:pandas-basic:preview");
    const preview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: active.sessionId,
      revision: pandasPage.revision,
      step: {
        id: "notebook-score",
        kind: "formula",
        params: {
          leftColumn: columnReference(active.metadata, "value"),
          operator: "multiply",
          value: 2,
          newColumn: "score"
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") throw new Error("Pandas notebook step did not preview.");
    recordAcceptanceProgress("verify:notebook:pandas-basic:apply");
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: active.sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") throw new Error("Pandas notebook step did not apply.");
    const editedNotebookCode = "# edited notebook export\ndef clean_data(df):\n    return df\n";
    testing.setCodeForExport(editedNotebookCode);
    const insertionIndex = notebook.cellCount;
    recordAcceptanceProgress("verify:notebook:pandas-basic:insert");
    await vscode.commands.executeCommand("openWrangler.insertNotebookCode");
    await waitFor(
      () => notebook.cellCount === insertionIndex + 1,
      10_000,
      "the notebook export command to insert a cell"
    );
    assert.equal(notebook.cellAt(insertionIndex).document.getText(), editedNotebookCode);
    const pandasInsertionMetadata = notebook.cellAt(insertionIndex).metadata.openWrangler;
    assert.deepEqual(pandasInsertionMetadata, {
      source: "pandas_frame",
      backend: "pandas",
      generated: true,
      insertionId: pandasInsertionMetadata.insertionId
    });
    assert.equal(typeof pandasInsertionMetadata.insertionId, "string");
    recordAcceptanceProgress("verify:notebook:pandas-basic:close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the Pandas notebook session");
    await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the Pandas notebook session to close");

    recordAcceptanceProgress("verify:notebook:pandas-duplicates:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "duplicate_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "duplicate_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged duplicate-column Pandas notebook variable session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    if (!active) throw new Error("Duplicate-column Pandas notebook session did not become active.");
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      ["duplicate", "duplicate", "7", "category", "category", "when", "when"]
    );
    const firstDuplicate = columnReferenceAt(active.metadata, 0);
    const secondDuplicate = columnReferenceAt(active.metadata, 1);
    const integerLabel = columnReferenceAt(active.metadata, 2);
    const firstCategory = columnReferenceAt(active.metadata, 3);
    const secondCategory = columnReferenceAt(active.metadata, 4);
    const firstDatetime = columnReferenceAt(active.metadata, 5);
    const secondDatetime = columnReferenceAt(active.metadata, 6);
    assert.notEqual(firstDuplicate.id, secondDuplicate.id, "Duplicate labels must retain distinct stable identities.");
    assert.notEqual(firstCategory.id, secondCategory.id, "Duplicate category labels must retain distinct identities.");
    assert.notEqual(firstDatetime.id, secondDatetime.id, "Duplicate datetime labels must retain distinct identities.");
    assert.equal(integerLabel.name, "7");

    recordAcceptanceProgress("verify:notebook:pandas-duplicates:profiles");
    const duplicateProfiles = await testing.request({
      kind: "getSummary",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      viewRequestId: "notebook-pandas-duplicate-profiles",
      filterModel: active.metadata.filterModel,
      columnIds: [firstDuplicate.id, secondDuplicate.id]
    });
    assert.equal(duplicateProfiles.kind, "summary", "Duplicate-label profiles must resolve by stable ID.");
    if (duplicateProfiles.kind !== "summary") throw new Error("Duplicate-label profiles did not resolve.");
    assert.deepEqual(
      duplicateProfiles.summaries.map((summary) => [summary.columnId, summary.column]),
      [
        [firstDuplicate.id, "duplicate"],
        [secondDuplicate.id, "duplicate"]
      ]
    );
    assert.deepEqual(
      duplicateProfiles.summaries.map((summary) => [summary.numeric?.min, summary.numeric?.max]),
      [
        [1, 2],
        [10.26, 20.74]
      ],
      "Same-name numeric columns must retain their own statistics."
    );

    let duplicateRevision = active.metadata.revision;
    const valueSteps: TransformStep[] = [
      {
        id: "duplicate-one-hot-second-category",
        kind: "oneHotEncode",
        params: { columns: [secondCategory], prefixSeparator: "__", dropOriginal: false }
      },
      {
        id: "integer-label-uppercase",
        kind: "upperText",
        params: { column: integerLabel }
      },
      {
        id: "duplicate-round-second",
        kind: "roundNumber",
        params: { column: secondDuplicate, decimals: 1 }
      },
      {
        id: "duplicate-format-second-datetime",
        kind: "formatDatetime",
        params: { column: secondDatetime, format: "%Y" }
      }
    ];
    const valueCodeMarkers: readonly (readonly RegExp[])[] = [
      [
        /for _position_0, _column_0 in \[\(4, 'category'\)\]:\s+_encoded_series_0 = df\.iloc\[:, _position_0\]/u,
        /\.eq\(value\)\.fillna\(False\)\.astype\('int8'\)/u
      ],
      [/df\.isetitem\(2, df\.iloc\[:, 2\]\.astype\('string'\)\.map\(str\.upper, na_action='ignore'\)\)/u],
      [/df\.isetitem\(1, pd\.to_numeric\(df\.iloc\[:, 1\], errors='coerce'\)\.round\(1\)\)/u],
      [/df\.isetitem\(6, pd\.to_datetime\(df\.iloc\[:, 6\], errors='coerce'\)\.dt\.strftime\('%Y'\)\)/u]
    ];

    for (const [index, step] of valueSteps.entries()) {
      recordAcceptanceProgress(`verify:notebook:pandas-duplicates:value:${step.kind}:preview`);
      const valuePreview = await testing.request({
        kind: "previewStep",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicateRevision,
        step,
        offset: 0,
        limit: 10
      });
      assert.equal(valuePreview.kind, "stepPreview", `Packaged ${step.kind} must preview duplicate labels.`);
      if (valuePreview.kind !== "stepPreview") {
        throw new Error(`Packaged ${step.kind} duplicate-label preview did not resolve.`);
      }
      for (const marker of valueCodeMarkers[index]) {
        assert.match(
          valuePreview.code,
          marker,
          `${step.kind} generated code must bind its operation-specific implementation to the exact Pandas position.`
        );
      }
      assert.doesNotMatch(
        JSON.stringify(valuePreview.metadata.draftStep),
        /"position"\s*:/u,
        "Private bound positions must not leak into public value-operation drafts."
      );

      if (step.kind === "oneHotEncode") {
        const encodedX = columnReference(valuePreview.metadata, "category__x");
        const encodedY = columnReference(valuePreview.metadata, "category__y");
        const encodedZ = columnReference(valuePreview.metadata, "category__z");
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedX.id), ["1", "0", "0", "1"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedY.id), ["0", "1", "0", "0"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, encodedZ.id), ["0", "0", "1", "0"]);
        assert.equal(
          valuePreview.metadata.schema.some((column) => column.name === "category__red"),
          false,
          "One-hot encoding must use the selected second duplicate, not its same-named neighbor."
        );
      } else if (step.kind === "upperText") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, integerLabel.id), ["A", "B", "C", "D"]);
      } else if (step.kind === "roundNumber") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, secondDuplicate.id).slice(0, 3), [
          "10.3",
          "20.7",
          "10.3"
        ]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, firstDuplicate.id), ["2", "1", "2", "2"]);
      } else if (step.kind === "formatDatetime") {
        assert.deepEqual(gridColumnDisplays(valuePreview.page, secondDatetime.id), ["2020", "2021", "2022", "2023"]);
        assert.deepEqual(gridColumnDisplays(valuePreview.page, firstDatetime.id), [
          "2024-01-02",
          "2024-02-03",
          "2024-03-04",
          "2024-04-05"
        ]);
      }

      recordAcceptanceProgress(`verify:notebook:pandas-duplicates:value:${step.kind}:apply`);
      const valueApplied = await testing.request({
        kind: "applyDraft",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: valuePreview.revision,
        offset: 0,
        limit: 10
      });
      assert.equal(valueApplied.kind, "planUpdated", `Packaged ${step.kind} must apply duplicate labels.`);
      if (valueApplied.kind !== "planUpdated") {
        throw new Error(`Packaged ${step.kind} duplicate-label apply did not resolve.`);
      }
      assert.equal(valueApplied.metadata.steps.length, index + 1);
      assert.doesNotMatch(
        JSON.stringify(valueApplied.metadata.steps),
        /"position"\s*:/u,
        "Private bound positions must not leak into persisted value-operation steps."
      );
      duplicateRevision = valueApplied.revision;
    }

    const duplicateSteps: TransformStep[] = [
      {
        id: "duplicate-sort-second",
        kind: "sortRows",
        params: {
          rules: [
            { column: secondDuplicate, direction: "desc", nulls: "last" },
            { column: integerLabel, direction: "desc", nulls: "last" }
          ]
        }
      },
      {
        id: "duplicate-filter-first",
        kind: "filterRows",
        params: {
          filterModel: {
            logic: "and",
            filters: [
              {
                column: firstDuplicate,
                type: "integer",
                predicates: [{ kind: "predicate", operator: "equals", value: 2 }]
              }
            ],
            sort: []
          }
        }
      },
      {
        id: "duplicate-drop-missing-second",
        kind: "dropMissingRows",
        params: { columns: [secondDuplicate], how: "any" }
      },
      {
        id: "duplicate-drop-duplicates-pair",
        kind: "dropDuplicates",
        params: { columns: [firstDuplicate, secondDuplicate], keep: "first" }
      }
    ];
    const expectedThirdColumnAfterStep = [["B", "C", "A", "D"], ["C", "A", "D"], ["C", "A"], ["C"]];
    const expectedCodeMarkerAfterStep: readonly (readonly RegExp[])[] = [
      [/_sort_order_4_0 = df\.iloc\[:, 2\]/u, /_sort_order_4_1 = df\.iloc\[:, 1\]/u],
      [
        /_filter_mask_5 = .*df\.iloc\[:, 0\] == _open_wrangler_view_value\(2, 'integer'\).*_open_wrangler_is_null.*_open_wrangler_is_nan/u
      ],
      [
        /_missing_positions_6 = \[1\] or list\(range\(df\.shape\[1\]\)\)/u,
        /\[df\.iloc\[:, position\]\.notna\(\) for position in _missing_positions_6\]/u
      ],
      [
        /_duplicate_positions_7 = \[0, 1\] or list\(range\(df\.shape\[1\]\)\)/u,
        /df\.iloc\[:, _duplicate_positions_7\]/u
      ]
    ];

    for (const [index, step] of duplicateSteps.entries()) {
      recordAcceptanceProgress(`verify:notebook:pandas-duplicates:rows:${step.kind}:preview`);
      const duplicatePreview = await testing.request({
        kind: "previewStep",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicateRevision,
        step,
        offset: 0,
        limit: 10
      });
      assert.equal(duplicatePreview.kind, "stepPreview", `Packaged ${step.kind} must preview duplicate labels.`);
      if (duplicatePreview.kind !== "stepPreview") {
        throw new Error(`Packaged ${step.kind} duplicate-label preview did not resolve.`);
      }
      for (const marker of expectedCodeMarkerAfterStep[index]) {
        assert.match(
          duplicatePreview.code,
          marker,
          `${step.kind} generated code must bind its operation-specific implementation to the exact Pandas position.`
        );
      }
      assert.doesNotMatch(
        JSON.stringify(duplicatePreview.metadata.draftStep),
        /"position"\s*:/u,
        "Private bound positions must not leak into the public draft step."
      );
      assert.deepEqual(
        duplicatePreview.page.rows.map((row) => row.values[2]?.display),
        expectedThirdColumnAfterStep[index],
        `${step.kind} must target the selected duplicate or integer-labelled column before apply.`
      );
      recordAcceptanceProgress(`verify:notebook:pandas-duplicates:rows:${step.kind}:apply`);
      const duplicateApplied = await testing.request({
        kind: "applyDraft",
        ...GRID_COLUMN_WINDOW,
        sessionId: active.sessionId,
        revision: duplicatePreview.revision,
        offset: 0,
        limit: 10
      });
      assert.equal(duplicateApplied.kind, "planUpdated", `Packaged ${step.kind} must apply duplicate labels.`);
      if (duplicateApplied.kind !== "planUpdated") {
        throw new Error(`Packaged ${step.kind} duplicate-label apply did not resolve.`);
      }
      assert.equal(duplicateApplied.metadata.steps.length, valueSteps.length + index + 1);
      assert.doesNotMatch(
        JSON.stringify(duplicateApplied.metadata.steps),
        /"position"\s*:/u,
        "Private bound positions must not leak into persisted cleaning steps."
      );
      duplicateRevision = duplicateApplied.revision;
    }

    const duplicateSourceBeforeRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(duplicate_frame.equals(duplicate_frame_source))"
    );
    assert.match(
      duplicateSourceBeforeRestart,
      /\bTrue\b/u,
      "Cleaning steps must not mutate the originating notebook dataframe before kernel recovery."
    );

    recordAcceptanceProgress("verify:notebook:pandas-duplicates:replay");
    const duplicateGeneration = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const duplicateReplacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(duplicateReplacementGeneration > duplicateGeneration);
    const duplicateReplayed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-duplicate-row-operations-replay",
      sessionId: active.sessionId,
      revision: duplicateRevision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(duplicateReplayed.kind, "page", "Duplicate/non-string row operations must replay after restart.");
    if (duplicateReplayed.kind !== "page") throw new Error("Duplicate/non-string row-operation replay failed.");
    assert.equal(jupyter.testing.stats(notebook.uri)?.generation, duplicateReplacementGeneration);
    assert.equal(duplicateReplayed.page.totalRows, 1);
    assert.equal(duplicateReplayed.metadata.steps.length, valueSteps.length + duplicateSteps.length);
    recordAcceptanceProgress("verify:notebook:pandas-duplicates:profiles-replayed");
    const replayedDuplicateProfiles = await testing.request({
      kind: "getSummary",
      sessionId: active.sessionId,
      revision: duplicateRevision,
      viewRequestId: "notebook-pandas-duplicate-profiles-replayed",
      filterModel: active.metadata.filterModel,
      columnIds: [firstDuplicate.id, secondDuplicate.id]
    });
    assert.equal(replayedDuplicateProfiles.kind, "summary", "Duplicate-label profiles must replay by stable ID.");
    if (replayedDuplicateProfiles.kind !== "summary") {
      throw new Error("Replayed duplicate-label profiles did not resolve.");
    }
    assert.deepEqual(
      replayedDuplicateProfiles.summaries.map((summary) => [summary.columnId, summary.column]),
      [
        [firstDuplicate.id, "duplicate"],
        [secondDuplicate.id, "duplicate"]
      ]
    );
    assert.deepEqual(
      replayedDuplicateProfiles.summaries.map((summary) => [summary.numeric?.min, summary.numeric?.max]),
      [
        [2, 2],
        [10.3, 10.3]
      ],
      "Kernel replay must not collapse same-name profiles."
    );
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstDuplicate.id), ["2"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondDuplicate.id), ["10.3"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, integerLabel.id), ["C"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstCategory.id), ["red"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondCategory.id), ["z"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, firstDatetime.id), ["2024-03-04"]);
    assert.deepEqual(gridColumnDisplays(duplicateReplayed.page, secondDatetime.id), ["2022"]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, secondDuplicate.id), [
      { kind: "number", raw: 10.3, display: "10.3", isNull: false, isNaN: false }
    ]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, integerLabel.id), [
      { kind: "string", raw: "C", display: "C", isNull: false, isNaN: false }
    ]);
    assert.deepEqual(gridColumnCells(duplicateReplayed.page, secondDatetime.id), [
      { kind: "string", raw: "2022", display: "2022", isNull: false, isNaN: false }
    ]);
    for (const [name, expected] of [
      ["category__x", "0"],
      ["category__y", "0"],
      ["category__z", "1"]
    ] as const) {
      assert.deepEqual(
        gridColumnDisplays(duplicateReplayed.page, columnReference(duplicateReplayed.metadata, name).id),
        [expected]
      );
      assert.deepEqual(gridColumnCells(duplicateReplayed.page, columnReference(duplicateReplayed.metadata, name).id), [
        { kind: "integer", raw: Number(expected), display: expected, isNull: false, isNaN: false }
      ]);
    }
    assert.deepEqual(
      duplicateReplayed.metadata.schema.slice(0, 7).map((column) => column.name),
      ["duplicate", "duplicate", "7", "category", "category", "when", "when"]
    );
    assert.doesNotMatch(
      JSON.stringify(duplicateReplayed.metadata.steps),
      /"position"\s*:/u,
      "Kernel replay must retain position-free public references."
    );
    recordAcceptanceProgress("verify:notebook:pandas-duplicates:close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the duplicate-column Pandas notebook session");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the duplicate-column Pandas notebook session to close"
    );
    assert.deepEqual(testing.diagnostics().sessions, [], "Duplicate/non-string acceptance must retain no session.");
    const duplicateSourceState = await jupyter.testing.execute(
      notebook.uri,
      "print(duplicate_frame.equals(duplicate_frame_source))"
    );
    assert.match(
      duplicateSourceState,
      /\bTrue\b/u,
      "Cleaning steps must not mutate the originating notebook dataframe."
    );

    recordAcceptanceProgress("verify:notebook:pandas-structural:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "structural_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "structural_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged structural duplicate-column Pandas notebook variable session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    if (!active) throw new Error("Structural duplicate-column Pandas session did not become active.");
    const structuralSessionId = active.sessionId;
    const structuralFirstDuplicate = columnReferenceAt(active.metadata, 0);
    const structuralSecondDuplicate = columnReferenceAt(active.metadata, 1);
    const structuralIntegerLabel = columnReferenceAt(active.metadata, 2);
    const structuralFirstCategory = columnReferenceAt(active.metadata, 3);
    const structuralSecondCategory = columnReferenceAt(active.metadata, 4);
    const structuralFirstDatetime = columnReferenceAt(active.metadata, 5);
    const structuralSecondDatetime = columnReferenceAt(active.metadata, 6);
    assert.equal(structuralFirstDuplicate.name, "duplicate");
    assert.equal(structuralSecondDuplicate.name, "duplicate");
    assert.notEqual(
      structuralFirstDuplicate.id,
      structuralSecondDuplicate.id,
      "Structural acceptance requires independently addressable duplicate labels."
    );
    assert.equal(structuralIntegerLabel.name, "7");

    const structuralRenamedFirst = {
      id: structuralFirstDuplicate.id,
      name: "renamed_first"
    } as const;
    const structuralSteps: TransformStep[] = [
      {
        id: "structural-select-reordered",
        kind: "selectColumns",
        params: {
          columns: [
            structuralSecondDuplicate,
            structuralIntegerLabel,
            structuralFirstDuplicate,
            structuralSecondCategory,
            structuralFirstCategory,
            structuralSecondDatetime,
            structuralFirstDatetime
          ]
        }
      },
      {
        id: "structural-clone-second",
        kind: "cloneColumn",
        params: { column: structuralSecondDuplicate, newName: "second_copy" }
      },
      {
        id: "structural-cast-first",
        kind: "castColumn",
        params: { column: structuralFirstDuplicate, dtype: "float" }
      },
      {
        id: "structural-formula-duplicates",
        kind: "formula",
        params: {
          leftColumn: structuralFirstDuplicate,
          operator: "add",
          rightColumn: structuralSecondDuplicate,
          newColumn: "combined"
        }
      },
      {
        id: "structural-text-length-integer",
        kind: "textLength",
        params: { column: structuralIntegerLabel, newColumn: "label_length" }
      },
      {
        id: "structural-drop-second-duplicate",
        kind: "dropColumns",
        params: { columns: [structuralSecondDuplicate] }
      },
      {
        id: "structural-rename-first-duplicate",
        kind: "renameColumn",
        params: { column: structuralFirstDuplicate, newName: structuralRenamedFirst.name }
      }
    ];
    const structuralCodeMarkers = [
      /df = df\.iloc\[:, \[1, 2, 0, 4, 3, 6, 5\]\]\.copy\(\)/u,
      /df = pd\.concat\(\[df, df\.iloc\[:, 0\]\.rename\('second_copy'\)\], axis=1\)/u,
      /df\.isetitem\(2, df\.iloc\[:, 2\]\.astype\('Float64'\)\)/u,
      /df = pd\.concat\(\[df, \(df\.iloc\[:, 2\] \+ df\.iloc\[:, 0\]\)\.rename\('combined'\)\], axis=1\)/u,
      /df = pd\.concat\(\[df, df\.iloc\[:, 1\]\.astype\('string'\)\.str\.len\(\)\.rename\('label_length'\)\], axis=1\)/u,
      /df = df\.iloc\[:, \[position for position in range\(df\.shape\[1\]\) if position not in \[0\]\]\]\.copy\(\)/u,
      /_columns_6\[1\] = 'renamed_first'/u
    ] as const;
    const secondDuplicateCells = [
      { kind: "number", raw: 10.26, display: "10.26", isNull: false, isNaN: false },
      { kind: "number", raw: 20.74, display: "20.74", isNull: false, isNaN: false },
      { kind: "number", raw: 10.26, display: "10.26", isNull: false, isNaN: false },
      { kind: "nan", raw: null, display: "NaN", isNull: false, isNaN: true }
    ] as const;
    const castDuplicateCells = [
      { kind: "number", raw: 2, display: "2.0", isNull: false, isNaN: false },
      { kind: "number", raw: 1, display: "1.0", isNull: false, isNaN: false },
      { kind: "number", raw: 2, display: "2.0", isNull: false, isNaN: false },
      { kind: "number", raw: 2, display: "2.0", isNull: false, isNaN: false }
    ] as const;
    const combinedCells = [
      { kind: "number", raw: 12.26, display: "12.26", isNull: false, isNaN: false },
      { kind: "number", raw: 21.74, display: "21.74", isNull: false, isNaN: false },
      { kind: "number", raw: 12.26, display: "12.26", isNull: false, isNaN: false },
      { kind: "null", raw: null, display: "", isNull: true, isNaN: false }
    ] as const;
    const lengthCells = ["a", "b", "c", "d"].map(() => ({
      kind: "integer" as const,
      raw: 1,
      display: "1",
      isNull: false,
      isNaN: false
    }));
    const integerLabelCells = ["a", "b", "c", "d"].map((value) => ({
      kind: "string" as const,
      raw: value,
      display: value,
      isNull: false,
      isNaN: false
    }));

    let structuralRevision = active.metadata.revision;
    let structuralMetadata = active.metadata;
    let structuralPage: GridPage | undefined;
    let structuralClone: ColumnReference | undefined;
    let structuralCombined: ColumnReference | undefined;
    let structuralLength: ColumnReference | undefined;
    for (const [index, step] of structuralSteps.entries()) {
      recordAcceptanceProgress(`verify:notebook:pandas-structural:${step.kind}:preview`);
      const structuralPreview = await testing.request({
        kind: "previewStep",
        ...GRID_COLUMN_WINDOW,
        sessionId: structuralSessionId,
        revision: structuralRevision,
        step,
        offset: 0,
        limit: 10
      });
      assert.equal(structuralPreview.kind, "stepPreview", `Packaged ${step.kind} must preview structural labels.`);
      if (structuralPreview.kind !== "stepPreview") {
        throw new Error(`Packaged ${step.kind} structural preview did not resolve.`);
      }
      assert.match(
        structuralPreview.code,
        structuralCodeMarkers[index],
        `${step.kind} generated code must use the exact position after the preceding lineage changes.`
      );
      assert.doesNotMatch(
        structuralPreview.code,
        /df\[['"]duplicate['"]\]/u,
        `${step.kind} generated code must not fall back to an ambiguous duplicate label.`
      );
      assert.doesNotMatch(
        JSON.stringify(structuralPreview.metadata.draftStep),
        /"position"\s*:/u,
        "Private structural bindings must not leak into the public draft."
      );
      assert.deepEqual(
        structuralPreview.metadata.draftStep,
        step,
        "Structural previews must preserve the submitted public stable references verbatim."
      );

      if (step.kind === "selectColumns") {
        assert.deepEqual(
          structuralPreview.metadata.schema.map(({ id, name, position }) => ({ id, name, position })),
          [
            { ...structuralSecondDuplicate, position: 0 },
            { ...structuralIntegerLabel, position: 1 },
            { ...structuralFirstDuplicate, position: 2 },
            { ...structuralSecondCategory, position: 3 },
            { ...structuralFirstCategory, position: 4 },
            { ...structuralSecondDatetime, position: 5 },
            { ...structuralFirstDatetime, position: 6 }
          ],
          "Select Columns must reorder duplicate and non-string identities before later operations bind them."
        );
        assert.deepEqual(gridColumnCells(structuralPreview.page, structuralSecondDuplicate.id), secondDuplicateCells);
        assert.deepEqual(gridColumnCells(structuralPreview.page, structuralIntegerLabel.id), integerLabelCells);
      } else if (step.kind === "cloneColumn") {
        const clone = columnReference(structuralPreview.metadata, "second_copy");
        assert.equal(clone.id, `c:step:${step.id}:0`);
        assert.deepEqual(gridColumnCells(structuralPreview.page, clone.id), secondDuplicateCells);
        assert.equal(structuralPreview.metadata.schema.at(-1)?.id, clone.id);
      } else if (step.kind === "castColumn") {
        assert.deepEqual(gridColumnCells(structuralPreview.page, structuralFirstDuplicate.id), castDuplicateCells);
        assert.deepEqual(
          gridColumnCells(structuralPreview.page, structuralSecondDuplicate.id),
          secondDuplicateCells,
          "Casting the first duplicate must not change its same-named neighbor."
        );
      } else if (step.kind === "formula") {
        const combined = columnReference(structuralPreview.metadata, "combined");
        assert.equal(combined.id, `c:step:${step.id}:0`);
        assert.deepEqual(gridColumnCells(structuralPreview.page, combined.id), combinedCells);
        assert.equal(structuralPreview.metadata.schema.at(-1)?.id, combined.id);
      } else if (step.kind === "textLength") {
        const length = columnReference(structuralPreview.metadata, "label_length");
        assert.equal(length.id, `c:step:${step.id}:0`);
        assert.deepEqual(gridColumnCells(structuralPreview.page, length.id), lengthCells);
        assert.equal(structuralPreview.metadata.schema.at(-1)?.id, length.id);
      } else if (step.kind === "dropColumns") {
        assert.equal(
          structuralPreview.metadata.schema.some((column) => column.id === structuralSecondDuplicate.id),
          false,
          "Drop Columns must remove only the exact reordered second duplicate identity."
        );
        assert.ok(
          structuralPreview.metadata.schema.some((column) => column.id === structuralFirstDuplicate.id),
          "Drop Columns must retain the same-named first duplicate."
        );
      } else if (step.kind === "renameColumn") {
        const renamed = structuralPreview.metadata.schema.find((column) => column.id === structuralFirstDuplicate.id);
        assert.ok(renamed, "Rename Column must preserve the surviving duplicate identity.");
        assert.equal(renamed.name, structuralRenamedFirst.name);
        assert.equal(renamed.position, 1, "Rename Column must bind after select and drop shifted the input twice.");
      }

      recordAcceptanceProgress(`verify:notebook:pandas-structural:${step.kind}:apply`);
      const structuralApplied = await testing.request({
        kind: "applyDraft",
        ...GRID_COLUMN_WINDOW,
        sessionId: structuralSessionId,
        revision: structuralPreview.revision,
        offset: 0,
        limit: 10
      });
      assert.equal(structuralApplied.kind, "planUpdated", `Packaged ${step.kind} must apply structural labels.`);
      if (structuralApplied.kind !== "planUpdated") {
        throw new Error(`Packaged ${step.kind} structural apply did not resolve.`);
      }
      assert.equal(structuralApplied.metadata.steps.length, index + 1);
      assert.deepEqual(
        structuralApplied.metadata.steps,
        structuralSteps.slice(0, index + 1),
        "Applied structural plans must preserve every submitted public stable reference verbatim."
      );
      assert.deepEqual(
        structuralApplied.metadata.schema,
        structuralPreview.metadata.schema,
        "Applying a structural preview must publish the exact previewed schema atomically."
      );
      assert.deepEqual(
        structuralApplied.page,
        structuralPreview.page,
        "Applying a structural preview must publish the exact previewed typed page atomically."
      );
      assert.doesNotMatch(
        JSON.stringify(structuralApplied.metadata.steps),
        /"position"\s*:/u,
        "Applied structural steps must remain position-free at the public boundary."
      );
      structuralRevision = structuralApplied.revision;
      structuralMetadata = structuralApplied.metadata;
      structuralPage = structuralApplied.page;
      if (step.kind === "cloneColumn") {
        structuralClone = columnReference(structuralApplied.metadata, "second_copy");
      } else if (step.kind === "formula") {
        structuralCombined = columnReference(structuralApplied.metadata, "combined");
      } else if (step.kind === "textLength") {
        structuralLength = columnReference(structuralApplied.metadata, "label_length");
      }
    }

    assert.ok(structuralPage, "The structural plan must publish its final typed page.");
    assert.ok(structuralClone, "Clone Column must publish deterministic output lineage.");
    assert.ok(structuralCombined, "Formula must publish deterministic output lineage.");
    assert.ok(structuralLength, "Text Length must publish deterministic output lineage.");
    assert.deepEqual(
      structuralMetadata.schema.map(({ id, name, position }) => ({ id, name, position })),
      [
        { ...structuralIntegerLabel, position: 0 },
        { ...structuralRenamedFirst, position: 1 },
        { ...structuralSecondCategory, position: 2 },
        { ...structuralFirstCategory, position: 3 },
        { ...structuralSecondDatetime, position: 4 },
        { ...structuralFirstDatetime, position: 5 },
        { ...structuralClone, position: 6 },
        { ...structuralCombined, position: 7 },
        { ...structuralLength, position: 8 }
      ]
    );
    assert.deepEqual(gridColumnCells(structuralPage, structuralLength.id), lengthCells);
    assert.deepEqual(gridColumnCells(structuralPage, structuralIntegerLabel.id), integerLabelCells);
    assert.deepEqual(gridColumnCells(structuralPage, structuralRenamedFirst.id), castDuplicateCells);
    assert.deepEqual(gridColumnCells(structuralPage, structuralCombined.id), combinedCells);
    assert.deepEqual(gridColumnCells(structuralPage, structuralClone.id), secondDuplicateCells);
    const structuralSourceBeforeRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(structural_frame.equals(structural_frame_source))"
    );
    assert.match(
      structuralSourceBeforeRestart,
      /\bTrue\b/u,
      "Structural operations must not mutate the originating duplicate-column dataframe."
    );

    recordAcceptanceProgress("verify:notebook:pandas-structural:replay");
    const structuralGeneration = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const structuralReplacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(structuralReplacementGeneration > structuralGeneration);
    const structuralReplayed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-structural-duplicate-replay",
      sessionId: structuralSessionId,
      revision: structuralRevision,
      offset: 0,
      limit: 10,
      filterModel: structuralMetadata.filterModel
    });
    assert.equal(structuralReplayed.kind, "page", "Structural duplicate/non-string operations must replay.");
    if (structuralReplayed.kind !== "page") {
      throw new Error("Structural duplicate/non-string replay failed.");
    }
    assert.equal(jupyter.testing.stats(notebook.uri)?.generation, structuralReplacementGeneration);
    assert.equal(structuralReplayed.metadata.steps.length, structuralSteps.length);
    assert.deepEqual(
      structuralReplayed.metadata.steps,
      structuralSteps,
      "Kernel replay must preserve the exact public structural plan."
    );
    assert.deepEqual(
      structuralReplayed.metadata.schema.map(({ id, name, position }) => ({ id, name, position })),
      [
        { ...structuralIntegerLabel, position: 0 },
        { ...structuralRenamedFirst, position: 1 },
        { ...structuralSecondCategory, position: 2 },
        { ...structuralFirstCategory, position: 3 },
        { ...structuralSecondDatetime, position: 4 },
        { ...structuralFirstDatetime, position: 5 },
        { ...structuralClone, position: 6 },
        { ...structuralCombined, position: 7 },
        { ...structuralLength, position: 8 }
      ]
    );
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralLength.id), lengthCells);
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralIntegerLabel.id), integerLabelCells);
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralRenamedFirst.id), castDuplicateCells);
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralCombined.id), combinedCells);
    assert.deepEqual(gridColumnCells(structuralReplayed.page, structuralClone.id), secondDuplicateCells);
    assert.doesNotMatch(
      JSON.stringify(structuralReplayed.metadata.steps),
      /"position"\s*:/u,
      "Kernel replay must retain position-free public structural references."
    );
    const structuralSourceAfterRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(structural_frame.equals(structural_frame_source))"
    );
    assert.match(
      structuralSourceAfterRestart,
      /\bTrue\b/u,
      "Structural replay must leave the recreated notebook dataframe immutable."
    );
    recordAcceptanceProgress("verify:notebook:pandas-structural:close");
    await disposePackagedSessionPanel(
      testing,
      structuralSessionId,
      "the structural duplicate-column Pandas notebook session"
    );
    await waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the structural duplicate-column Pandas notebook session to close"
    );
    assert.deepEqual(testing.diagnostics().sessions, [], "Structural acceptance must retain no session.");

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "identity_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "identity_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged group-by/by-example duplicate-column Pandas notebook session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "pandas");
    if (!active) throw new Error("Group-by/by-example duplicate-column Pandas session did not become active.");
    const identitySessionId = active.sessionId;
    const identityFirstDuplicate = columnReferenceAt(active.metadata, 0);
    const identitySecondDuplicate = columnReferenceAt(active.metadata, 1);
    const identityIntegerLabel = columnReferenceAt(active.metadata, 2);
    assert.notEqual(
      identityFirstDuplicate.id,
      identitySecondDuplicate.id,
      "Group-by/by-example acceptance requires independently addressable duplicate labels."
    );
    assert.equal(identityIntegerLabel.name, "7");

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:by-example-preview");
    const identityExamplePreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: active.metadata.revision,
      step: {
        id: "duplicate-by-example-stable-references",
        kind: "byExample",
        params: {
          sourceColumns: [identityIntegerLabel],
          newColumn: "upper_integer_label",
          examples: [
            { inputs: ["alpha"], output: "ALPHA" },
            { inputs: ["bravo"], output: "BRAVO" }
          ]
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(
      identityExamplePreview.kind,
      "stepPreview",
      `Stable-reference by-example must preview: ${JSON.stringify(identityExamplePreview)}`
    );
    if (identityExamplePreview.kind !== "stepPreview") {
      throw new Error(`Stable-reference by-example preview did not resolve: ${JSON.stringify(identityExamplePreview)}`);
    }
    assert.match(
      identityExamplePreview.code,
      /_open_wrangler_nullable_string_copy\(df\.iloc\[:, 2\]\)\.astype\('string'\)/u,
      "By-example generated code must address the non-string-labelled source by position."
    );
    assert.deepEqual(
      gridColumnDisplays(
        identityExamplePreview.page,
        columnReference(identityExamplePreview.metadata, "upper_integer_label").id
      ),
      ["ALPHA", "BRAVO", "CHARLIE", "DELTA"]
    );
    assert.equal(identityExamplePreview.metadata.draftStep?.kind, "byExample");
    if (identityExamplePreview.metadata.draftStep?.kind === "byExample") {
      assert.deepEqual(identityExamplePreview.metadata.draftStep.params.sourceColumns, [identityIntegerLabel]);
      assert.equal(identityExamplePreview.metadata.draftStep.params.program?.kind, "case");
      assert.match(
        JSON.stringify(identityExamplePreview.metadata.draftStep.params.program),
        new RegExp(identityIntegerLabel.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")
      );
    }
    assert.doesNotMatch(
      JSON.stringify(identityExamplePreview.metadata.draftStep),
      /"position"\s*:/u,
      "Private by-example positions must not leak into public draft metadata."
    );

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:by-example-apply");
    const identityExampleApplied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityExamplePreview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(identityExampleApplied.kind, "planUpdated", "Stable-reference by-example must apply.");
    if (identityExampleApplied.kind !== "planUpdated") {
      throw new Error("Stable-reference by-example apply did not resolve.");
    }

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:group-preview");
    const identityGroupPreview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityExampleApplied.revision,
      step: {
        id: "duplicate-group-stable-references",
        kind: "groupBy",
        params: {
          keys: [identityIntegerLabel],
          aggregations: [{ column: identitySecondDuplicate, operation: "sum", alias: "second_duplicate_total" }]
        }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(
      identityGroupPreview.kind,
      "stepPreview",
      `Stable-reference group-by must preview: ${JSON.stringify(identityGroupPreview)}`
    );
    if (identityGroupPreview.kind !== "stepPreview") {
      throw new Error(`Stable-reference group-by preview did not resolve: ${JSON.stringify(identityGroupPreview)}`);
    }
    assert.match(
      identityGroupPreview.code,
      /_group_labels_1 = \[df\.columns\[position\] for position in \[2\]\]/u,
      "Group-by generated code must bind the non-string-labelled key by position."
    );
    assert.match(
      identityGroupPreview.code,
      /pd\.concat\(\[df\.iloc\[:, position\] for position in \[2, 1\]\], axis=1\)/u,
      "Group-by generated code must bind the exact second duplicate aggregation by position."
    );
    assert.doesNotMatch(
      identityGroupPreview.code,
      /df\[['"]duplicate['"]\]/u,
      "Group-by generated code must not fall back to an ambiguous duplicate label."
    );
    assert.equal(identityGroupPreview.metadata.draftStep?.kind, "groupBy");
    if (identityGroupPreview.metadata.draftStep?.kind === "groupBy") {
      assert.deepEqual(identityGroupPreview.metadata.draftStep.params.keys, [identityIntegerLabel]);
      assert.deepEqual(identityGroupPreview.metadata.draftStep.params.aggregations, [
        { column: identitySecondDuplicate, operation: "sum", alias: "second_duplicate_total" }
      ]);
    }
    assert.doesNotMatch(
      JSON.stringify(identityGroupPreview.metadata.draftStep),
      /"position"\s*:/u,
      "Private group-by positions must not leak into public draft metadata."
    );

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:group-apply");
    const identityGroupApplied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: identitySessionId,
      revision: identityGroupPreview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(identityGroupApplied.kind, "planUpdated", "Stable-reference group-by must apply.");
    if (identityGroupApplied.kind !== "planUpdated") {
      throw new Error("Stable-reference group-by apply did not resolve.");
    }
    assert.equal(identityGroupApplied.metadata.steps.length, 2);
    assert.doesNotMatch(
      JSON.stringify(identityGroupApplied.metadata.steps),
      /"position"\s*:/u,
      "Private group-by/by-example positions must not leak into persisted public steps."
    );
    const identitySourceBeforeRestart = await jupyter.testing.execute(
      notebook.uri,
      "print(identity_frame.equals(identity_frame_source))"
    );
    assert.match(
      identitySourceBeforeRestart,
      /\bTrue\b/u,
      "Group-by/by-example steps must not mutate the notebook source before recovery."
    );

    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:replay");
    const identityGeneration = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const identityReplacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(identityReplacementGeneration > identityGeneration);
    const identityReplayed = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-pandas-group-by-example-stable-reference-replay",
      sessionId: identitySessionId,
      revision: identityGroupApplied.revision,
      offset: 0,
      limit: 10,
      filterModel: identityGroupApplied.metadata.filterModel
    });
    assert.equal(identityReplayed.kind, "page", "Stable-reference group-by/by-example plan must replay.");
    if (identityReplayed.kind !== "page") {
      throw new Error("Stable-reference group-by/by-example replay failed.");
    }
    assert.equal(jupyter.testing.stats(notebook.uri)?.generation, identityReplacementGeneration);
    assert.equal(identityReplayed.page.totalRows, 4);
    assert.equal(identityReplayed.metadata.steps.length, 2);
    assert.deepEqual(gridColumnDisplays(identityReplayed.page, columnReference(identityReplayed.metadata, "7").id), [
      "alpha",
      "bravo",
      "charlie",
      "delta"
    ]);
    assert.deepEqual(
      gridColumnDisplays(
        identityReplayed.page,
        columnReference(identityReplayed.metadata, "second_duplicate_total").id
      ).slice(0, 3),
      ["10.26", "20.74", "10.26"]
    );
    assert.doesNotMatch(
      JSON.stringify(identityReplayed.metadata.steps),
      /"position"\s*:/u,
      "Kernel replay must retain position-free public group-by/by-example references."
    );
    recordAcceptanceProgress("verify:notebook:pandas-by-example-group:close");
    await disposePackagedSessionPanel(
      testing,
      identitySessionId,
      "the stable-reference group-by/by-example notebook session"
    );
    await waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the stable-reference group-by/by-example notebook session to close"
    );
    assert.deepEqual(
      testing.diagnostics().sessions,
      [],
      "Stable-reference group-by/by-example acceptance must retain no session."
    );
    const identitySourceAfterReplay = await jupyter.testing.execute(
      notebook.uri,
      "print(identity_frame.equals(identity_frame_source))"
    );
    assert.match(
      identitySourceAfterReplay,
      /\bTrue\b/u,
      "Recovered group-by/by-example steps must leave the notebook source immutable."
    );

    recordAcceptanceProgress("verify:notebook:polars:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "polars_frame",
      notebookUri: notebook.uri
    });
    await waitFor(
      () => testing.activeSession()?.metadata.source.variableName === "polars_frame",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the packaged Polars notebook variable session"
    );
    active = testing.activeSession();
    assert.equal(active?.metadata.backend, "polars");
    if (!active) throw new Error("Polars notebook session did not become active.");
    recordAcceptanceProgress("verify:notebook:polars:replay");
    const generation = jupyter.testing.stats(notebook.uri)?.generation ?? 0;
    const replacementGeneration = await jupyter.testing.restart(notebook.uri, setupCode);
    assert.ok(replacementGeneration > generation);
    const recovered = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-polars-recovery-page",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(recovered.kind, "page", "The Polars notebook session must replay after kernel replacement.");
    if (recovered.kind !== "page") throw new Error("Polars notebook recovery did not return a page.");
    assert.equal(recovered.page.rows[0]?.values[0]?.display, "3");
    recordAcceptanceProgress("verify:notebook:polars:close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the Polars notebook session");
    await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the Polars notebook session to close");

    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      await configuration.update("notebookPreviewProvider", "disabled", vscode.ConfigurationTarget.Workspace);
      previewProviderOverridden = true;
      recordAcceptanceProgress("verify:notebook-renderer-provenance");
      await exercisePackagedRendererProvenance(testing, jupyter, notebook, currentPayload, directory);
      recordAcceptanceProgress("verify:notebook-renderer-same-group-switch");
      await exercisePackagedSameGroupRendererSwitch(jupyter, notebook, currentPayload, directory);
    }

    recordAcceptanceProgress("verify:notebook:permission-denial");
    const denialCalls = jupyter.testing.denialCalls();
    jupyter.testing.setDenied(true);
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "pandas_frame",
      notebookUri: notebook.uri
    });
    await waitFor(() => jupyter.testing.denialCalls() > denialCalls, 10_000, "the packaged Jupyter permission denial");
    assert.equal(testing.diagnostics().sessionCount, 0);
    jupyter.testing.setDenied(false);
    const deniedPanelTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.label === "Open Wrangler: pandas_frame");
    if (deniedPanelTabs.length > 0) assert.equal(await vscode.window.tabGroups.close(deniedPanelTabs, true), true);
    assert.equal(await notebook.save(), true);
    const originTab = notebookTab(notebook.uri);
    assert.ok(originTab, "The originating notebook tab must still be open after the permission-denial scenario.");
    assert.equal(await vscode.window.tabGroups.close(originTab, true), true);
    await waitFor(
      () =>
        !notebookTab(notebook.uri) &&
        !vscode.window.visibleNotebookEditors.some(
          (editor) => editor.notebook.uri.toString() === notebook.uri.toString()
        ),
      10_000,
      "the originating notebook renderer to dispose before the isolated saved-output scenario"
    );

    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      recordAcceptanceProgress("verify:notebook-renderer-linked-live");
      await exercisePackagedLinkedRendererLiveOpen(testing, jupyter, directory);
    }
    recordAcceptanceProgress("verify:notebook:complete");
  } finally {
    try {
      if (previewProviderOverridden) {
        await configuration.update(
          "notebookPreviewProvider",
          originalWorkspacePreviewProvider,
          vscode.ConfigurationTarget.Workspace
        );
      }
    } finally {
      try {
        await configuration.update("notebookStartMode", originalMode, vscode.ConfigurationTarget.Workspace);
      } finally {
        cleanupAcceptanceTemporaryDirectory(directory);
      }
    }
  }
}

async function exercisePackagedLinkedRendererLiveOpen(
  testing: TestApi,
  jupyter: FakeJupyterApi,
  directory: string
): Promise<void> {
  const label = "linked renderer live acceptance";
  const variableName = "saved_preview_frame";
  const snapshotPath = path.join(directory, "renderer-linked-live.ipynb");
  const schema: SessionMetadata["schema"] = [
    { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:score", name: "score", position: 1, rawType: "Int64", type: "integer", nullable: true },
    { id: "c:group", name: "group", position: 2, rawType: "String", type: "string", nullable: false }
  ];
  const payload: NotebookOutputPayload = {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "claimed-snapshot-session",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: { kind: "notebookOutput", label, variableName },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: 99, columns: schema.length },
      filteredShape: { rows: 99, columns: schema.length },
      schema,
      filterModel: { logic: "and", filters: [], sort: [] },
      steps: []
    },
    page: {
      offset: 0,
      limit: 99,
      totalRows: 99,
      columnIds: schema.map((column) => column.id),
      rows: [
        snapshotRow("r:capture:0", 0, "Berlin", 2, "b"),
        snapshotRow("r:capture:1", 1, "Amsterdam", 5, "a"),
        snapshotRow("r:capture:2", 2, "Berlin", 7, "a"),
        snapshotRow("r:capture:3", 3, "Cairo", null, "c")
      ]
    },
    summaries: []
  };
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: {
                "text/plain": ["Open Wrangler linked live preview"],
                [OPEN_WRANGLER_MIME_V2]: payload
              }
            }
          ],
          source: [variableName]
        }
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5
    })
  );

  let snapshotNotebook: vscode.NotebookDocument | undefined;
  try {
    recordAcceptanceProgress("verify:notebook-renderer-linked-live:open");
    snapshotNotebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(snapshotPath));
    const snapshotEditor = await vscode.window.showNotebookDocument(snapshotNotebook, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });
    snapshotEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
    await jupyter.testing.execute(
      snapshotNotebook.uri,
      [
        "import polars as pl",
        `${variableName} = pl.DataFrame({`,
        "    'city': ['Berlin', 'Amsterdam', 'Berlin', 'Cairo'],",
        "    'score': [2, 5, 7, None],",
        "    'group': ['b', 'a', 'a', 'c'],",
        "})"
      ].join("\n")
    );
    const liveKernelBaseline = jupyter.testing.stats(snapshotNotebook.uri);
    assert.ok(liveKernelBaseline, "The linked renderer fixture must own one user-started kernel.");

    const workbench = await connectToEditorWorkbench();
    const button = await waitForNotebookRendererButton(workbench, label, "Open in Open Wrangler");
    recordAcceptanceProgress("verify:notebook-renderer-linked-live:click");
    try {
      await button.evaluate((candidate: unknown) => (candidate as { click(): void }).click());
    } finally {
      await button.dispose();
    }
    await waitFor(
      () => {
        const source = testing.activeSession()?.metadata.source;
        return (
          source?.kind === "notebookVariable" &&
          source.variableName === variableName &&
          source.uri === snapshotNotebook?.uri.toString()
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the linked MIME-v2 renderer output to open its complete current live dataframe"
    );

    const active = testing.activeSession();
    assert.ok(active, "The linked renderer output must become an active live-variable session.");
    assert.notEqual(active.sessionId, payload.metadata.sessionId, "The live session must not trust a saved identity.");
    assert.equal(active.metadata.sessionId, active.sessionId);
    assert.deepEqual(active.metadata.source, {
      kind: "notebookVariable",
      label: variableName,
      variableName,
      uri: snapshotNotebook.uri.toString()
    });
    assert.equal(active.metadata.mode, "editing");
    assert.equal(active.metadata.revision, 0);
    assert.deepEqual(active.metadata.shape, { rows: 4, columns: 3 });
    assert.deepEqual(active.metadata.filteredShape, { rows: 4, columns: 3 });
    assert.deepEqual(active.metadata.capabilities, {
      editable: true,
      lazy: false,
      cancel: false,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: true
    });
    assert.deepEqual(active.metadata.filterModel, { logic: "and", filters: [], sort: [] });
    assert.deepEqual(active.metadata.steps, []);
    assert.equal(active.metadata.latestStepInputSchema, undefined);
    assert.equal(active.metadata.draftStep, undefined);
    assert.equal(active.metadata.stats, undefined);
    const liveScore = columnReference(active.metadata, "score");
    assert.notEqual(
      liveScore.id,
      payload.metadata.schema.find((column) => column.name === "score")?.id,
      "The live session must generate its own column identities instead of trusting the saved preview."
    );
    const diagnostic = testing.diagnostics().sessions.find((session) => session.publicId === active.sessionId);
    assert.ok(diagnostic, "The linked live session must be coordinator-owned.");
    assert.notEqual(diagnostic.runtimeId, payload.metadata.sessionId);
    assert.notEqual(diagnostic.runtimeId, diagnostic.publicId);
    assert.ok(
      (jupyter.testing.stats(snapshotNotebook.uri)?.executions ?? 0) > liveKernelBaseline.executions,
      "Opening the linked renderer action must execute against its exact live kernel."
    );

    const filteredModel: FilterModel = {
      logic: "and",
      filters: [
        {
          column: "group",
          type: "string",
          logic: "and",
          predicates: [{ kind: "predicate", operator: "equals", value: "a" }]
        }
      ],
      sort: [{ column: "score", direction: "desc", nulls: "last" }]
    };
    recordAcceptanceProgress("verify:notebook-renderer-linked-live:page");
    const projected = await testing.request({
      kind: "getPage",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      viewRequestId: "linked-renderer-live-page",
      offset: 0,
      limit: 2,
      columnOffset: 1,
      columnLimit: 1,
      filterModel: filteredModel
    });
    assert.equal(projected.kind, "page");
    if (projected.kind !== "page") throw new Error("The linked live projected page did not resolve.");
    assert.deepEqual(projected.page.columnIds, [liveScore.id]);
    assert.deepEqual(
      projected.page.rows.map((row) => row.values[0]?.display),
      ["7", "5"]
    );
    assert.equal(projected.page.totalRows, 2);
    assert.deepEqual(projected.metadata.filteredShape, { rows: 2, columns: 3 });

    recordAcceptanceProgress("verify:notebook-renderer-linked-live:summary");
    const summary = await testing.request({
      kind: "getSummary",
      sessionId: active.sessionId,
      revision: projected.revision,
      viewRequestId: "linked-renderer-live-summary",
      filterModel: filteredModel,
      columnIds: [liveScore.id]
    });
    assert.equal(summary.kind, "summary");
    if (summary.kind !== "summary") throw new Error("The linked live summary did not resolve.");
    assert.deepEqual(summary.summaries, [
      {
        columnId: liveScore.id,
        column: "score",
        type: "integer",
        rawType: "Int64",
        totalCount: 2,
        nullCount: 0,
        nanCount: 0,
        distinctCount: 2,
        topValues: [
          { value: "7", count: 1 },
          { value: "5", count: 1 }
        ],
        numeric: {
          min: 5,
          max: 7,
          mean: 6,
          median: 6,
          std: Math.SQRT2,
          exactMin: { kind: "integer", raw: 5, display: "5", isNull: false, isNaN: false },
          exactMax: { kind: "integer", raw: 7, display: "7", isNull: false, isNaN: false }
        },
        visualization: {
          kind: "numeric",
          bins: [
            { min: 5, max: 6, count: 1 },
            { min: 6, max: 7, count: 1 }
          ]
        }
      }
    ]);

    recordAcceptanceProgress("verify:notebook-renderer-linked-live:statistics");
    const statistics = await testing.request({
      kind: "getDatasetStats",
      sessionId: active.sessionId,
      revision: projected.revision,
      viewRequestId: "linked-renderer-live-statistics",
      filterModel: { logic: "and", filters: [], sort: [] }
    });
    assert.equal(statistics.kind, "datasetStats");
    if (statistics.kind !== "datasetStats") throw new Error("The linked live statistics did not resolve.");
    assert.deepEqual(statistics.stats, {
      missingCells: 1,
      missingRows: 1,
      duplicateRows: 0,
      missingValuesByColumn: [
        { column: "city", count: 0 },
        { column: "score", count: 1 },
        { column: "group", count: 0 }
      ]
    });

    recordAcceptanceProgress("verify:notebook-renderer-linked-live:values");
    const values = await testing.request({
      kind: "getColumnValues",
      sessionId: active.sessionId,
      revision: projected.revision,
      viewRequestId: "linked-renderer-live-values",
      column: "city",
      search: "ber",
      limit: 100,
      filterModel: filteredModel
    });
    assert.equal(values.kind, "columnValues");
    if (values.kind !== "columnValues") throw new Error("The linked live values query did not resolve.");
    assert.deepEqual(values.values, [
      {
        value: "Berlin",
        count: 1,
        selectionValue: {
          kind: "typedSelection",
          version: 1,
          columnType: "string",
          cell: { kind: "string", raw: "Berlin", display: "Berlin", isNull: false, isNaN: false }
        }
      }
    ]);
    assert.equal(values.hasMore, false);

    recordAcceptanceProgress("verify:notebook-renderer-linked-live:close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the exact linked live session");
    assert.deepEqual(
      testing.diagnostics().sessions,
      [],
      `An earlier packaged notebook session leaked into linked-live cleanup: ${JSON.stringify(testing.diagnostics().sessions)}`
    );
    assert.ok(
      jupyter.testing.stats(snapshotNotebook.uri),
      "Closing the Open Wrangler panel must not stop the user's kernel."
    );
    const snapshotTab = notebookTab(snapshotNotebook.uri);
    if (snapshotTab) assert.equal(await vscode.window.tabGroups.close(snapshotTab, true), true);
    recordAcceptanceProgress("verify:notebook-renderer-linked-live:complete");
  } catch (error) {
    await bestEffortLinkedRendererCleanup(testing, snapshotNotebook, label, variableName);
    throw error;
  }
}

async function disposePackagedSessionPanel(testing: TestApi, sessionId: string, description: string): Promise<void> {
  const response = await testing.disposePanelForSession(sessionId);
  assert.equal(response?.kind, "sessionClosed", `${description} panel must close authoritatively.`);
  if (response?.kind === "sessionClosed") assert.equal(response.sessionId, sessionId);
  await waitFor(
    () => !testing.diagnostics().sessions.some((session) => session.publicId === sessionId),
    10_000,
    `${description} to leave the coordinator`
  );
}

async function exercisePackagedSameGroupRendererSwitch(
  jupyter: FakeJupyterApi,
  originNotebook: vscode.NotebookDocument,
  payloadTemplate: NotebookOutputPayload,
  directory: string
): Promise<void> {
  const label = "same-group renderer switch";
  const notebookPath = path.join(directory, "renderer-same-group.ipynb");
  const payload: NotebookOutputPayload = {
    ...payloadTemplate,
    metadata: {
      ...payloadTemplate.metadata,
      sessionId: "snapshot-renderer-same-group",
      source: { kind: "notebookOutput", label }
    }
  };
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: {
                "text/plain": [`Open Wrangler ${label}`],
                [OPEN_WRANGLER_MIME_V2]: payload
              }
            }
          ],
          source: ["# saved renderer switch"]
        }
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5
    })
  );

  let switchedNotebook: vscode.NotebookDocument | undefined;
  try {
    recordAcceptanceProgress("verify:notebook-renderer-same-group:connect");
    const workbench = await connectToEditorWorkbench();
    recordAcceptanceProgress("verify:notebook-renderer-same-group:open");
    switchedNotebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(notebookPath));
    const switchedEditor = await vscode.window.showNotebookDocument(switchedNotebook, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });
    switchedEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
    recordAcceptanceProgress("verify:notebook-renderer-same-group:preview-only");
    await waitForNotebookRendererPreviewOnly(workbench, label);
    assert.equal(
      jupyter.testing.stats(switchedNotebook.uri),
      undefined,
      "Switching to a saved-output notebook must not acquire a Jupyter kernel."
    );

    const switchedTab = notebookTab(switchedNotebook.uri);
    assert.ok(switchedTab, "The same-group renderer fixture tab must be open.");
    recordAcceptanceProgress("verify:notebook-renderer-same-group:close");
    assert.equal(await vscode.window.tabGroups.close(switchedTab, true), true);
    recordAcceptanceProgress("verify:notebook-renderer-same-group:restore");
    await vscode.window.showNotebookDocument(originNotebook, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });
    recordAcceptanceProgress("verify:notebook-renderer-same-group:restored-button");
    await (await waitForNotebookRendererButton(workbench, "renderer provenance A", "Open in Open Wrangler")).dispose();
    recordAcceptanceProgress("verify:notebook-renderer-same-group:complete");
  } finally {
    const switchedTab = switchedNotebook ? notebookTab(switchedNotebook.uri) : undefined;
    if (switchedTab) await vscode.window.tabGroups.close(switchedTab, true).then(undefined, () => undefined);
  }
}

function snapshotRow(
  id: string,
  rowNumber: number,
  city: string,
  score: number | null,
  group: string
): GridPage["rows"][number] {
  return {
    id,
    rowNumber,
    values: [
      { kind: "string", raw: city, display: city, isNull: false, isNaN: false },
      score === null
        ? { kind: "null", raw: null, display: "", isNull: true, isNaN: false }
        : { kind: "integer", raw: score, display: String(score), isNull: false, isNaN: false },
      { kind: "string", raw: group, display: group, isNull: false, isNaN: false }
    ]
  };
}

async function bestEffortLinkedRendererCleanup(
  testing: TestApi,
  notebook: vscode.NotebookDocument | undefined,
  label: string,
  variableName: string
): Promise<void> {
  const active = testing.activeSession();
  if (active?.metadata.source.kind === "notebookVariable" && active.metadata.source.variableName === variableName) {
    try {
      await testing.request({
        kind: "closeSession",
        sessionId: active.sessionId,
        revision: active.metadata.revision
      });
    } catch {
      // Editor-process-group teardown remains the final bounded fallback.
    }
  }
  const tabs = linkedRendererTabs(notebook, label);
  if (tabs.length > 0) {
    try {
      await vscode.window.tabGroups.close(tabs, true);
    } catch {
      // Preserve the original acceptance failure.
    }
  }
}

function linkedRendererTabs(notebook: vscode.NotebookDocument | undefined, label: string): vscode.Tab[] {
  return [
    ...(notebook ? [notebookTab(notebook.uri)] : []),
    ...vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.label === `Open Wrangler: ${label}` || isOpenWranglerSessionTab(tab))
  ].filter((tab): tab is vscode.Tab => Boolean(tab));
}

async function exercisePackagedRendererProvenance(
  testing: TestApi,
  jupyter: FakeJupyterApi,
  originNotebook: vscode.NotebookDocument,
  payloadTemplate: NotebookOutputPayload,
  directory: string
): Promise<void> {
  recordAcceptanceProgress("verify:notebook-renderer:fixtures");
  const secondNotebookPath = path.join(directory, "renderer-provenance-b.ipynb");
  const secondPayload: NotebookOutputPayload = {
    ...payloadTemplate,
    metadata: {
      ...payloadTemplate.metadata,
      sessionId: "snapshot-renderer-provenance-b",
      source: {
        kind: "notebookOutput",
        label: "renderer provenance B",
        variableName: "renderer_frame"
      }
    }
  };
  writeFileSync(
    secondNotebookPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: {
                "text/plain": [`Open Wrangler ${secondPayload.metadata.source.label}`],
                [OPEN_WRANGLER_MIME_V2]: secondPayload
              }
            }
          ],
          source: ["renderer_frame"]
        }
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5
    })
  );
  recordAcceptanceProgress("verify:notebook-renderer:fixture-written");

  let secondNotebook: vscode.NotebookDocument | undefined;
  try {
    recordAcceptanceProgress("verify:notebook-renderer:open-b");
    const openedSecondNotebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(secondNotebookPath));
    secondNotebook = openedSecondNotebook;
    recordAcceptanceProgress("verify:notebook-renderer:opened-b");
    assert.equal(
      jupyter.testing.lookupCalls(openedSecondNotebook.uri),
      0,
      "Opening notebook B through the API without a visible editor must not start proactive formatter work."
    );
    assert.equal(
      jupyter.testing.stats(openedSecondNotebook.uri),
      undefined,
      "An API-opened background notebook must not start or execute a kernel."
    );
    recordAcceptanceProgress("verify:notebook-renderer:show-a");
    const originEditor = await vscode.window.showNotebookDocument(originNotebook, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });
    originEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
    recordAcceptanceProgress("verify:notebook-renderer:show-b");
    await vscode.window.showNotebookDocument(openedSecondNotebook, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: false,
      preview: false
    });
    recordAcceptanceProgress("verify:notebook-renderer:shown-b");
    const originKernelBaseline = jupyter.testing.stats(originNotebook.uri);
    const secondKernelBaseline = jupyter.testing.stats(openedSecondNotebook.uri);
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      openedSecondNotebook,
      "Notebook B must remain active while the renderer event is emitted from notebook A."
    );

    recordAcceptanceProgress("verify:notebook-renderer:button");
    const workbench = await connectToEditorWorkbench();
    const originButton = await waitForNotebookRendererButton(
      workbench,
      "renderer provenance A",
      "Open in Open Wrangler"
    );
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      openedSecondNotebook,
      "Notebook B must still be the exact active document immediately before notebook A's renderer action."
    );
    assert.equal(testing.activeSession(), undefined);
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "The renderer provenance action requires zero coordinator sessions for its authoritative receipt."
    );
    assert.equal(
      releasedJupyterSessionTabs().length,
      0,
      "The renderer provenance action requires zero Open Wrangler tabs for its authoritative receipt."
    );
    const originLookupBaseline = jupyter.testing.lookupCalls(originNotebook.uri);
    const secondLookupBaseline = jupyter.testing.lookupCalls(openedSecondNotebook.uri);
    const denialBaseline = jupyter.testing.denialCalls();
    const waitForOriginReceipt = async (): Promise<void> => {
      recordAcceptanceProgress("verify:notebook-renderer:session");
      await waitFor(
        () => {
          const source = testing.activeSession()?.metadata.source;
          return (
            source?.kind === "notebookVariable" &&
            source.variableName === "renderer_frame" &&
            source.uri === originNotebook.uri.toString()
          );
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "notebook A's primary renderer action to open notebook A's live renderer_frame while notebook B is active",
        () => rendererProvenanceDiagnostics(testing, jupyter, originNotebook, openedSecondNotebook)
      );
    };
    recordAcceptanceProgress("verify:notebook-renderer:activate");
    try {
      await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "notebook A's renderer action while notebook B is active",
        activate: () =>
          withAcceptanceOperationDeadline(
            originButton.click(),
            WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
            "the exact notebook renderer action to receive one Playwright click"
          ),
        receipt: waitForOriginReceipt,
        authoritativeReceiptAfterActivationFailure: waitForOriginReceipt
      });
    } finally {
      await originButton.dispose();
    }

    const active = testing.activeSession();
    assert.ok(active, "The renderer provenance scenario must open the exact live notebook-variable session.");
    assert.equal(active.metadata.backend, "polars");
    assert.deepEqual(active.metadata.source, {
      kind: "notebookVariable",
      label: "renderer_frame",
      variableName: "renderer_frame",
      uri: originNotebook.uri.toString()
    });
    assert.equal(active.metadata.mode, "editing");
    assert.deepEqual(active.metadata.shape, { rows: 1, columns: 1 });
    assert.deepEqual(active.metadata.filteredShape, { rows: 1, columns: 1 });
    assert.equal(active.metadata.capabilities.editable, true);
    assert.equal(active.metadata.capabilities.notebookInsert, true);
    const provenancePage = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "notebook-renderer-provenance-page",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: active.metadata.filterModel
    });
    assert.equal(provenancePage.kind, "page");
    if (provenancePage.kind !== "page") throw new Error("Renderer provenance page did not resolve.");
    assert.equal(
      provenancePage.page.rows[0]?.values[0]?.display,
      "101",
      "The primary renderer action must use notebook A's current live renderer_frame, not its captured value or notebook B."
    );
    assert.ok(
      (jupyter.testing.stats(originNotebook.uri)?.executions ?? 0) > (originKernelBaseline?.executions ?? 0),
      "Opening a linked renderer output must dispatch the live request to notebook A's exact kernel."
    );
    assert.deepEqual(
      jupyter.testing.stats(openedSecondNotebook.uri),
      secondKernelBaseline,
      "Opening notebook A's live variable must not dispatch work to notebook B's kernel."
    );
    assert.ok(
      jupyter.testing.lookupCalls(originNotebook.uri) > originLookupBaseline,
      "The primary renderer action must acquire notebook A's exact kernel."
    );
    assert.equal(
      jupyter.testing.lookupCalls(openedSecondNotebook.uri),
      secondLookupBaseline,
      "The primary renderer action must not acquire notebook B's kernel."
    );
    assert.equal(
      jupyter.testing.denialCalls(),
      denialBaseline,
      "The already-authorized primary renderer action must not request a second Jupyter permission."
    );

    recordAcceptanceProgress("verify:notebook-renderer:session-close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the live renderer provenance session");
    await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the renderer provenance session to close");
    recordAcceptanceProgress("verify:notebook-renderer:tabs-close");
    const tabsToClose = rendererProvenanceTabs(openedSecondNotebook);
    if (tabsToClose.length > 0) assert.equal(await vscode.window.tabGroups.close(tabsToClose, true), true);
    recordAcceptanceProgress("verify:notebook-renderer:complete");
  } catch (error) {
    await bestEffortRendererProvenanceCleanup(testing, secondNotebook);
    throw error;
  }
}

function rendererProvenanceDiagnostics(
  testing: TestApi,
  jupyter: FakeJupyterApi,
  originNotebook: vscode.NotebookDocument,
  secondNotebook: vscode.NotebookDocument
): string {
  const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
  const source = testing.activeSession()?.metadata.source;
  const coordinator = testing.diagnostics();
  const sourceDiagnostic =
    source?.kind === "notebookVariable"
      ? {
          kind: source.kind,
          variableName: source.variableName,
          origin:
            source.uri === originNotebook.uri.toString()
              ? "A"
              : source.uri === secondNotebook.uri.toString()
                ? "B"
                : "other"
        }
      : source
        ? { kind: source.kind, label: source.label }
        : null;
  return JSON.stringify({
    activeNotebook:
      activeNotebook === originNotebook
        ? "A"
        : activeNotebook === secondNotebook
          ? "B"
          : activeNotebook
            ? "other"
            : "none",
    activeSource: sourceDiagnostic,
    coordinator: {
      sessionCount: coordinator.sessionCount,
      activeSessionPresent: coordinator.activeSessionId !== undefined
    },
    kernels: {
      A: {
        stats: jupyter.testing.stats(originNotebook.uri) ?? null,
        lookupCalls: jupyter.testing.lookupCalls(originNotebook.uri)
      },
      B: {
        stats: jupyter.testing.stats(secondNotebook.uri) ?? null,
        lookupCalls: jupyter.testing.lookupCalls(secondNotebook.uri)
      }
    },
    jupyterDenialCalls: jupyter.testing.denialCalls()
  });
}

async function bestEffortRendererProvenanceCleanup(
  testing: TestApi,
  secondNotebook: vscode.NotebookDocument | undefined
): Promise<void> {
  const active = testing.activeSession();
  if (active?.metadata.source.kind === "notebookVariable" && active.metadata.source.variableName === "renderer_frame") {
    try {
      await testing.request({
        kind: "closeSession",
        sessionId: active.sessionId,
        revision: active.metadata.revision
      });
    } catch {
      // Editor-process-group teardown remains the final bounded fallback.
    }
  }
  const tabsToClose = rendererProvenanceTabs(secondNotebook);
  if (tabsToClose.length > 0) {
    try {
      await vscode.window.tabGroups.close(tabsToClose, true);
    } catch {
      // Preserve the original acceptance failure.
    }
  }
}

function rendererProvenanceTabs(secondNotebook: vscode.NotebookDocument | undefined): vscode.Tab[] {
  return [
    ...(secondNotebook ? [notebookTab(secondNotebook.uri)] : []),
    ...vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.label === "Open Wrangler: renderer provenance A" || isOpenWranglerSessionTab(tab))
  ].filter((tab): tab is vscode.Tab => Boolean(tab));
}

function notebookTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputNotebook && tab.input.uri.toString() === uri.toString());
}

interface NotebookRendererLoadSnapshot {
  readonly rendererResponses: readonly number[];
  readonly rendererRequestFailures: readonly string[];
  readonly pageErrors: readonly string[];
  readonly consoleErrors: readonly string[];
}

interface NotebookRendererLoadObserver {
  snapshot(): NotebookRendererLoadSnapshot;
  dispose(): void;
}

interface NotebookRendererButton {
  readonly pointer: {
    click(x: number, y: number): Promise<void>;
  };
  click(): Promise<void>;
  boundingBox(): Promise<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null>;
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
  dispose(): Promise<void>;
}

function observeNotebookRendererLoad(workbench: Page): NotebookRendererLoadObserver {
  const rendererResponses: number[] = [];
  const rendererRequestFailures: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const append = (target: string[], value: string): void => {
    if (target.length >= 8) return;
    const normalized = value.replaceAll(/\s+/gu, " ").trim();
    target.push(normalized.slice(0, 512));
  };
  const isRendererRequest = (url: string): boolean => url.includes("notebookRenderer.js");
  const onResponse = (response: Response): void => {
    if (isRendererRequest(response.url()) && rendererResponses.length < 8) {
      rendererResponses.push(response.status());
    }
  };
  const onRequestFailed = (request: Request): void => {
    if (isRendererRequest(request.url())) {
      append(rendererRequestFailures, request.failure()?.errorText ?? "unknown request failure");
    }
  };
  const onPageError = (error: Error): void => {
    append(pageErrors, `${error.name}: ${error.message}`);
  };
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!/(?:module|notebook|renderer|open\s*wrangler|openwrangler)/iu.test(text)) return;
    append(consoleErrors, text);
  };

  workbench.on("response", onResponse);
  workbench.on("requestfailed", onRequestFailed);
  workbench.on("pageerror", onPageError);
  workbench.on("console", onConsole);
  return {
    snapshot: () => ({
      rendererResponses: [...rendererResponses],
      rendererRequestFailures: [...rendererRequestFailures],
      pageErrors: [...pageErrors],
      consoleErrors: [...consoleErrors]
    }),
    dispose: () => {
      workbench.off("response", onResponse);
      workbench.off("requestfailed", onRequestFailed);
      workbench.off("pageerror", onPageError);
      workbench.off("console", onConsole);
    }
  };
}

async function waitForNotebookRendererButton(
  workbench: Page,
  label: string,
  buttonName = "Open in Open Wrangler"
): Promise<NotebookRendererButton> {
  const deadline = Date.now() + NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS;
  discovery: do {
    const browser = workbench.context().browser();
    assertNotebookRendererLifecycle(workbench, browser);
    const targets = openWranglerWebviewTargets(workbench, browser, NOTEBOOK_RENDERER_TARGET_LIMIT);
    const nestedButtons: NotebookRendererButton[] = [];
    let returnedNestedButton: NotebookRendererButton | undefined;
    try {
      for (const target of targets) {
        if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
        try {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break discovery;
          const probeTimeoutMs = Math.min(NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS, remainingMs);
          const nested = await resolveNestedNotebookRendererButtonWithDeadline(
            target.frame,
            label,
            buttonName,
            probeTimeoutMs
          );
          if (nested) nestedButtons.push(nested);
        } catch (error) {
          const discoveryExpired = Date.now() >= deadline;
          if (!(discoveryExpired && isNestedNotebookRendererProbeDeadline(error))) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
          }
          if (discoveryExpired) break discovery;
        }
      }
      if (nestedButtons.length === 1) {
        returnedNestedButton = nestedButtons[0]!;
        return returnedNestedButton;
      }
    } finally {
      await Promise.allSettled(
        nestedButtons.filter((button) => button !== returnedNestedButton).map((button) => button.dispose())
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  assertNotebookRendererLifecycle(workbench, browser);
  const diagnostics = await notebookRendererDiagnostics(workbench, browser, label, buttonName);
  assertNotebookRendererLifecycle(workbench, browser);
  throw new Error(`Timed out waiting for the exact notebook renderer action: ${JSON.stringify(diagnostics)}`);
}

async function waitForNotebookRendererPreviewOnly(workbench: Page, label: string): Promise<void> {
  const expectedHint = "Run this cell again to open the current dataframe in Open Wrangler.";
  const deadline = Date.now() + NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS;
  do {
    const browser = workbench.context().browser();
    assertNotebookRendererLifecycle(workbench, browser);
    for (const target of openWranglerWebviewTargets(workbench, browser, NOTEBOOK_RENDERER_TARGET_LIMIT)) {
      if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
      try {
        const preview = target.frame.locator("section.openwrangler-notebook").filter({
          hasText: `Open Wrangler preview: ${label}`
        });
        if ((await preview.count()) === 1) {
          const note = preview.locator('[role="note"]').filter({ hasText: expectedHint });
          const action = preview.getByRole("button", { name: "Open in Open Wrangler", exact: true });
          if ((await note.count()) === 1 && (await note.isVisible()) && (await action.count()) === 0) return;
        }

        const nestedMatches = await target.frame.evaluate(
          ({ expectedLabel, expectedNote }) => {
            type NestedDocument = NestedElement & { readonly readyState: string };
            type NestedElement = {
              readonly contentDocument?: NestedDocument | null;
              readonly isConnected: boolean;
              readonly textContent: string | null;
              querySelector(selector: string): NestedElement | null;
              querySelectorAll(selector: string): ArrayLike<NestedElement>;
            };
            const outerDocument = (globalThis as unknown as { readonly document: NestedDocument }).document;
            const innerDocument = outerDocument.querySelector("iframe#active-frame")?.contentDocument;
            if (!innerDocument || innerDocument.readyState === "loading") return false;
            const titlePrefix = `Open Wrangler preview: ${expectedLabel} (`;
            const previews = Array.from(innerDocument.querySelectorAll("section.openwrangler-notebook")).filter(
              (section) => (section.querySelector("header > span")?.textContent ?? "").startsWith(titlePrefix)
            );
            if (previews.length !== 1) return false;
            const preview = previews[0]!;
            const openActions = Array.from(preview.querySelectorAll("button")).filter(
              (button) => button.isConnected && (button.textContent ?? "").trim() === "Open in Open Wrangler"
            );
            const notes = Array.from(preview.querySelectorAll('[role="note"]')).filter(
              (note) => note.isConnected && (note.textContent ?? "").trim() === expectedNote
            );
            return openActions.length === 0 && notes.length === 1;
          },
          { expectedLabel: label, expectedNote: expectedHint }
        );
        if (nestedMatches) return;
      } catch (error) {
        ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
      }
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  assertNotebookRendererLifecycle(workbench, browser);
  const diagnostics = await notebookRendererDiagnostics(workbench, browser, label, "Open in Open Wrangler");
  throw new Error(`Timed out waiting for the exact preview-only notebook output: ${JSON.stringify(diagnostics)}`);
}

async function resolveNestedNotebookRendererButtonWithDeadline(
  frame: Frame,
  label: string,
  buttonName: string,
  timeoutMs: number
): Promise<NotebookRendererButton | undefined> {
  const pending = resolveNestedNotebookRendererButton(frame, label, buttonName);
  try {
    return await withAcceptanceOperationDeadline(
      pending,
      timeoutMs,
      "the nested notebook renderer action readiness probe"
    );
  } catch (error) {
    void pending.then((button) => button?.dispose()).catch(() => undefined);
    throw error;
  }
}

async function resolveNestedNotebookRendererButton(
  frame: Frame,
  label: string,
  buttonName: string
): Promise<NotebookRendererButton | undefined> {
  const raw = await frame.evaluateHandle(findExactActiveNotebookRendererButton, {
    expectedLabel: label,
    expectedButtonName: buttonName
  });
  const element = raw.asElement() as ElementHandle<unknown> | null;
  if (!element) {
    await raw.dispose();
    return undefined;
  }
  try {
    const [visible, enabled, box] = await Promise.all([
      element.isVisible(),
      element.isEnabled(),
      element.boundingBox()
    ]);
    if (!visible || !enabled || !box || box.width <= 0 || box.height <= 0) {
      await element.dispose();
      return undefined;
    }
  } catch (error) {
    await element.dispose().catch(() => undefined);
    throw error;
  }
  return {
    pointer: frame.page().mouse,
    click: () => element.click(),
    boundingBox: () => element.boundingBox(),
    evaluate: <Result>(pageFunction: (candidate: unknown) => Result | Promise<Result>) =>
      element.evaluate(pageFunction),
    dispose: () => element.dispose()
  };
}

function isNestedNotebookRendererProbeDeadline(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Timed out waiting for the nested notebook renderer action readiness probe after ")
  );
}

function assertNotebookRendererLifecycle(workbench: Page, browser: Browser | null): void {
  if (workbench.isClosed()) throw new Error("The editor workbench closed during notebook renderer discovery.");
  if (browser !== null && !browser.isConnected()) {
    throw new Error("The editor CDP browser disconnected during notebook renderer discovery.");
  }
}

async function notebookRendererDiagnostics(
  workbench: Page,
  browser: Browser | null,
  label: string,
  buttonName: string
): Promise<unknown> {
  const targets = openWranglerWebviewTargets(workbench, browser, NOTEBOOK_RENDERER_DIAGNOSTIC_TARGET_LIMIT);
  try {
    const diagnostics = await withAcceptanceOperationDeadline(
      Promise.all(
        targets.map(async (target) => {
          if (isRetiredRendererTarget(workbench, target.page, target.frame)) {
            return rendererTargetDiagnostic(target, { retired: true });
          }
          try {
            const preview = target.frame.locator("section.openwrangler-notebook").filter({
              hasText: `Open Wrangler preview: ${label}`
            });
            const button = preview.getByRole("button", { name: buttonName, exact: true });
            const [
              previewCount,
              buttonCount,
              readyState,
              bodyChildren,
              bodyDescendants,
              alerts,
              tables,
              preformatted,
              moduleScripts,
              selectedOutputMimes,
              notebookBacklayerContainers,
              notebookBacklayerCells,
              notebookBacklayerOutputs,
              notebookBacklayerRenderedOutputs,
              notebookBacklayerRendererErrors,
              selectedOutputGeometry
            ] = await Promise.all([
              preview.count(),
              button.count(),
              target.frame.locator(":root").evaluate((root) => root.ownerDocument.readyState),
              target.frame.locator("body > *").count(),
              target.frame.locator("body *").count(),
              target.frame.locator('[role="alert"]').count(),
              target.frame.locator("table").count(),
              target.frame.locator("pre").count(),
              target.frame.locator('script[type="module"]').count(),
              target.frame.locator(".output-inner-container[output-mime-type]").evaluateAll((elements) =>
                elements
                  .slice(0, 16)
                  .map((element) => element.getAttribute("output-mime-type"))
                  .filter((mime): mime is string => typeof mime === "string")
              ),
              target.frame.locator("#container").count(),
              target.frame.locator(".cell_container").count(),
              target.frame.locator(".output_container").count(),
              target.frame.locator(".output").count(),
              target.frame.locator(".no-renderer-error").count(),
              target.frame.locator(".output-inner-container[output-mime-type]").evaluateAll((elements) =>
                elements.slice(0, 16).map((element) => {
                  const rect = element.getBoundingClientRect();
                  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
                  const mime = element.getAttribute("output-mime-type") ?? "missing";
                  return [
                    mime,
                    Math.round(rect.width),
                    Math.round(rect.height),
                    Math.round(rect.left),
                    Math.round(rect.top),
                    style?.display ?? "unknown",
                    style?.visibility ?? "unknown",
                    element.isConnected ? "connected" : "detached"
                  ].join(":");
                })
              )
            ]);
            const [firstButtonVisible, firstButtonEnabled] =
              buttonCount > 0
                ? await Promise.all([
                    button.first().isVisible(),
                    button.first().isEnabled({ timeout: WORKBENCH_DIAGNOSTIC_TIMEOUT_MS })
                  ])
                : [false, false];
            const nestedGuest = await nestedNotebookRendererDiagnostics(target.frame, label, buttonName);
            return rendererTargetDiagnostic(target, {
              retired: false,
              previewCount,
              buttonCount,
              readyState:
                readyState === "loading" || readyState === "interactive" || readyState === "complete"
                  ? readyState
                  : "unavailable",
              bodyChildren,
              bodyDescendants,
              alerts,
              tables,
              preformatted,
              moduleScripts,
              selectedOutputMimes: selectedOutputMimes.join(","),
              notebookBacklayerContainers,
              notebookBacklayerCells,
              notebookBacklayerOutputs,
              notebookBacklayerRenderedOutputs,
              notebookBacklayerRendererErrors,
              selectedOutputGeometry: selectedOutputGeometry.join(","),
              firstButtonVisible,
              firstButtonEnabled,
              ...nestedGuest
            });
          } catch (error) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
            return rendererTargetDiagnostic(target, { retired: true });
          }
        })
      ),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "bounded notebook renderer diagnostics"
    );
    assertNotebookRendererLifecycle(workbench, browser);
    return diagnostics;
  } catch (error) {
    assertNotebookRendererLifecycle(workbench, browser);
    if (error instanceof Error && error.message.startsWith("Timed out waiting for bounded notebook renderer")) {
      return "unavailable within the diagnostics deadline";
    }
    throw error;
  }
}

async function nestedNotebookRendererDiagnostics(
  frame: Frame,
  label: string,
  buttonName: string
): Promise<Record<string, boolean | number | string>> {
  return frame.evaluate(
    ({ expectedLabel, expectedButtonName }) => {
      type Rect = { readonly width: number; readonly height: number };
      type NestedDocument = NestedElement & { readonly readyState: string };
      type NestedElement = {
        readonly contentDocument?: NestedDocument | null;
        readonly isConnected: boolean;
        readonly textContent: string | null;
        getBoundingClientRect(): Rect;
        querySelector(selector: string): NestedElement | null;
        querySelectorAll(selector: string): ArrayLike<NestedElement>;
      };
      const outerDocument = (globalThis as unknown as { readonly document: NestedDocument }).document;
      const activeFrames = Array.from(outerDocument.querySelectorAll("iframe#active-frame"));
      const pendingFrames = Array.from(outerDocument.querySelectorAll("iframe#pending-frame"));
      const innerDocument = activeFrames.length === 1 ? activeFrames[0]?.contentDocument : undefined;
      const empty = {
        nestedActiveFrames: activeFrames.length,
        nestedPendingFrames: pendingFrames.length,
        nestedGuestAccessible: false,
        nestedGuestReadyState: "unavailable",
        nestedContainers: 0,
        nestedCells: 0,
        nestedOutputs: 0,
        nestedRenderedOutputs: 0,
        nestedRendererErrors: 0,
        nestedPreviewCount: 0,
        nestedButtonCount: 0,
        nestedPreviewWidth: 0,
        nestedPreviewHeight: 0,
        nestedButtonWidth: 0,
        nestedButtonHeight: 0
      };
      if (!innerDocument) return empty;

      const titlePrefix = `Open Wrangler preview: ${expectedLabel} (`;
      const previews = Array.from(innerDocument.querySelectorAll("section.openwrangler-notebook")).filter((section) =>
        (section.querySelector("header > span")?.textContent ?? "").startsWith(titlePrefix)
      );
      const buttons = previews.flatMap((section) =>
        Array.from(section.querySelectorAll("button")).filter(
          (button) => button.isConnected && (button.textContent ?? "").trim() === expectedButtonName
        )
      );
      const previewRect = previews.length === 1 ? previews[0]!.getBoundingClientRect() : undefined;
      const buttonRect = buttons.length === 1 ? buttons[0]!.getBoundingClientRect() : undefined;
      return {
        nestedActiveFrames: activeFrames.length,
        nestedPendingFrames: pendingFrames.length,
        nestedGuestAccessible: true,
        nestedGuestReadyState:
          innerDocument.readyState === "loading" ||
          innerDocument.readyState === "interactive" ||
          innerDocument.readyState === "complete"
            ? innerDocument.readyState
            : "unavailable",
        nestedContainers: innerDocument.querySelectorAll("#container").length,
        nestedCells: innerDocument.querySelectorAll(".cell_container").length,
        nestedOutputs: innerDocument.querySelectorAll(".output_container").length,
        nestedRenderedOutputs: innerDocument.querySelectorAll(".output").length,
        nestedRendererErrors: innerDocument.querySelectorAll(".no-renderer-error").length,
        nestedPreviewCount: previews.length,
        nestedButtonCount: buttons.length,
        nestedPreviewWidth: Math.round(previewRect?.width ?? 0),
        nestedPreviewHeight: Math.round(previewRect?.height ?? 0),
        nestedButtonWidth: Math.round(buttonRect?.width ?? 0),
        nestedButtonHeight: Math.round(buttonRect?.height ?? 0)
      };
    },
    { expectedLabel: label, expectedButtonName: buttonName }
  );
}

function releasedNotebookRendererHostDiagnostics(
  notebook: vscode.NotebookDocument,
  cellIndex: number
): Record<string, boolean | number> {
  const mimes = notebook.cellAt(cellIndex).outputs.flatMap((output) => output.items.map((item) => item.mime));
  const displayOrder = vscode.workspace
    .getConfiguration("notebook", notebook.uri)
    .get<unknown[]>("displayOrder", [])
    .filter((item): item is string => typeof item === "string");
  return {
    outputMimeCount: mimes.length,
    customMimeIndex: mimes.indexOf(OPEN_WRANGLER_MIME_V2),
    htmlMimeIndex: mimes.indexOf("text/html"),
    plainMimeIndex: mimes.indexOf("text/plain"),
    displayOrderCount: displayOrder.length,
    customDisplayOrderIndex: displayOrder.indexOf(OPEN_WRANGLER_MIME_V2),
    htmlDisplayOrderIndex: displayOrder.indexOf("text/html"),
    plainDisplayOrderIndex: displayOrder.indexOf("text/plain")
  };
}

async function seedVisiblePersistedPanel(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  const sourceBytes = readFileSync(fixture.fsPath);
  recordAcceptanceProgress("seed:visible-panel:open");
  const opened = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: semicolonCsvSource(fixture),
    backend: "polars",
    pageSize: 200,
    mode: "editing"
  });
  assert.equal(opened.kind, "sessionOpened");
  if (opened.kind !== "sessionOpened") return;
  assert.deepEqual(opened.metadata.shape, {
    rows: PACKAGED_FIRST_USE_ROW_COUNT,
    columns: PACKAGED_SCREENSHOT_COLUMNS.length
  });

  recordAcceptanceProgress("seed:visible-panel:preview");
  const preview = await testing.request({
    kind: "previewStep",
    ...GRID_COLUMN_WINDOW,
    sessionId: opened.metadata.sessionId,
    revision: opened.metadata.revision,
    step: {
      id: PERSISTED_PANEL_STEP_ID,
      kind: "formula",
      params: {
        leftColumn: columnReference(opened.metadata, "revenue"),
        operator: "multiply",
        value: 2,
        newColumn: PERSISTED_PANEL_OUTPUT_COLUMN
      }
    },
    offset: 0,
    limit: 200
  });
  assert.equal(preview.kind, "stepPreview");
  if (preview.kind !== "stepPreview") return;

  recordAcceptanceProgress("seed:visible-panel:apply");
  const applied = await testing.request({
    kind: "applyDraft",
    ...GRID_COLUMN_WINDOW,
    sessionId: opened.metadata.sessionId,
    revision: preview.revision,
    offset: 0,
    limit: 200
  });
  assert.equal(applied.kind, "planUpdated");
  if (applied.kind !== "planUpdated") return;

  recordAcceptanceProgress("seed:visible-panel:view");
  const page = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    viewRequestId: "seed-visible-persisted-panel",
    sessionId: opened.metadata.sessionId,
    revision: applied.revision,
    offset: 400,
    limit: 200,
    filterModel: persistedPanelFilterModel()
  });
  assert.equal(page.kind, "page");
  if (page.kind !== "page") return;
  assert.deepEqual(
    page.metadata.steps.map((step) => step.id),
    [PERSISTED_PANEL_STEP_ID]
  );
  assert.deepEqual(page.metadata.filterModel, persistedPanelFilterModel());
  assert.equal(page.metadata.shape.columns, PACKAGED_SCREENSHOT_COLUMNS.length + 1);
  const selected = columnReference(page.metadata, PERSISTED_PANEL_SELECTED_COLUMN);
  await testing.updateViewState(opened.metadata.sessionId, {
    columnWidths: { [selected.id]: PERSISTED_PANEL_COLUMN_WIDTH },
    selectedColumnId: selected.id,
    viewport: {
      firstVisibleRow: PERSISTED_PANEL_FIRST_VISIBLE_ROW,
      scrollLeft: PERSISTED_PANEL_SCROLL_LEFT
    }
  });

  recordAcceptanceProgress("seed:visible-panel:close");
  const closed = await testing.request({
    kind: "closeSession",
    sessionId: opened.metadata.sessionId,
    revision: page.revision
  });
  assert.equal(closed.kind, "sessionClosed");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the visible persisted-panel seed session and runtime to close"
  );
  assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes, "Seeding visible state must not modify its source.");
}

async function seedPersistedPlan(
  testing: TestApi,
  fixture: vscode.Uri,
  persistedPanelFixture: vscode.Uri
): Promise<void> {
  await seedVisiblePersistedPanel(testing, persistedPanelFixture);
  const source = csvSource(fixture);
  const filterModel: FilterModel = {
    filters: [],
    sort: [{ column: "sales", direction: "desc", nulls: "last" }]
  };
  for (const target of [
    {
      backend: "polars" as const,
      stepId: "packaged-score",
      multiplier: 2,
      score: "24.0",
      width: 250,
      scrollLeft: 35
    },
    {
      backend: "duckdb" as const,
      stepId: "packaged-duckdb-score",
      multiplier: 3,
      score: "36.0",
      width: 310,
      scrollLeft: 75
    }
  ]) {
    recordAcceptanceProgress(`seed:${target.backend}:open`);
    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source,
      backend: target.backend,
      pageSize: 20,
      mode: "editing"
    });
    assert.equal(
      opened.kind,
      "sessionOpened",
      `Expected ${target.backend} sessionOpened, received ${JSON.stringify(opened)}`
    );
    if (opened.kind !== "sessionOpened") continue;

    recordAcceptanceProgress(`seed:${target.backend}:preview`);
    const preview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      step: {
        id: target.stepId,
        kind: "formula",
        params: {
          leftColumn: columnReference(opened.metadata, "sales"),
          operator: "multiply",
          value: target.multiplier,
          newColumn: "score"
        }
      },
      offset: 0,
      limit: 20
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") continue;

    recordAcceptanceProgress(`seed:${target.backend}:apply`);
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId: opened.metadata.sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 20
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") continue;

    recordAcceptanceProgress(`seed:${target.backend}:page`);
    const page = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `persisted-${target.backend}-plan-page`,
      sessionId: opened.metadata.sessionId,
      revision: applied.revision,
      offset: 0,
      limit: 20,
      filterModel
    });
    assert.equal(page.kind, "page");
    if (page.kind !== "page") continue;
    assert.equal(page.page.rows[0]?.values[0]?.display, "Berlin");
    assert.equal(page.page.rows[0]?.values[4]?.display, target.score);
    assert.deepEqual(
      page.metadata.steps.map((step) => step.id),
      [target.stepId]
    );
    const salesColumnId = page.metadata.schema.find((column) => column.name === "sales")?.id;
    assert.ok(salesColumnId);
    recordAcceptanceProgress(`seed:${target.backend}:view-state`);
    await testing.updateViewState(opened.metadata.sessionId, {
      columnWidths: { [salesColumnId]: target.width },
      selectedColumnId: salesColumnId,
      viewport: { firstVisibleRow: SHORT_FIXTURE_FIRST_VISIBLE_ROW, scrollLeft: target.scrollLeft }
    });

    recordAcceptanceProgress(`seed:${target.backend}:close`);
    const closed = await testing.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: page.revision
    });
    assert.equal(closed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `the seeded ${target.backend} session and standalone runtime to close`
    );

    recordAcceptanceProgress(`seed:${target.backend}:readback-open`);
    const readback = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source,
      backend: target.backend,
      pageSize: 20,
      mode: "editing"
    });
    assert.equal(readback.kind, "sessionOpened");
    if (readback.kind !== "sessionOpened") continue;
    assert.deepEqual(
      readback.metadata.steps.map((step) => step.id),
      [target.stepId]
    );
    assert.equal(readback.page.rows[0]?.values[4]?.display, target.score);
    assert.deepEqual(testing.activeSession()?.viewState, {
      filterModel: { ...filterModel, logic: "and" },
      columnWidths: { [salesColumnId]: target.width },
      selectedColumnId: salesColumnId,
      viewport: { firstVisibleRow: SHORT_FIXTURE_FIRST_VISIBLE_ROW, scrollLeft: target.scrollLeft }
    });
    recordAcceptanceProgress(`seed:${target.backend}:readback-close`);
    const readbackClosed = await testing.request({
      kind: "closeSession",
      sessionId: readback.metadata.sessionId,
      revision: readback.metadata.revision
    });
    assert.equal(readbackClosed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `the ${target.backend} persistence readback session to close`
    );
    recordAcceptanceProgress(`seed:${target.backend}:complete`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

interface VisiblePersistedPanelSnapshot {
  readonly appliedStepText: string;
  readonly selectedColumnWidth: number;
  readonly selectedValues: readonly string[];
  readonly selectedColumnId: string;
  readonly sort: FilterModel["sort"];
  readonly sortLabels: readonly string[];
  readonly status: string;
  readonly viewport: { firstVisibleRow: number; scrollLeft: number };
}

async function assertPersistedSortPriorityInNativeView(workbench: Page): Promise<readonly string[]> {
  const sidebarWasVisible = await workbench
    .locator(".part.sidebar")
    .first()
    .isVisible()
    .catch(() => false);
  await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
  const sidebar = workbench.locator(".part.sidebar:visible");
  const filtersTree = sidebar.getByRole("tree", { name: /Filters\s*\/\s*Sorts/u }).first();
  if (!(await filtersTree.isVisible().catch(() => false))) {
    const filtersHeader = sidebar.getByText("Filters / Sorts", { exact: true }).first();
    await filtersHeader.waitFor({ state: "visible", timeout: 10_000 });
    await filtersHeader.click();
  }
  await filtersTree.waitFor({ state: "visible", timeout: 10_000 });
  const revenue = filtersTree
    .getByRole("treeitem", { name: /^revenue, Priority 1 · Descending · nulls last/u })
    .first();
  const market = filtersTree.getByRole("treeitem", { name: /^market, Priority 2 · Descending · nulls last/u }).first();
  await revenue.waitFor({ state: "visible", timeout: 10_000 });
  await market.waitFor({ state: "visible", timeout: 10_000 });
  const labels = [(await revenue.getAttribute("aria-label")) ?? "", (await market.getAttribute("aria-label")) ?? ""];
  assert.match(labels[0] ?? "", /^revenue, Priority 1 · Descending · nulls last/u);
  assert.match(labels[1] ?? "", /^market, Priority 2 · Descending · nulls last/u);
  if (!sidebarWasVisible) {
    await closeVisibleWorkbenchPart(workbench, ".part.sidebar", [
      "workbench.action.closeSidebar",
      "workbench.action.toggleSidebarVisibility"
    ]);
  }
  const activeEditorTab = workbench
    .locator(".part.editor .editor-group-container.active .tabs-container .tab.active:visible")
    .last();
  await activeEditorTab.waitFor({ state: "visible", timeout: 10_000 });
  await activeEditorTab.click();
  return labels;
}

async function visiblePersistedPanelSnapshot(
  testing: TestApi,
  workbench: Page,
  sessionId: string
): Promise<VisiblePersistedPanelSnapshot> {
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The visible persistence assertion requires the exact rendered panel.");
  await waitForSettledViewState(testing, "the visible persisted panel to settle before physical inspection");
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId);
  assert.ok(active, "The visible persistence assertion requires its exact active session.");
  assert.deepEqual(
    active.metadata.steps.map((step) => step.id),
    [PERSISTED_PANEL_STEP_ID]
  );
  assert.equal(active.metadata.shape.columns, PACKAGED_SCREENSHOT_COLUMNS.length + 1);
  assert.ok(columnReference(active.metadata, PERSISTED_PANEL_OUTPUT_COLUMN));
  assert.match(active.code ?? "", new RegExp(PERSISTED_PANEL_OUTPUT_COLUMN, "u"));
  assert.deepEqual(active.viewState.filterModel, persistedPanelFilterModel());
  const selected = columnReference(active.metadata, PERSISTED_PANEL_SELECTED_COLUMN);
  assert.equal(active.viewState.selectedColumnId, selected.id);
  assert.equal(active.viewState.columnWidths[selected.id], PERSISTED_PANEL_COLUMN_WIDTH);
  assert.equal(active.viewState.viewport.firstVisibleRow, PERSISTED_PANEL_FIRST_VISIBLE_ROW);
  assert.ok(active.viewState.viewport.scrollLeft > 0, "The restored horizontal viewport must remain nonzero.");

  assert.equal((await app.locator(".backendBadge").first().innerText()).trim(), "POLARS");
  const cleaningPlan = app.getByRole("region", { name: "Cleaning plan" });
  await cleaningPlan.waitFor({ state: "visible", timeout: 10_000 });
  const appliedStepText = (await cleaningPlan.innerText()).replace(/\s+/gu, " ").trim();
  assert.match(appliedStepText, /\b1 applied step\b/u);

  const outputPosition = active.metadata.schema.findIndex((column) => column.name === PERSISTED_PANEL_OUTPUT_COLUMN);
  assert.equal(
    outputPosition,
    PACKAGED_SCREENSHOT_COLUMNS.length,
    "The committed recovery output must remain the final schema column."
  );
  const selectedPosition = active.metadata.schema.findIndex((column) => column.id === selected.id);
  assert.notEqual(selectedPosition, -1);
  const selectedHeader = app.locator(`th[data-grid-column="${selectedPosition}"]`).first();
  await selectedHeader.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await selectedHeader.getAttribute("data-column"), PERSISTED_PANEL_SELECTED_COLUMN);
  assert.equal(await selectedHeader.getAttribute("aria-selected"), "true");
  const selectedColumnWidth = Math.round((await selectedHeader.boundingBox())?.width ?? 0);
  assert.ok(
    Math.abs(selectedColumnWidth - PERSISTED_PANEL_COLUMN_WIDTH) <= 1,
    `The distinctive persisted selected-column width was not rendered: ${selectedColumnWidth}.`
  );

  const visibleRows = app.getByRole("status", { name: "Visible rows" });
  await visibleRows.waitFor({ state: "visible", timeout: 10_000 });
  await waitForLocatorText(
    visibleRows,
    (text) => text.trim() === "Rows 401\u2013600 of 10,000",
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the persisted 401\u2013600 row block to reach the rendered grid"
  );
  const status = (await visibleRows.innerText()).trim();

  const selectedCells = app.locator(`td[data-grid-column="${selectedPosition}"][data-grid-row]`);
  await selectedCells.first().waitFor({ state: "visible", timeout: 10_000 });
  const selectedValues = (await selectedCells.allInnerTexts()).slice(0, 3).map((value) => value.trim());
  assert.equal(selectedValues.length, 3, "The selected persisted column must expose visible values.");
  assert.ok(
    selectedValues.every((value) => Number.isFinite(Number(value.replaceAll(",", "")))),
    `The selected persisted numeric column must remain numeric: ${JSON.stringify(selectedValues)}.`
  );
  assert.equal(await selectedCells.first().getAttribute("aria-selected"), "true");

  const scroller = app.getByTestId("data-grid-scroller");
  const physicalViewport = await scroller.evaluate((element) => {
    const target = element as {
      scrollLeft: number;
      scrollTop: number;
      scrollWidth: number;
      scrollHeight: number;
      clientWidth: number;
      clientHeight: number;
    };
    return {
      scrollLeft: target.scrollLeft,
      scrollTop: target.scrollTop,
      scrollWidth: target.scrollWidth,
      scrollHeight: target.scrollHeight,
      clientWidth: target.clientWidth,
      clientHeight: target.clientHeight
    };
  });
  assert.ok(physicalViewport.scrollLeft > 0, "The rendered grid must retain a nonzero horizontal scroll.");
  assert.ok(physicalViewport.scrollTop > 0, "The rendered grid must retain a nonzero vertical scroll.");
  assert.ok(physicalViewport.scrollWidth > physicalViewport.clientWidth);
  assert.ok(physicalViewport.scrollHeight > physicalViewport.clientHeight);

  assert.equal(status, "Rows 401\u2013600 of 10,000");
  const sortLabels = await assertPersistedSortPriorityInNativeView(workbench);
  await waitForSettledViewState(testing, "the visible persisted panel to settle after native-view inspection");

  return {
    appliedStepText,
    selectedColumnWidth,
    selectedValues,
    selectedColumnId: selected.id,
    sort: active.viewState.filterModel.sort.map((rule) => ({ ...rule })),
    sortLabels,
    status,
    viewport: { ...active.viewState.viewport }
  };
}

async function verifyVisiblePersistedReplayAndRecovery(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  const sourceBytes = readFileSync(fixture.fsPath);
  const insights = vscode.workspace.getConfiguration("openWrangler", fixture);
  const previousInsightsOnOpen = insights.inspect<boolean>("insightsOnOpen")?.globalValue;
  await insights.update("insightsOnOpen", false, vscode.ConfigurationTarget.Global);
  let sessionId: string | undefined;
  try {
    const workbench = await connectToEditorWorkbench();
    recordAcceptanceProgress("verify:visible-replay-recovery:open");
    await vscode.commands.executeCommand("vscode.openWith", fixture, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.uri === fixture.toString() &&
          active.metadata.backend === "polars" &&
          active.metadata.steps.some((step) => step.id === PERSISTED_PANEL_STEP_ID)
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the fresh editor process to replay the visible persisted Polars plan"
    );
    const active = testing.activeSession();
    assert.ok(active, "The fresh editor process must publish the persisted panel session.");
    sessionId = active.sessionId;
    await waitFor(
      () => testing.panelHydrated(sessionId!),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the fresh persisted panel renderer to acknowledge its replay"
    );
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The fresh persisted panel must synchronize before physical inspection."
    );
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await workbench.bringToFront();
    const persistedTab = workbench
      .locator(".part.editor .editor-group-container.active .tabs-container .tab.active:visible")
      .filter({ hasText: path.basename(fixture.fsPath) })
      .last();
    await persistedTab.waitFor({ state: "visible", timeout: 10_000 });
    await persistedTab.click();
    recordAcceptanceProgress("verify:visible-replay-recovery:initial-visible-state");
    const initial = await visiblePersistedPanelSnapshot(testing, workbench, sessionId);
    const initialTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const initialApp = await exactSessionApp(initialTarget.frame, sessionId);
    assert.ok(initialApp);
    const initialHeaderProfiles = initialApp.getByRole("button", { name: "Header profiles", exact: true });
    await initialHeaderProfiles.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await initialHeaderProfiles.getAttribute("aria-pressed"),
      "false",
      "The recovery journey must defer profiles until its renderer-owned request."
    );

    const generation = testing.runtimeGeneration();
    const runtimeId = testing.diagnostics().sessions.find((session) => session.publicId === sessionId)?.runtimeId;
    assert.ok(runtimeId);
    recordAcceptanceProgress("verify:visible-replay-recovery:restart");
    testing.restartRuntime("Injected visible panel recovery test.");
    await workbench
      .locator(".notifications-toasts.visible .notification-list-item")
      .first()
      .waitFor({ state: "visible", timeout: 2_000 })
      .catch(() => undefined);
    const availableCommands = new Set(await vscode.commands.getCommands(true));
    if (availableCommands.has("notifications.clearAll")) {
      await vscode.commands.executeCommand("notifications.clearAll");
    }
    if (availableCommands.has("notifications.hideList")) {
      await vscode.commands.executeCommand("notifications.hideList");
    }
    await workbench
      .locator(".notifications-toasts.visible .notification-list-item")
      .first()
      .waitFor({ state: "hidden", timeout: 10_000 });
    recordAcceptanceProgress("verify:visible-replay-recovery:header-profiles");
    await initialHeaderProfiles.click();
    await waitFor(
      () => testing.runtimeGeneration() === generation + 1,
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the renderer-originated Header profiles request to restart the runtime exactly once"
    );
    await waitFor(
      () => {
        const recovered = testing.diagnostics().sessions.find((session) => session.publicId === sessionId);
        return Boolean(recovered && recovered.runtimeId !== runtimeId);
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the visible panel session to bind its replacement runtime"
    );

    const recoveredTarget = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const recoveredApp = await exactSessionApp(recoveredTarget.frame, sessionId);
    assert.ok(recoveredApp);
    const recoveredHeaderProfiles = recoveredApp.getByRole("button", { name: "Header profiles", exact: true });
    await recoveredHeaderProfiles.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await recoveredHeaderProfiles.getAttribute("aria-pressed"), "true");
    const recoveredSelectedHeader = recoveredApp
      .locator(`th[data-column="${PERSISTED_PANEL_SELECTED_COLUMN}"]`)
      .first();
    await recoveredSelectedHeader.waitFor({ state: "visible", timeout: 10_000 });
    await waitForLocatorText(
      recoveredSelectedHeader,
      (text) =>
        !text.includes("Profiling\u2026") &&
        ["Missing", "Distinct", "Min", "Max"].every((label) => text.includes(label)),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "renderer-originated Header profiles to finish on the persisted selected column"
    );
    assert.equal(
      await testing.synchronizePanel(sessionId),
      true,
      "The recovered renderer must acknowledge its authoritative session snapshot."
    );
    recordAcceptanceProgress("verify:visible-replay-recovery:recovered-visible-state");
    const recovered = await visiblePersistedPanelSnapshot(testing, workbench, sessionId);
    assert.deepEqual(
      recovered,
      initial,
      "Runtime recovery and renderer-originated profiling must preserve the complete visible dataframe state."
    );
    assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes);
  } finally {
    if (sessionId) {
      await testing.disposePanelForSession(sessionId);
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        15_000,
        "the visible persistence session and replacement runtime to close"
      );
    }
    await insights.update("insightsOnOpen", previousInsightsOnOpen, vscode.ConfigurationTarget.Global);
    assert.deepEqual(readFileSync(fixture.fsPath), sourceBytes);
  }
}

async function verifyPersistedReplayAndRecovery(
  testing: TestApi,
  workspace: vscode.Uri,
  fixture: vscode.Uri
): Promise<void> {
  const sourceText = readFileSync(fixture.fsPath, "utf8");
  recordAcceptanceProgress("verify:replay-recovery:polars-open");
  const restored = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: csvSource(fixture),
    backend: "polars",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(restored.kind, "sessionOpened");
  if (restored.kind !== "sessionOpened") return;
  recordAcceptanceProgress("verify:replay-recovery:polars-opened");
  assert.deepEqual(
    restored.metadata.steps.map((step) => step.id),
    ["packaged-score"]
  );
  assert.equal(restored.metadata.shape.columns, 5);
  assert.equal(restored.page.rows[0]?.values[0]?.display, "Berlin");
  assert.equal(restored.page.rows[0]?.values[4]?.display, "24.0");
  assert.deepEqual(restored.metadata.filterModel.sort, [{ column: "sales", direction: "desc", nulls: "last" }]);
  const restoredSalesId = restored.metadata.schema.find((column) => column.name === "sales")?.id;
  assert.ok(restoredSalesId);
  assert.deepEqual(testing.activeSession()?.viewState, {
    filterModel: restored.metadata.filterModel,
    columnWidths: { [restoredSalesId]: 250 },
    selectedColumnId: restoredSalesId,
    viewport: { firstVisibleRow: SHORT_FIXTURE_FIRST_VISIBLE_ROW, scrollLeft: 35 }
  });

  const secondFixture = vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv");
  const secondSourceText = readFileSync(secondFixture.fsPath, "utf8");
  recordAcceptanceProgress("verify:replay-recovery:pandas-open");
  const second = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: tsvSource(secondFixture),
    backend: "pandas",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(second.kind, "sessionOpened");
  if (second.kind !== "sessionOpened") return;
  recordAcceptanceProgress("verify:replay-recovery:pandas-opened");
  assert.notEqual(second.metadata.sessionId, restored.metadata.sessionId);
  recordAcceptanceProgress("verify:replay-recovery:duckdb-open");
  const third = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: csvSource(fixture),
    backend: "duckdb",
    pageSize: 20,
    mode: "editing"
  });
  assert.equal(third.kind, "sessionOpened");
  if (third.kind !== "sessionOpened") return;
  recordAcceptanceProgress("verify:replay-recovery:duckdb-opened");
  assert.deepEqual(
    third.metadata.steps.map((step) => step.id),
    ["packaged-duckdb-score"]
  );
  assert.equal(third.metadata.shape.columns, 5);
  assert.equal(third.page.rows[0]?.values[0]?.display, "Berlin");
  assert.equal(third.page.rows[0]?.values[4]?.display, "36.0");
  assert.deepEqual(third.metadata.filterModel.sort, [{ column: "sales", direction: "desc", nulls: "last" }]);
  const duckdbSalesId = third.metadata.schema.find((column) => column.name === "sales")?.id;
  assert.ok(duckdbSalesId);
  assert.deepEqual(testing.activeSession()?.viewState, {
    filterModel: third.metadata.filterModel,
    columnWidths: { [duckdbSalesId]: 310 },
    selectedColumnId: duckdbSalesId,
    viewport: { firstVisibleRow: SHORT_FIXTURE_FIRST_VISIBLE_ROW, scrollLeft: 75 }
  });
  assert.notEqual(third.metadata.sessionId, restored.metadata.sessionId);
  assert.notEqual(third.metadata.sessionId, second.metadata.sessionId);
  assert.equal(testing.diagnostics().sessionCount, 3);
  testing.setActiveSession(second.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, second.metadata.sessionId);
  testing.setActiveSession(third.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, third.metadata.sessionId);
  testing.setActiveSession(restored.metadata.sessionId);
  assert.equal(testing.activeSession()?.sessionId, restored.metadata.sessionId);

  const beforeRestart = testing.diagnostics();
  const generation = testing.runtimeGeneration();
  recordAcceptanceProgress("verify:replay-recovery:restart");
  testing.restartRuntime("Injected packaged-editor recovery test.");
  recordAcceptanceProgress("verify:replay-recovery:concurrent-replay");
  const [restoredPage, secondPage, thirdPage] = await Promise.all([
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-restored-page",
      sessionId: restored.metadata.sessionId,
      revision: restored.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: restored.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-second-page",
      sessionId: second.metadata.sessionId,
      revision: second.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: second.metadata.filterModel
    }),
    testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "restart-duckdb-page",
      sessionId: third.metadata.sessionId,
      revision: third.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: third.metadata.filterModel
    })
  ]);
  recordAcceptanceProgress("verify:replay-recovery:replayed");
  assert.equal(restoredPage.kind, "page", `Polars recovery returned ${JSON.stringify(restoredPage)}.`);
  assert.equal(secondPage.kind, "page", `Pandas recovery returned ${JSON.stringify(secondPage)}.`);
  assert.equal(thirdPage.kind, "page", `DuckDB recovery returned ${JSON.stringify(thirdPage)}.`);
  if (restoredPage.kind !== "page" || secondPage.kind !== "page" || thirdPage.kind !== "page") return;
  assert.equal(testing.runtimeGeneration(), generation + 1, "Concurrent recovery must start exactly one runtime.");
  assert.equal(restoredPage.page.rows[0]?.values[4]?.display, "24.0");
  assert.equal(secondPage.metadata.shape.columns, 4);
  assert.equal(thirdPage.metadata.backend, "duckdb");
  assert.equal(thirdPage.metadata.shape.columns, 5);
  assert.equal(thirdPage.page.rows[0]?.values[4]?.display, "36.0");
  const afterRestart = testing.diagnostics();
  assert.equal(afterRestart.sessionCount, 3);
  for (const before of beforeRestart.sessions) {
    const after = afterRestart.sessions.find((session) => session.publicId === before.publicId);
    assert.ok(after);
    assert.notEqual(after.runtimeId, before.runtimeId, `Expected runtime replay for ${before.sourceLabel}.`);
  }

  const exportDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-export-"));
  try {
    for (const target of [
      {
        name: "polars",
        sessionId: restored.metadata.sessionId,
        revision: restoredPage.revision,
        columns: 5
      },
      { name: "pandas", sessionId: second.metadata.sessionId, revision: secondPage.revision, columns: 4 },
      { name: "duckdb", sessionId: third.metadata.sessionId, revision: thirdPage.revision, columns: 5 }
    ]) {
      const csvDestination = path.join(exportDirectory, `${target.name}.csv`);
      const csvExported = await testing.request({
        kind: "exportData",
        sessionId: target.sessionId,
        revision: target.revision,
        path: csvDestination,
        format: "csv"
      });
      assert.equal(csvExported.kind, "dataExported");
      if (csvExported.kind === "dataExported") assert.equal(csvExported.shape.columns, target.columns);
      assert.match(readFileSync(csvDestination, "utf8"), /city,year,sales,active/);

      const parquetDestination = path.join(exportDirectory, `${target.name}.parquet`);
      const parquetExported = await testing.request({
        kind: "exportData",
        sessionId: target.sessionId,
        revision: target.revision,
        path: parquetDestination,
        format: "parquet"
      });
      assert.equal(parquetExported.kind, "dataExported");
      if (parquetExported.kind === "dataExported") assert.equal(parquetExported.shape.columns, target.columns);
      assert.equal(readFileSync(parquetDestination).subarray(0, 4).toString("ascii"), "PAR1");
    }
    assert.equal(readFileSync(fixture.fsPath, "utf8"), sourceText, "Export must not modify the source fixture.");
    assert.equal(
      readFileSync(secondFixture.fsPath, "utf8"),
      secondSourceText,
      "Pandas export must not modify the source fixture."
    );
  } finally {
    cleanupAcceptanceTemporaryDirectory(exportDirectory);
  }

  const firstClosed = await testing.request({
    kind: "closeSession",
    sessionId: restored.metadata.sessionId,
    revision: restoredPage.revision
  });
  const secondClosed = await testing.request({
    kind: "closeSession",
    sessionId: second.metadata.sessionId,
    revision: secondPage.revision
  });
  const thirdClosed = await testing.request({
    kind: "closeSession",
    sessionId: third.metadata.sessionId,
    revision: thirdPage.revision
  });
  assert.equal(firstClosed.kind, "sessionClosed");
  assert.equal(secondClosed.kind, "sessionClosed");
  assert.equal(thirdClosed.kind, "sessionClosed");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "all recovered sessions and the standalone runtime to close"
  );
}

async function exercisePackagedFileInputs(testing: TestApi, workspace: vscode.Uri, python: string): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-file-inputs-"));
  const config = vscode.workspace.getConfiguration("openWrangler");
  const originalBackend = config.get<"auto" | "polars" | "duckdb" | "pandas">("defaultBackend", "auto");
  try {
    writeFileSync(
      path.join(directory, "sample.csv"),
      readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "sample.csv").fsPath)
    );
    const sampleTsv = readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "sample.tsv").fsPath);
    writeFileSync(path.join(directory, "sample-pandas.tsv"), sampleTsv);
    writeFileSync(path.join(directory, "sample-duckdb.tsv"), sampleTsv);
    const sampleJsonl = readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "sample.jsonl").fsPath);
    writeFileSync(path.join(directory, "sample-polars.jsonl"), sampleJsonl);
    writeFileSync(path.join(directory, "sample-duckdb.jsonl"), sampleJsonl);
    writeFileSync(path.join(directory, "configured.csv"), "name;value\nalpha;1\nbeta;2\n", "utf8");
    writeFileSync(
      path.join(directory, "reconfigure.csv"),
      [
        "name;value;category;status;amount;date;note;flag",
        ...Array.from(
          { length: 80 },
          (_, index) =>
            `row-${index};${index};group-${index % 4};${index % 2 === 0 ? "active" : "paused"};${index * 10};2026-07-${String((index % 28) + 1).padStart(2, "0")};note-${index};${index % 2 === 0}`
        )
      ].join("\n") + "\n",
      "utf8"
    );
    writeFileSync(path.join(directory, "configured.tsv"), "name|value\nalpha|1\nbeta|2\n", "utf8");
    const damagedCsvPrefix = Buffer.from(
      `name,value\n${"a".repeat(IMPORT_DETECTION_SAMPLE_BYTES - Buffer.byteLength("name,value\n", "utf8"))}`,
      "utf8"
    );
    assert.equal(damagedCsvPrefix.length, IMPORT_DETECTION_SAMPLE_BYTES);
    writeFileSync(
      path.join(directory, "damaged.csv"),
      Buffer.concat([damagedCsvPrefix, Buffer.from([0xff]), Buffer.from(",1\n", "utf8")])
    );
    writeFileSync(path.join(directory, "damaged.jsonl"), '{"name":"broken"\n', "utf8");
    writeFileSync(path.join(directory, "damaged.parquet"), "PAR1broken", "utf8");
    writeFileSync(path.join(directory, "damaged.xls"), "not-an-excel-workbook", "utf8");
    writeFileSync(
      path.join(directory, "legacy.xls"),
      gunzipSync(
        Buffer.from(
          readFileSync(vscode.Uri.joinPath(workspace, "fixtures", "legacy.xls.gz.base64").fsPath, "utf8").trim(),
          "base64"
        )
      )
    );
    execFileSync(
      python,
      [
        "-c",
        [
          "import sys",
          "from pathlib import Path",
          "import duckdb",
          "import polars as pl",
          "from openpyxl import Workbook",
          "root = Path(sys.argv[1])",
          "pl.DataFrame({'name': ['alpha', 'beta'], 'value': [1, 2], 'active': [True, False]}).write_parquet(root / 'sample.parquet')",
          "connection = duckdb.connect(config={'autoinstall_known_extensions': False, 'autoload_known_extensions': False})",
          "try:",
          "    connection.execute(\"SET TimeZone = 'Pacific/Auckland'\")",
          "    connection.execute(\"CREATE TABLE rich AS SELECT CAST('123456789012345678901234567890.12345678' AS DECIMAL(38,8)) AS exact_decimal, TIMESTAMPTZ '2026-07-16 14:30:00+02:00' AS zoned, [1, 2, NULL]::INTEGER[] AS items, {'label': 'alpha', 'score': 7} AS record UNION ALL SELECT CAST('-0.00000001' AS DECIMAL(38,8)), TIMESTAMPTZ '2026-01-01 00:15:00-08:00', []::INTEGER[], {'label': 'beta', 'score': NULL}\")",
          "    connection.execute(\"COPY rich TO ? (FORMAT PARQUET)\", [str(root / 'sample-duckdb-rich.parquet')])",
          "finally:",
          "    connection.close()",
          "workbook = Workbook()",
          "sheet = workbook.active",
          "sheet.title = 'Overview'",
          "sheet.append(['name', 'value', 'active'])",
          "sheet.append(['ignored-alpha', 11, True])",
          "sheet.append(['ignored-beta', 12, False])",
          "sheet = workbook.create_sheet('Sales')",
          "sheet.append(['name', 'value', 'active'])",
          "sheet.append(['alpha', 1, True])",
          "sheet.append(['beta', 2, False])",
          "workbook.save(root / 'sample.xlsx')"
        ].join("\n"),
        directory
      ],
      { encoding: "utf8" }
    );
    const duckdbRichParquetUri = vscode.Uri.file(path.join(directory, "sample-duckdb-rich.parquet"));
    const duckdbRichParquetSource = readFileSync(duckdbRichParquetUri.fsPath);
    const parquetLaunchUri = vscode.Uri.file(path.join(directory, "sample.parquet"));
    const parquetSource = readFileSync(parquetLaunchUri.fsPath);
    recordAcceptanceProgress("verify:file-inputs:canonical:polars:parquet:open");
    await config.update("defaultBackend", "polars", vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("openWrangler.openFile", parquetLaunchUri);
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === parquetLaunchUri.fsPath &&
          active.metadata.backend === "polars" &&
          active.metadata.shape.rows === 2 &&
          active.metadata.shape.columns === 3
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the editor-menu file URI to open through the canonical launch command",
      () =>
        packagedFileOpenDiagnostics(testing, {
          sourceLabel: path.basename(parquetLaunchUri.fsPath),
          backend: "polars",
          shape: { rows: 2, columns: 3 }
        })
    );
    recordAcceptanceProgress("verify:file-inputs:canonical:polars:parquet:opened");
    assert.deepEqual(
      readFileSync(parquetLaunchUri.fsPath),
      parquetSource,
      "Opening a source from an editor menu must not modify it."
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the editor-menu file session to dispose"
    );
    recordAcceptanceProgress("verify:file-inputs:canonical:polars:parquet:closed");

    recordAcceptanceProgress("verify:file-inputs:configured");
    await exerciseConfiguredFileImportOptions(testing, directory);
    recordAcceptanceProgress("verify:file-inputs:corrupt");
    await exerciseCorruptFileFailures(testing, directory, config);
    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      recordAcceptanceProgress("verify:file-inputs:configured:public-excel");
      await exercisePublicLegacyExcelImportOptions(testing, directory, config);
      recordAcceptanceProgress("verify:file-inputs:reconfigure");
      await exerciseLiveImportReconfiguration(testing, directory, config);
    }

    const fixtures: Array<{
      uri: vscode.Uri;
      backend: "polars" | "duckdb" | "pandas";
      shape: { rows: number; columns: number };
      verify?: () => Promise<void>;
    }> = [
      {
        uri: vscode.Uri.file(path.join(directory, "sample-pandas.tsv")),
        backend: "pandas" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample-duckdb.tsv")),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample-polars.jsonl")),
        backend: "polars" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample-duckdb.jsonl")),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.csv")),
        backend: "duckdb" as const,
        shape: { rows: 4, columns: 4 }
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.parquet")),
        backend: "polars" as const,
        shape: { rows: 2, columns: 3 }
      },
      {
        uri: duckdbRichParquetUri,
        backend: "duckdb" as const,
        shape: { rows: 2, columns: 4 },
        verify: () => verifyDuckDBRichParquetPage(testing, duckdbRichParquetUri, duckdbRichParquetSource)
      },
      {
        uri: vscode.Uri.file(path.join(directory, "sample.xlsx")),
        backend: "polars" as const,
        shape: { rows: 2, columns: 3 }
      }
    ];

    for (const fixture of fixtures) {
      const extension = path.extname(fixture.uri.fsPath).slice(1).toLowerCase();
      const checkpoint = `verify:file-inputs:${fixture.backend}:${extension}`;
      recordAcceptanceProgress(`${checkpoint}:open`);
      await config.update("defaultBackend", fixture.backend, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand(
        "vscode.openWith",
        fixture.uri,
        "openWrangler.viewer",
        vscode.ViewColumn.One
      );
      await waitFor(
        () => {
          const active = testing.activeSession();
          return (
            active?.metadata.source.path === fixture.uri.fsPath &&
            active.metadata.backend === fixture.backend &&
            active.metadata.shape.rows === fixture.shape.rows &&
            active.metadata.shape.columns === fixture.shape.columns
          );
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        `${path.basename(fixture.uri.fsPath)} to open through the packaged custom editor`,
        () =>
          packagedFileOpenDiagnostics(testing, {
            sourceLabel: path.basename(fixture.uri.fsPath),
            backend: fixture.backend,
            shape: fixture.shape
          })
      );
      recordAcceptanceProgress(`${checkpoint}:opened`);
      await fixture.verify?.();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        `${path.basename(fixture.uri.fsPath)} to dispose its session and runtime`
      );
      recordAcceptanceProgress(`${checkpoint}:closed`);
    }
  } finally {
    await config.update("defaultBackend", originalBackend, vscode.ConfigurationTarget.Global);
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function verifyDuckDBRichParquetPage(testing: TestApi, source: vscode.Uri, originalBytes: Buffer): Promise<void> {
  const active = testing.activeSession();
  assert.ok(active, "The rich DuckDB Parquet fixture must publish an active session.");
  assert.equal(active.metadata.backend, "duckdb");
  assert.equal(active.metadata.source.path, source.fsPath);
  assert.deepEqual(
    active.metadata.schema.map((column) => [column.name, column.type]),
    [
      ["exact_decimal", "decimal"],
      ["zoned", "datetime"],
      ["items", "list"],
      ["record", "struct"]
    ]
  );

  const response = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    viewRequestId: "packaged-duckdb-rich-parquet-page",
    sessionId: active.sessionId,
    revision: active.metadata.revision,
    offset: 0,
    limit: 20,
    filterModel: active.metadata.filterModel
  });
  assert.equal(response.kind, "page", "The rich DuckDB Parquet fixture must return a typed page.");
  if (response.kind !== "page") return;

  assert.deepEqual(gridColumnCells(response.page, columnReference(response.metadata, "exact_decimal").id)[0], {
    kind: "decimal",
    raw: "123456789012345678901234567890.12345678",
    display: "123456789012345678901234567890.12345678",
    isNull: false,
    isNaN: false
  });
  assert.deepEqual(gridColumnCells(response.page, columnReference(response.metadata, "zoned").id)[0], {
    kind: "datetime",
    raw: "2026-07-16T12:30:00+00:00",
    display: "2026-07-16T12:30:00+00:00",
    isNull: false,
    isNaN: false
  });
  assert.deepEqual(gridColumnCells(response.page, columnReference(response.metadata, "items").id)[0], {
    kind: "list",
    raw: [1, 2, null],
    display: "[1,2,null]",
    isNull: false,
    isNaN: false
  });
  assert.deepEqual(gridColumnCells(response.page, columnReference(response.metadata, "record").id)[0], {
    kind: "struct",
    raw: { label: "alpha", score: 7 },
    display: '{"label":"alpha","score":7}',
    isNull: false,
    isNaN: false
  });
  assert.doesNotThrow(
    () => JSON.parse(JSON.stringify(response.page.rows.map((row) => row.values))),
    "The rich DuckDB page must remain strict-JSON-safe."
  );
  assert.deepEqual(readFileSync(source.fsPath), originalBytes, "Opening rich DuckDB Parquet data must not modify it.");

  const replacement = `${source.fsPath}.replacement`;
  writeFileSync(replacement, Buffer.concat([originalBytes, Buffer.from([0])]));
  let replacementCommitted = false;
  await waitFor(
    () => {
      const state = testing.sessionSchedulerState(active.sessionId);
      if (!state?.quiescent) return false;
      // Keep the final scheduler check and source replacement in one
      // extension-host turn. A late webview request cannot start between them.
      renameSync(replacement, source.fsPath);
      replacementCommitted = true;
      return true;
    },
    10_000,
    "the rich DuckDB session scheduler to quiesce before source replacement",
    () =>
      JSON.stringify({
        scheduler: testing.sessionSchedulerState(active.sessionId),
        coordinator: testing.diagnostics()
      })
  );
  assert.equal(replacementCommitted, true, "The rich DuckDB source replacement must commit exactly once.");

  const invalidated = await testing.request({
    kind: "getPage",
    ...GRID_COLUMN_WINDOW,
    viewRequestId: "packaged-duckdb-rich-parquet-source-replaced",
    sessionId: active.sessionId,
    revision: response.revision,
    offset: 0,
    limit: 20,
    filterModel: response.metadata.filterModel
  });
  assert.equal(invalidated.kind, "error", "Replacing the rich DuckDB source must invalidate the live session.");
  if (invalidated.kind !== "error") return;
  assert.equal(invalidated.code, "engine_error");
  assert.equal(invalidated.recoverable, true);
  assert.match(invalidated.message, /source file.*changed or is no longer available.*Reopen the file/iu);
  assert.equal(invalidated.viewRequestId, "packaged-duckdb-rich-parquet-source-replaced");
}

async function exerciseConfiguredFileImportOptions(testing: TestApi, directory: string): Promise<void> {
  const csvPath = path.join(directory, "configured.csv");
  const tsvPath = path.join(directory, "configured.tsv");
  const excelPath = path.join(directory, "sample.xlsx");
  const legacyExcelPath = path.join(directory, "legacy.xls");
  const csvBytes = readFileSync(csvPath);
  const tsvBytes = readFileSync(tsvPath);
  const excelBytes = readFileSync(excelPath);
  const legacyExcelBytes = readFileSync(legacyExcelPath);

  const rejected = await testing.request({
    kind: "openSession",
    ...GRID_COLUMN_WINDOW,
    source: {
      kind: "file",
      label: "configured.csv",
      path: csvPath,
      importOptions: { delimiter: "", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    },
    backend: "polars",
    pageSize: 20,
    mode: "viewing"
  });
  assert.equal(rejected.kind, "error", "Malformed import options must fail before a session is retained.");
  if (rejected.kind === "error") {
    assert.equal(rejected.code, "invalid_request");
    assert.match(rejected.message, /delimiter must contain exactly one Unicode code point/u);
  }
  assert.equal(testing.diagnostics().sessionCount, 0, "An invalid import attempt must not retain a session.");
  await waitFor(
    () => !testing.runtimeRunning(),
    10_000,
    "the invalid import attempt to release its standalone runtime"
  );

  const cases: Array<{
    label: string;
    source: SessionSource;
    backend: "polars" | "pandas";
    expectedColumns: string[];
    expectedFirstColumn: string[];
  }> = [
    {
      label: "non-default CSV delimiter",
      source: {
        kind: "file",
        label: "configured.csv",
        path: csvPath,
        importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      },
      backend: "polars",
      expectedColumns: ["name", "value"],
      expectedFirstColumn: ["alpha", "beta"]
    },
    {
      label: "non-default TSV delimiter",
      source: {
        kind: "file",
        label: "configured.tsv",
        path: tsvPath,
        importOptions: { delimiter: "|", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      },
      backend: "pandas",
      expectedColumns: ["name", "value"],
      expectedFirstColumn: ["alpha", "beta"]
    },
    {
      label: "Excel sheet name",
      source: {
        kind: "file",
        label: "sample.xlsx",
        path: excelPath,
        importOptions: { sheetName: "Sales" }
      },
      backend: "polars",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["alpha", "beta"]
    },
    {
      label: "zero-based Excel sheet index",
      source: {
        kind: "file",
        label: "sample.xlsx",
        path: excelPath,
        importOptions: { sheetIndex: 1 }
      },
      backend: "pandas",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["alpha", "beta"]
    },
    {
      label: "BIFF Excel sheet name in Polars",
      source: {
        kind: "file",
        label: "legacy.xls",
        path: legacyExcelPath,
        importOptions: { sheetName: "second" }
      },
      backend: "polars",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["second", "résumé"]
    },
    {
      label: "BIFF Excel sheet index in Polars",
      source: {
        kind: "file",
        label: "legacy.xls",
        path: legacyExcelPath,
        importOptions: { sheetIndex: 1 }
      },
      backend: "polars",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["second", "résumé"]
    },
    {
      label: "BIFF Excel sheet name in Pandas",
      source: {
        kind: "file",
        label: "legacy.xls",
        path: legacyExcelPath,
        importOptions: { sheetName: "second" }
      },
      backend: "pandas",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["second", "résumé"]
    },
    {
      label: "BIFF Excel sheet index in Pandas",
      source: {
        kind: "file",
        label: "legacy.xls",
        path: legacyExcelPath,
        importOptions: { sheetIndex: 1 }
      },
      backend: "pandas",
      expectedColumns: ["name", "value", "active"],
      expectedFirstColumn: ["second", "résumé"]
    }
  ];
  const openedSessions: Array<{ sessionId: string; revision: number }> = [];
  try {
    for (const candidate of cases) {
      recordAcceptanceProgress(
        `verify:file-inputs:configured:${candidate.backend}:${candidate.label.replaceAll(" ", "-")}:open`
      );
      const opened = await testing.request({
        kind: "openSession",
        ...GRID_COLUMN_WINDOW,
        source: candidate.source,
        backend: candidate.backend,
        pageSize: 20,
        mode: "viewing"
      });
      assert.equal(opened.kind, "sessionOpened", `${candidate.label} must open through ${candidate.backend}.`);
      if (opened.kind !== "sessionOpened") continue;
      openedSessions.push({
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision
      });
      assert.equal(opened.metadata.backend, candidate.backend);
      assert.deepEqual(opened.metadata.source, candidate.source);
      assert.deepEqual(
        opened.metadata.schema.map((column) => column.name),
        candidate.expectedColumns
      );
      const firstColumn = opened.metadata.schema[0];
      assert.ok(firstColumn, `${candidate.label} must expose its first selected column.`);
      assert.deepEqual(gridColumnDisplays(opened.page, firstColumn.id), candidate.expectedFirstColumn);
      recordAcceptanceProgress(
        `verify:file-inputs:configured:${candidate.backend}:${candidate.label.replaceAll(" ", "-")}:opened`
      );
    }
  } finally {
    for (const session of openedSessions.reverse()) {
      const closed = await testing.request({
        kind: "closeSession",
        sessionId: session.sessionId,
        revision: session.revision
      });
      assert.equal(closed.kind, "sessionClosed");
    }
  }
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the configured import sessions to close without retaining a runtime"
  );
  assert.deepEqual(readFileSync(csvPath), csvBytes, "Configured CSV import must not modify its source.");
  assert.deepEqual(readFileSync(tsvPath), tsvBytes, "Configured TSV import must not modify its source.");
  assert.deepEqual(readFileSync(excelPath), excelBytes, "Excel sheet selection must not modify its workbook.");
  assert.deepEqual(
    readFileSync(legacyExcelPath),
    legacyExcelBytes,
    "BIFF Excel sheet selection must not modify its workbook."
  );
}

async function exercisePublicLegacyExcelImportOptions(
  testing: TestApi,
  directory: string,
  config: vscode.WorkspaceConfiguration
): Promise<void> {
  const page = await connectToEditorWorkbench();
  const source = vscode.Uri.file(path.join(directory, "legacy.xls"));
  const sourceBytes = readFileSync(source.fsPath);

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the public BIFF import scenarios to start without a retained session or runtime"
  );

  for (const scenario of [
    {
      backend: "polars" as const
    },
    {
      backend: "pandas" as const
    }
  ] as const) {
    const checkpoint = `verify:file-inputs:configured:public-excel:${scenario.backend}`;
    await config.update("defaultBackend", scenario.backend, vscode.ConfigurationTarget.Global);
    recordAcceptanceProgress(`${checkpoint}:open`);
    await vscode.commands.executeCommand("openWrangler.openFile", source);

    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === source.fsPath &&
          active.metadata.backend === scenario.backend &&
          active.metadata.shape.rows === 1 &&
          active.metadata.shape.columns === 3
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      `legacy.xls to open its first worksheet automatically through the public ${scenario.backend} workflow`,
      () =>
        packagedFileOpenDiagnostics(testing, {
          sourceLabel: path.basename(source.fsPath),
          backend: scenario.backend,
          shape: { rows: 1, columns: 3 }
        })
    );

    assert.equal(
      await page.locator(".quick-input-widget:visible").filter({ hasText: "Excel sheet" }).count(),
      0,
      `The public ${scenario.backend} BIFF workflow must open its first worksheet without an import prompt.`
    );
    const initiallyActive = testing.activeSession();
    assert.ok(initiallyActive, `The public ${scenario.backend} BIFF workflow must publish an active session.`);
    const stableSessionId = initiallyActive.sessionId;
    const stableSourceIdentity = fileSourceIdentity(initiallyActive.metadata.source);
    assert.deepEqual(
      initiallyActive.metadata.source.importOptions,
      { sheetIndex: 0 },
      `The public ${scenario.backend} BIFF workflow must record its automatic first-sheet selection.`
    );
    assert.deepEqual(
      initiallyActive.metadata.schema.map((column) => column.name),
      ["name", "value", "active"],
      `The public ${scenario.backend} BIFF workflow must expose the first worksheet schema.`
    );
    const initialFirstColumn = initiallyActive.metadata.schema[0];
    assert.ok(initialFirstColumn, `The public ${scenario.backend} BIFF workflow must expose its first column.`);
    const initialGrid = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `public-biff-${scenario.backend}-initial`,
      sessionId: stableSessionId,
      revision: initiallyActive.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: initiallyActive.metadata.filterModel
    });
    assert.equal(
      initialGrid.kind,
      "page",
      `The public ${scenario.backend} BIFF workflow must return its automatic first-sheet page.`
    );
    if (initialGrid.kind !== "page") {
      throw new Error(`The public ${scenario.backend} BIFF workflow did not return its first-sheet page.`);
    }
    assert.deepEqual(
      gridColumnDisplays(initialGrid.page, initialFirstColumn.id),
      ["first"],
      `The public ${scenario.backend} BIFF workflow must initially read the first worksheet.`
    );
    assert.deepEqual(
      readFileSync(source.fsPath),
      sourceBytes,
      `The public ${scenario.backend} automatic BIFF open must not modify its source.`
    );
    recordAcceptanceProgress(`${checkpoint}:opened-first-sheet`);

    recordAcceptanceProgress(`${checkpoint}:change-sheet`);
    const changingSheet = vscode.commands.executeCommand("openWrangler.changeImportOptions");
    await acceptSearchableExcelSheet(page, testing, source, stableSessionId, "second");
    await changingSheet;
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.sessionId === stableSessionId &&
          active.metadata.source.path === source.fsPath &&
          active.metadata.backend === scenario.backend &&
          active.metadata.source.importOptions?.sheetName === "second" &&
          active.metadata.shape.rows === 2 &&
          active.metadata.shape.columns === 3
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      `the public ${scenario.backend} BIFF session to adopt the selected worksheet by name`,
      () =>
        packagedFileOpenDiagnostics(testing, {
          sourceLabel: path.basename(source.fsPath),
          backend: scenario.backend,
          shape: { rows: 2, columns: 3 }
        })
    );

    const active = testing.activeSession();
    assert.ok(active, `The reconfigured public ${scenario.backend} BIFF workflow must remain active.`);
    assert.equal(
      active.sessionId,
      stableSessionId,
      `The public ${scenario.backend} worksheet change must retain the public session identity.`
    );
    assert.deepEqual(
      fileSourceIdentity(active.metadata.source),
      stableSourceIdentity,
      `The public ${scenario.backend} worksheet change must retain the exact source identity.`
    );
    assert.deepEqual(
      active.metadata.source.importOptions,
      { sheetName: "second" },
      `The public ${scenario.backend} BIFF workflow must preserve its selected worksheet name.`
    );
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      ["name", "value", "active"],
      `The public ${scenario.backend} BIFF workflow must expose the selected worksheet schema.`
    );
    assert.equal(
      testing.diagnostics().sessions.filter((session) => session.publicId === stableSessionId).length,
      1,
      `The public ${scenario.backend} worksheet change must retain exactly one private session owner.`
    );
    const firstColumn = active.metadata.schema[0];
    assert.ok(firstColumn, `The public ${scenario.backend} BIFF workflow must expose its first column.`);
    const grid = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `public-biff-${scenario.backend}-second`,
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 20,
      filterModel: active.metadata.filterModel
    });
    assert.equal(grid.kind, "page", `The public ${scenario.backend} BIFF workflow must return a live grid page.`);
    if (grid.kind !== "page") {
      throw new Error(`The public ${scenario.backend} BIFF workflow did not return a page.`);
    }
    assert.deepEqual(
      gridColumnDisplays(grid.page, firstColumn.id),
      ["second", "résumé"],
      `The public ${scenario.backend} BIFF workflow must read the selected worksheet.`
    );
    assert.deepEqual(
      readFileSync(source.fsPath),
      sourceBytes,
      `The public ${scenario.backend} BIFF workflow must not modify its source.`
    );
    recordAcceptanceProgress(`${checkpoint}:changed-sheet`);

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `the public ${scenario.backend} BIFF session and runtime to close`
    );
    assert.equal(
      testing.activeSession(),
      undefined,
      `Closing the public ${scenario.backend} BIFF panel must deactivate it.`
    );
    assert.deepEqual(
      readFileSync(source.fsPath),
      sourceBytes,
      `Closing the public ${scenario.backend} BIFF workflow must leave its source byte-identical.`
    );
    recordAcceptanceProgress(`${checkpoint}:closed`);
  }
}

async function exerciseCorruptFileFailures(
  testing: TestApi,
  directory: string,
  config: vscode.WorkspaceConfiguration
): Promise<void> {
  await config.update("defaultBackend", "auto", vscode.ConfigurationTarget.Global);
  for (const name of ["damaged.csv", "damaged.jsonl", "damaged.parquet", "damaged.xls"]) {
    const uri = vscode.Uri.file(path.join(directory, name));
    const sourceBytes = readFileSync(uri.fsPath);
    const generationBeforeOpen = testing.runtimeGeneration();
    recordAcceptanceProgress(`verify:file-inputs:corrupt:${path.extname(name).slice(1)}:open`);
    await vscode.commands.executeCommand("vscode.openWith", uri, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () =>
        testing.runtimeGeneration() > generationBeforeOpen &&
        testing.diagnostics().sessionCount === 0 &&
        !testing.runtimeRunning(),
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      `${name} to fail without retaining a session or runtime`
    );
    assert.equal(testing.activeSession(), undefined, `${name} must not publish an active session.`);
    assert.deepEqual(readFileSync(uri.fsPath), sourceBytes, `${name} must remain byte-identical after a failed open.`);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `${name} failure panel to close without retained runtime state`
    );
    recordAcceptanceProgress(`verify:file-inputs:corrupt:${path.extname(name).slice(1)}:closed`);
  }
}

function stableImportReconfigurationSnapshot(active: ReturnType<TestApi["activeSession"]>): unknown {
  if (!active) return undefined;
  const { stats: _progressiveStats, ...metadata } = active.metadata;
  return {
    sessionId: active.sessionId,
    metadata,
    code: active.code,
    viewState: active.viewState,
    stepInspection: active.stepInspection
  };
}

function stableImportDiagnostics(diagnostics: ReturnType<TestApi["diagnostics"]>): ReturnType<TestApi["diagnostics"]> {
  return structuredClone(diagnostics);
}

async function waitForOpenWranglerWebviewButton(
  workbench: Page,
  name: string,
  requireEnabled = false
): Promise<Locator> {
  const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
  discovery: do {
    const browser = workbench.context().browser();
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    for (const target of openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_TARGET_LIMIT)) {
      if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
      try {
        const button = target.frame.getByRole("button", { name, exact: true }).first();
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break discovery;
        const available = await withAcceptanceOperationDeadline(
          (async () => {
            if ((await button.count()) === 0 || !(await button.isVisible())) return false;
            return !requireEnabled || (await button.isEnabled());
          })(),
          remainingMs,
          `the Open Wrangler ${JSON.stringify(name)} button`
        );
        if (available) return button;
      } catch (error) {
        if (Date.now() >= deadline) break discovery;
        ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);

  const browser = workbench.context().browser();
  assertOpenWranglerWebviewLifecycle(workbench, browser);
  const diagnostics = await openWranglerWebviewDiagnostics(workbench, browser, name);
  assertOpenWranglerWebviewLifecycle(workbench, browser);
  throw new Error(
    `The Open Wrangler webview did not expose a visible${requireEnabled ? " enabled" : ""} ` +
      `${JSON.stringify(name)} button: ${JSON.stringify(diagnostics)}`
  );
}

interface GridViewportMeasurement {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

async function waitForOpenWranglerGridViewport(
  action: Locator,
  expected: Pick<GridViewportMeasurement, "scrollTop" | "scrollLeft">
): Promise<GridViewportMeasurement> {
  return withAcceptanceOperationDeadline(
    action.evaluate(
      (_element, target) =>
        new Promise<GridViewportMeasurement>((resolve, reject) => {
          const scroller = _element.ownerDocument.querySelector('[data-testid="data-grid-scroller"]');
          if (!scroller) {
            reject(new Error("The Open Wrangler grid scroller is unavailable."));
            return;
          }
          const deadline = performance.now() + 5_000;
          const read = (): GridViewportMeasurement => ({
            scrollTop: scroller.scrollTop,
            scrollLeft: scroller.scrollLeft,
            scrollHeight: scroller.scrollHeight,
            scrollWidth: scroller.scrollWidth,
            clientHeight: scroller.clientHeight,
            clientWidth: scroller.clientWidth
          });
          const poll = () => {
            const current = read();
            const overflowed = current.scrollHeight > current.clientHeight && current.scrollWidth > current.clientWidth;
            const positioned =
              Math.abs(current.scrollTop - target.scrollTop) <= 1 &&
              Math.abs(current.scrollLeft - target.scrollLeft) <= 1;
            if (overflowed && positioned) {
              resolve(current);
              return;
            }
            if (performance.now() >= deadline) {
              resolve(current);
              return;
            }
            setTimeout(poll, 25);
          };
          poll();
        }),
      expected
    ),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the synchronized Open Wrangler grid viewport"
  );
}

interface OpenWranglerWebviewTarget {
  page: Page;
  frame: Frame;
  pageIndex: number;
  frameIndex: number;
  isWorkbenchPage: boolean;
  isMainFrame: boolean;
  protocol: string;
  isWebview: boolean;
  isOpenWranglerWebview: boolean;
}

function openWranglerWebviewTargets(
  workbench: Page,
  browser: Browser | null,
  limit: number
): OpenWranglerWebviewTarget[] {
  const discovered = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  const pages = [workbench, ...discovered.filter((candidate) => candidate !== workbench && !candidate.isClosed())];
  const uniquePages = pages.filter((candidate, index) => pages.indexOf(candidate) === index);
  const targets: OpenWranglerWebviewTarget[] = [];
  for (const [pageIndex, candidate] of uniquePages.entries()) {
    if (candidate !== workbench && candidate.isClosed()) continue;
    const frames = candidate
      .frames()
      .map((frame, frameIndex) => ({ frame, frameIndex, classification: classifyRendererUrl(frame.url()) }));
    for (const { frame, frameIndex, classification } of frames) {
      targets.push({
        page: candidate,
        frame,
        pageIndex,
        frameIndex,
        isWorkbenchPage: candidate === workbench,
        isMainFrame: frame === candidate.mainFrame(),
        ...classification
      });
    }
  }
  return prioritizeNewestRendererTargets(targets, limit);
}

function classifyRendererUrl(url: string): {
  protocol: string;
  isWebview: boolean;
  isOpenWranglerWebview: boolean;
} {
  let protocol = "other";
  try {
    const candidate = new URL(url).protocol.toLowerCase();
    if (
      candidate === "about:" ||
      candidate === "file:" ||
      candidate === "http:" ||
      candidate === "https:" ||
      candidate === "vscode-file:" ||
      candidate === "vscode-webview:"
    ) {
      protocol = candidate;
    }
  } catch {
    // The diagnostic retains only an allowlisted protocol classification.
  }
  const normalized = url.toLowerCase();
  return {
    protocol,
    isWebview: protocol === "vscode-webview:" || normalized.includes("vscode-webview"),
    isOpenWranglerWebview:
      normalized.includes("matt17br.openwrangler") ||
      normalized.includes("openwrangler") ||
      normalized.includes("open-wrangler")
  };
}

function assertOpenWranglerWebviewLifecycle(workbench: Page, browser: Browser | null): void {
  if (workbench.isClosed()) throw new Error("The editor workbench closed during Open Wrangler webview discovery.");
  if (browser !== null && !browser.isConnected()) {
    throw new Error("The editor CDP browser disconnected during Open Wrangler webview discovery.");
  }
}

function activeEditorTabDiagnostic(): Record<string, boolean | string> {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  const constructorName =
    typeof input === "object" && input !== null
      ? (input as { constructor?: { name?: unknown } }).constructor?.name
      : undefined;
  const viewType =
    typeof input === "object" &&
    input !== null &&
    "viewType" in input &&
    typeof (input as { viewType?: unknown }).viewType === "string"
      ? (input as { viewType: string }).viewType
      : "";
  return {
    label: tab?.label ?? "",
    inputType: typeof constructorName === "string" ? constructorName : typeof input,
    viewType,
    isOpenWranglerSession: tab ? isOpenWranglerSessionTab(tab) : false
  };
}

async function openWranglerGridDiagnostics(
  workbench: Page,
  browser: Browser | null,
  expectedSessionId: string
): Promise<unknown> {
  const allTargets = openWranglerWebviewTargets(workbench, browser, Number.MAX_SAFE_INTEGER);
  const targets = allTargets.slice(0, OPEN_WRANGLER_WEBVIEW_DIAGNOSTIC_TARGET_LIMIT);
  const summary = {
    totalTargets: allTargets.length,
    openWranglerTargets: allTargets.filter((target) => target.isOpenWranglerWebview).length,
    diagnosedTargets: targets.length
  };
  try {
    const targetsState = await withAcceptanceOperationDeadline(
      Promise.all(
        targets.map(async (target) => {
          if (isRetiredRendererTarget(workbench, target.page, target.frame)) {
            return rendererTargetDiagnostic(target, { retired: true, attached: false });
          }
          try {
            const apps = target.frame.locator("main.app");
            const sessionIds = (
              await target.frame.locator("main.app[data-session-id]").evaluateAll((elements) =>
                elements
                  .map((element) => element.getAttribute("data-session-id") ?? "")
                  .filter((sessionId) => sessionId.length > 0)
                  .slice(0, 4)
              )
            ).join(",");
            const exactApp = await exactSessionApp(target.frame, expectedSessionId);
            const exactGrid = exactApp?.locator('[data-testid="data-grid-scroller"] [role="grid"]').first();
            const [roots, appCount, gridCount, exactAppVisible, exactGridCount, exactGridVisible] = await Promise.all([
              target.frame.locator("#root").count(),
              apps.count(),
              target.frame.locator('[data-testid="data-grid-scroller"] [role="grid"]').count(),
              exactApp?.isVisible() ?? Promise.resolve(false),
              exactGrid?.count() ?? Promise.resolve(0),
              exactGrid?.isVisible() ?? Promise.resolve(false)
            ]);
            return rendererTargetDiagnostic(target, {
              retired: false,
              attached: !target.frame.isDetached(),
              roots,
              apps: appCount,
              grids: gridCount,
              sessionIds,
              exactAppVisible,
              exactGridCount,
              exactGridVisible
            });
          } catch (error) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
            return rendererTargetDiagnostic(target, { retired: true, attached: false });
          }
        })
      ),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "bounded exact-session Open Wrangler grid diagnostics"
    );
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    return { ...summary, targets: targetsState };
  } catch (error) {
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    if (error instanceof Error && error.message.startsWith("Timed out waiting for bounded exact-session")) {
      return { ...summary, targets: "unavailable within the diagnostics deadline" };
    }
    throw error;
  }
}

async function openWranglerWebviewDiagnostics(
  workbench: Page,
  browser: Browser | null,
  name: string
): Promise<unknown> {
  const targets = openWranglerWebviewTargets(workbench, browser, OPEN_WRANGLER_WEBVIEW_DIAGNOSTIC_TARGET_LIMIT);
  try {
    const diagnostics = await withAcceptanceOperationDeadline(
      Promise.all(
        targets.map(async (target) => {
          if (isRetiredRendererTarget(workbench, target.page, target.frame)) {
            return rendererTargetDiagnostic(target, { retired: true });
          }
          try {
            const button = target.frame.getByRole("button", { name, exact: true });
            const [readyState, roots, appWorkspaces, contentSecurityPolicies, scripts, buttons, firstButtonVisible] =
              await Promise.all([
                target.frame.locator(":root").evaluate((root) => root.ownerDocument.readyState),
                target.frame.locator("#root").count(),
                target.frame.locator('[data-testid="app-workspace"]').count(),
                target.frame.locator('meta[http-equiv="Content-Security-Policy"]').count(),
                target.frame.locator("script").count(),
                button.count(),
                button.first().isVisible()
              ]);
            return rendererTargetDiagnostic(target, {
              readyState:
                readyState === "loading" || readyState === "interactive" || readyState === "complete"
                  ? readyState
                  : "unavailable",
              roots,
              appWorkspaces,
              contentSecurityPolicies,
              scripts,
              buttons,
              firstButtonVisible
            });
          } catch (error) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
            return rendererTargetDiagnostic(target, { retired: true });
          }
        })
      ),
      WORKBENCH_DIAGNOSTIC_TIMEOUT_MS,
      "bounded Open Wrangler webview diagnostics"
    );
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    return diagnostics;
  } catch (error) {
    assertOpenWranglerWebviewLifecycle(workbench, browser);
    if (error instanceof Error && error.message.startsWith("Timed out waiting for bounded Open Wrangler")) {
      return "unavailable within the diagnostics deadline";
    }
    throw error;
  }
}

function rendererTargetDiagnostic(
  target: OpenWranglerWebviewTarget,
  detail: Record<string, boolean | number | string>
): Record<string, boolean | number | string> {
  return {
    pageIndex: target.pageIndex,
    frameIndex: target.frameIndex,
    isWorkbenchPage: target.isWorkbenchPage,
    isMainFrame: target.isMainFrame,
    protocol: target.protocol,
    isWebview: target.isWebview,
    isOpenWranglerWebview: target.isOpenWranglerWebview,
    ...detail
  };
}

async function exerciseLiveImportReconfiguration(
  testing: TestApi,
  directory: string,
  config: vscode.WorkspaceConfiguration
): Promise<void> {
  const page = await connectToEditorWorkbench();
  const configured = vscode.Uri.file(path.join(directory, "reconfigure.csv"));
  const configuredBytes = readFileSync(configured.fsPath);
  await config.update("defaultBackend", "auto", vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const opening = vscode.commands.executeCommand("openWrangler.openFile", configured);
  await waitForAutomaticDelimitedImport(page, testing, configured, "verify:file-inputs:reconfigure:initial-options");
  await opening;
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.source.path === configured.fsPath &&
        active.metadata.shape.rows === 80 &&
        active.metadata.shape.columns === 8
      );
    },
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the semicolon CSV to open with automatically detected import options"
  );

  const before = testing.activeSession();
  assert.ok(before, "The configurable CSV must publish an active session.");
  assert.deepEqual(
    before.metadata.source.importOptions,
    {
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    },
    "Automatic import detection must establish the baseline before reconfiguration selects a real alternative."
  );
  const stableSessionId = before.sessionId;
  const stableSourceIdentity = fileSourceIdentity(before.metadata.source);
  const initialDiagnostics = testing.diagnostics();
  const initialRuntimeId = initialDiagnostics.sessions.find(
    (session) => session.publicId === stableSessionId
  )?.runtimeId;
  assert.ok(initialRuntimeId, "The active configurable CSV must own a runtime session.");

  const changeTitleAction = page
    .locator(
      '.part.editor .editor-group-container.active .editor-actions [aria-label*="Change Import Options"]:visible'
    )
    .first();
  await withAcceptanceOperationDeadline(
    changeTitleAction.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the generic Open Wrangler Change Import Options title action"
  );
  await withAcceptanceOperationDeadline(
    changeTitleAction.click(),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the generic Open Wrangler Change Import Options title action click"
  );
  await acceptDelimitedImportOptions(
    page,
    testing,
    configured,
    stableSessionId,
    "verify:file-inputs:reconfigure:title-options",
    {
      delimiter: "Semicolon",
      encoding: "utf-8",
      header: "First row contains column names",
      quoteChar: "'"
    }
  );
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.sessionId === stableSessionId &&
        active.metadata.source.path === configured.fsPath &&
        active.metadata.shape.rows === 80 &&
        active.metadata.shape.columns === 8 &&
        active.metadata.source.importOptions?.delimiter === ";" &&
        active.metadata.source.importOptions.quoteChar === "'"
      );
    },
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the live CSV session to atomically adopt its semicolon import options"
  );
  // The test API can observe replacement metadata while the coordinator is
  // still persisting it. Restore focus after the final Quick Input and require
  // the exact session's physical, authoritative renderer before continuing.
  await focusAndSynchronizeExactSessionPanel(page, testing, stableSessionId, path.basename(configured.fsPath));
  recordAcceptanceProgress("verify:file-inputs:reconfigure:title-options:renderer-synchronized");

  const changed = testing.activeSession();
  assert.ok(changed, "The reconfigured CSV must remain active.");
  assert.equal(changed.sessionId, stableSessionId, "Import reconfiguration must retain the public session ID.");
  assert.deepEqual(
    fileSourceIdentity(changed.metadata.source),
    stableSourceIdentity,
    "Import reconfiguration must retain the exact source identity."
  );
  assert.deepEqual(changed.metadata.source.importOptions, {
    delimiter: ";",
    encoding: "utf-8",
    quoteChar: "'",
    hasHeader: true
  });
  assert.deepEqual(
    readFileSync(configured.fsPath),
    configuredBytes,
    "Live reconfiguration must not modify its source."
  );
  const changedRuntimeId = testing
    .diagnostics()
    .sessions.find((session) => session.publicId === stableSessionId)?.runtimeId;
  assert.ok(changedRuntimeId, "The reconfigured public session must retain one private runtime.");
  assert.notEqual(
    changedRuntimeId,
    initialRuntimeId,
    "A successful import reconfiguration must replace, not mutate, its private runtime."
  );
  const retainedColumn = changed.metadata.schema.find((column) => column.name === "value");
  assert.ok(retainedColumn, "The reconfigured CSV must expose its value column for reload-state acceptance.");
  const retainedColumnWidths = Object.fromEntries(changed.metadata.schema.map((column) => [column.id, 640]));
  const retainedViewState = {
    selectedColumnId: retainedColumn.id,
    columnWidths: retainedColumnWidths,
    viewport: { firstVisibleRow: 1, scrollLeft: 23 }
  };
  assert.equal(
    await testing.synchronizePanel(stableSessionId),
    true,
    "The reconfigured renderer must settle its authoritative default view before acceptance injects retained state."
  );
  recordAcceptanceProgress("verify:file-inputs:reconfigure:view-state:default-synchronized");
  await testing.updateViewState(stableSessionId, retainedViewState);
  assert.equal(
    await testing.synchronizePanel(stableSessionId),
    true,
    "The acceptance view-state injection must commit through the real renderer before native import actions."
  );
  recordAcceptanceProgress("verify:file-inputs:reconfigure:view-state:retained-synchronized");
  const synchronizedGridAction = await waitForExactSessionWebviewButton(
    page,
    testing,
    stableSessionId,
    "Import options",
    true
  );
  const physicalViewport = await waitForOpenWranglerGridViewport(synchronizedGridAction, {
    scrollTop: 29,
    scrollLeft: 23
  });
  recordAcceptanceProgress("verify:file-inputs:reconfigure:view-state:physical");
  assert.ok(
    physicalViewport.scrollHeight > physicalViewport.clientHeight,
    "The import-reconfiguration fixture must overflow the real grid vertically."
  );
  assert.ok(
    physicalViewport.scrollWidth > physicalViewport.clientWidth,
    "The import-reconfiguration fixture must overflow the real grid horizontally."
  );
  assert.ok(
    Math.abs(physicalViewport.scrollTop - 29) <= 1,
    "The real grid must commit the injected first visible row before cancellation acceptance."
  );
  assert.ok(
    Math.abs(physicalViewport.scrollLeft - 23) <= 1,
    "The real grid must commit the injected horizontal viewport before cancellation acceptance."
  );
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.viewState.selectedColumnId === retainedViewState.selectedColumnId &&
        changed.metadata.schema.every((column) => active.viewState.columnWidths[column.id] === 640) &&
        active.viewState.viewport.firstVisibleRow === 1 &&
        active.viewState.viewport.scrollLeft === 23
      );
    },
    5_000,
    "the reconfigured CSV view state to persist under its confirmed source and backend",
    () =>
      JSON.stringify({
        expected: retainedViewState,
        actual: testing.activeSession()?.viewState
      })
  );
  recordAcceptanceProgress("verify:file-inputs:reconfigure:view-state:persisted");

  const activeTab = page
    .locator(".part.editor .editor-group-container.active .tabs-container .tab.active")
    .filter({ hasText: path.basename(configured.fsPath) })
    .last();
  const { action: tabImportAction } = await openEditorTabContextMenu(
    page,
    activeTab,
    "Open Wrangler: Change Import Options"
  );
  assert.ok(tabImportAction, "The generic Open Wrangler tab must expose Change Import Options.");
  await tabImportAction.click();
  const delimiterPrompt = await waitForImportQuickInput(page, testing, configured, "Delimiter", stableSessionId);
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.viewState.selectedColumnId === retainedViewState.selectedColumnId &&
        changed.metadata.schema.every((column) => active.viewState.columnWidths[column.id] === 640) &&
        active.viewState.viewport.firstVisibleRow === 1 &&
        active.viewState.viewport.scrollLeft === 23
      );
    },
    5_000,
    "the native import action to flush the physically confirmed renderer view"
  );
  const confirmedBeforeCancellation = stableImportReconfigurationSnapshot(testing.activeSession());
  const diagnosticsBeforeCancellation = stableImportDiagnostics(testing.diagnostics());
  await waitForImportNaturalKeyboardFocus(delimiterPrompt, "Delimiter", "contains");
  await withAcceptanceOperationDeadline(
    page.keyboard.press("Escape"),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the live import-options cancellation"
  );
  await withAcceptanceOperationDeadline(
    delimiterPrompt.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the cancelled live import-options prompt to close"
  );
  assert.deepEqual(
    stableImportReconfigurationSnapshot(testing.activeSession()),
    confirmedBeforeCancellation,
    "Cancelling import reconfiguration must preserve the exact confirmed active snapshot."
  );
  assert.deepEqual(
    stableImportDiagnostics(testing.diagnostics()),
    diagnosticsBeforeCancellation,
    "Cancelling import reconfiguration must not create, replace, or retain a runtime session."
  );

  const gridImportAction = await waitForExactSessionWebviewButton(page, testing, stableSessionId, "Import options");
  await gridImportAction.click();
  const gridDelimiterPrompt = await waitForImportQuickInput(page, testing, configured, "Delimiter", stableSessionId);
  await waitForImportNaturalKeyboardFocus(gridDelimiterPrompt, "Delimiter", "contains");
  await withAcceptanceOperationDeadline(
    page.keyboard.press("Escape"),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the live-grid import-options cancellation"
  );
  await withAcceptanceOperationDeadline(
    gridDelimiterPrompt.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the live-grid import-options prompt to close"
  );
  assert.deepEqual(
    stableImportReconfigurationSnapshot(testing.activeSession()),
    confirmedBeforeCancellation,
    "The live-grid Import options action must preserve the confirmed session when cancelled."
  );
  assert.deepEqual(
    stableImportDiagnostics(testing.diagnostics()),
    diagnosticsBeforeCancellation,
    "The live-grid Import options action must not create a candidate when its prompt is cancelled."
  );

  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the reconfigured CSV panel to close cleanly"
  );
  // Runtime cleanup can finish before VS Code removes the closing session tab
  // and editor input. Opening the same URI as a custom editor during that gap
  // can race editor resolution, especially on macOS. Require the public tab
  // model to finish closing before the reload.
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () => vscode.window.tabGroups.all.every((group) => group.tabs.length === 0),
    10_000,
    "the reconfigured CSV session tab to close before same-source custom-editor reload"
  );
  const conflictingDefaultBackend = changed.metadata.backend === "pandas" ? "polars" : "pandas";
  await config.update("defaultBackend", conflictingDefaultBackend, vscode.ConfigurationTarget.Global);
  try {
    await vscode.commands.executeCommand("vscode.openWith", configured, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitFor(
      () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return (
          input instanceof vscode.TabInputCustom &&
          input.viewType === "openWrangler.viewer" &&
          input.uri.toString() === configured.toString()
        );
      },
      10_000,
      "the fresh Open Wrangler custom-editor input for the confirmed source"
    );
    await waitFor(
      () => {
        const active = testing.activeSession();
        return (
          active?.metadata.source.path === configured.fsPath &&
          active.metadata.backend === changed.metadata.backend &&
          active.metadata.source.importOptions?.delimiter === ";" &&
          active.metadata.shape.rows === 80 &&
          active.metadata.shape.columns === 8 &&
          active.viewState.selectedColumnId === retainedColumn.id &&
          changed.metadata.schema.every((column) => active.viewState.columnWidths[column.id] === 640) &&
          active.viewState.viewport.firstVisibleRow === 1 &&
          active.viewState.viewport.scrollLeft === 23
        );
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the custom editor to reload the last confirmed import options, backend, and view",
      () => {
        const active = testing.activeSession();
        return JSON.stringify({
          active: Boolean(active),
          sourceMatches: active?.metadata.source.path === configured.fsPath,
          backendMatches: active?.metadata.backend === changed.metadata.backend,
          importOptionsMatch:
            active?.metadata.source.importOptions?.delimiter === ";" &&
            active.metadata.source.importOptions.quoteChar === "'" &&
            active.metadata.source.importOptions.hasHeader === true,
          shapeMatches: active?.metadata.shape.rows === 80 && active.metadata.shape.columns === 8,
          selectedColumnMatches: active?.viewState.selectedColumnId === retainedColumn.id,
          widthsMatch:
            active !== undefined &&
            changed.metadata.schema.every((column) => active.viewState.columnWidths[column.id] === 640),
          firstVisibleRowMatches: active?.viewState.viewport.firstVisibleRow === 1,
          scrollLeftMatches: active?.viewState.viewport.scrollLeft === 23
        });
      }
    );
    assert.deepEqual(
      readFileSync(configured.fsPath),
      configuredBytes,
      "Reloading the confirmed file configuration must not modify its source."
    );
  } finally {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "the reloaded configurable CSV custom editor to close cleanly"
    );
    await config.update("defaultBackend", "auto", vscode.ConfigurationTarget.Global);
  }

  const damaged = vscode.Uri.file(path.join(directory, "damaged.csv"));
  const damagedBytes = readFileSync(damaged.fsPath);
  const generationBeforeFailure = testing.runtimeGeneration();
  await vscode.commands.executeCommand("vscode.openWith", damaged, "openWrangler.viewer", vscode.ViewColumn.One);
  await waitFor(
    () =>
      testing.runtimeGeneration() > generationBeforeFailure &&
      testing.diagnostics().sessionCount === 0 &&
      !testing.runtimeRunning(),
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the strict UTF-8 open to fail without retaining a corrupt file session"
  );
  assert.equal(testing.activeSession(), undefined, "The corrupt initial open must not publish an active session.");

  const errorImportAction = await waitForOpenWranglerWebviewButton(page, "Import options");
  await errorImportAction.click();
  await acceptDelimitedImportOptions(
    page,
    testing,
    damaged,
    undefined,
    "verify:file-inputs:reconfigure:damaged-options",
    {
      delimiter: "Comma",
      encoding: "utf8-lossy",
      header: "First row contains column names",
      quoteChar: '"'
    }
  );
  await waitFor(
    () => {
      const active = testing.activeSession();
      return (
        active?.metadata.source.path === damaged.fsPath &&
        active.metadata.backend === "pandas" &&
        active.metadata.shape.rows === 1 &&
        active.metadata.shape.columns === 2
      );
    },
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
    "the failed file panel to retry successfully with lossy UTF-8"
  );
  const recovered = testing.activeSession();
  assert.ok(recovered, "The lossy UTF-8 retry must publish an active session.");
  assert.deepEqual(recovered.metadata.source.importOptions, {
    delimiter: ",",
    encoding: "utf8-lossy",
    quoteChar: '"',
    hasHeader: true
  });
  assert.deepEqual(readFileSync(damaged.fsPath), damagedBytes, "Retrying a corrupt source must not modify it.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await waitFor(
    () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
    10_000,
    "the recovered corrupt-file panel to close cleanly"
  );
}

function fileSourceIdentity(source: SessionSource): Pick<SessionSource, "kind" | "label" | "path" | "uri"> {
  return {
    kind: source.kind,
    label: source.label,
    path: source.path,
    uri: source.uri
  };
}

async function acceptDelimitedImportOptions(
  page: Page,
  testing: TestApi,
  expectedSource: vscode.Uri,
  existingSessionId: string | undefined,
  checkpointPrefix: string,
  selection: {
    delimiter: string;
    encoding: string;
    header: string;
    quoteChar: string;
  }
): Promise<void> {
  for (const { key, title, option } of [
    { key: "delimiter", title: "Delimiter", option: selection.delimiter },
    { key: "encoding", title: "Text encoding", option: selection.encoding },
    { key: "header", title: "Header row", option: selection.header }
  ]) {
    const checkpoint = `${checkpointPrefix}:${key}`;
    recordAcceptanceProgress(`${checkpoint}:wait`);
    const quickInput = await waitForImportQuickInput(page, testing, expectedSource, title, existingSessionId);
    recordAcceptanceProgress(`${checkpoint}:visible`);
    await acceptQuickPickOptionWithKeyboard(page, quickInput, title, option, checkpoint);
  }

  const quoteCheckpoint = `${checkpointPrefix}:quote`;
  recordAcceptanceProgress(`${quoteCheckpoint}:wait`);
  const quoteInput = await waitForImportQuickInput(page, testing, expectedSource, "Quote character", existingSessionId);
  recordAcceptanceProgress(`${quoteCheckpoint}:visible`);
  const field = quoteInput.locator(".quick-input-box input").first();
  await withAcceptanceOperationDeadline(
    field.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the configured quote-character field to become visible"
  );
  await waitForImportNaturalKeyboardFocus(field, "Quote character", "exact");
  await withAcceptanceOperationDeadline(
    field.fill(selection.quoteChar, { timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the configured quote character"
  );
  recordAcceptanceProgress(`${quoteCheckpoint}:focused`);
  recordAcceptanceProgress(`${quoteCheckpoint}:accept`);
  await withAcceptanceOperationDeadline(
    pressKeyboardKeyPairWithoutTransitionGap(page.keyboard, "Enter"),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the configured quote character acceptance"
  );
  await withAcceptanceOperationDeadline(
    quoteInput.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the quote-character prompt to close"
  );
  recordAcceptanceProgress(`${quoteCheckpoint}:accepted`);
}

async function acceptQuickPickOptionWithKeyboard(
  page: Page,
  quickInput: Locator,
  title: string,
  option: string,
  checkpoint?: string,
  waitForPromptToHide = true
): Promise<void> {
  const selected = quickInput.getByRole("option", { name: option }).first();
  await withAcceptanceOperationDeadline(
    selected.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${title} option ${JSON.stringify(option)} to become visible`
  );
  await waitForImportNaturalKeyboardFocus(quickInput, title, "contains");
  const optionCount = await withAcceptanceOperationDeadline(
    quickInput.getByRole("option").count(),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${title} option count`
  );
  assert.ok(
    optionCount > 0 && optionCount <= 16,
    `${title} must expose between 1 and 16 bounded options; received ${optionCount}.`
  );

  let selectedIsFocused = false;
  for (let attempt = 0; attempt <= optionCount; attempt += 1) {
    const className =
      (await withAcceptanceOperationDeadline(
        selected.getAttribute("class", { timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        `${title} option ${JSON.stringify(option)} focus state`
      )) ?? "";
    selectedIsFocused = /(?:^|\s)focused(?:\s|$)/u.test(className);
    if (selectedIsFocused) break;
    if (attempt === optionCount) break;
    await withAcceptanceOperationDeadline(
      page.keyboard.press("ArrowDown"),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      `${title} keyboard navigation to ${JSON.stringify(option)}`
    );
  }

  if (!selectedIsFocused) {
    const visibleOptions = await boundedImportOptionDiagnostics(quickInput);
    throw new Error(
      `${title} did not focus requested option ${JSON.stringify(option)} within ${optionCount} keyboard steps. ` +
        `Visible options: ${JSON.stringify(visibleOptions)}`
    );
  }
  if (checkpoint) recordAcceptanceProgress(`${checkpoint}:focused`);
  if (checkpoint) recordAcceptanceProgress(`${checkpoint}:accept`);
  await withAcceptanceOperationDeadline(
    pressKeyboardKeyPairWithoutTransitionGap(page.keyboard, "Enter"),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${title} option ${JSON.stringify(option)} keyboard acceptance`
  );
  if (waitForPromptToHide) {
    try {
      await withAcceptanceOperationDeadline(
        quickInput.waitFor({ state: "hidden", timeout: 3_000 }),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        `${title} prompt to advance`
      );
    } catch (error) {
      const visibleOptions = await boundedImportOptionDiagnostics(quickInput);
      throw new Error(
        `${title} did not advance after accepting focused option ${JSON.stringify(option)} with Enter. ` +
          `Visible options: ${JSON.stringify(visibleOptions)}`,
        { cause: error }
      );
    }
  }
  if (checkpoint) recordAcceptanceProgress(`${checkpoint}:accepted`);
}

async function acceptSearchableExcelSheet(
  page: Page,
  testing: TestApi,
  expectedSource: vscode.Uri,
  existingSessionId: string,
  sheetName: string
): Promise<void> {
  const sheetPrompt = await waitForImportQuickInput(page, testing, expectedSource, "Excel sheet", existingSessionId);
  const field = sheetPrompt.locator(".quick-input-box input").first();
  await withAcceptanceOperationDeadline(
    field.waitFor({ state: "visible", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    "the searchable Excel worksheet field to become visible"
  );
  await waitForImportNaturalKeyboardFocus(field, "Excel sheet", "exact");
  await withAcceptanceOperationDeadline(
    field.fill(sheetName, { timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `the Excel worksheet search ${JSON.stringify(sheetName)}`
  );
  assert.equal(
    await field.inputValue({ timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS }),
    sheetName,
    "The Excel worksheet picker must accept a searchable worksheet query."
  );
  await acceptQuickPickOptionWithKeyboard(page, sheetPrompt, "Excel sheet", sheetName);
}

function packagedFileOpenDiagnostics(
  testing: TestApi,
  expected: {
    sourceLabel: string;
    backend: "polars" | "duckdb" | "pandas";
    shape: { rows: number; columns: number };
  }
): string {
  const active = testing.activeSession();
  const diagnostics = testing.diagnostics();
  return JSON.stringify({
    expected,
    configuredOpenTimeoutMs: getSetting("sessionOpenTimeoutMs", DEFAULT_SESSION_OPEN_TIMEOUT_MS),
    runtimeRunning: testing.runtimeRunning(),
    runtimeGeneration: testing.runtimeGeneration(),
    sessionCount: diagnostics.sessionCount,
    sessions: diagnostics.sessions.map(({ sourceLabel }) => sourceLabel),
    active: active
      ? {
          sourceLabel: active.metadata.source.label,
          backend: active.metadata.backend,
          shape: active.metadata.shape
        }
      : undefined
  });
}

async function exerciseRuntimeSelectionCommands(testing: TestApi, fixture: vscode.Uri, python: string): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-runtime-selection-"));
  const invocationLog = path.join(directory, "python-invocations.log");
  const isolatedPython = createDependencyIsolatedPython(directory, python, invocationLog);
  const config = vscode.workspace.getConfiguration("openWrangler");
  const originalWorkspacePythonPath = config.inspect<string>("pythonPath")?.workspaceValue;

  try {
    assert.equal(await vscode.commands.executeCommand("openWrangler.changeRuntime", isolatedPython), isolatedPython);
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, isolatedPython);

    const rejected = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "polars",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejected.kind, "error");
    if (rejected.kind === "error") {
      assert.equal(rejected.code, "missing_dependencies");
      assert.match(rejected.message, /Missing: polars/);
      assert.match(rejected.detail ?? "", /Install Runtime Dependencies/);
    }
    const rejectedDuckDB = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "duckdb",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedDuckDB.kind, "error");
    if (rejectedDuckDB.kind === "error") {
      assert.equal(rejectedDuckDB.code, "missing_dependencies");
      assert.match(rejectedDuckDB.message, /Missing: duckdb>=1\.5\.4,<1\.6, pytz\.$/u);
      assert.match(rejectedDuckDB.detail ?? "", /Install Runtime Dependencies/);
    }
    const rejectedLossyUtf8 = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: {
        ...csvSource(fixture),
        importOptions: {
          delimiter: ",",
          encoding: "utf8-lossy",
          quoteChar: '"',
          hasHeader: true
        }
      },
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedLossyUtf8.kind, "error");
    if (rejectedLossyUtf8.kind === "error") {
      assert.equal(rejectedLossyUtf8.code, "missing_dependencies");
      assert.match(rejectedLossyUtf8.message, /Missing: pandas/);
      assert.doesNotMatch(rejectedLossyUtf8.message, /polars|duckdb/iu);
      assert.match(rejectedLossyUtf8.detail ?? "", /Install Runtime Dependencies/);
    }
    const rejectedLegacyExcel = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: {
        kind: "file",
        label: "legacy.xls",
        path: path.join(directory, "legacy.xls"),
        importOptions: { sheetIndex: 0 }
      },
      backend: "pandas",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejectedLegacyExcel.kind, "error");
    if (rejectedLegacyExcel.kind === "error") {
      assert.equal(rejectedLegacyExcel.code, "missing_dependencies");
      assert.match(rejectedLegacyExcel.message, /Missing: pandas, xlrd>=2\.0\.1/);
      assert.doesNotMatch(rejectedLegacyExcel.message, /openpyxl/);
      assert.match(rejectedLegacyExcel.detail ?? "", /Install Runtime Dependencies/);
    }
    assert.equal(testing.runtimeRunning(), false, "Missing dependencies must fail before runtime startup.");
    const invocationsBeforeDecline = readFileSync(invocationLog, "utf8");
    const generationBeforeDecline = testing.runtimeGeneration();
    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      const page = await connectToEditorWorkbench();
      const commandOutcome = vscode.commands
        .executeCommand<boolean>("openWrangler.installRuntimeDependencies", true)
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      const earlyOutcome = await Promise.race([
        commandOutcome.then((outcome) => ({ kind: "settled" as const, outcome })),
        new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 500))
      ]);
      assert.equal(
        earlyOutcome.kind,
        "pending",
        `The public dependency command must wait for its real modal, not settle from a caller argument: ${JSON.stringify(earlyOutcome)}`
      );
      const { page: confirmationPage, dialog: confirmation } = await waitForVisibleEditorDialog(
        page,
        "Install pandas, xlrd>=2.0.1"
      );
      try {
        await confirmationPage.bringToFront();
        const confirmationMessage = await confirmation.locator(".dialog-message-text").innerText();
        const confirmationDetail = await confirmation.locator(".dialog-message-detail").innerText();
        assert.equal(
          confirmationMessage,
          `Install pandas, xlrd>=2.0.1 into ${isolatedPython}?`,
          "The real dependency confirmation must identify the exact requirements and interpreter."
        );
        assert.equal(confirmationDetail, "Open Wrangler never installs packages without this confirmation.");
        assert.equal(
          await confirmation.getByRole("button", { name: "Install", exact: true }).count(),
          1,
          "The dependency modal must expose exactly one affirmative Install action."
        );
        await confirmationPage.keyboard.press("Escape");
        await confirmation.waitFor({ state: "hidden", timeout: 10_000 });
        const outcome = await commandOutcome;
        if (outcome.status === "rejected") throw outcome.error;
        assert.equal(
          outcome.value,
          false,
          "A hostile truthy command argument must not bypass the real dependency confirmation."
        );
      } finally {
        if (await confirmation.isVisible().catch(() => false)) {
          await confirmationPage.bringToFront();
          await confirmationPage.keyboard.press("Escape");
          await confirmation.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
        }
      }
    } else {
      assert.equal(
        await testing.declineRuntimeDependencyInstallation(),
        false,
        "The gated non-UI test path must decline without installing dependencies."
      );
    }
    assert.equal(
      readFileSync(invocationLog, "utf8"),
      invocationsBeforeDecline,
      "Declining dependency installation must not invoke the selected Python environment."
    );
    assert.equal(
      testing.runtimeGeneration(),
      generationBeforeDecline,
      "Declining dependency installation must not restart the runtime."
    );
    assert.equal(testing.runtimeRunning(), false, "Declining dependency installation must not start the runtime.");
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, isolatedPython);

    assert.equal(await vscode.commands.executeCommand("openWrangler.clearRuntime"), true);
    assert.equal(config.inspect<string>("pythonPath")?.workspaceValue, undefined);
    assert.equal(getSetting("pythonPath", ""), python, "Clearing the workspace override must reveal the fallback.");
  } finally {
    try {
      await config.update("pythonPath", originalWorkspacePythonPath, vscode.ConfigurationTarget.Workspace);
    } finally {
      cleanupAcceptanceTemporaryDirectory(directory);
    }
  }
}

interface DependencyInstallLifecycleFixture {
  executable: string;
  started: string;
  release: string;
  completed: string;
}

interface DependencyGuardAcceptanceEnvironment {
  executable: string;
  executableIdentity: {
    device: string;
    inode: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
  };
  packageRoot: string;
  packageRootIdentity: {
    device: string;
    inode: string;
  };
  pythonVersion: string;
}

interface DependencyGuardAcceptanceDependency {
  importModule: string;
  distribution: string;
  installSpec: string;
  minimumVersion: string | null;
  maximumVersionExclusive: string | null;
}

interface DependencyGuardRecoveryFixture {
  directory: string;
  executable: string;
  helperPath: string;
  environment: DependencyGuardAcceptanceEnvironment;
  dependency: DependencyGuardAcceptanceDependency;
  marker: string;
  pipStarted: string;
  pipRelease: string;
  pipCompleted: string;
  parentScript: string;
  parentState: string;
  parentAuthorized: string;
  parentCrashFrame: string;
  invocationLog: string;
  dependencyProbeLog: string;
}

interface AcceptanceGuardProcess {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  closed: boolean;
  parentPid?: number;
}

type DependencyGuardCleanupLeg = "guard" | "parent";

function dependencyGuardCleanupOrder(authorized: boolean): readonly DependencyGuardCleanupLeg[] {
  return authorized ? ["guard", "parent"] : ["parent", "guard"];
}

async function exerciseDependencyMutationRecovery(
  testing: TestApi,
  fixture: vscode.Uri,
  python: string,
  helperPath: string
): Promise<void> {
  assert.equal(
    testing.diagnostics().sessionCount,
    0,
    "Dependency-recovery acceptance must start after every dataframe session closed."
  );
  assert.equal(
    testing.runtimeRunning(),
    false,
    "Dependency-recovery acceptance must start without a live dataframe runtime."
  );
  assert.deepEqual(
    dependencyGuardCleanupOrder(false),
    ["parent", "guard"],
    "A pre-authorization guard must lose its exact owned parent before release is status-proved."
  );
  assert.deepEqual(
    dependencyGuardCleanupOrder(true),
    ["guard", "parent"],
    "An authorized writer must be released and status-proved before its looping parent is terminated."
  );

  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-dependency-recovery-"));
  const recovery = createDependencyGuardRecoveryFixture(directory, python, helperPath);
  const config = vscode.workspace.getConfiguration("openWrangler");
  const originalWorkspacePythonPath = config.inspect<string>("pythonPath")?.workspaceValue;
  let guardParent: AcceptanceGuardProcess | undefined;
  let orphanedGuardPid: number | undefined;
  let sessionId: string | undefined;
  let sessionRevision = 0;
  let operationFailed = false;
  let operationFailure: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    guardParent = launchAcceptanceGuardParent(recovery);
    await waitFor(
      () => existsSync(recovery.parentState),
      10_000,
      "the disposable dependency-guard parent to publish exact process ownership"
    );
    const parentState = readDependencyGuardParentState(recovery.parentState);
    guardParent.parentPid = parentState.parentPid;
    orphanedGuardPid = parentState.guardPid;
    assert.notEqual(orphanedGuardPid, parentState.parentPid);
    assert.equal(acceptanceProcessIsAlive(parentState.parentPid), true);
    assert.equal(acceptanceProcessIsAlive(orphanedGuardPid), true);
    await waitFor(
      () => existsSync(recovery.parentAuthorized),
      10_000,
      "the disposable dependency-guard parent to publish exact READY and GO evidence"
    );
    assert.deepEqual(readDependencyGuardParentAuthorization(recovery.parentAuthorized), {
      guardPid: orphanedGuardPid,
      kind: "authorized",
      parentPid: parentState.parentPid,
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
    });
    await waitFor(
      () => existsSync(recovery.pipStarted),
      10_000,
      "the guarded fake pip writer to begin after exact GO authorization"
    );
    assert.equal(
      existsSync(recovery.marker),
      true,
      "The durable recovery marker must exist before simulating abrupt guard-parent termination."
    );
    const markerMetadata = lstatSync(recovery.marker);
    assert.ok(markerMetadata.isFile() && !markerMetadata.isSymbolicLink() && markerMetadata.nlink === 1);
    if (process.platform !== "win32") {
      assert.equal(markerMetadata.mode & 0o077, 0, "The durable dependency marker must remain mode 0600.");
    }
    const pipStarted = JSON.parse(readFileSync(recovery.pipStarted, "utf8")) as Record<string, unknown>;
    assert.deepEqual(pipStarted.args, ["install", "--no-input", "--no-user", "--", recovery.dependency.installSpec]);
    // Crash only the disposable Python parent after exact GO. Its guarded
    // writer is a distinct process and must remain alive, modelling an
    // extension-host-like parent loss without claiming that this editor
    // restarted or power failed.
    const parentExit = await crashAcceptanceGuardParent(
      guardParent,
      recovery.parentCrashFrame,
      "the abruptly terminated dependency-guard parent"
    );
    assert.equal(
      parentExit.code,
      DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE,
      "The exact disposable Python parent must acknowledge the crash frame with os._exit()."
    );
    assert.equal(acceptanceProcessIsAlive(orphanedGuardPid), true, "The guarded writer must outlive its parent.");
    assert.equal(existsSync(recovery.marker), true, "Guard-parent loss after GO must retain the exact durable marker.");

    assert.equal(
      await vscode.commands.executeCommand("openWrangler.changeRuntime", recovery.executable),
      recovery.executable
    );
    const invocationsBeforeBlockedOpen = readDependencyGuardAcceptanceInvocations(recovery);
    const dependencyProbesBeforeBlockedOpen = readDependencyGuardProbeInvocations(recovery);
    const generationBeforeBlockedOpen = testing.runtimeGeneration();
    const blocked = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "polars",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(
      blocked.kind,
      "error",
      `A retained dependency marker must block a fresh open: ${JSON.stringify(blocked)}`
    );
    if (blocked.kind === "error") {
      assert.equal(blocked.code, "dependency_environment_uncertain");
      assert.match(blocked.message, /dependency state is uncertain/iu);
      assert.match(
        blocked.detail ?? "",
        /Another dependency guard currently owns this environment/iu,
        "A live guarded writer must report the busy state without offering concurrent validation."
      );
      assert.doesNotMatch(
        `${blocked.message}\n${blocked.detail ?? ""}`,
        new RegExp(`${DEPENDENCY_GUARD_ACCEPTANCE_TOKEN}|${DEPENDENCY_GUARD_HOSTILE_TOKEN}`, "u"),
        "Recovery diagnostics must never expose a dependency-guard token."
      );
    }
    assert.equal(testing.runtimeGeneration(), generationBeforeBlockedOpen);
    assert.equal(testing.runtimeRunning(), false, "A dirty guard must block before runtime startup.");
    assert.equal(testing.diagnostics().sessionCount, 0, "A dirty guard must not retain a failed session.");
    const blockedOpenInvocations = readDependencyGuardAcceptanceInvocations(recovery).slice(
      invocationsBeforeBlockedOpen.length
    );
    assert.ok(
      blockedOpenInvocations.length >= 2 &&
        blockedOpenInvocations.length <= 4 &&
        blockedOpenInvocations.every(
          (arguments_) =>
            (arguments_.length === 1 && arguments_[0] === "-c") ||
            (arguments_.length === 2 &&
              sameAcceptanceExecutable(arguments_[0], recovery.helperPath) &&
              arguments_[1] === "status")
        ),
      `Blocked-open Python work was not limited to environment/status checks: ${JSON.stringify(blockedOpenInvocations)}`
    );
    assert.deepEqual(
      readDependencyGuardProbeInvocations(recovery),
      dependencyProbesBeforeBlockedOpen,
      "A bridge fresh to the interrupted marker must stop before the ordinary importlib dependency probe."
    );

    assert.equal(
      acceptanceProcessIsAlive(orphanedGuardPid),
      true,
      "The same orphaned guarded writer must still own the journal before public recovery."
    );
    assert.equal(
      await vscode.commands.executeCommand(
        "openWrangler.revalidateRuntimeDependencies",
        true,
        DEPENDENCY_GUARD_HOSTILE_TOKEN,
        recovery.environment
      ),
      false,
      "A live dependency guard lock must make public recovery fail closed."
    );
    assert.equal(existsSync(recovery.marker), true, "Busy recovery must retain the exact marker.");

    writeFileSync(recovery.pipRelease, "release\n", { encoding: "utf8", flag: "wx" });
    await waitFor(
      () => existsSync(recovery.pipCompleted),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the orphaned guarded writer to finish its no-network pip fixture"
    );
    const releasedStatus = await waitForAcceptanceGuardRelease(
      recovery,
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the orphaned dependency guard to release its exact environment after its writer completed"
    );
    assert.equal(existsSync(recovery.marker), true, "Writer completion must not clear an unvalidated marker.");
    assert.deepEqual(releasedStatus, {
      kind: "status",
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      state: "dirty",
      token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
    });

    // The first open observed the journal while its exact writer still held
    // the lock, so it could only fail closed as busy. Ask the production
    // bridge to discover the retained marker once the writer has exited. This
    // binds recovery to the environment and token discovered from disk; the
    // later public command arguments remain deliberately hostile.
    const dependencyProbesBeforeMarkerDiscovery = readDependencyGuardProbeInvocations(recovery);
    const generationBeforeMarkerDiscovery = testing.runtimeGeneration();
    const discovered = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "polars",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(
      discovered.kind,
      "error",
      `A retained exact dependency marker must block until explicit validation: ${JSON.stringify(discovered)}`
    );
    if (discovered.kind === "error") {
      assert.equal(discovered.code, "dependency_environment_uncertain");
      assert.match(discovered.message, /dependency state is uncertain/iu);
      assert.match(discovered.detail ?? "", /Revalidate Runtime Dependencies/iu);
      assert.doesNotMatch(
        `${discovered.message}\n${discovered.detail ?? ""}`,
        new RegExp(`${DEPENDENCY_GUARD_ACCEPTANCE_TOKEN}|${DEPENDENCY_GUARD_HOSTILE_TOKEN}`, "u"),
        "Exact marker discovery diagnostics must never expose a dependency-guard token."
      );
    }
    assert.equal(testing.runtimeGeneration(), generationBeforeMarkerDiscovery);
    assert.equal(testing.runtimeRunning(), false, "Marker discovery must stop before runtime startup.");
    assert.equal(testing.diagnostics().sessionCount, 0, "Marker discovery must not retain a failed session.");
    assert.deepEqual(
      readDependencyGuardProbeInvocations(recovery),
      dependencyProbesBeforeMarkerDiscovery,
      "Exact marker discovery must stop before the ordinary importlib dependency probe."
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const page = await connectToEditorWorkbench();
    const declinedCommand = vscode.commands
      .executeCommand<boolean>(
        "openWrangler.revalidateRuntimeDependencies",
        true,
        DEPENDENCY_GUARD_HOSTILE_TOKEN,
        recovery.environment
      )
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
    const earlyDecline = await Promise.race([
      declinedCommand.then((outcome) => ({ kind: "settled" as const, outcome })),
      new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 500))
    ]);
    assert.equal(
      earlyDecline.kind,
      "pending",
      `Hostile recovery arguments must not settle the command without its real modal: ${JSON.stringify(earlyDecline)}`
    );
    const { page: declinePage, dialog: declineDialog } = await waitForVisibleEditorDialog(
      page,
      "Revalidate runtime dependencies"
    );
    try {
      await assertDependencyRecoveryDialog(declineDialog, recovery.executable);
      await declinePage.bringToFront();
      await declinePage.keyboard.press("Escape");
      await declineDialog.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
      const declined = await declinedCommand;
      if (declined.status === "rejected") throw declined.error;
      assert.equal(declined.value, false);
    } finally {
      if (await declineDialog.isVisible().catch(() => false)) {
        await declinePage.bringToFront();
        await declinePage.keyboard.press("Escape");
        await declineDialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
      }
    }
    assert.equal(existsSync(recovery.marker), true, "Escaping the real recovery modal must retain the marker.");
    await new Promise<void>((resolve) => setImmediate(resolve));

    const recoveryCommand = vscode.commands
      .executeCommand<boolean>(
        "openWrangler.revalidateRuntimeDependencies",
        DEPENDENCY_GUARD_HOSTILE_TOKEN,
        recovery.environment
      )
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
    const { page: recoveryPage, dialog: recoveryDialog } = await waitForVisibleEditorDialog(
      page,
      "Revalidate runtime dependencies"
    );
    await assertDependencyRecoveryDialog(recoveryDialog, recovery.executable);
    await recoveryPage.bringToFront();
    await withAcceptanceOperationDeadline(
      recoveryDialog.getByRole("button", { name: "Revalidate", exact: true }).click(),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      "the exact dependency-revalidation confirmation"
    );
    await recoveryDialog.waitFor({ state: "hidden", timeout: WORKBENCH_PLAYWRIGHT_TIMEOUT_MS });
    const recovered = await recoveryCommand;
    if (recovered.status === "rejected") throw recovered.error;
    assert.equal(recovered.value, true, "Exact dependency validation must report success.");
    assert.equal(existsSync(recovery.marker), false, "Successful exact validation must clear only its marker.");
    assert.deepEqual(readAcceptanceGuardStatus(recovery), {
      kind: "status",
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      state: "clean",
      token: null
    });

    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "polars",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(
      opened.kind,
      "sessionOpened",
      `Validated dependency recovery did not unblock: ${JSON.stringify(opened)}`
    );
    if (opened.kind === "sessionOpened") {
      sessionId = opened.metadata.sessionId;
      sessionRevision = opened.metadata.revision;
      assert.equal(opened.metadata.backend, "polars");
    }
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  } finally {
    if ((orphanedGuardPid === undefined || guardParent?.parentPid === undefined) && existsSync(recovery.parentState)) {
      try {
        const parentState = readDependencyGuardParentState(recovery.parentState);
        orphanedGuardPid = parentState.guardPid;
        if (guardParent) guardParent.parentPid = parentState.parentPid;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    let processOwnershipConfirmed = orphanedGuardPid !== undefined || guardParent === undefined;
    let exactAuthorizationConfirmed = false;
    if (orphanedGuardPid !== undefined && guardParent && existsSync(recovery.parentAuthorized)) {
      try {
        assert.deepEqual(readDependencyGuardParentAuthorization(recovery.parentAuthorized), {
          guardPid: orphanedGuardPid,
          kind: "authorized",
          parentPid: guardParent.parentPid,
          protocol: DEPENDENCY_GUARD_PROTOCOL,
          token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
        });
        exactAuthorizationConfirmed = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (orphanedGuardPid === undefined && guardParent) {
      processOwnershipConfirmed = false;
      cleanupFailures.push(
        new Error("Dependency-recovery cleanup could not recover the exact guarded-writer identity.")
      );
    }

    const settleGuard = async (): Promise<void> => {
      if (orphanedGuardPid === undefined) return;
      try {
        await settleOrphanedAcceptanceGuard(recovery, orphanedGuardPid);
      } catch (error) {
        processOwnershipConfirmed = false;
        cleanupFailures.push(error);
      }
    };
    const terminateParent = async (): Promise<void> => {
      if (!guardParent || guardParent.closed) return;
      try {
        await crashAcceptanceGuardParent(
          guardParent,
          recovery.parentCrashFrame,
          "the disposable dependency-guard parent"
        );
      } catch (error) {
        processOwnershipConfirmed = false;
        cleanupFailures.push(error);
      }
    };
    for (const cleanupLeg of dependencyGuardCleanupOrder(exactAuthorizationConfirmed)) {
      if (cleanupLeg === "parent") await terminateParent();
      else await settleGuard();
    }
    if (sessionId) {
      try {
        await testing.request({
          kind: "closeSession",
          sessionId,
          revision: sessionRevision
        });
      } catch (error) {
        processOwnershipConfirmed = false;
        cleanupFailures.push(error);
      }
    }
    try {
      await config.update("pythonPath", originalWorkspacePythonPath, vscode.ConfigurationTarget.Workspace);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        30_000,
        "dependency-recovery acceptance sessions and runtime to close"
      );
    } catch (error) {
      processOwnershipConfirmed = false;
      cleanupFailures.push(error);
    }
    if (processOwnershipConfirmed) {
      try {
        cleanupAcceptanceTemporaryDirectory(directory);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  const failures = operationFailed ? [operationFailure, ...cleanupFailures] : cleanupFailures;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Dependency-recovery acceptance and cleanup reported multiple failures.");
  }
}

async function assertDependencyRecoveryDialog(dialog: Locator, executable: string): Promise<void> {
  assert.equal(
    await dialog.locator(".dialog-message-text").innerText(),
    `Revalidate runtime dependencies in ${executable}?`
  );
  assert.equal(
    await dialog.locator(".dialog-message-detail").innerText(),
    "Open Wrangler found an interrupted dependency change. Revalidation waits for any package writer to exit, imports and version-checks the recorded dependencies, and clears the retained recovery marker only if every check succeeds. It does not install, remove, or overwrite packages."
  );
  assert.equal(
    await dialog.getByRole("button", { name: "Revalidate", exact: true }).count(),
    1,
    "The dependency-recovery modal must expose exactly one affirmative Revalidate action."
  );
}

async function exerciseDependencyInstallShutdownLifecycle(testing: TestApi, python: string): Promise<void> {
  assert.equal(
    testing.diagnostics().sessionCount,
    0,
    "Dependency-install shutdown acceptance must start after every dataframe session closed."
  );
  assert.equal(
    testing.runtimeRunning(),
    false,
    "Dependency-install shutdown acceptance must start without a live dataframe runtime."
  );

  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-dependency-shutdown-"));
  const lifecycle = createDependencyInstallLifecyclePython(directory, python);
  const config = vscode.workspace.getConfiguration("openWrangler");
  const originalWorkspacePythonPath = config.inspect<string>("pythonPath")?.workspaceValue;
  let shutdown: Promise<void> | undefined;
  let shutdownConfirmed = false;

  try {
    assert.equal(
      await vscode.commands.executeCommand("openWrangler.changeRuntime", lifecycle.executable),
      lifecycle.executable
    );
    const rejected = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: {
        kind: "file",
        label: "dependency-shutdown.xls",
        path: path.join(directory, "dependency-shutdown.xls"),
        importOptions: { sheetIndex: 0 }
      },
      backend: "pandas",
      pageSize: 20,
      mode: "viewing"
    });
    assert.equal(rejected.kind, "error");
    if (rejected.kind === "error") {
      assert.equal(rejected.code, "missing_dependencies");
      assert.match(rejected.message, /Missing: pandas, xlrd>=2\.0\.1/);
      assert.doesNotMatch(rejected.message, /openpyxl/);
    }
    assert.equal(testing.runtimeRunning(), false, "The fake pip target must fail before runtime startup.");

    const page = await connectToEditorWorkbench();
    const pendingCommand = vscode.commands
      .executeCommand<boolean>("openWrangler.installRuntimeDependencies", true)
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error })
      );
    let commandState: "pending" | "fulfilled" | "rejected" = "pending";
    void pendingCommand.then((outcome) => {
      commandState = outcome.status;
    });
    const { page: confirmationPage, dialog: confirmation } = await waitForVisibleEditorDialog(
      page,
      "Install pandas, xlrd>=2.0.1"
    );
    await confirmationPage.bringToFront();
    assert.equal(
      await confirmation.locator(".dialog-message-text").innerText(),
      `Install pandas, xlrd>=2.0.1 into ${lifecycle.executable}?`
    );
    const installButton = confirmation.getByRole("button", { name: "Install", exact: true });
    assert.equal(
      await installButton.count(),
      1,
      "The dependency lifecycle modal must expose exactly one affirmative Install action."
    );
    assert.equal(await installButton.isVisible(), true, "The dependency lifecycle Install action must be visible.");
    assert.equal(await installButton.isEnabled(), true, "The dependency lifecycle Install action must be enabled.");
    recordAcceptanceProgress("verify:dependency-install-confirmation-visible");
    // Native workbench hovers can overlap a modal without changing its focus semantics.
    await installButton.focus({ timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
    await installButton.press("Enter", { timeout: WORKBENCH_OPERATION_TIMEOUT_MS });
    recordAcceptanceProgress("verify:dependency-install-action-dispatched");
    await confirmation.waitFor({ state: "hidden", timeout: 10_000 });
    recordAcceptanceProgress("verify:dependency-install-dialog-hidden");
    await waitFor(
      () => existsSync(lifecycle.started),
      10_000,
      "the disposable fake pip process to publish its start marker"
    );
    recordAcceptanceProgress("verify:dependency-install-child-started");

    const started = JSON.parse(readFileSync(lifecycle.started, "utf8")) as Record<string, unknown>;
    assert.deepEqual(started.args, ["install", "--no-input", "--no-user", "--", "pandas", "xlrd>=2.0.1"]);
    assert.equal(started.pipNoInput, "1", "The owned pip process must receive non-interactive mode.");
    assert.equal(started.pipUser, "0", "The owned pip process must explicitly prohibit user-site installation.");
    assert.equal(
      started.pipConfigFile,
      process.platform === "win32" ? "nul" : devNull,
      "The owned pip process must disable every inherited pip configuration file."
    );
    assert.equal(started.pythonPathPresent, false, "The owned pip process must not inherit PYTHONPATH.");
    assert.equal(started.pythonHomePresent, false, "The owned pip process must not inherit PYTHONHOME.");
    assert.notEqual(
      path.normalize(String(started.cwd)),
      path.normalize(path.dirname(lifecycle.executable)),
      "Dependency installation must not import a neighboring pip module from the interpreter directory."
    );
    assert.match(path.basename(String(started.cwd)), /^openwrangler-pip-/u);
    assert.equal(existsSync(String(started.cwd)), true, "The private pip directory must remain owned until close.");
    if (process.platform !== "win32") {
      assert.equal(statSync(String(started.cwd)).mode & 0o077, 0, "The private pip directory must be mode 0700.");
    }
    assert.equal(
      existsSync(lifecycle.completed),
      false,
      "The fake pip process must remain blocked until the acceptance harness releases it."
    );

    shutdown = testing.shutdownRuntimeBridgeForTesting();
    let shutdownState: "pending" | "fulfilled" | "rejected" = "pending";
    void shutdown.then(
      () => {
        shutdownState = "fulfilled";
      },
      () => {
        shutdownState = "rejected";
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      shutdownState,
      "pending",
      "Runtime-bridge shutdown must remain pending while the exact pip child is still running."
    );
    assert.equal(
      commandState,
      "pending",
      "The public install command must remain pending while its exact pip child is still running."
    );
    assert.equal(
      existsSync(lifecycle.completed),
      false,
      "Runtime-bridge shutdown must not signal or kill the still-blocked pip child."
    );

    writeFileSync(lifecycle.release, "release\n", { encoding: "utf8", flag: "wx" });
    await shutdown;
    shutdownConfirmed = true;
    assert.equal(
      existsSync(lifecycle.completed),
      true,
      "Runtime-bridge shutdown must resolve only after the fake pip child exits naturally."
    );
    const completed = JSON.parse(readFileSync(lifecycle.completed, "utf8")) as Record<string, unknown>;
    assert.deepEqual(completed, { ...started, released: true });

    const outcome = await pendingCommand;
    if (outcome.status === "rejected") throw outcome.error;
    assert.equal(
      outcome.value,
      false,
      "An install that closes during bridge shutdown must not report post-disposal success."
    );
    assert.equal(testing.runtimeRunning(), false);
    assert.equal(testing.diagnostics().sessionCount, 0);
    assert.equal(
      existsSync(String(started.cwd)),
      false,
      "The private pip directory must be removed only after authoritative child close."
    );
  } finally {
    try {
      writeFileSync(lifecycle.release, "release\n", { encoding: "utf8", flag: "wx" });
    } catch {
      // A concurrently observed release is equivalent for bounded cleanup.
    }
    shutdown ??= testing.shutdownRuntimeBridgeForTesting();
    if (!shutdownConfirmed) {
      try {
        await shutdown;
        shutdownConfirmed = true;
      } catch {
        // Preserve the primary acceptance failure. The outer owned-process
        // harness will retain the private root when shutdown is unconfirmed.
      }
    }
    await config.update("pythonPath", originalWorkspacePythonPath, vscode.ConfigurationTarget.Workspace);
    if (shutdownConfirmed) cleanupAcceptanceTemporaryDirectory(directory);
  }
}

const PINNED_REAL_PYTHON_EXTENSION_VERSION = "2026.4.0";

interface InstrumentedPythonEnvironment {
  executable: string;
  runtimeMarkerDirectory: string;
}

async function exerciseRealPythonEnvironmentSelection(
  testing: TestApi,
  workspace: vscode.Uri,
  fixture: vscode.Uri,
  python: string,
  openWranglerExtensionPath: string
): Promise<void> {
  const pythonExtension = vscode.extensions.getExtension<PythonExtension>("ms-python.python");
  assert.ok(pythonExtension, "The opt-in acceptance phase must install the released Python extension.");
  assert.equal(
    pythonExtension.packageJSON.version,
    PINNED_REAL_PYTHON_EXTENSION_VERSION,
    "Real environment-selection acceptance must run against the pinned stable Python extension."
  );
  const pythonApi = await pythonExtension.activate();
  await pythonApi.ready;
  assert.equal(
    typeof pythonApi.environments.updateActiveEnvironmentPath,
    "function",
    "The released Python extension must expose its stable environment-selection API."
  );
  assert.equal(
    typeof pythonApi.environments.onDidChangeActiveEnvironmentPath,
    "function",
    "The released Python extension must expose active-environment change notifications."
  );

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(fixture);
  assert.ok(workspaceFolder, "The Python-environment fixture must belong to the isolated workspace.");
  assert.equal(workspaceFolder.uri.toString(), workspace.toString());
  const config = vscode.workspace.getConfiguration("openWrangler", fixture);
  await config.update("pythonPath", undefined, vscode.ConfigurationTarget.Global);
  await config.update("pythonPath", undefined, vscode.ConfigurationTarget.Workspace);
  assert.equal(
    getSetting("pythonPath", "", fixture),
    "",
    "The real Python-extension phase must not bypass environment selection with an Open Wrangler override."
  );

  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-real-python-environments-"));
  const environmentA = createInstrumentedPythonEnvironment(path.join(directory, "environment-a"), python, "a");
  const environmentB = createInstrumentedPythonEnvironment(path.join(directory, "environment-b"), python, "b");
  const runtimeRoot = path.join(openWranglerExtensionPath, "python");
  assert.equal(
    existsSync(path.join(runtimeRoot, "openwrangler_runtime", "server.py")),
    true,
    "The packaged Open Wrangler runtime must exist before instrumented environment acceptance."
  );
  verifyInstrumentedPythonEnvironmentMarker(environmentA, runtimeRoot);
  verifyInstrumentedPythonEnvironmentMarker(environmentB, runtimeRoot);
  const originalSource = readFileSync(fixture.fsPath);
  const expectedFirstRowScore = "21.0";
  let sessionId: string | undefined;
  let revision = 0;

  try {
    recordAcceptanceProgress("python-environment:select-a");
    await pythonApi.environments.updateActiveEnvironmentPath(environmentA.executable, workspaceFolder);
    await waitForSelectedPythonEnvironment(pythonApi, workspaceFolder, environmentA.executable);

    recordAcceptanceProgress("python-environment:open-a");
    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend: "polars",
      pageSize: 20,
      mode: "editing"
    });
    assert.equal(opened.kind, "sessionOpened", `Environment A failed to open the fixture: ${JSON.stringify(opened)}`);
    if (opened.kind !== "sessionOpened") return;
    sessionId = opened.metadata.sessionId;
    revision = opened.metadata.revision;

    const preview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision,
      step: {
        id: "real-python-environment-score",
        kind: "formula",
        params: {
          leftColumn: columnReference(opened.metadata, "sales"),
          operator: "multiply",
          value: 2,
          newColumn: "score"
        }
      },
      offset: 0,
      limit: 20
    });
    assert.equal(preview.kind, "stepPreview");
    if (preview.kind !== "stepPreview") return;
    revision = preview.revision;
    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision,
      offset: 0,
      limit: 20
    });
    assert.equal(applied.kind, "planUpdated");
    if (applied.kind !== "planUpdated") return;
    revision = applied.revision;
    assert.equal(applied.page.rows[0]?.values[4]?.display, expectedFirstRowScore);
    await waitFor(
      () => instrumentedRuntimeStarts(environmentA) >= 1,
      10_000,
      "environment A to launch the Open Wrangler runtime"
    );
    const generationA = testing.runtimeGeneration();
    assert.ok(generationA > 0);

    recordAcceptanceProgress("python-environment:switch-b");
    await pythonApi.environments.updateActiveEnvironmentPath(environmentB.executable, workspaceFolder);
    await waitForSelectedPythonEnvironment(pythonApi, workspaceFolder, environmentB.executable);
    await waitFor(
      () => !testing.runtimeRunning(),
      30_000,
      "the environment-A runtime to stop after the workspace selection changed"
    );

    recordAcceptanceProgress("python-environment:recover-b");
    const recoveredB = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "real-python-environment-b",
      sessionId,
      revision,
      offset: 0,
      limit: 20,
      filterModel: applied.metadata.filterModel
    });
    assert.equal(recoveredB.kind, "page", `Environment B recovery failed: ${JSON.stringify(recoveredB)}`);
    if (recoveredB.kind !== "page") return;
    revision = recoveredB.revision;
    assert.deepEqual(
      recoveredB.metadata.steps.map((step) => step.id),
      ["real-python-environment-score"],
      "The committed plan must replay after the selected Python environment changes."
    );
    assert.equal(recoveredB.page.rows[0]?.values[4]?.display, expectedFirstRowScore);
    await waitFor(
      () => instrumentedRuntimeStarts(environmentB) >= 1,
      10_000,
      "environment B to launch the recovered Open Wrangler runtime"
    );
    assert.equal(
      testing.runtimeGeneration(),
      generationA + 1,
      "One workspace environment switch must create exactly one replacement runtime."
    );

    recordAcceptanceProgress("python-environment:switch-a");
    await pythonApi.environments.updateActiveEnvironmentPath(environmentA.executable, workspaceFolder);
    await waitForSelectedPythonEnvironment(pythonApi, workspaceFolder, environmentA.executable);
    await waitFor(() => !testing.runtimeRunning(), 30_000, "the environment-B runtime to stop after switching back");

    recordAcceptanceProgress("python-environment:recover-a");
    const recoveredA = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "real-python-environment-a-return",
      sessionId,
      revision,
      offset: 0,
      limit: 20,
      filterModel: recoveredB.metadata.filterModel
    });
    assert.equal(recoveredA.kind, "page", `Environment A replay failed: ${JSON.stringify(recoveredA)}`);
    if (recoveredA.kind !== "page") return;
    revision = recoveredA.revision;
    assert.deepEqual(
      recoveredA.metadata.steps.map((step) => step.id),
      ["real-python-environment-score"]
    );
    assert.equal(recoveredA.page.rows[0]?.values[4]?.display, expectedFirstRowScore);
    await waitFor(
      () => instrumentedRuntimeStarts(environmentA) >= 2,
      10_000,
      "environment A to launch the second recovered runtime"
    );
    assert.equal(
      testing.runtimeGeneration(),
      generationA + 2,
      "Switching back must create exactly one further replacement runtime."
    );
    assert.deepEqual(readFileSync(fixture.fsPath), originalSource, "Environment recovery must not modify the source.");
  } finally {
    if (sessionId) {
      await testing
        .request({
          kind: "closeSession",
          sessionId,
          revision
        })
        .catch(() => undefined);
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        30_000,
        "the real Python-environment session and runtime to close"
      );
    }
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

function createInstrumentedPythonEnvironment(
  environmentRoot: string,
  dependencyPython: string,
  label: string
): InstrumentedPythonEnvironment {
  execFileSync(dependencyPython, ["-m", "venv", "--without-pip", environmentRoot], {
    stdio: "pipe",
    timeout: 60_000,
    windowsHide: true
  });
  const executable =
    process.platform === "win32"
      ? path.join(environmentRoot, "Scripts", "python.exe")
      : path.join(environmentRoot, "bin", "python");
  assert.equal(existsSync(executable), true, `Instrumented Python environment ${label} must be executable.`);
  const dependencySitePackages = execFileSync(
    dependencyPython,
    ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  const environmentSitePackages = execFileSync(
    executable,
    ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  assert.ok(dependencySitePackages && environmentSitePackages);
  const runtimeMarkerDirectory = path.join(environmentRoot, "runtime-starts");
  mkdirSync(runtimeMarkerDirectory);
  const runtimeMarkerImportLine = [
    "import os, sys, uuid; ",
    "os.path.isfile(os.path.join(os.environ.get('PYTHONPATH', '').split(os.pathsep, 1)[0], ",
    "'openwrangler_runtime', 'server.py')) and not hasattr(sys, '_openwrangler_acceptance_runtime_marked') and ",
    `(setattr(sys, '_openwrangler_acceptance_runtime_marked', True), open(os.path.join(${JSON.stringify(runtimeMarkerDirectory)}, `,
    "'runtime-' + uuid.uuid4().hex + '.marker'), 'x').close())"
  ].join("");
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler-acceptance-dependencies.pth"),
    `${dependencySitePackages}\n${runtimeMarkerImportLine}\n`,
    "utf8"
  );
  return { executable, runtimeMarkerDirectory };
}

function verifyInstrumentedPythonEnvironmentMarker(
  environment: InstrumentedPythonEnvironment,
  runtimeRoot: string
): void {
  assert.deepEqual(instrumentedRuntimeMarkers(environment), []);
  execFileSync(environment.executable, ["-c", "pass"], {
    env: { ...process.env, PYTHONPATH: runtimeRoot },
    stdio: "pipe",
    timeout: 30_000,
    windowsHide: true
  });
  const markers = instrumentedRuntimeMarkers(environment);
  assert.equal(markers.length, 1, "The executable .pth marker must identify one runtime-root launch.");
  const markerPath = path.join(environment.runtimeMarkerDirectory, markers[0]!);
  const metadata = lstatSync(markerPath);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
  rmSync(markerPath);
  assert.deepEqual(instrumentedRuntimeMarkers(environment), []);
}

async function waitForSelectedPythonEnvironment(
  pythonApi: PythonExtension,
  resource: vscode.WorkspaceFolder,
  expectedExecutable: string
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 30_000) {
    const active = pythonApi.environments.getActiveEnvironmentPath(resource);
    const resolved = await pythonApi.environments.resolveEnvironment(active);
    const selectedExecutable = resolved?.executable.uri?.fsPath ?? active.path;
    if (sameAcceptanceExecutable(selectedExecutable, expectedExecutable)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the released Python extension to publish the selected environment.");
}

function sameAcceptanceExecutable(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function instrumentedRuntimeStarts(environment: InstrumentedPythonEnvironment): number {
  return instrumentedRuntimeMarkers(environment).length;
}

function instrumentedRuntimeMarkers(environment: InstrumentedPythonEnvironment): string[] {
  const entries = readdirSync(environment.runtimeMarkerDirectory);
  assert.ok(entries.length <= 16, "Instrumented Python runtime markers exceeded their fixed bound.");
  return entries.filter((entry) => /^runtime-[0-9a-f]{32}\.marker$/u.test(entry));
}

function createDependencyGuardRecoveryFixture(
  directory: string,
  dependencyPython: string,
  helperPath: string
): DependencyGuardRecoveryFixture {
  assert.equal(existsSync(helperPath), true, "The bundled dependency guard must exist in the installed extension.");
  const environmentRoot = path.join(directory, "environment");
  execFileSync(dependencyPython, ["-m", "venv", "--without-pip", environmentRoot], {
    stdio: "pipe",
    timeout: 60_000,
    windowsHide: true
  });
  const executable =
    process.platform === "win32"
      ? path.join(environmentRoot, "Scripts", "python.exe")
      : path.join(environmentRoot, "bin", "python");
  assert.equal(existsSync(executable), true, "The dependency-recovery environment is missing its interpreter.");

  const dependencySitePackages = execFileSync(
    dependencyPython,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  const environmentSitePackages = execFileSync(
    executable,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  assert.ok(path.isAbsolute(dependencySitePackages) && path.isAbsolute(environmentSitePackages));
  assert.doesNotMatch(dependencySitePackages, /[\r\n]/u);
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler-acceptance-dependencies.pth"),
    `${dependencySitePackages}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  const invocationLog = path.join(directory, "python-invocations.jsonl");
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler-acceptance-invocations.pth"),
    [
      "import json, os, sys; ",
      `stream = open(${JSON.stringify(invocationLog)}, "a", encoding="utf-8"); `,
      "stream.write(json.dumps(sys.argv, separators=(',', ':')) + '\\n'); ",
      "stream.flush(); os.fsync(stream.fileno()); stream.close()"
    ].join(""),
    { encoding: "utf8", flag: "wx" }
  );
  const dependencyProbeLog = path.join(directory, "dependency-probes.jsonl");
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler_acceptance_probe_recorder.py"),
    [
      "import importlib.util",
      "import json",
      "import os",
      "",
      `_log_path = ${JSON.stringify(dependencyProbeLog)}`,
      "_original_find_spec = importlib.util.find_spec",
      "",
      "def _recording_find_spec(name, *args, **kwargs):",
      "    with open(_log_path, 'a', encoding='utf-8') as stream:",
      "        stream.write(json.dumps({'module': name}, separators=(',', ':')) + '\\n')",
      "        stream.flush()",
      "        os.fsync(stream.fileno())",
      "    return _original_find_spec(name, *args, **kwargs)",
      "",
      "importlib.util.find_spec = _recording_find_spec",
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx" }
  );
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler-acceptance-probe-recorder.pth"),
    "import openwrangler_acceptance_probe_recorder\n",
    { encoding: "utf8", flag: "wx" }
  );

  const fixturePackage = path.join(environmentSitePackages, "openwrangler_guard_fixture");
  mkdirSync(fixturePackage);
  writeFileSync(path.join(fixturePackage, "__init__.py"), "", { encoding: "utf8", flag: "wx" });
  const fixtureMetadata = path.join(environmentSitePackages, "openwrangler_guard_fixture-1.0.0.dist-info");
  mkdirSync(fixtureMetadata);
  writeFileSync(
    path.join(fixtureMetadata, "METADATA"),
    ["Metadata-Version: 2.1", "Name: openwrangler-guard-fixture", "Version: 1.0.0", ""].join("\n"),
    { encoding: "utf8", flag: "wx" }
  );

  const pipStarted = path.join(directory, "guarded-pip-started.json");
  const pipRelease = path.join(directory, "release-guarded-pip");
  const pipCompleted = path.join(directory, "guarded-pip-completed");
  const pipPackage = path.join(environmentSitePackages, "pip");
  mkdirSync(pipPackage);
  writeFileSync(path.join(pipPackage, "__init__.py"), "", { encoding: "utf8", flag: "wx" });
  writeFileSync(
    path.join(pipPackage, "__main__.py"),
    [
      "import json",
      "import os",
      "import sys",
      "import time",
      "",
      `started_path = ${JSON.stringify(pipStarted)}`,
      `release_path = ${JSON.stringify(pipRelease)}`,
      `completed_path = ${JSON.stringify(pipCompleted)}`,
      "def publish_json(path, value):",
      "    temporary_path = f'{path}.{os.getpid()}.tmp'",
      "    with open(temporary_path, 'x', encoding='utf-8') as stream:",
      "        json.dump(value, stream, sort_keys=True)",
      "        stream.flush()",
      "        os.fsync(stream.fileno())",
      "    os.replace(temporary_path, path)",
      "",
      "publish_json(started_path, {'args': sys.argv[1:]})",
      "deadline = time.monotonic() + 60",
      "while not os.path.exists(release_path):",
      "    if time.monotonic() >= deadline:",
      "        raise SystemExit(91)",
      "    time.sleep(0.025)",
      "publish_json(completed_path, {'completed': True})",
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx" }
  );

  const preflight = JSON.parse(
    execFileSync(
      executable,
      [
        "-I",
        "-c",
        [
          "import importlib.metadata",
          "import json",
          "import openwrangler_guard_fixture",
          "import pip",
          "import polars",
          "print(json.dumps({",
          "    'fixtureVersion': importlib.metadata.version('openwrangler-guard-fixture'),",
          "    'pip': pip.__file__,",
          "    'polarsVersion': polars.__version__,",
          "}, sort_keys=True))"
        ].join("\n")
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true
      }
    )
  ) as Record<string, unknown>;
  assert.equal(preflight.fixtureVersion, "1.0.0");
  assert.equal(typeof preflight.polarsVersion, "string");
  assert.equal(
    typeof preflight.pip === "string" && sameAcceptanceExecutable(preflight.pip, path.join(pipPackage, "__init__.py")),
    true,
    "The dependency-recovery fixture must resolve only its local no-network pip implementation."
  );

  const environment = JSON.parse(
    execFileSync(
      executable,
      [
        "-I",
        "-c",
        [
          "import json",
          "import os",
          "import sys",
          "executable = os.path.abspath(sys.executable)",
          "executable_stat = os.stat(executable)",
          "package_root = os.path.realpath(os.path.abspath(sys.prefix))",
          "package_root_stat = os.stat(package_root)",
          "print(json.dumps({",
          "    'executable': executable,",
          "    'executableIdentity': {",
          "        'device': str(executable_stat.st_dev),",
          "        'inode': str(executable_stat.st_ino),",
          "        'size': str(executable_stat.st_size),",
          "        'mtimeNs': str(executable_stat.st_mtime_ns),",
          "        'ctimeNs': str(executable_stat.st_ctime_ns),",
          "    },",
          "    'packageRoot': package_root,",
          "    'packageRootIdentity': {",
          "        'device': str(package_root_stat.st_dev),",
          "        'inode': str(package_root_stat.st_ino),",
          "    },",
          "    'pythonVersion': '.'.join(str(part) for part in sys.version_info[:3]),",
          "}, separators=(',', ':')))"
        ].join("\n")
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true
      }
    )
  ) as DependencyGuardAcceptanceEnvironment;
  assert.equal(sameAcceptanceExecutable(environment.executable, executable), true);
  assert.equal(sameAcceptanceExecutable(environment.packageRoot, environmentRoot), true);

  const dependency: DependencyGuardAcceptanceDependency = {
    importModule: "openwrangler_guard_fixture",
    distribution: "openwrangler-guard-fixture",
    installSpec: "openwrangler-guard-fixture>=1.0.0,<2.0.0",
    minimumVersion: "1.0.0",
    maximumVersionExclusive: "2.0.0"
  };
  const parentState = path.join(directory, "guard-parent-state.json");
  const parentAuthorized = path.join(directory, "guard-parent-authorized.json");
  const parentScript = path.join(directory, "guard_parent.py");
  const installFrame = `${JSON.stringify({
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "install",
    token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN,
    environment,
    dependencies: [dependency]
  })}\n`;
  const goFrame = `${JSON.stringify({
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "go",
    token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
  })}\n`;
  const parentCrashFrame = `${JSON.stringify({
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "crash",
    token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
  })}\n`;
  writeFileSync(
    parentScript,
    [
      "import json",
      "import os",
      "import subprocess",
      "import sys",
      "",
      `helper_path = ${JSON.stringify(helperPath)}`,
      `working_directory = ${JSON.stringify(directory)}`,
      `state_path = ${JSON.stringify(parentState)}`,
      `authorized_path = ${JSON.stringify(parentAuthorized)}`,
      `release_path = ${JSON.stringify(pipRelease)}`,
      `install_frame = ${JSON.stringify(installFrame)}.encode('ascii')`,
      `go_frame = ${JSON.stringify(goFrame)}.encode('ascii')`,
      `crash_frame = ${JSON.stringify(parentCrashFrame)}.encode('ascii')`,
      `expected_token = ${JSON.stringify(DEPENDENCY_GUARD_ACCEPTANCE_TOKEN)}`,
      `protocol = ${JSON.stringify(DEPENDENCY_GUARD_PROTOCOL)}`,
      `crash_exit_code = ${DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE}`,
      "",
      "def publish(path, payload):",
      "    temporary_path = f'{path}.{os.getpid()}.tmp'",
      "    with open(temporary_path, 'x', encoding='utf-8') as stream:",
      "        json.dump(payload, stream, separators=(',', ':'), sort_keys=True)",
      "        stream.flush()",
      "        os.fsync(stream.fileno())",
      "    os.replace(temporary_path, path)",
      "",
      "guard = None",
      "authorized = False",
      "try:",
      "    creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)",
      "    guard = subprocess.Popen(",
      "        [sys.executable, '-I', helper_path, 'install'],",
      "        cwd=working_directory,",
      "        env=os.environ.copy(),",
      "        stdin=subprocess.PIPE,",
      "        stdout=subprocess.PIPE,",
      "        stderr=subprocess.DEVNULL,",
      "        close_fds=True,",
      "        creationflags=creationflags,",
      "    )",
      "    publish(state_path, {'guardPid': guard.pid, 'parentPid': os.getpid()})",
      "    if guard.stdin is None or guard.stdout is None:",
      "        raise RuntimeError('guard pipes were unavailable')",
      "    guard.stdin.write(install_frame)",
      "    guard.stdin.flush()",
      "    ready_raw = guard.stdout.readline(65537)",
      "    if not ready_raw or len(ready_raw) > 65536 or not ready_raw.endswith(b'\\n') or ready_raw.endswith(b'\\r\\n'):",
      "        raise RuntimeError('guard READY frame was not exact')",
      "    ready = json.loads(ready_raw[:-1].decode('ascii'))",
      "    if ready != {'kind': 'ready', 'protocol': protocol, 'token': expected_token}:",
      "        raise RuntimeError('guard READY frame did not match')",
      "    guard.stdin.write(go_frame)",
      "    guard.stdin.flush()",
      "    guard.stdin.close()",
      "    authorized = True",
      "    publish(authorized_path, {",
      "        'guardPid': guard.pid,",
      "        'kind': 'authorized',",
      "        'parentPid': os.getpid(),",
      "        'protocol': protocol,",
      "        'token': expected_token,",
      "    })",
      "    crash_request = sys.stdin.buffer.read(len(crash_frame) + 1)",
      "    if crash_request != crash_frame:",
      "        raise RuntimeError('parent crash frame did not match')",
      "    os._exit(crash_exit_code)",
      "except BaseException:",
      "    if guard is not None and guard.poll() is None:",
      "        if authorized:",
      "            try:",
      "                with open(release_path, 'x', encoding='utf-8') as stream:",
      "                    stream.write('release\\n')",
      "            except FileExistsError:",
      "                pass",
      "        elif guard.stdin is not None:",
      "            guard.stdin.close()",
      "        try:",
      "            guard.wait(timeout=10)",
      "        except subprocess.TimeoutExpired:",
      "            guard.kill()",
      "            guard.wait(timeout=10)",
      "    raise",
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx" }
  );
  const marker = path.join(
    environment.packageRoot,
    ".openwrangler-dependency-journal-v1",
    `mutation-${DEPENDENCY_GUARD_ACCEPTANCE_TOKEN}.json`
  );
  return {
    directory,
    executable,
    helperPath,
    environment,
    dependency,
    marker,
    pipStarted,
    pipRelease,
    pipCompleted,
    parentScript,
    parentState,
    parentAuthorized,
    parentCrashFrame,
    invocationLog,
    dependencyProbeLog
  };
}

function launchAcceptanceGuardParent(fixture: DependencyGuardRecoveryFixture): AcceptanceGuardProcess {
  const child = spawn(fixture.executable, ["-I", fixture.parentScript], {
    cwd: fixture.directory,
    env: dependencyGuardAcceptanceProcessEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const handle: AcceptanceGuardProcess = {
    child,
    exit: Promise.resolve({
      code: null,
      signal: null,
      stdout: "",
      stderr: ""
    }),
    closed: false
  };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflow = false;
  let processError: Error | undefined;
  const capture = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
    if (stream === "stdout") stdoutBytes += chunk.byteLength;
    else stderrBytes += chunk.byteLength;
    if (stdoutBytes > 65_536 || stderrBytes > 65_536) {
      outputOverflow = true;
      return;
    }
    chunks.push(Buffer.from(chunk));
  };
  child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, "stderr"));
  child.once("error", (error) => {
    processError = error;
  });
  handle.exit = new Promise((resolve, reject) => {
    child.once("close", (code, signal) => {
      handle.closed = true;
      if (processError) {
        reject(processError);
        return;
      }
      if (outputOverflow) {
        reject(new Error("Dependency-guard acceptance output exceeded its fixed 64 KiB bound."));
        return;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
  return handle;
}

function parseAcceptanceGuardFrames(stdout: string): Record<string, unknown>[] {
  assert.ok(Buffer.byteLength(stdout, "utf8") <= 65_536);
  assert.ok(stdout.endsWith("\n") && !stdout.endsWith("\r\n"));
  return stdout
    .slice(0, -1)
    .split("\n")
    .map((frame) => {
      const decoded = JSON.parse(frame) as unknown;
      assert.ok(decoded && typeof decoded === "object" && !Array.isArray(decoded));
      return decoded as Record<string, unknown>;
    });
}

function readDependencyGuardParentState(file: string): { parentPid: number; guardPid: number } {
  const decoded = readBoundedAcceptanceJson(file);
  assert.deepEqual(Object.keys(decoded).sort(), ["guardPid", "parentPid"]);
  assert.ok(Number.isSafeInteger(decoded.parentPid) && (decoded.parentPid as number) > 0);
  assert.ok(Number.isSafeInteger(decoded.guardPid) && (decoded.guardPid as number) > 0);
  return {
    parentPid: decoded.parentPid as number,
    guardPid: decoded.guardPid as number
  };
}

function readDependencyGuardParentAuthorization(file: string): Record<string, unknown> {
  const decoded = readBoundedAcceptanceJson(file);
  assert.deepEqual(Object.keys(decoded).sort(), ["guardPid", "kind", "parentPid", "protocol", "token"]);
  return decoded;
}

function readBoundedAcceptanceJson(file: string): Record<string, unknown> {
  let descriptor: number | undefined;
  let payload: Buffer | undefined;
  let operationError: unknown;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    assert.ok(opened.isFile() && opened.nlink === 1n);
    assert.ok(opened.size > 0n && opened.size <= 4_096n);

    const boundedPayload = Buffer.alloc(4_097);
    let offset = 0;
    while (offset < boundedPayload.byteLength) {
      const count = readSync(descriptor, boundedPayload, offset, boundedPayload.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    assert.ok(offset > 0 && offset <= 4_096);

    const completed = fstatSync(descriptor, { bigint: true });
    assert.ok(
      completed.isFile() &&
        completed.nlink === 1n &&
        completed.dev === opened.dev &&
        completed.ino === opened.ino &&
        completed.size === opened.size &&
        completed.size === BigInt(offset) &&
        completed.mtimeNs === opened.mtimeNs &&
        completed.ctimeNs === opened.ctimeNs,
      "Bounded acceptance evidence must not change while its owned descriptor is read."
    );
    const pathIdentity = lstatSync(file, { bigint: true });
    assert.ok(
      pathIdentity.isFile() &&
        !pathIdentity.isSymbolicLink() &&
        pathIdentity.nlink === 1n &&
        pathIdentity.dev === completed.dev &&
        pathIdentity.ino === completed.ino,
      "Bounded acceptance evidence must retain its opened file identity."
    );
    payload = Buffer.from(boundedPayload.subarray(0, offset));
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError && closeError) {
    throw new AggregateError(
      [operationError, closeError],
      "Bounded acceptance evidence read and descriptor close both failed."
    );
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  assert.ok(payload);

  const decoded = JSON.parse(payload.toString("utf8")) as unknown;
  assert.ok(decoded && typeof decoded === "object" && !Array.isArray(decoded));
  return decoded as Record<string, unknown>;
}

function acceptanceProcessIsAlive(pid: number): boolean {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function readAcceptanceGuardStatus(fixture: DependencyGuardRecoveryFixture): Record<string, unknown> {
  const stdout = execFileSync(fixture.executable, ["-I", fixture.helperPath, "status"], {
    cwd: fixture.directory,
    env: dependencyGuardAcceptanceProcessEnvironment(),
    input: `${JSON.stringify({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      environment: fixture.environment
    })}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true
  });
  const frames = parseAcceptanceGuardFrames(stdout);
  assert.equal(frames.length, 1);
  return frames[0]!;
}

function readDependencyGuardProbeInvocations(fixture: DependencyGuardRecoveryFixture): Record<string, unknown>[] {
  if (!existsSync(fixture.dependencyProbeLog)) return [];
  const payload = readFileSync(fixture.dependencyProbeLog);
  assert.ok(payload.byteLength <= 65_536, "Dependency-probe invocation evidence exceeded 64 KiB.");
  const lines = payload.toString("utf8").split("\n");
  assert.equal(lines.pop(), "");
  assert.ok(lines.length <= 64, "Dependency-probe invocation evidence exceeded 64 calls.");
  return lines.map((line) => {
    const decoded = JSON.parse(line) as unknown;
    assert.ok(
      decoded &&
        typeof decoded === "object" &&
        !Array.isArray(decoded) &&
        typeof (decoded as Record<string, unknown>).module === "string"
    );
    return decoded as Record<string, unknown>;
  });
}

function readDependencyGuardAcceptanceInvocations(fixture: DependencyGuardRecoveryFixture): string[][] {
  const payload = readFileSync(fixture.invocationLog);
  assert.ok(payload.byteLength <= 65_536, "Dependency-recovery invocation evidence exceeded 64 KiB.");
  const lines = payload.toString("utf8").split("\n");
  assert.equal(lines.pop(), "");
  assert.ok(lines.length <= 64, "Dependency-recovery invocation evidence exceeded 64 processes.");
  return lines.map((line) => {
    const decoded = JSON.parse(line) as unknown;
    assert.ok(Array.isArray(decoded) && decoded.every((argument) => typeof argument === "string"));
    return decoded as string[];
  });
}

function dependencyGuardAcceptanceProcessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowedKeys = new Set([
    "APPDATA",
    "COMSPEC",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR"
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedKeys.has(key.toLocaleUpperCase("en-US"))) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function settleOrphanedAcceptanceGuard(fixture: DependencyGuardRecoveryFixture, pid: number): Promise<void> {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  createAcceptanceSignalExclusively(fixture.pipRelease, "release\n");
  if (existsSync(fixture.pipStarted) && !existsSync(fixture.pipCompleted)) {
    await waitFor(
      () => existsSync(fixture.pipCompleted),
      WORKBENCH_OPERATION_TIMEOUT_MS,
      `the exact orphaned dependency guard ${pid} to finish its guarded writer during cleanup`
    );
  }
  await waitForAcceptanceGuardRelease(
    fixture,
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `the exact orphaned dependency guard ${pid} to release its environment during cleanup`
  );
}

function createAcceptanceSignalExclusively(file: string, content: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      // Another cleanup observer already published the one-shot release signal.
      return;
    }
    throw error;
  }

  let operationError: unknown;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assert.ok(
      opened.isFile() && opened.nlink === 1n,
      "An acceptance cleanup signal must be one exclusively owned regular file."
    );
    writeFileSync(descriptor, content, "utf8");
    const completed = fstatSync(descriptor, { bigint: true });
    assert.ok(
      completed.isFile() &&
        completed.nlink === 1n &&
        completed.dev === opened.dev &&
        completed.ino === opened.ino &&
        completed.size === BigInt(Buffer.byteLength(content, "utf8")),
      "An acceptance cleanup signal must retain its exclusive file identity while written."
    );
    const pathIdentity = lstatSync(file, { bigint: true });
    assert.ok(
      pathIdentity.isFile() &&
        !pathIdentity.isSymbolicLink() &&
        pathIdentity.nlink === 1n &&
        pathIdentity.dev === completed.dev &&
        pathIdentity.ino === completed.ino,
      "An acceptance cleanup signal path must retain its exclusive file identity."
    );
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError && closeError) {
    throw new AggregateError(
      [operationError, closeError],
      "Acceptance cleanup signal publication and descriptor close both failed."
    );
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
}

async function waitForAcceptanceGuardRelease(
  fixture: DependencyGuardRecoveryFixture,
  timeoutMs: number,
  expectation: string
): Promise<Record<string, unknown>> {
  let releasedStatus: Record<string, unknown> | undefined;
  await waitFor(
    () => {
      try {
        const status = readAcceptanceGuardStatus(fixture);
        const released =
          status.protocol === DEPENDENCY_GUARD_PROTOCOL &&
          status.kind === "status" &&
          ((status.state === "dirty" && status.token === DEPENDENCY_GUARD_ACCEPTANCE_TOKEN) ||
            (status.state === "clean" && status.token === null));
        if (released) releasedStatus = status;
        return released;
      } catch {
        return false;
      }
    },
    timeoutMs,
    expectation
  );
  assert.ok(releasedStatus, "Dependency-guard release polling completed without an exact status.");
  return releasedStatus;
}

async function crashAcceptanceGuardParent(
  process: AcceptanceGuardProcess,
  crashFrame: string,
  description: string
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  if (!process.closed) {
    assert.ok(
      process.parentPid !== undefined && process.parentPid > 0,
      `${description} cannot be crashed before its exact Python PID is published.`
    );
    assert.ok(
      !process.child.stdin.destroyed && process.child.stdin.writable,
      `${description} no longer owns a writable crash channel.`
    );
    process.child.stdin.end(Buffer.from(crashFrame, "ascii"));
  }
  const result = await withAcceptanceOperationDeadline(
    process.exit,
    WORKBENCH_OPERATION_TIMEOUT_MS,
    `${description} to close`
  );
  const failureDetail = result.stderr.trim() ? ` stderr=${JSON.stringify(result.stderr.trim())}` : "";
  assert.equal(
    result.code,
    DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE,
    `${description} did not exit through its exact crash frame.${failureDetail}`
  );
  assert.equal(result.signal, null, `${description} was terminated by an unexpected signal.`);
  return result;
}

function createDependencyIsolatedPython(directory: string, python: string, invocationLog: string): string {
  const environment = path.join(directory, "environment");
  execFileSync(python, ["-m", "venv", "--without-pip", environment], {
    stdio: "pipe",
    timeout: 30_000,
    windowsHide: true
  });
  const executable =
    process.platform === "win32"
      ? path.join(environment, "Scripts", "python.exe")
      : path.join(environment, "bin", "python");
  assert.ok(existsSync(executable), "The dependency-isolated Python environment is missing its interpreter.");
  const sitePackages = execFileSync(
    executable,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  assert.ok(path.isAbsolute(sitePackages), "The dependency-isolated environment returned an invalid site-packages.");
  writeFileSync(
    path.join(sitePackages, "openwrangler-acceptance-invocations.pth"),
    `import builtins; builtins.open(${JSON.stringify(invocationLog)}, "a", encoding="utf-8").write("invoked\\n")\n`,
    { encoding: "utf8", flag: "wx" }
  );
  return executable;
}

function createDependencyInstallLifecyclePython(
  directory: string,
  dependencyPython: string
): DependencyInstallLifecycleFixture {
  const started = path.join(directory, "pip-started.json");
  const release = path.join(directory, "release-pip");
  const completed = path.join(directory, "pip-completed.json");
  const fakePipSource = [
    "import json",
    "import os",
    "import sys",
    "import time",
    "",
    `started_path = ${JSON.stringify(started)}`,
    `release_path = ${JSON.stringify(release)}`,
    `completed_path = ${JSON.stringify(completed)}`,
    "environment_keys = {key.upper() for key in os.environ}",
    "def publish_json(path, value):",
    "    temporary_path = f'{path}.{os.getpid()}.tmp'",
    "    with open(temporary_path, 'x', encoding='utf-8') as stream:",
    "        json.dump(value, stream, sort_keys=True)",
    "        stream.flush()",
    "        os.fsync(stream.fileno())",
    "    os.replace(temporary_path, path)",
    "",
    "details = {",
    '    "args": sys.argv[1:],',
    '    "cwd": os.getcwd(),',
    '    "pipNoInput": os.environ.get("PIP_NO_INPUT"),',
    '    "pipConfigFile": os.environ.get("PIP_CONFIG_FILE"),',
    '    "pipUser": os.environ.get("PIP_USER"),',
    '    "pythonPathPresent": "PYTHONPATH" in environment_keys,',
    '    "pythonHomePresent": "PYTHONHOME" in environment_keys,',
    "}",
    "publish_json(started_path, details)",
    "deadline = time.monotonic() + 30",
    "while not os.path.exists(release_path):",
    "    if time.monotonic() >= deadline:",
    "        raise SystemExit(92)",
    "    time.sleep(0.025)",
    "publish_json(completed_path, {**details, 'released': True})",
    ""
  ].join("\n");

  const environment = path.join(directory, "environment");
  execFileSync(dependencyPython, ["-m", "venv", "--without-pip", environment], {
    stdio: "pipe",
    timeout: 30_000,
    windowsHide: true
  });
  const executable =
    process.platform === "win32"
      ? path.join(environment, "Scripts", "python.exe")
      : path.join(environment, "bin", "python");
  assert.ok(existsSync(executable), "The lifecycle-test Python environment is missing its interpreter.");
  const sitePackages = execFileSync(
    executable,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  assert.ok(path.isAbsolute(sitePackages), "The lifecycle-test environment returned invalid site-packages.");
  writeFileSync(
    path.join(sitePackages, "sitecustomize.py"),
    [
      "import os",
      "import sys",
      'sys.path[:] = [entry for entry in sys.path if entry != ""]',
      "cwd = os.path.normcase(os.path.abspath(os.getcwd()))",
      "sys.path[:] = [",
      "    entry",
      "    for entry in sys.path",
      "    if os.path.normcase(os.path.abspath(entry)) != cwd",
      "]",
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx" }
  );
  const pipPackage = path.join(sitePackages, "pip");
  mkdirSync(pipPackage);
  writeFileSync(path.join(pipPackage, "__init__.py"), "", { encoding: "utf8", flag: "wx" });
  writeFileSync(path.join(pipPackage, "__main__.py"), fakePipSource, { encoding: "utf8", flag: "wx" });
  const preflight = JSON.parse(
    execFileSync(
      executable,
      [
        "-I",
        "-c",
        [
          "import importlib.util",
          "import json",
          "import pip",
          "import sys",
          "print(json.dumps({",
          "    'executable': sys.executable,",
          "    'prefix': sys.prefix,",
          "    'pandas': importlib.util.find_spec('pandas') is not None,",
          "    'xlrd': importlib.util.find_spec('xlrd') is not None,",
          "    'pip': pip.__file__,",
          "}, sort_keys=True))"
        ].join("\n")
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true
      }
    )
  ) as Record<string, unknown>;
  assert.equal(
    typeof preflight.executable === "string" && sameAcceptanceExecutable(preflight.executable, executable),
    true,
    "The lifecycle-test interpreter must report the exact selected virtual-environment executable."
  );
  assert.equal(
    typeof preflight.prefix === "string" && sameAcceptanceExecutable(preflight.prefix, environment),
    true,
    "The lifecycle-test interpreter must retain its isolated virtual-environment prefix."
  );
  assert.equal(preflight.pandas, false, "The lifecycle-test environment must not expose pandas.");
  assert.equal(preflight.xlrd, false, "The lifecycle-test environment must not expose xlrd.");
  assert.equal(
    typeof preflight.pip === "string" && sameAcceptanceExecutable(preflight.pip, path.join(pipPackage, "__init__.py")),
    true,
    "The lifecycle-test environment must import only its owned fake pip package."
  );
  return { executable, started, release, completed };
}

async function exercisePackagedViewingQueries(testing: TestApi, fixture: vscode.Uri): Promise<void> {
  const original = readFileSync(fixture.fsPath, "utf8");
  const filterModel: FilterModel = {
    logic: "or",
    filters: [
      {
        column: "city",
        type: "string",
        predicates: [{ kind: "predicate", operator: "startsWith", value: "M" }]
      },
      {
        column: "sales",
        type: "float",
        predicates: [{ kind: "predicate", operator: "gt", value: 11 }]
      }
    ],
    sort: [
      { column: "active", direction: "asc", nulls: "last" },
      { column: "sales", direction: "desc", nulls: "last" }
    ]
  };

  for (const backend of ["pandas", "polars", "duckdb"] as const) {
    const opened = await testing.request({
      kind: "openSession",
      ...GRID_COLUMN_WINDOW,
      source: csvSource(fixture),
      backend,
      pageSize: 2,
      mode: "viewing"
    });
    assert.equal(opened.kind, "sessionOpened", `${backend} viewing session must open.`);
    if (opened.kind !== "sessionOpened") continue;

    const page = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: `${backend}-filter-page`,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 2,
      filterModel
    });
    assert.equal(page.kind, "page", `${backend} advanced filter and multi-sort must return a page.`);
    if (page.kind !== "page") continue;
    assert.equal(page.page.totalRows, 2);
    assert.deepEqual(
      page.page.rows.map((row) => row.values[0]?.display),
      ["Berlin", "Milan"]
    );
    assert.equal(page.metadata.steps.length, 0, "Viewing queries must not become cleaning steps.");
    assert.deepEqual(page.metadata.filterModel, filterModel);

    const summary = await testing.request({
      kind: "getSummary",
      viewRequestId: `${backend}-filter-summary`,
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      filterModel
    });
    assert.equal(summary.kind, "summary", `${backend} progressive summary must resolve.`);
    if (summary.kind === "summary") {
      assert.equal(summary.summaries.length, 4);
      assert.ok(summary.summaries.every((column) => column.totalCount === 2));
      assert.equal(summary.summaries.find((column) => column.column === "sales")?.numeric?.max, 12);
    }

    const stats = await testing.request({
      kind: "getDatasetStats",
      viewRequestId: `${backend}-filter-stats`,
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      filterModel
    });
    assert.equal(stats.kind, "datasetStats", `${backend} exact dataset stats must resolve.`);
    if (stats.kind === "datasetStats") {
      assert.equal(stats.stats.missingCells, 0);
      assert.equal(stats.stats.missingRows, 0);
      assert.equal(stats.stats.duplicateRows, 0);
    }

    const values = await testing.request({
      kind: "getColumnValues",
      viewRequestId: `${backend}-filter-values`,
      sessionId: opened.metadata.sessionId,
      revision: page.revision,
      column: "city",
      filterModel,
      search: "il",
      limit: 10
    });
    assert.equal(values.kind, "columnValues", `${backend} searchable column values must resolve.`);
    if (values.kind === "columnValues") {
      assert.deepEqual(values.values, [
        {
          value: "Milan",
          count: 1,
          selectionValue: {
            kind: "typedSelection",
            version: 1,
            columnType: "string",
            cell: { kind: "string", raw: "Milan", display: "Milan", isNull: false, isNaN: false }
          }
        }
      ]);
      assert.equal(values.hasMore, false);
    }

    assert.equal(testing.activeSession()?.metadata.steps.length, 0);
    const closed = await testing.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: page.revision
    });
    assert.equal(closed.kind, "sessionClosed");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      `${backend} viewing-query session to dispose`
    );
  }

  assert.equal(readFileSync(fixture.fsPath, "utf8"), original, "Viewing queries must not alter the source.");
}

async function exerciseWideColumnProjection(testing: TestApi): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-wide-projection-"));
  const sourcePath = path.join(directory, "wide.csv");
  const columnCount = 417;
  const farColumnOffset = columnCount - 12;
  const names = Array.from({ length: columnCount }, (_, column) => `column_${column.toString().padStart(3, "0")}`);
  const values = (row: number) => names.map((_name, column) => String(row * 1_000 + column));
  const source = [names, values(0), values(1)].map((row) => row.join(",")).join("\n") + "\n";
  writeFileSync(sourcePath, source);

  try {
    for (const backend of ["pandas", "polars", "duckdb"] as const) {
      const opened = await testing.request({
        kind: "openSession",
        source: { kind: "file", label: "wide.csv", path: sourcePath },
        backend,
        pageSize: 2,
        columnOffset: 0,
        columnLimit: 16,
        mode: "viewing"
      });
      assert.equal(opened.kind, "sessionOpened", `${backend} wide projection must open.`);
      if (opened.kind !== "sessionOpened") continue;
      assert.equal(opened.metadata.shape.columns, columnCount);
      assert.deepEqual(
        opened.page.columnIds,
        opened.metadata.schema.slice(0, 16).map((column) => column.id),
        `${backend} initial transport must stay column bounded.`
      );
      assert.ok(opened.page.rows.every((row) => row.values.length === 16));

      const projected = await testing.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: `${backend}-wide-far-columns`,
        offset: 0,
        limit: 2,
        columnOffset: farColumnOffset,
        columnLimit: 12,
        filterModel: {
          logic: "and",
          filters: [
            {
              column: "column_000",
              type: "integer",
              predicates: [{ kind: "predicate", operator: "gt", value: 0 }]
            }
          ],
          sort: [{ column: "column_001", direction: "desc", nulls: "last" }]
        }
      });
      assert.equal(projected.kind, "page", `${backend} far-column block must resolve.`);
      if (projected.kind !== "page") continue;
      assert.equal(projected.page.totalRows, 1, `${backend} must filter on an untransported column.`);
      assert.deepEqual(
        projected.page.columnIds,
        projected.metadata.schema.slice(farColumnOffset, columnCount).map((column) => column.id)
      );
      assert.equal(projected.page.rows[0]?.values[0]?.display, String(1_000 + farColumnOffset));
      assert.equal(projected.page.rows[0]?.values[11]?.display, String(1_000 + columnCount - 1));
      assert.ok(projected.page.rows.every((row) => row.values.length === 12));

      const closed = await testing.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: projected.revision
      });
      assert.equal(closed.kind, "sessionClosed");
    }

    if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT) {
      const sourceUri = vscode.Uri.file(sourcePath);
      const originalBackend = vscode.workspace
        .getConfiguration("openWrangler")
        .get<"auto" | "polars" | "pandas" | "duckdb">("defaultBackend", "auto");
      await vscode.workspace
        .getConfiguration("openWrangler")
        .update("defaultBackend", "polars", vscode.ConfigurationTarget.Global);
      try {
        recordAcceptanceProgress("verify:wide-projection:picker:open");
        await vscode.commands.executeCommand("openWrangler.openFile", sourceUri);
        await waitFor(
          () => {
            const active = testing.activeSession();
            // Uri.fsPath intentionally lower-cases Windows drive letters, while
            // the raw os.tmpdir() spelling used to create sourcePath need not.
            return (
              active?.metadata.source.uri === sourceUri.toString() &&
              active.metadata.backend === "polars" &&
              active.metadata.shape.rows === 2 &&
              active.metadata.shape.columns === columnCount
            );
          },
          SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
          "the public wide-schema file workflow to open every column",
          () =>
            packagedFileOpenDiagnostics(testing, {
              sourceLabel: path.basename(sourceUri.fsPath),
              backend: "polars",
              shape: { rows: 2, columns: columnCount }
            })
        );

        const active = testing.activeSession();
        assert.ok(active, "The wide-schema picker journey requires its exact active session.");
        assert.equal(
          active.metadata.source.path,
          sourceUri.fsPath,
          "The public file command must retain VS Code's canonical filesystem spelling."
        );
        const sessionId = active.sessionId;
        const finalColumn = active.metadata.schema[columnCount - 1];
        assert.ok(finalColumn, "The wide-schema picker journey requires its final column.");
        const workbench = await connectToEditorWorkbench();
        const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
        const app = await exactSessionApp(target.frame, sessionId);
        assert.ok(app, "The wide-schema picker journey requires its exact visible application.");
        const columnSearch = app.getByRole("combobox", { name: "Column", exact: true });

        recordAcceptanceProgress("verify:wide-projection:picker:all-columns");
        await columnSearch.focus();
        const listbox = app.getByRole("listbox", { name: "Matching columns", exact: true });
        await listbox.waitFor({ state: "visible", timeout: 10_000 });
        const firstOption = listbox.getByRole("option").first();
        assert.equal(
          await firstOption.getAttribute("aria-setsize"),
          String(columnCount),
          "The real column picker must expose the complete schema instead of a 100-result subset."
        );
        assert.equal(
          await app.getByText(/Showing 100 of/u).count(),
          0,
          "The real column picker must not retain the old 100-result cap."
        );

        await columnSearch.press("End");
        const finalOption = listbox.locator(`[role="option"][aria-posinset="${columnCount}"]`);
        await finalOption.waitFor({ state: "visible", timeout: 10_000 });
        assert.match(
          (await finalOption.getAttribute("aria-label")) ?? "",
          /^column_416, /u,
          "End must reach the final column in a 417-column schema."
        );
        assert.equal(
          await finalOption.getAttribute("aria-setsize"),
          String(columnCount),
          "The final virtualized option must retain the complete result count."
        );
        assert.ok(
          (await listbox.getByRole("option").count()) < 30,
          "The complete column picker must remain DOM-bounded while exposing all results."
        );

        await columnSearch.press("Enter");
        await waitFor(
          () => testing.activeSession()?.viewState.selectedColumnId === finalColumn.id,
          10_000,
          "the real column picker to select its final schema column"
        );
        await app.locator('th[data-column="column_416"]').first().waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(
          await app.locator('th[data-column="column_416"]').first().getAttribute("aria-colindex"),
          String(columnCount + 1),
          "The selected far-right grid header must keep its full-schema ARIA coordinate."
        );

        await disposePackagedSessionPanel(testing, sessionId, "the real wide-schema picker session");
        recordAcceptanceProgress("verify:wide-projection:picker:complete");
      } finally {
        await vscode.workspace
          .getConfiguration("openWrangler")
          .update("defaultBackend", originalBackend, vscode.ConfigurationTarget.Global);
      }
    }

    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      10_000,
      "wide projected sessions to close"
    );
    assert.equal(readFileSync(sourcePath, "utf8"), source, "Wide projection must not mutate the source.");
  } finally {
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function exercisePackagedOperationGroups(testing: TestApi, sourceFixture: vscode.Uri): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-operation-groups-"));
  const sourcePath = path.join(directory, "operations.csv");
  const original = readFileSync(sourceFixture.fsPath, "utf8");
  writeFileSync(sourcePath, original);

  try {
    for (const backend of ["pandas", "polars", "duckdb"] as const) {
      const opened = await testing.request({
        kind: "openSession",
        ...GRID_COLUMN_WINDOW,
        source: csvSource(vscode.Uri.file(sourcePath)),
        backend,
        pageSize: 20,
        mode: "editing"
      });
      assert.equal(opened.kind, "sessionOpened", `${backend} operation-group session must open.`);
      if (opened.kind !== "sessionOpened") continue;

      let revision = opened.metadata.revision;
      let stepCount = 0;
      const steps: TransformStep[] = [
        {
          id: `${backend}-sort`,
          kind: "sortRows",
          params: { rules: [{ column: columnReference(opened.metadata, "sales"), direction: "desc", nulls: "last" }] }
        },
        {
          id: `${backend}-formula`,
          kind: "formula",
          params: {
            leftColumn: columnReference(opened.metadata, "sales"),
            operator: "multiply",
            value: 2,
            newColumn: "score"
          }
        },
        {
          id: `${backend}-text`,
          kind: "upperText",
          params: { column: columnReference(opened.metadata, "city"), newColumn: "city_upper" }
        },
        {
          id: `${backend}-numeric`,
          kind: "roundNumber",
          params: {
            column: { id: `c:step:${backend}-formula:0`, name: "score" },
            decimals: 0,
            newColumn: "rounded_score"
          }
        },
        {
          id: `${backend}-example`,
          kind: "byExample",
          params: {
            sourceColumns: [columnReference(opened.metadata, "city")],
            newColumn: "city_example",
            examples: [
              { inputs: ["Milan"], output: "MILAN" },
              { inputs: ["Rome"], output: "ROME" }
            ]
          }
        },
        {
          id: `${backend}-custom`,
          kind: "customCode",
          params: {
            code:
              backend === "pandas"
                ? 'result = df.assign(custom=df["sales"] + 1)'
                : backend === "polars"
                  ? 'result = df.with_columns((pl.col("sales") + 1).alias("custom"))'
                  : 'result = df.filter("sales IS NOT NULL")'
          }
        },
        {
          id: `${backend}-group`,
          kind: "groupBy",
          params: {
            keys: [columnReference(opened.metadata, "active")],
            aggregations: [
              { column: columnReference(opened.metadata, "sales"), operation: "sum", alias: "total_sales" }
            ]
          }
        }
      ];

      for (const step of steps) {
        const preview = await testing.request({
          kind: "previewStep",
          ...GRID_COLUMN_WINDOW,
          sessionId: opened.metadata.sessionId,
          revision,
          step,
          offset: 0,
          limit: 20
        });
        assert.equal(preview.kind, "stepPreview", `${backend} ${step.kind} must preview.`);
        if (preview.kind !== "stepPreview") break;
        assert.equal(preview.metadata.draftStep?.kind, step.kind);
        assert.match(preview.code, /def clean_data\(df\):/);
        assert.equal(preview.diff.truncated, false);
        if (backend === "polars") assert.doesNotMatch(preview.code, /to_pandas|import pandas/);
        if (backend === "duckdb") {
          assert.match(preview.code, /\bimport duckdb\b/u);
          assert.doesNotMatch(preview.code, DUCKDB_FOREIGN_ENGINE_CONVERSION);
        }
        if (step.kind === "byExample") {
          assert.ok(preview.metadata.draftStep?.params.program, "By-example preview must resolve a program.");
        }

        revision = preview.revision;
        const applied = await testing.request({
          kind: "applyDraft",
          ...GRID_COLUMN_WINDOW,
          sessionId: opened.metadata.sessionId,
          revision,
          offset: 0,
          limit: 20
        });
        assert.equal(applied.kind, "planUpdated", `${backend} ${step.kind} must apply.`);
        if (applied.kind !== "planUpdated") break;
        stepCount += 1;
        revision = applied.revision;
        assert.equal(applied.metadata.steps.length, stepCount);

        if (step.kind === "customCode") {
          const generation = testing.runtimeGeneration();
          testing.restartRuntime(`${backend} custom-code replay acceptance`);
          const replayed = await testing.request({
            kind: "getPage",
            ...GRID_COLUMN_WINDOW,
            viewRequestId: `${backend}-${step.kind}-replay-page`,
            sessionId: opened.metadata.sessionId,
            revision,
            offset: 0,
            limit: 20,
            filterModel: applied.metadata.filterModel
          });
          assert.equal(replayed.kind, "page", `${backend} custom-code plan must replay after restart.`);
          assert.equal(testing.runtimeGeneration(), generation + 1);
          if (replayed.kind === "page") revision = replayed.revision;
        }
      }

      assert.equal(stepCount, steps.length, `${backend} must apply every representative operation group.`);
      const active = testing.activeSession();
      assert.equal(active?.metadata.steps.length, steps.length);
      assert.deepEqual(
        active?.metadata.schema.map((column) => column.name),
        ["active", "total_sales"]
      );
      assert.match(active?.code ?? "", /def clean_data/u, `${backend} must retain executable generated code.`);
      if (backend === "duckdb") {
        assert.match(active?.code ?? "", /\bimport duckdb\b/u);
        assert.doesNotMatch(active?.code ?? "", DUCKDB_FOREIGN_ENGINE_CONVERSION);
      }

      const editedCode = `# edited ${backend} code preview\ndef clean_data(df):\n    return df\n`;
      const priorClipboard = await vscode.env.clipboard.readText();
      testing.setCodeForExport(editedCode);
      const copiedCode = await vscode.commands.executeCommand<string>("openWrangler.copyCode");
      assert.equal(copiedCode, editedCode, `${backend} must copy the edited code buffer.`);
      if ((await vscode.env.clipboard.readText()) === editedCode) {
        await vscode.env.clipboard.writeText(priorClipboard);
      }
      const scriptPath = path.join(directory, `${backend}.clean.py`);
      await assert.rejects(
        testing.exportCodeTo(vscode.Uri.file(sourcePath)),
        /never overwrites the active source/u,
        `${backend} deterministic export must reject the active source.`
      );
      if (process.env.OPEN_WRANGLER_EDITOR_CDP_PORT && backend === "pandas") {
        const page = await connectToEditorWorkbench();
        await exerciseRealScriptSaveDialog(page, vscode.Uri.file(sourcePath), scriptPath);
      } else {
        await testing.exportCodeTo(vscode.Uri.file(scriptPath));
      }
      assert.equal(readFileSync(scriptPath, "utf8"), editedCode, `${backend} must export the edited code buffer.`);
      assert.deepEqual(
        readdirSync(directory).filter((name) => name.startsWith(".openwrangler-") && name.endsWith(".tmp")),
        [],
        `${backend} script export must not retain sibling temporary files.`
      );

      const closed = await testing.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision
      });
      assert.equal(closed.kind, "sessionClosed");
      await waitFor(
        () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
        10_000,
        `${backend} operation-group session to dispose`
      );
    }

    assert.equal(
      readFileSync(sourcePath, "utf8"),
      original,
      "Operation previews and applies must not alter the source."
    );
  } finally {
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function exerciseRealScriptSaveDialog(
  page: Page,
  hostileDestination: vscode.Uri,
  destination: string
): Promise<void> {
  const commandOutcome = vscode.commands.executeCommand<boolean>("openWrangler.exportCode", hostileDestination);
  const earlyOutcome = await Promise.race([
    commandOutcome.then((value) => ({ kind: "settled" as const, value })),
    new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 500))
  ]);
  assert.equal(
    earlyOutcome.kind,
    "pending",
    `A caller-provided export URI must not bypass the real Save dialog: ${JSON.stringify(earlyOutcome)}`
  );
  const dialog = page
    .locator(".quick-input-widget:visible")
    .filter({ hasText: "Export Open Wrangler Python Code" })
    .last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const input = dialog.locator(".quick-input-box input").first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(
    await input.inputValue(),
    /\.clean\.py$/u,
    "The hostile command argument must not become the default URI."
  );

  await input.fill(path.resolve(destination));
  await input.press("Enter");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(await commandOutcome, true, "The real Save dialog must commit the selected script destination.");

  const cancelledDestination = `${destination}.cancelled.py`;
  const cancelledOutcome = vscode.commands.executeCommand<boolean>("openWrangler.exportCode");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(path.resolve(cancelledDestination));
  await input.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(await cancelledOutcome, false, "Cancelling the real Save dialog must not export code.");
  assert.equal(existsSync(cancelledDestination), false, "Save-dialog cancellation must not create a script.");
}

function csvSource(uri: vscode.Uri): SessionSource {
  return {
    kind: "file",
    label: path.basename(uri.fsPath),
    path: uri.fsPath,
    uri: uri.toString(),
    importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  };
}

function semicolonCsvSource(uri: vscode.Uri): SessionSource {
  return {
    kind: "file",
    label: path.basename(uri.fsPath),
    path: uri.fsPath,
    uri: uri.toString(),
    importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  };
}

function tsvSource(uri: vscode.Uri): SessionSource {
  return {
    kind: "file",
    label: path.basename(uri.fsPath),
    path: uri.fsPath,
    uri: uri.toString(),
    importOptions: { delimiter: "\t", encoding: "utf-8", quoteChar: '"', hasHeader: true }
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  expectation: string,
  diagnostics?: () => string
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      const detail = diagnostics ? ` Last state: ${diagnostics()}.` : "";
      throw new Error(`Timed out waiting for ${expectation}.${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
