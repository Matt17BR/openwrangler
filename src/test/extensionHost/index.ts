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
  ignoreRetiredRendererProbeFailure,
  invokeAcceptanceActionOnce,
  isRetiredRendererTarget,
  pollAcceptanceCondition,
  pressKeyboardKeyPairWithoutTransitionGap,
  probeRendererButtonReadiness,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";
import { ACCEPTANCE_PROGRESS_PROTOCOL, writeAcceptanceProgressCheckpoint } from "./progress";
import { readReleasedRemoteJupyterDescriptorToken } from "./remoteJupyterDescriptor";
import {
  PACKAGED_SCREENSHOT_COLUMNS,
  PACKAGED_SCREENSHOT_FEATURED_COLUMNS,
  PACKAGED_SCREENSHOT_HERO_SIDEBAR_WIDTH,
  PACKAGED_SCREENSHOT_ROW_COUNT,
  PACKAGED_SCREENSHOT_VIEWPORT,
  packagedScreenshotFeaturedColumnWidths,
  packagedScreenshotFileName,
  packagedScreenshotFixtureCsv
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

interface ReleasedJupyterVariableActionElement {
  readonly isConnected: boolean;
  readonly ownerDocument: {
    readonly activeElement: unknown;
    readonly documentElement: {
      readonly dataset: { openWranglerAcceptanceClick?: string };
    };
  };
  addEventListener(type: "click", listener: () => void, options: { readonly capture: true; readonly once: true }): void;
}

interface FakeJupyterApi {
  testing: {
    execute(uri: vscode.Uri, code: string): Promise<string>;
    restart(uri: vscode.Uri, setupCode?: string): Promise<number>;
    setDenied(value: boolean): void;
    denialCalls(): number;
    stats(uri: vscode.Uri): { generation: number; executions: number } | undefined;
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
const RELEASED_JUPYTER_CONSENT_MESSAGE =
  "Do you want to grant Kernel access to the extension Open Wrangler (Matt17BR.openwrangler)?";
const RELEASED_JUPYTER_CONSENT_DETAIL = "This allows the extension to execute code against Jupyter Kernels.";
const RELEASED_JUPYTER_VARIABLE_VIEWER_ACTION = "Show variable snapshot in data viewer";
const RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_COMMAND = "openWrangler.openNotebookVariable";
const RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN =
  /^(?:Open Variable|Open Wrangler: Open Notebook Variable)$/u;
const RELEASED_JUPYTER_EXPORT_COMMAND = "jupyter.notebookeditor.export";
const NOTEBOOK_TOOLBAR_MORE_COMMAND = "toolbar.toggle.more";
const RELEASED_JUPYTER_NOTEBOOK_VARIABLE_INPUT_TITLE = "Open Notebook Variable in Open Wrangler";
const RELEASED_JUPYTER_SETUP_RESULT = "__OW_RELEASED_SETUP__";
const RELEASED_JUPYTER_RESTART_RESULT = "__OW_RELEASED_RESTART__";
const RELEASED_JUPYTER_RUNTIME_RESULT = "__OW_RELEASED_RUNTIME__";
const RELEASED_JUPYTER_PYSPARK_SETUP_RESULT = "__OW_RELEASED_PYSPARK_SETUP__";
const RELEASED_JUPYTER_PYSPARK_CLOSE_RESULT = "__OW_RELEASED_PYSPARK_CLOSE__";
const RELEASED_JUPYTER_LOCAL_KERNEL_LABEL = "Open Wrangler Acceptance";
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
    commands?: Array<{ command?: string; title?: string; shortTitle?: string; icon?: string }>;
    viewsContainers?: { activitybar?: Array<{ id?: string; icon?: string }> };
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
      icon: "$(open-preview)"
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
      title: "Open Wrangler: Open Notebook Variable",
      shortTitle: "Open Variable",
      icon: "$(table)"
    }
  );
  const fileResourcePredicate =
    "resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.(csv|tsv|parquet|jsonl|xlsx|xls)$/i";
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
      /resourceExtname =~ \/\\\.\(csv\|tsv\|parquet\|jsonl\|xlsx\|xls\)\$\/i/u,
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
    "notebookType == 'jupyter-notebook' && isWorkspaceTrusted && (config.notebook.globalToolbar != true || openWrangler.forceNotebookEditorTitleAction)";
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
    await exercisePackagedPlatformSmoke(
      testing,
      extension,
      vscode.Uri.joinPath(workspace, "fixtures", "[Live] sample.csv")
    );
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
    await seedPersistedPlan(testing, fixture);
    recordAcceptanceProgress("seed:complete");
    console.log("Open Wrangler extension-host persistence seed passed.");
    return;
  }

  if (phase === "single") await seedPersistedPlan(testing, fixture);
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
    await exercisePackagedFileLaunchSurfaces(
      testing,
      vscode.Uri.file(path.join(path.dirname(fixture.fsPath), "[Live] sample.csv")),
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

function recordAcceptanceProgress(checkpoint: string): void {
  const progressPath = process.env.OPEN_WRANGLER_TEST_PROGRESS;
  if (!progressPath) return;
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
}

type ReleasedJupyterPhase = "jupyter-deny" | "jupyter-allow" | "jupyter-pyspark" | "jupyter-remote";

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
  readonly backend: "pandas" | "polars" | "pyspark";
  readonly firstValue: string;
  readonly notebookInsert?: boolean;
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
  const notebookPath = path.join(directory, `${phase}.ipynb`);
  const notebookUri = vscode.Uri.file(notebookPath);
  const setupMarker = `OPEN_WRANGLER_SETUP_${phase.replace("jupyter-", "").toUpperCase()}`;
  writeReleasedJupyterNotebook(notebookPath, setupMarker, kernelTarget, extension.extensionPath);
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  const originalNotebookStartMode = configuration.get<"viewing" | "editing">("notebookStartMode", "viewing");

  let notebook: vscode.NotebookDocument | undefined;
  let rendererLoadObserver: NotebookRendererLoadObserver | undefined;
  let remoteServerCollection: JupyterServerCollection | undefined;
  try {
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

    await executeReleasedNotebookCell(notebook, 0, setupMarker, `${phase}:setup-cell`, variableNotebookEditor);
    assert.equal(
      jupyterExtension.isActive,
      true,
      "Executing the fixture must activate the released Jupyter extension."
    );
    const initialKernel = releasedNotebookSetupResult(notebook.cellAt(0));
    assertReleasedJupyterKernelIdentity(initialKernel, kernelTarget, testPython);
    assert.equal(initialKernel.pid, warmKernel.pid, "The Variables refresh must remain on the exact warmed kernel.");
    assert.equal(initialKernel.setup, setupMarker);
    assert.equal(
      initialKernel.runtime,
      false,
      "The private released-Jupyter kernel must not inherit an installed Open Wrangler runtime before bootstrap."
    );

    const viewerAction = await waitForReleasedJupyterVariableAction(workbench, "pandas_frame", `${phase}:variables`);
    assertExactOpenNotebookDocument(notebook, "after resolving the pandas_frame action from Jupyter Variables");

    recordAcceptanceProgress(`${phase}:variables-action`);
    await viewerAction.focus();
    assert.equal(
      await viewerAction.evaluate((element) => element.ownerDocument.activeElement === element),
      true,
      "The released Jupyter Variables action must accept keyboard focus."
    );
    await viewerAction.evaluate((element) => {
      const root = element.ownerDocument.documentElement;
      root.dataset.openWranglerAcceptanceClick = "pending";
      element.addEventListener(
        "click",
        () => {
          root.dataset.openWranglerAcceptanceClick = "seen";
        },
        { capture: true, once: true }
      );
    });
    await withBoundedAcceptancePromise(
      viewerAction.click(),
      WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
      "the real released-Jupyter Variables action"
    );
    assert.equal(
      await viewerAction.evaluate(
        (element) => element.ownerDocument.documentElement.dataset.openWranglerAcceptanceClick
      ),
      "seen",
      "The real released-Jupyter Variables action must receive its browser click event."
    );
    recordAcceptanceProgress(`${phase}:variables-delegation-dispatched`);
    try {
      await waitFor(
        () => releasedJupyterSessionTabs().length === 1,
        10_000,
        "the released Jupyter viewer delegation to create exactly one Open Wrangler panel",
        () => JSON.stringify({ tabCount: releasedJupyterSessionTabs().length, coordinator: testing.diagnostics() })
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Workbench: ${JSON.stringify(
          await boundedImportPromptDiagnostics(workbench)
        )}`
      );
    }
    recordAcceptanceProgress(`${phase}:variables-panel-created`);
    const consent = await waitForReleasedJupyterConsent(workbench, testing);
    assertExactOpenNotebookDocument(notebook, "while the released Jupyter consent belongs to the fixture notebook");

    if (phase === "jupyter-deny") {
      recordAcceptanceProgress("jupyter-deny:consent");
      await consent.deny.click();
      await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
      await waitForStableReleasedJupyterSessionCount(testing, 0, 2_000, 10_000);
      assert.equal(testing.diagnostics().sessionCount, 0);
      await closeReleasedJupyterSessionTabs();
      assert.equal(testing.diagnostics().sessionCount, 0);

      recordAcceptanceProgress("jupyter-deny:persisted-denial");
      assertExactOpenNotebookDocument(notebook, "before retrying the denied released Jupyter permission");
      await withBoundedAcceptancePromise(
        vscode.commands.executeCommand("openWrangler.launchDataViewer", {
          name: "pandas_frame",
          type: "DataFrame",
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

    recordAcceptanceProgress(`${phase}:mime-v2`);
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
    await executeReleasedNotebookCell(notebook, 1, undefined, `${phase}:mime-cell`, executionEditor);
    const pandasOutputMimes = notebook.cellAt(1).outputs.flatMap((output) => output.items.map((item) => item.mime));
    assert.ok(
      pandasOutputMimes.includes(OPEN_WRANGLER_MIME_V2),
      "A formatter registered through the released kernel API must emit the Open Wrangler MIME v2 payload. " +
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
    assert.equal(pandasMimePayload.metadata.source.label, "DataFrame");
    assert.deepEqual(pandasMimePayload.metadata.shape, { rows: 2_500, columns: 6 });
    assert.deepEqual(
      pandasMimePayload.metadata.schema.map((column) => column.name),
      ["order_id", "market", "revenue", "fulfilled", "order_date", "channel"]
    );

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
    let rendererButton: NotebookRendererButton;
    try {
      rendererButton = await waitForNotebookRendererButton(workbench, "DataFrame");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Host: ${JSON.stringify(
          releasedNotebookRendererHostDiagnostics(notebook, 1)
        )} Browser: ${JSON.stringify(rendererLoadObserver.snapshot())}`
      );
    }
    try {
      if (phase === "jupyter-allow" && screenshotOutput) {
        await captureReleasedJupyterPandasPreview(workbench, rendererButton, screenshotOutput);
      }
      await rendererButton.click();
    } finally {
      await rendererButton.dispose();
    }
    await waitFor(
      () => testing.activeSession()?.metadata.source.kind === "notebookOutput",
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the released-Jupyter MIME v2 renderer snapshot"
    );
    const snapshot = testing.activeSession();
    assert.ok(snapshot, "The released-Jupyter renderer action must publish a snapshot session.");
    assert.equal(snapshot.metadata.source.kind, "notebookOutput");
    assert.equal(snapshot.metadata.source.label, "DataFrame");
    assert.equal(snapshot.metadata.capabilities.notebookInsert, false);
    await disposePackagedSessionPanel(testing, snapshot.sessionId, "the released-Jupyter MIME snapshot");
    await restoreScreenshotWorkbench?.();

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
    assert.equal(testing.diagnostics().sessionCount, 2, "Both engine-native sessions must remain open before restart.");

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
    assert.equal(testing.diagnostics().sessionCount, 0);
  } finally {
    rendererLoadObserver?.dispose();
    await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
    remoteServerCollection?.dispose();
    await configuration.update("notebookStartMode", originalNotebookStartMode, vscode.ConfigurationTarget.Workspace);
    cleanupAcceptanceTemporaryDirectory(directory);
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
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-released-jupyter-pyspark-"));
  const notebookPath = path.join(directory, "jupyter-pyspark.ipynb");
  const notebookUri = vscode.Uri.file(notebookPath);
  writeReleasedPySparkNotebook(notebookPath, extension.extensionPath);

  let notebook: vscode.NotebookDocument | undefined;
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
    assert.equal(classicSetup.javaVersion, "17");
    assert.equal(classicSetup.module, "pyspark.sql.classic.dataframe");

    await dispatchReleasedJupyterVariableAction(workbench, "spark_classic_frame", `${phase}:classic-action`);
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

    await dispatchReleasedJupyterVariableAction(workbench, "spark_connect_frame", `${phase}:connect-action`);
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
  } finally {
    await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function dispatchReleasedJupyterVariableAction(
  workbench: Page,
  variableName: string,
  checkpoint: string
): Promise<void> {
  const viewerAction = await waitForReleasedJupyterVariableAction(workbench, variableName, checkpoint);
  try {
    await invokeAcceptanceActionOnce({
      description: `the real released-Jupyter Variables action for ${variableName}`,
      click: () => viewerAction.click({ timeout: 2_000 }),
      receipt: async () => {
        assert.equal(
          await viewerAction.evaluate(
            (element) => element.ownerDocument.documentElement.dataset.openWranglerAcceptanceClick
          ),
          "seen",
          `The real released-Jupyter Variables action for ${variableName} must receive its browser click event.`
        );
        await waitFor(
          () => releasedJupyterSessionTabs().length === 1,
          10_000,
          `the released Jupyter viewer delegation for ${variableName}`,
          () => JSON.stringify({ tabCount: releasedJupyterSessionTabs().length })
        );
      }
    });
  } finally {
    await viewerAction.dispose();
  }
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
          "from pyspark.sql import SparkSession",
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
          `print(${JSON.stringify(RELEASED_JUPYTER_PYSPARK_SETUP_RESULT)} + json.dumps({`,
          "    'sparkVersion': spark.version,",
          "    'javaVersion': spark.sparkContext._jvm.java.lang.System.getProperty('java.specification.version'),",
          "    'module': type(spark_classic_frame).__module__,",
          "    'pid': os.getpid(),",
          "    'sessionId': f'{os.getpid()}:{id(spark)}',",
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
    "import pandas as pd",
    "import polars as pl",
    "pandas_frame = pd.DataFrame({'value': [1, 2], 'label': ['a', 'b']})",
    "pandas_series = pd.Series([5, 6], name='series_value')",
    "showcase_rows = 2500",
    "showcase_markets = ['DACH', 'Nordics', 'Iberia', 'France', 'Italy', 'Benelux', 'UK & Ireland']",
    "showcase_channels = ['Direct', 'Partner', 'Online']",
    "notebook_showcase = pd.DataFrame({",
    "    'order_id': list(range(24001, 24001 + showcase_rows)),",
    "    'market': [showcase_markets[index % len(showcase_markets)] for index in range(showcase_rows)],",
    "    'revenue': [round(620.50 + ((index * 7919) % 1850000) / 100, 2) for index in range(showcase_rows)],",
    "    'fulfilled': [index % 7 != 2 for index in range(showcase_rows)],",
    "    'order_date': pd.to_datetime('2026-01-01') + pd.to_timedelta([index % 365 for index in range(showcase_rows)], unit='D'),",
    "    'channel': [showcase_channels[index % len(showcase_channels)] for index in range(showcase_rows)],",
    "})",
    "polars_frame = pl.DataFrame({",
    "    'units': [1 + ((index * 7 + 2) % 12) for index in range(showcase_rows)],",
    "    'market': [showcase_markets[index % len(showcase_markets)] for index in range(showcase_rows)],",
    "    'revenue': [round(620.50 + ((index * 6151) % 1250000) / 100, 2) for index in range(showcase_rows)],",
    "    'fulfilled': [index % 7 != 2 for index in range(showcase_rows)],",
    "    'order_date': [date(2026, 1, 1) + timedelta(days=index % 365) for index in range(showcase_rows)],",
    "    'channel': [showcase_channels[index % len(showcase_channels)] for index in range(showcase_rows)],",
    "})",
    "polars_series = pl.Series('series_value', [7, 8])",
    `openwrangler_restart_marker = ${JSON.stringify(setupMarker)}`,
    `print(${JSON.stringify(RELEASED_JUPYTER_SETUP_RESULT)} + json.dumps({` +
      "'executable': sys.executable, 'pid': os.getpid(), " +
      "'runtime': importlib.util.find_spec('openwrangler_runtime') is not None, " +
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
          source: ["notebook_showcase\n"]
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
        throw new Error(`Released-Jupyter cell ${index} failed: ${notebookCellOutputText(cell)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    recordAcceptanceProgress(`${checkpoint}:timeout`);
    throw new Error(
      `Timed out waiting for a fresh released-Jupyter execution of cell ${index}. ` +
        `Command: ${readCommandState().kind}. Output: ${JSON.stringify(notebookCellOutputText(cell))}`
    );
  } finally {
    executionListener.dispose();
  }
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
): Promise<ElementHandle<ReleasedJupyterVariableActionElement>> {
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
          await row.hover({ timeout: 1_000 });
          const actions = row.getByRole("button", {
            name: RELEASED_JUPYTER_VARIABLE_VIEWER_ACTION,
            exact: true
          });
          if ((await actions.count()) !== 1) continue;
          const action = await actions.first().elementHandle({
            timeout: RELEASED_JUPYTER_VARIABLE_ACTION_PREPARE_TIMEOUT_MS
          });
          if (action) return action as ElementHandle<ReleasedJupyterVariableActionElement>;
        } catch (error) {
          if (!isReleasedJupyterVariableActionReplacement(error)) {
            throw error;
          }
          // The Variables view can replace a row while its real kernel refreshes.
        }
      }
      return undefined;
    },
    prepare: async (action) => {
      const [visible, enabled] = await withReleasedJupyterVariableActionPrepareDeadline(
        Promise.all([action.isVisible(), action.isEnabled()]),
        "visibility and enabled-state probes"
      );
      if (!visible || !enabled) {
        throw new ReleasedJupyterVariableActionReplacementError();
      }
      await withReleasedJupyterVariableActionPrepareDeadline(action.focus(), "focus");
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
          root.dataset.openWranglerAcceptanceClick = "pending";
          element.addEventListener(
            "click",
            () => {
              root.dataset.openWranglerAcceptanceClick = "seen";
            },
            { capture: true, once: true }
          );
          return true;
        }),
        "click-listener setup"
      );
      if (!listenerAttached) throw new ReleasedJupyterVariableActionReplacementError();
    },
    dispose: (action) => action.dispose(),
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
      /^(?:elementHandle|locator)\.(?:elementHandle|hover): Timeout \d+ms exceeded/u.test(message))
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
      "Timed out waiting for released Jupyter kernel consent after the Open Wrangler panel opened. " +
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
          display_name: "Open Wrangler Acceptance",
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
  const input = await clickReleasedNotebookVariableAction(workbench, notebook);
  assertActiveNotebookTab(
    notebook,
    "The exact released-Jupyter notebook tab must remain active after its toolbar action opens the variable input."
  );
  await input.fill(variableName);
  await input.press("Enter");
  assertExactOpenNotebookDocument(notebook, "after submitting the Open Wrangler notebook toolbar variable");
}

interface ReleasedNotebookPinnedAction {
  readonly action: ElementHandle<unknown>;
  readonly overflowMenu?: ElementHandle<unknown>;
  readonly abandonBeforeDispatch?: () => Promise<void>;
  readonly description: string;
}

async function clickReleasedNotebookVariableAction(
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
  const pinned =
    cursorHost || globalToolbar !== true
      ? await resolveReleasedNotebookEditorTitleAction(workbench)
      : await resolveReleasedNotebookToolbarAction(workbench);
  let dispatchStarted = false;
  try {
    assertExactOpenNotebookDocument(notebook, "immediately before clicking its Open Wrangler notebook action");
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      notebook,
      "The exact released-Jupyter notebook must remain active after resolving its Open Wrangler action."
    );
    assertActiveNotebookTab(
      notebook,
      "The exact released-Jupyter notebook tab must remain active before clicking its Open Wrangler action."
    );
    dispatchStarted = true;
    return await invokeAcceptanceActionOnce({
      description: pinned.description,
      click: () => pinned.action.click({ timeout: 2_000 }),
      receipt: () => waitForReleasedNotebookVariableInput(workbench),
      naturalDismissal: pinned.overflowMenu
        ? () => pinned.overflowMenu!.waitForElementState("hidden", { timeout: 2_000 })
        : undefined
    });
  } finally {
    if (!dispatchStarted && pinned.abandonBeforeDispatch) {
      await pinned.abandonBeforeDispatch();
    } else {
      await Promise.allSettled([pinned.action.dispose(), pinned.overflowMenu?.dispose()]);
    }
  }
}

function assertReleasedNotebookActionLabelOwnership(): void {
  const owners: Array<{ extensionId: string; command: string }> = [];
  for (const extension of vscode.extensions.all) {
    const commands = (extension.packageJSON as { contributes?: { commands?: unknown } }).contributes?.commands;
    if (!Array.isArray(commands)) continue;
    for (const candidate of commands) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const command = candidate as { command?: unknown; title?: unknown; shortTitle?: unknown };
      if (
        typeof command.command === "string" &&
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

async function resolveReleasedNotebookEditorTitleAction(workbench: Page): Promise<ReleasedNotebookPinnedAction> {
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
            ? releasedCommandOwnedLabeledAction(titleActions, commandItems.first(), "button")
            : labelCount === 1
              ? byLabel.first()
              : undefined;
        const actionCount = action ? await action.count() : 0;
        assert.ok(actionCount < 2, "The active editor title exposed duplicate command-owned labeled actions.");
        if (actionCount === 1 && action && (await action.isVisible()) && (await action.isEnabled())) {
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
              ? releasedCommandOwnedLabeledAction(refreshedTitleActions, refreshedItems.first(), "button")
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
          const pinned = await pinVisibleEnabledReleasedNotebookAction(refreshedAction);
          if (!pinned) continue;
          return {
            action: pinned,
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
    "Timed out clicking the real Open Wrangler action in the active notebook editor title. " +
      `Structure: ${JSON.stringify(diagnostics)}`
  );
}

async function resolveReleasedNotebookToolbarAction(workbench: Page): Promise<ReleasedNotebookPinnedAction> {
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
          const direct = releasedCommandOwnedLabeledAction(toolbar, directItems.first(), "button");
          const directOwnedCount = await direct.count();
          assert.ok(directOwnedCount < 2, "The notebook toolbar exposed duplicate command-owned labeled actions.");
          if (directOwnedCount === 1) directAction = direct;
        } else if (directLabelCount === 1) {
          directAction = directByLabel.first();
        }
        if (directAction && (await directAction.isVisible()) && (await directAction.isEnabled())) {
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
              ? releasedCommandOwnedLabeledAction(refreshedToolbar, refreshedItems.first(), "button")
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
          const pinned = await pinVisibleEnabledReleasedNotebookAction(refreshedAction);
          if (!pinned) continue;
          return {
            action: pinned,
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
              action: overflow.action,
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

function releasedCommandOwnedLabeledAction(
  container: Locator,
  commandItem: Locator,
  role: "button" | "menuitem"
): Locator {
  const exactLabel = container.getByRole(role, {
    name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
  });
  return commandItem.and(exactLabel).or(
    commandItem.getByRole(role, {
      name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN
    })
  );
}

async function pinVisibleEnabledReleasedNotebookAction(action: Locator): Promise<ElementHandle<unknown> | undefined> {
  const pinned = await action.elementHandle();
  if (!pinned) return undefined;
  let transferred = false;
  try {
    if (!(await pinned.isVisible()) || !(await pinned.isEnabled())) return undefined;
    transferred = true;
    return pinned;
  } finally {
    if (!transferred) await pinned.dispose();
  }
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
        commandState.total === 1
          ? releasedCommandOwnedLabeledAction(menuContainer, menuItems.first(), "menuitem")
          : undefined;
      const commandOwnedState = commandOwned
        ? await releasedLocatorState(commandOwned)
        : { total: 0, visible: 0, enabled: 0 };
      assert.ok(commandState.total < 2, "The notebook overflow exposed duplicate Open Wrangler variable actions.");
      assert.ok(labelState.total < 2, "The notebook overflow exposed duplicate labeled Open Wrangler actions.");
      assert.ok(commandOwnedState.total < 2, "The notebook overflow exposed duplicate command-owned labeled actions.");
      const inventory = commandState.total === 0 ? labelState : commandState;
      const actionState = commandState.total === 0 ? labelState : commandOwnedState;
      const ownedAction =
        commandState.total === 0 ? (labelState.total === 1 ? menuByLabel.first() : undefined) : commandOwned;
      if (actionState.total === 1 && actionState.visible === 1 && actionState.enabled === 1) {
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
        const directAction =
          directCommandState.total > 0
            ? directCommandState
            : await releasedLocatorState(
                toolbars.getByRole("button", {
                  name: RELEASED_JUPYTER_NOTEBOOK_TOOLBAR_ACTION_NAME_PATTERN,
                  includeHidden: true
                })
              );
        const jupyterExport = notebookToolbarCommandItems(toolbars, RELEASED_JUPYTER_EXPORT_COMMAND);
        return {
          notebookEditors: await releasedLocatorState(notebookEditors),
          toolbars: await releasedLocatorState(toolbars),
          toolbarButtons: await releasedLocatorState(toolbars.getByRole("button", { includeHidden: true })),
          directAction,
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
      toolbarButtons: 0,
      jupyterExports: 0,
      tableIcons: 0
    }
  );
  const classification =
    totals.visibleNotebookEditors === 0
      ? "notebook-missing"
      : totals.toolbars === 0
        ? "toolbar-missing"
        : totals.visibleToolbars === 0
          ? "toolbar-hidden"
          : totals.directActions > 1 || observedOverflowAction.total > 1
            ? "duplicate"
            : totals.directActions > 0 && totals.visibleDirectActions === 0
              ? "action-hidden"
              : totals.visibleDirectActions > 0 && totals.enabledDirectActions === 0
                ? "action-disabled"
                : totals.jupyterExports === 0
                  ? "scoped-context-unavailable"
                  : totals.tableIcons > 0
                    ? "label-mismatch"
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

async function waitForReleasedNotebookVariableInput(workbench: Page): Promise<Locator> {
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
        if (title !== RELEASED_JUPYTER_NOTEBOOK_VARIABLE_INPUT_TITLE) continue;
        const input = widget.locator(".quick-input-box input").first();
        if ((await input.count()) > 0 && (await input.isVisible())) matches.push(input);
      }
    }
    if (matches.length === 1) return matches[0]!;
    assert.ok(
      matches.length < 2,
      "The notebook-toolbar action exposed multiple visible Open Wrangler variable inputs."
    );
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  const diagnostics = await boundedImportPromptDiagnostics(workbench);
  throw new Error(
    "Timed out waiting for the Open Wrangler notebook-toolbar variable input. " +
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
  if (target.remote) {
    assert.equal(restoredSetup.remoteRunId, target.remote.runId);
    assert.equal(restoredSetup.hostname, target.remote.hostname);
    assert.equal(restoredSetup.hostExtensionVisible, false);
  }

  recordAcceptanceProgress(`${phase}:restart-replay`);
  const [polarsReplayed, pandasReplayed] = await Promise.all([
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
  assert.equal(active.metadata.shape.rows > 0, true);
  assert.equal(active.metadata.shape.columns, 4);

  recordAcceptanceProgress("platform-smoke:grid");
  const gridTarget = await waitForOpenWranglerGridTarget(page, testing, active.metadata.sessionId);
  const grid = gridTarget.frame.getByRole("grid", { name: `Data grid for ${active.metadata.source.label}` });
  await grid.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await grid.getAttribute("aria-colcount"), "5");
  const firstCell = gridTarget.frame.locator('td[data-grid-row="0"][data-grid-column="0"]').first();
  await firstCell.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await firstCell.innerText()).trim(), "Milan");
  await firstCell.focus();
  await firstCell.press("ArrowRight");
  await gridTarget.frame
    .locator('td[data-grid-row="0"][data-grid-column="1"]:focus')
    .waitFor({ state: "visible", timeout: 5_000 });

  await exercisePrimarySortJourney(testing, gridTarget.frame, "platform-smoke:sort-journey");

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

async function exercisePrimarySortJourney(testing: TestApi, frame: Frame, checkpoint: string): Promise<void> {
  recordAcceptanceProgress(checkpoint);
  const cityHeader = frame.locator('th[data-column="city"]').first();
  const cityMenu = cityHeader.locator("details.columnMenu").first();
  await cityMenu.getByLabel("Column actions for city").click();
  await cityMenu.getByRole("button", { name: "Sort ascending", exact: true }).click();
  assert.equal(
    await cityMenu.evaluate((element) => element.hasAttribute("open")),
    false,
    "A quick-sort choice must close its column menu."
  );
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 1 && sort[0]?.column === "city" && sort[0].direction === "asc" && sort[0].nulls === "last"
      );
    },
    10_000,
    "the city quick sort to become the only active viewing sort"
  );
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "Berlin" })
    .waitFor({ state: "visible", timeout: 10_000 });
  await cityHeader.getByRole("button", { name: /Clear sort for city; currently ascending/u }).waitFor({
    state: "visible",
    timeout: 10_000
  });

  const salesHeader = frame.locator('th[data-column="sales"]').first();
  const salesMenu = salesHeader.locator("details.columnMenu").first();
  await salesMenu.getByLabel("Column actions for sales").click();
  await salesMenu.getByRole("button", { name: "Sort descending", exact: true }).click();
  assert.equal(
    await salesMenu.evaluate((element) => element.hasAttribute("open")),
    false,
    "A later quick sort must also close its column menu."
  );
  await waitFor(
    () => {
      const sort = testing.activeSession()?.viewState.filterModel.sort;
      return (
        sort?.length === 1 && sort[0]?.column === "sales" && sort[0].direction === "desc" && sort[0].nulls === "last"
      );
    },
    10_000,
    "the sales quick sort to replace the earlier city sort"
  );
  assert.equal(
    await cityHeader.getByRole("button", { name: /Clear sort for city/u }).count(),
    0,
    "Replacing a quick sort must remove the prior column's active-sort indicator."
  );
  const clearSalesSort = salesHeader.getByRole("button", {
    name: /Clear sort for sales; currently descending/u
  });
  await clearSalesSort.waitFor({ state: "visible", timeout: 10_000 });
  await clearSalesSort.click();
  await waitFor(
    () => testing.activeSession()?.viewState.filterModel.sort.length === 0,
    10_000,
    "the visible sort indicator to clear the viewing sort"
  );
  await frame
    .locator('td[data-grid-row="0"][data-grid-column="0"]')
    .filter({ hasText: "Milan" })
    .waitFor({ state: "visible", timeout: 10_000 });
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
  await exercisePrimarySortJourney(testing, gridTarget.frame, "verify:file-launch:title-action:sort-journey");
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
  const diagnostics: ContextMenuDiagnostic[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.keyboard.press("Escape");
    const visibleMenus = page.locator(".context-view.monaco-menu-container:visible");
    await visibleMenus.waitFor({ state: "hidden", timeout: 1_000 }).catch(() => {});
    await tab.click({ button: "right" });

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
    `The editor-tab context menu did not expose ${requiredActionName ? JSON.stringify(requiredActionName) : "a visible HTML menu"} after two right-click attempts. Visible menu diagnostics: ${JSON.stringify(diagnostics)}`,
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
            width: viewport.width,
            height: Math.min(viewport.height - titleBarHeight, maximumHeight ?? Number.POSITIVE_INFINITY)
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
  await workbench.setViewportSize(PACKAGED_SCREENSHOT_VIEWPORT);
  const viewport = await workbench.evaluate(() => {
    const pageWindow = globalThis as unknown as { innerHeight: number; innerWidth: number };
    return { width: pageWindow.innerWidth, height: pageWindow.innerHeight };
  });
  assert.deepEqual(
    viewport,
    PACKAGED_SCREENSHOT_VIEWPORT,
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
    title: "Open Wrangler preview: DataFrame (pandas) - 2500 x 6",
    headers: ["order_id", "market", "revenue", "fulfilled", "order_date", "channel"],
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
  await captureWorkbenchScreenshot(
    workbench,
    path.resolve(
      outputDirectory,
      packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-pandas", "dark")
    ),
    450
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

  const widths = Object.fromEntries(active.metadata.schema.map((column) => [column.id, 230]));
  await testing.updateViewState(sessionId, {
    ...active.viewState,
    columnWidths: widths,
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
  await waitForReleasedJupyterCodePreview(workbench, "double_units");
  const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
  const app = await exactSessionApp(target.frame, sessionId);
  assert.ok(app, "The Polars notebook screenshot requires the exact live Open Wrangler renderer.");
  const backendBadge = app.locator(".backendBadge").first();
  await backendBadge.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await backendBadge.innerText()).trim(), "POLARS");
  await app.getByRole("button", { name: "Apply step" }).waitFor({ state: "visible", timeout: 10_000 });
  await app.getByRole("button", { name: "Discard" }).waitFor({ state: "visible", timeout: 10_000 });
  await clearReleasedJupyterScreenshotTransientUi(workbench);
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

async function waitForReleasedJupyterCodePreview(workbench: Page, expectedCode: string): Promise<Locator> {
  const deadline = Date.now() + 10_000;
  do {
    for (const frame of workbench.frames()) {
      const content = frame.locator('[aria-label="Editable generated Python code preview"]');
      if ((await content.count()) === 0 || !(await content.isVisible().catch(() => false))) continue;
      if ((await content.innerText().catch(() => "")).includes(expectedCode)) return content;
    }
    await workbench.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`The generated Polars notebook code did not expose ${JSON.stringify(expectedCode)}.`);
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
  const transient = await workbench
    .locator(
      ".quick-input-widget:visible, .monaco-dialog-box:visible, .context-view.monaco-menu-container:visible, " +
        ".notifications-toasts .notification-toast:visible, .notifications-center .notification-list-item:visible"
    )
    .allInnerTexts();
  assert.deepEqual(
    transient.map((text) => text.replace(/\s+/gu, " ").trim().slice(0, 500)),
    [],
    "Notebook screenshot capture must not retain transient workbench UI."
  );
}

function releasedJupyterScreenshotTheme(): string {
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON.contributes?.themes as
      Array<{ id?: unknown; label?: unknown; uiTheme?: unknown }> | undefined;
    const dark = themes?.find((theme) => theme.uiTheme === "vs-dark");
    if (typeof dark?.id === "string" && dark.id.length > 0) return dark.id;
    if (typeof dark?.label === "string" && dark.label.length > 0) return dark.label;
  }
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
    const columnWidths = await fitFeaturedGridColumns(opened.sessionId, revenue.id);
    assert.deepEqual(testing.activeSession()?.viewState.columnWidths, columnWidths);
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
    assert.ok(hero, "The screenshot fixture must remain active while its complete Summary is composed.");
    await primeExactDatasetStats(hero.sessionId);
    await composeNativeViews("hero");
    await resizePrimarySidebar(PACKAGED_SCREENSHOT_HERO_SIDEBAR_WIDTH);
    assert.equal(
      await testing.synchronizePanel(hero.sessionId),
      true,
      "The complete Summary screenshot must synchronize with the exact renderer."
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
      `${editor}-high-contrast-zoom-200.png`
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
    scene?: "hero"
  ): Promise<void> {
    await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global);
    await windowConfiguration.update("zoomLevel", zoomLevel, vscode.ConfigurationTarget.Global);
    await waitFor(
      () => vscode.window.activeColorTheme.kind === expectedKind,
      10_000,
      `${theme} to activate before screenshot capture`
    );
    await vscode.commands.executeCommand("workbench.view.extension.openWrangler");
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
    if (scene) await assertPackagedScreenshotScene(scene);
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

  async function resizePrimarySidebar(targetWidth: number): Promise<void> {
    const sidebar = capturePage.locator(".part.sidebar:visible").first();
    await sidebar.waitFor({ state: "visible", timeout: 10_000 });
    const bounds = await sidebar.boundingBox();
    assert.ok(bounds, "The README hero requires measurable primary-sidebar geometry.");
    if (Math.abs(bounds.width - targetWidth) <= 2) return;
    const sash = await nearestWorkbenchSash("vertical", bounds.x + bounds.width);
    assert.ok(sash, "The README hero requires the primary-sidebar resize sash.");
    const startX = sash.x + sash.width / 2;
    const startY = Math.max(bounds.y + 20, Math.min(bounds.y + bounds.height - 20, bounds.y + bounds.height / 2));
    await capturePage.mouse.move(startX, startY);
    await capturePage.mouse.down();
    await capturePage.mouse.move(startX + targetWidth - bounds.width, startY, { steps: 12 });
    await capturePage.mouse.up();
    await waitForWorkbenchPartSize(sidebar, "width", targetWidth, "the README hero sidebar");
  }

  async function nearestWorkbenchSash(
    orientation: "horizontal" | "vertical",
    targetPosition: number
  ): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    const candidates = capturePage.locator(`.monaco-sash.${orientation}:visible`);
    let nearest:
      | {
          bounds: { x: number; y: number; width: number; height: number };
          distance: number;
        }
      | undefined;
    for (let index = 0; index < (await candidates.count()); index += 1) {
      const bounds = await candidates.nth(index).boundingBox();
      if (!bounds) continue;
      const position = orientation === "vertical" ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2;
      const distance = Math.abs(position - targetPosition);
      if (!nearest || distance < nearest.distance) nearest = { bounds, distance };
    }
    return nearest && nearest.distance <= 12 ? nearest.bounds : undefined;
  }

  async function waitForWorkbenchPartSize(
    part: Locator,
    dimension: "height" | "width",
    expected: number,
    label: string
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let actual: number | undefined;
    do {
      actual = (await part.boundingBox())?.[dimension];
      if (actual !== undefined && Math.abs(actual - expected) <= 3) return;
      await capturePage.waitForTimeout(25);
    } while (Date.now() < deadline);
    throw new Error(`${label} must measure ${expected}px; observed ${String(actual)}px.`);
  }

  async function primeExactDatasetStats(sessionId: string): Promise<void> {
    const target = await waitForOpenWranglerGridTarget(capturePage, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, "Dataset statistics composition requires the exact live Open Wrangler renderer.");
    const toggle = app.getByRole("button", { name: "Insights & filters" });
    await toggle.click();
    const drawer = app.getByRole("complementary", { name: "Insights and filters" });
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(
      () => testing.activeSession()?.metadata.stats !== undefined,
      30_000,
      "exact dataset statistics before README screenshot capture"
    );
    await drawer.getByRole("button", { name: "Close panel" }).click();
    await drawer.waitFor({ state: "hidden", timeout: 10_000 });
  }

  async function composeNativeViews(scene: "hero"): Promise<void> {
    const desired = new Map<string, boolean>([
      ["Operations", false],
      ["Summary", true],
      ["Filters / Sorts", false],
      ["Cleaning Steps", false]
    ]);
    const sidebar = capturePage.locator(".part.sidebar:visible");
    for (const [label, expanded] of desired) {
      const title = sidebar.getByText(label, { exact: true }).first();
      await title.waitFor({ state: "visible", timeout: 10_000 });
      const header = title.locator("xpath=ancestor::*[contains(@class, 'pane-header')][1]");
      assert.equal(await header.count(), 1, `The ${label} native view must expose one pane header.`);
      if ((await nativeViewExpanded(header)) !== expanded) {
        await header.click();
        const deadline = Date.now() + 5_000;
        while ((await nativeViewExpanded(header)) !== expanded && Date.now() < deadline) {
          await capturePage.waitForTimeout(25);
        }
      }
      assert.equal(await nativeViewExpanded(header), expanded, `${label} must match the ${scene} scene composition.`);
    }
  }

  async function nativeViewExpanded(header: Locator): Promise<boolean> {
    const ariaExpanded = await header.getAttribute("aria-expanded");
    if (ariaExpanded !== null) return ariaExpanded === "true";
    return (await header.getAttribute("class"))?.split(/\s+/u).includes("expanded") ?? false;
  }

  async function assertHeroNativeViewComposition(): Promise<void> {
    const active = testing.activeSession();
    assert.ok(active?.metadata.stats, "The hero Summary must publish exact dataset statistics.");
    const sidebar = capturePage.locator(".part.sidebar:visible").first();
    await sidebar.waitFor({ state: "visible", timeout: 10_000 });
    const deadline = Date.now() + 15_000;
    let measurement:
      | {
          width: number;
          rowCount: number;
          missingLabels: string[];
          clippedParts: string[];
          profilingVisible: boolean;
          overlaps: string[];
        }
      | undefined;
    do {
      measurement = await sidebar.evaluate(
        (root, expected) => {
          type EvidenceElement = {
            readonly innerText: string;
            readonly scrollWidth: number;
            readonly clientWidth: number;
            getBoundingClientRect(): {
              readonly bottom: number;
              readonly height: number;
              readonly top: number;
              readonly width: number;
            };
            querySelectorAll(selector: string): ArrayLike<EvidenceElement>;
          };
          const rootElement = root as unknown as EvidenceElement;
          const visible = (element: EvidenceElement): boolean => {
            const bounds = element.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0;
          };
          const headers = Array.from(rootElement.querySelectorAll(".pane-header")).filter(visible);
          const header = (label: string) =>
            headers.find((candidate) => candidate.innerText.replace(/\s+/gu, " ").trim() === label);
          const rows = Array.from(rootElement.querySelectorAll(".monaco-list-row")).filter(visible);
          const matchingRows = expected.labels.map((label) =>
            rows.find((row) => row.innerText.replace(/\s+/gu, " ").trim().startsWith(label))
          );
          const clippedParts = matchingRows.flatMap((row, index) =>
            Array.from(row?.querySelectorAll(".label-name, .label-description, .monaco-highlighted-label") ?? [])
              .filter(visible)
              .filter((part) => part.scrollWidth > part.clientWidth + 1)
              .map(() => expected.labels[index] ?? "")
          );
          const operations = header("Operations")?.getBoundingClientRect();
          const summary = header("Summary")?.getBoundingClientRect();
          const filters = header("Filters / Sorts")?.getBoundingClientRect();
          const first = matchingRows[0]?.getBoundingClientRect();
          const last = matchingRows.at(-1)?.getBoundingClientRect();
          const overlaps = [
            operations && summary && operations.bottom > summary.top + 1 ? "Operations and Summary headers" : "",
            summary && first && summary.bottom > first.top + 1 ? "Summary header and first row" : "",
            last && filters && last.bottom > filters.top + 1 ? "Summary rows and Filters header" : ""
          ].filter(Boolean);
          return {
            width: rootElement.getBoundingClientRect().width,
            rowCount: matchingRows.filter(Boolean).length,
            missingLabels: expected.labels.filter((_, index) => !matchingRows[index]),
            clippedParts,
            profilingVisible: rows.some((row) => /\bProfiling\b/u.test(row.innerText)),
            overlaps
          };
        },
        {
          labels: [
            active.metadata.source.label,
            "Shape",
            "Columns",
            "Selected column",
            "Missing cells",
            "Duplicate rows"
          ]
        }
      );
      if (
        Math.abs(measurement.width - PACKAGED_SCREENSHOT_HERO_SIDEBAR_WIDTH) <= 3 &&
        measurement.rowCount === 6 &&
        measurement.missingLabels.length === 0 &&
        measurement.clippedParts.length === 0 &&
        !measurement.profilingVisible &&
        measurement.overlaps.length === 0
      ) {
        return;
      }
      await capturePage.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new Error(`The hero native Summary is cramped or incomplete: ${JSON.stringify(measurement)}`);
  }

  async function assertPackagedScreenshotScene(scene: "hero"): Promise<void> {
    await assertHeroNativeViewComposition();
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
          clippedCells: number;
          clippedControls: string[];
          revenueSummary: string;
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
          const workspace = appRoot.querySelector('[data-testid="app-workspace"]');
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
          const visibleCells = Array.from(appRoot.querySelectorAll("td[data-grid-column]")).filter((cell) => {
            const bounds = cell.getBoundingClientRect();
            return bounds.right > scrollerBounds.left && bounds.left < scrollerBounds.right;
          });
          const controls = Array.from(appRoot.querySelectorAll(".toolbar, .cleaningBar, .gridControls, .draftPanel"));
          const clippedControls = controls
            .filter((element) => element.scrollWidth > element.clientWidth + 1)
            .map((element) => element.className);
          const revenueHeader = headers.find((header) => header.dataset.column === "revenue");
          const draft = appRoot.querySelector('.draftPanel[aria-label="Draft preview"]');
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
            clippedCells: visibleCells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
            clippedControls,
            revenueSummary: revenueHeader?.querySelector(".exactSummaryStats")?.innerText ?? "",
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
        measurement.clippedCells === 0 &&
        measurement.clippedControls.length === 0 &&
        /\bMin\b/u.test(measurement.revenueSummary) &&
        /\bMax\b/u.test(measurement.revenueSummary) &&
        !measurement.draftVisible &&
        !measurement.columnSearchOpen;
      if (ready) return;
      await capturePage.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new Error(`The ${scene} screenshot scene is clipped or incomplete: ${JSON.stringify(measurement)}`);
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
      recordAcceptanceProgress("verify:notebook-renderer-snapshot");
      await exercisePackagedSavedSnapshot(testing, jupyter, directory);
    }
    recordAcceptanceProgress("verify:notebook:complete");
  } finally {
    await configuration.update("notebookStartMode", originalMode, vscode.ConfigurationTarget.Workspace);
    cleanupAcceptanceTemporaryDirectory(directory);
  }
}

async function exercisePackagedSavedSnapshot(
  testing: TestApi,
  jupyter: FakeJupyterApi,
  directory: string
): Promise<void> {
  const label = "saved snapshot acceptance";
  const snapshotPath = path.join(directory, "renderer-saved-snapshot.ipynb");
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
      source: { kind: "notebookOutput", label, variableName: "stale_saved_frame" },
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
                "text/plain": ["Open Wrangler saved snapshot"],
                [OPEN_WRANGLER_MIME_V2]: payload
              }
            }
          ],
          source: ["# saved output only"]
        }
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      nbformat: 4,
      nbformat_minor: 5
    })
  );

  let snapshotNotebook: vscode.NotebookDocument | undefined;
  try {
    recordAcceptanceProgress("verify:notebook-renderer-snapshot:open");
    snapshotNotebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(snapshotPath));
    const snapshotEditor = await vscode.window.showNotebookDocument(snapshotNotebook, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });
    snapshotEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
    assert.equal(
      jupyter.testing.stats(snapshotNotebook.uri),
      undefined,
      "A saved snapshot notebook must not acquire a Jupyter kernel before its renderer action."
    );

    const workbench = await connectToEditorWorkbench();
    const button = await waitForNotebookRendererButton(workbench, label);
    recordAcceptanceProgress("verify:notebook-renderer-snapshot:click");
    try {
      await button.evaluate((candidate: unknown) => (candidate as { click(): void }).click());
    } finally {
      await button.dispose();
    }
    await waitFor(
      () => {
        const source = testing.activeSession()?.metadata.source;
        return source?.kind === "notebookOutput" && source.label === label;
      },
      SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
      "the saved MIME-v2 renderer output to become a coordinator-owned session"
    );

    const active = testing.activeSession();
    assert.ok(active, "The saved renderer output must become an active coordinator session.");
    assert.notEqual(active.sessionId, payload.metadata.sessionId, "The host must replace a saved runtime identity.");
    assert.equal(active.metadata.sessionId, active.sessionId);
    assert.deepEqual(active.metadata.source, { kind: "notebookOutput", label });
    assert.equal(active.metadata.mode, "viewing");
    assert.equal(active.metadata.revision, 0);
    assert.deepEqual(active.metadata.shape, { rows: 4, columns: 3 });
    assert.deepEqual(active.metadata.filteredShape, { rows: 4, columns: 3 });
    assert.deepEqual(active.metadata.capabilities, {
      editable: false,
      lazy: false,
      cancel: false,
      exportCsv: false,
      exportParquet: false,
      notebookInsert: false
    });
    assert.deepEqual(active.metadata.filterModel, { logic: "and", filters: [], sort: [] });
    assert.deepEqual(active.metadata.steps, []);
    assert.equal(active.metadata.latestStepInputSchema, undefined);
    assert.equal(active.metadata.draftStep, undefined);
    assert.equal(active.metadata.stats, undefined);
    const diagnostic = testing.diagnostics().sessions.find((session) => session.publicId === active.sessionId);
    assert.ok(diagnostic, "The saved snapshot must be coordinator-owned.");
    assert.notEqual(diagnostic.runtimeId, payload.metadata.sessionId);
    assert.notEqual(diagnostic.runtimeId, diagnostic.publicId);
    assert.equal(
      jupyter.testing.stats(snapshotNotebook.uri),
      undefined,
      "Opening a saved snapshot must not acquire its notebook's Jupyter kernel."
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
    recordAcceptanceProgress("verify:notebook-renderer-snapshot:page");
    const projected = await testing.request({
      kind: "getPage",
      sessionId: active.sessionId,
      revision: active.metadata.revision,
      viewRequestId: "saved-snapshot-page",
      offset: 0,
      limit: 2,
      columnOffset: 1,
      columnLimit: 1,
      filterModel: filteredModel
    });
    assert.equal(projected.kind, "page");
    if (projected.kind !== "page") throw new Error("The saved snapshot projected page did not resolve.");
    assert.deepEqual(projected.page.columnIds, ["c:score"]);
    assert.deepEqual(
      projected.page.rows.map((row) => row.id),
      ["r:capture:2", "r:capture:1"]
    );
    assert.deepEqual(
      projected.page.rows.map((row) => row.values[0]?.display),
      ["7", "5"]
    );
    assert.equal(projected.page.totalRows, 2);
    assert.deepEqual(projected.metadata.filteredShape, { rows: 2, columns: 3 });

    recordAcceptanceProgress("verify:notebook-renderer-snapshot:summary");
    const summary = await testing.request({
      kind: "getSummary",
      sessionId: active.sessionId,
      revision: projected.revision,
      viewRequestId: "saved-snapshot-summary",
      filterModel: filteredModel,
      columnIds: ["c:score"]
    });
    assert.equal(summary.kind, "summary");
    if (summary.kind !== "summary") throw new Error("The saved snapshot summary did not resolve.");
    assert.deepEqual(summary.summaries, [
      {
        columnId: "c:score",
        column: "score",
        type: "integer",
        rawType: "Int64",
        totalCount: 2,
        nullCount: 0,
        nanCount: 0,
        distinctCount: 2,
        topValues: [
          { value: "5", count: 1 },
          { value: "7", count: 1 }
        ],
        numeric: { min: 5, max: 7, mean: 6, median: 6, std: Math.SQRT2 },
        visualization: {
          kind: "numeric",
          bins: [
            { min: 5, max: 6, count: 1 },
            { min: 6, max: 7, count: 1 }
          ]
        }
      }
    ]);

    recordAcceptanceProgress("verify:notebook-renderer-snapshot:statistics");
    const statistics = await testing.request({
      kind: "getDatasetStats",
      sessionId: active.sessionId,
      revision: projected.revision,
      viewRequestId: "saved-snapshot-statistics",
      filterModel: { logic: "and", filters: [], sort: [] }
    });
    assert.equal(statistics.kind, "datasetStats");
    if (statistics.kind !== "datasetStats") throw new Error("The saved snapshot statistics did not resolve.");
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

    recordAcceptanceProgress("verify:notebook-renderer-snapshot:values");
    const values = await testing.request({
      kind: "getColumnValues",
      sessionId: active.sessionId,
      revision: projected.revision,
      viewRequestId: "saved-snapshot-values",
      column: "city",
      search: "ber",
      limit: 100,
      filterModel: filteredModel
    });
    assert.equal(values.kind, "columnValues");
    if (values.kind !== "columnValues") throw new Error("The saved snapshot values query did not resolve.");
    assert.deepEqual(values.values, [{ value: "Berlin", count: 1 }]);
    assert.equal(values.hasMore, false);

    recordAcceptanceProgress("verify:notebook-renderer-snapshot:close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the exact saved snapshot session");
    assert.deepEqual(
      testing.diagnostics().sessions,
      [],
      `An earlier packaged notebook session leaked into saved-snapshot cleanup: ${JSON.stringify(testing.diagnostics().sessions)}`
    );
    const snapshotTab = notebookTab(snapshotNotebook.uri);
    if (snapshotTab) assert.equal(await vscode.window.tabGroups.close(snapshotTab, true), true);
    assert.equal(jupyter.testing.stats(snapshotNotebook.uri), undefined);
    recordAcceptanceProgress("verify:notebook-renderer-snapshot:complete");
  } catch (error) {
    await bestEffortSavedSnapshotCleanup(testing, snapshotNotebook, label);
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
    recordAcceptanceProgress("verify:notebook-renderer-same-group:button");
    await (await waitForNotebookRendererButton(workbench, label)).dispose();
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
    await (await waitForNotebookRendererButton(workbench, "renderer provenance A", "Open live variable")).dispose();
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

async function bestEffortSavedSnapshotCleanup(
  testing: TestApi,
  notebook: vscode.NotebookDocument | undefined,
  label: string
): Promise<void> {
  const active = testing.activeSession();
  if (active?.metadata.source.kind === "notebookOutput" && active.metadata.source.label === label) {
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
  const tabs = savedSnapshotTabs(notebook, label);
  if (tabs.length > 0) {
    try {
      await vscode.window.tabGroups.close(tabs, true);
    } catch {
      // Preserve the original acceptance failure.
    }
  }
}

function savedSnapshotTabs(notebook: vscode.NotebookDocument | undefined, label: string): vscode.Tab[] {
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
      jupyter.testing.stats(openedSecondNotebook.uri),
      undefined,
      "Notebook B must not acquire a kernel before notebook A's renderer action."
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
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      openedSecondNotebook,
      "Notebook B must remain active while the renderer event is emitted from notebook A."
    );

    recordAcceptanceProgress("verify:notebook-renderer:button");
    const workbench = await connectToEditorWorkbench();
    const originButton = await waitForNotebookRendererButton(workbench, "renderer provenance A", "Open live variable");
    assert.equal(
      vscode.window.activeNotebookEditor?.notebook,
      openedSecondNotebook,
      "Notebook B must still be the exact active document immediately before notebook A's renderer action."
    );
    let originFocusObserved = false;
    const focusListener = vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (editor?.notebook === originNotebook) originFocusObserved = true;
    });
    try {
      recordAcceptanceProgress("verify:notebook-renderer:click");
      try {
        await originButton.click();
      } finally {
        await originButton.dispose();
      }
      if (vscode.window.activeNotebookEditor?.notebook === originNotebook) originFocusObserved = true;
      await waitFor(
        () => originFocusObserved,
        10_000,
        "the real renderer action to focus its exact originating notebook before opening the session panel",
        () => rendererProvenanceDiagnostics(testing, jupyter, originNotebook, openedSecondNotebook)
      );
    } finally {
      focusListener.dispose();
    }
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
      "notebook A's real renderer action to open notebook A after notebook B was active immediately before dispatch",
      () => rendererProvenanceDiagnostics(testing, jupyter, originNotebook, openedSecondNotebook)
    );

    const active = testing.activeSession();
    assert.ok(active, "The renderer provenance scenario must open a live notebook session.");
    assert.equal(active.metadata.backend, "polars");
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
      "The renderer event must read notebook A's kernel variable."
    );
    assert.equal(
      jupyter.testing.stats(openedSecondNotebook.uri),
      undefined,
      "Notebook A's renderer event must not acquire notebook B's active kernel."
    );

    recordAcceptanceProgress("verify:notebook-renderer:insertion");
    const generatedCode = "# renderer provenance A\ndef clean_data(df):\n    return df\n";
    testing.setCodeForExport(generatedCode);
    const originCellCount = originNotebook.cellCount;
    const originCellsBeforeInsertion = Array.from({ length: originCellCount }, (_, index) =>
      originNotebook.cellAt(index).document.getText()
    );
    const secondCellCount = openedSecondNotebook.cellCount;
    assert.equal(await vscode.commands.executeCommand<boolean>("openWrangler.insertNotebookCode"), true);
    await waitFor(
      () => originNotebook.cellCount === originCellCount + 1,
      10_000,
      "generated code from notebook A's renderer session to return to notebook A"
    );
    assert.equal(
      openedSecondNotebook.cellCount,
      secondCellCount,
      "Notebook B must remain unchanged by notebook A's export."
    );
    const rendererInsertionIndices = Array.from({ length: originNotebook.cellCount }, (_, index) => index).filter(
      (index) => {
        const cell = originNotebook.cellAt(index);
        return cell.document.getText() === generatedCode && cell.metadata.openWrangler?.source === "renderer_frame";
      }
    );
    assert.equal(rendererInsertionIndices.length, 1, "Exactly one renderer-provenance cell must be inserted.");
    const rendererInsertionIndex = rendererInsertionIndices[0];
    if (rendererInsertionIndex === undefined) throw new Error("The renderer-provenance insertion index was missing.");
    assert.deepEqual(
      Array.from({ length: originNotebook.cellCount }, (_, index) => index)
        .filter((index) => index !== rendererInsertionIndex)
        .map((index) => originNotebook.cellAt(index).document.getText()),
      originCellsBeforeInsertion,
      "Notebook A's existing cells must retain their exact order and contents."
    );
    const rendererInsertionMetadata = originNotebook.cellAt(rendererInsertionIndex).metadata.openWrangler;
    assert.deepEqual(rendererInsertionMetadata, {
      source: "renderer_frame",
      backend: "polars",
      generated: true,
      insertionId: rendererInsertionMetadata.insertionId
    });
    assert.equal(typeof rendererInsertionMetadata.insertionId, "string");
    assert.equal(
      await originNotebook.save(),
      true,
      "The renderer provenance fixture must close without a save prompt."
    );
    // VS Code retains an API-opened NotebookDocument after its final tab closes
    // while this live session pins the document. Closed/reopened same-URI
    // rejection is therefore exercised deterministically in coordinator/native
    // command unit tests instead of manufacturing a false packaged lifecycle.

    recordAcceptanceProgress("verify:notebook-renderer:session-close");
    await disposePackagedSessionPanel(testing, active.sessionId, "the renderer provenance session");
    await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the renderer provenance session to close");
    recordAcceptanceProgress("verify:notebook-renderer:tabs-close");
    const tabsToClose = rendererProvenanceTabs(openedSecondNotebook);
    if (tabsToClose.length > 0) assert.equal(await vscode.window.tabGroups.close(tabsToClose, true), true);
    recordAcceptanceProgress("verify:notebook-renderer:complete");
  } catch (error) {
    await bestEffortRendererProvenanceCleanup(testing, originNotebook, secondNotebook);
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
        ? { kind: source.kind }
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
      A: jupyter.testing.stats(originNotebook.uri) ?? null,
      B: jupyter.testing.stats(secondNotebook.uri) ?? null
    }
  });
}

async function bestEffortRendererProvenanceCleanup(
  testing: TestApi,
  originNotebook: vscode.NotebookDocument,
  secondNotebook: vscode.NotebookDocument | undefined
): Promise<void> {
  const active = testing.activeSession();
  if (
    active?.metadata.source.kind === "notebookVariable" &&
    active.metadata.source.uri === originNotebook.uri.toString()
  ) {
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
  click(): Promise<void>;
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
    for (const target of targets) {
      if (isRetiredRendererTarget(workbench, target.page, target.frame)) continue;
      for (const button of directNotebookRendererButtonCandidates(target.frame, label, buttonName)) {
        try {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break discovery;
          const probeTimeoutMs = Math.min(NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS, remainingMs);
          const ready = await withAcceptanceOperationDeadline(
            probeRendererButtonReadiness(button, probeTimeoutMs),
            probeTimeoutMs,
            "the notebook renderer action readiness probe"
          );
          if (ready) return locatorNotebookRendererButton(button);
        } catch (error) {
          const discoveryExpired = Date.now() >= deadline;
          if (!(discoveryExpired && isNotebookRendererProbeDeadline(error))) {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, error);
          }
          if (discoveryExpired) break discovery;
        }
      }
    }

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
      if (nestedButtons.length > 1) {
        throw new Error("Multiple visible notebook renderer actions matched the exact requested output.");
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

function directNotebookRendererButtonCandidates(frame: Frame, label: string, buttonName: string): Locator[] {
  const preview = frame.locator("section.openwrangler-notebook").filter({
    hasText: `Open Wrangler preview: ${label}`
  });
  return [preview.getByRole("button", { name: buttonName, exact: true }).first()];
}

function locatorNotebookRendererButton(button: Locator): NotebookRendererButton {
  return {
    click: () => button.click(),
    evaluate: <Result>(pageFunction: (element: unknown) => Result | Promise<Result>) => button.evaluate(pageFunction),
    dispose: () => Promise.resolve()
  };
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
  const raw = await frame.evaluateHandle(
    ({ expectedLabel, expectedButtonName }) => {
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
      if (!innerDocument || innerDocument.readyState === "loading") return null;
      const titlePrefix = `Open Wrangler preview: ${expectedLabel} (`;
      const matches = Array.from(innerDocument.querySelectorAll("section.openwrangler-notebook")).flatMap((section) => {
        const title = section.querySelector("header > span")?.textContent ?? "";
        if (!title.startsWith(titlePrefix)) return [];
        return Array.from(section.querySelectorAll("button")).filter(
          (button) => button.isConnected && (button.textContent ?? "").trim() === expectedButtonName
        );
      });
      return matches.length === 1 ? matches[0] : null;
    },
    { expectedLabel: label, expectedButtonName: buttonName }
  );
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
    click: () => element.click(),
    evaluate: <Result>(pageFunction: (candidate: unknown) => Result | Promise<Result>) =>
      element.evaluate(pageFunction),
    dispose: () => element.dispose()
  };
}

function isNotebookRendererProbeDeadline(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Timed out waiting for the notebook renderer action readiness probe after ")
  );
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

async function seedPersistedPlan(testing: TestApi, fixture: vscode.Uri): Promise<void> {
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

async function waitForOpenWranglerWebviewButtonEnabled(page: Page, name: string): Promise<Locator> {
  return waitForOpenWranglerWebviewButton(page, name, true);
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
  // still persisting it. The renderer leaves busy mode only after the
  // reconfiguration barrier has released, which is the user-visible commit.
  await waitForOpenWranglerWebviewButtonEnabled(page, "Import options");

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
  const synchronizedGridAction = await waitForOpenWranglerWebviewButton(page, "Import options", true);
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

  const gridImportAction = await waitForOpenWranglerWebviewButton(page, "Import options");
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
  const conflictingDefaultBackend = changed.metadata.backend === "pandas" ? "polars" : "pandas";
  await config.update("defaultBackend", conflictingDefaultBackend, vscode.ConfigurationTarget.Global);
  try {
    await vscode.commands.executeCommand("vscode.openWith", configured, "openWrangler.viewer", vscode.ViewColumn.One);
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
      "the custom editor to reload the last confirmed import options, backend, and view"
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
  const columnCount = 300;
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
        columnOffset: 288,
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
        projected.metadata.schema.slice(288, 300).map((column) => column.id)
      );
      assert.equal(projected.page.rows[0]?.values[0]?.display, "1288");
      assert.equal(projected.page.rows[0]?.values[11]?.display, "1299");
      assert.ok(projected.page.rows.every((row) => row.values.length === 12));

      const closed = await testing.request({
        kind: "closeSession",
        sessionId: opened.metadata.sessionId,
        revision: projected.revision
      });
      assert.equal(closed.kind, "sessionClosed");
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
