import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { isActiveColumnFilter, viewSortModelSignature } from "../shared/filterModel";
import {
  canEditLatestStep,
  canStartOperation,
  operationCatalog,
  operationByKind,
  supportedOperationCatalog,
  supportsOperation
} from "../shared/operations";
import { dataBackendLabel, formatSessionRowCount, supportsViewingCapability } from "../shared/protocol";
import type { FilterModel, OperationKind, SessionMetadata } from "../shared/protocol";
import { isCodePreviewWebviewMessage, type CodePreviewHostMessage } from "../shared/codePreviewMessages";
import { codeDialectLanguageLabel, runtimeIdentityForSessionMetadata } from "../shared/runtimeIdentity";
import { SessionCoordinator, type ActiveSessionSnapshot } from "./sessionCoordinator";
import { OpenWranglerPanel, SESSION_BOUND_EXPORT_DATA_COMMAND } from "./webviewPanel";
import { insertGeneratedNotebookCell, type NotebookInsertionResult } from "./notebooks/notebookInsertion";
import { exportFileSafely } from "./files/safeFileExport";
import { insertGeneratedRDocumentCode } from "./r/rDocumentInsertion";
import type { PythonLiveVariableProvider, PythonLiveVariableSnapshot } from "./notebooks/pythonInteractiveCommands";
import type { RLiveVariableProvider, RLiveVariableSnapshot } from "./r/rInteractiveCommands";

type ViewKind = "operations" | "summary" | "filters" | "steps";
type ViewSortAction = "moveUp" | "moveDown" | "remove";
export type ViewSortDispatchStatus =
  | "sent"
  | "invalid-target"
  | "stale-target"
  | "inspection-active"
  | "priority-boundary"
  | "panel-unavailable"
  | "unsupported";

const VIEW_SORT_HANDLE_KIND = "openWrangler.viewSort";
const VIEW_SORT_TREE_ID_PREFIX = `${VIEW_SORT_HANDLE_KIND}:`;
const VIEW_SORT_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type NotebookInsertionDiagnosticStatus =
  | NotebookInsertionResult["status"]
  | "untrusted"
  | "missing-code"
  | "unsupported-source"
  | "missing-notebook"
  | "missing-source-document"
  | "dispatching";

class OpenWranglerTreeProvider implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ViewNode | undefined>();
  private snapshot: ActiveSessionSnapshot | undefined;
  private readonly subscription: vscode.Disposable;
  private sortRegistryContext: string;
  private readonly sortTargets = new Map<string, ViewSortTarget>();
  private readonly sortTokens = new Map<string, string>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly kind: ViewKind,
    coordinator: SessionCoordinator,
    private readonly pythonVariables?: PythonLiveVariableProvider,
    private readonly rVariables?: RLiveVariableProvider
  ) {
    this.snapshot = coordinator.activeSession();
    this.sortRegistryContext = viewSortRegistryContext(this.snapshot);
    this.subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      this.snapshot = snapshot;
      const nextContext = viewSortRegistryContext(snapshot);
      if (this.kind === "filters") {
        if (nextContext === this.sortRegistryContext) return;
        this.sortRegistryContext = nextContext;
        this.sortTargets.clear();
        this.sortTokens.clear();
      }
      this.changeEmitter.fire(undefined);
    });
    if (this.kind === "operations" && this.pythonVariables) {
      this.pythonVariableSubscription = this.pythonVariables.onDidChangeVariables(() =>
        this.changeEmitter.fire(undefined)
      );
    }
    if (this.kind === "operations" && this.rVariables) {
      this.rVariableSubscription = this.rVariables.onDidChangeVariables(() => this.changeEmitter.fire(undefined));
    }
  }

  private pythonVariableSubscription: vscode.Disposable | undefined;
  private rVariableSubscription: vscode.Disposable | undefined;

  getTreeItem(element: ViewNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ViewNode[] {
    if (this.kind === "operations") {
      return operationNodes(this.snapshot?.metadata, this.pythonVariables?.snapshot(), this.rVariables?.snapshot());
    }
    if (!this.snapshot) return [new ViewNode("No active dataframe", "Open a data file or notebook variable", "info")];
    if (this.kind === "summary") return summaryNodes(this.snapshot);
    if (this.kind === "filters") {
      return filterNodes(this.snapshot, (target) => this.registerViewSortTarget(target));
    }
    return cleaningStepNodes(this.snapshot);
  }

  resolveViewSortTarget(value: unknown): ViewSortTargetResolution {
    const decoded = decodeViewSortTargetToken(value);
    if (decoded.kind !== "token") return decoded;
    const target = this.sortTargets.get(decoded.token);
    return target ? { kind: "resolved", target } : { kind: "stale" };
  }

  dispose(): void {
    this.sortTargets.clear();
    this.sortTokens.clear();
    this.subscription.dispose();
    this.pythonVariableSubscription?.dispose();
    this.rVariableSubscription?.dispose();
    this.changeEmitter.dispose();
  }

  private registerViewSortTarget(target: ViewSortTarget): ViewSortHandle {
    const key = `${target.index}\u0000${target.column}`;
    let token = this.sortTokens.get(key);
    if (!token) {
      token = randomUUID();
      this.sortTokens.set(key, token);
    }
    this.sortTargets.set(token, target);
    return { kind: VIEW_SORT_HANDLE_KIND, token };
  }
}

class ViewNode extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    icon: string,
    command?: vscode.Command,
    contextValue?: string,
    disabledReason?: string,
    readonly viewSortHandle?: ViewSortHandle
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.contextValue = contextValue;
    const detail = disabledReason ? `${description}. ${disabledReason}` : description;
    this.tooltip = `${label}: ${detail}`;
    this.accessibilityInformation = { label: `${label}, ${detail}` };
    if (viewSortHandle) this.id = `${VIEW_SORT_TREE_ID_PREFIX}${viewSortHandle.token}`;
  }
}

interface ViewSortTarget {
  readonly sessionId: string;
  readonly column: string;
  readonly index: number;
  readonly modelSignature: string;
}

interface ViewSortHandle {
  readonly kind: typeof VIEW_SORT_HANDLE_KIND;
  readonly token: string;
}

type ViewSortTargetResolution =
  | { readonly kind: "resolved"; readonly target: ViewSortTarget }
  | { readonly kind: "stale" }
  | { readonly kind: "invalid" };

function viewSortRegistryContext(snapshot: ActiveSessionSnapshot | undefined): string {
  if (!snapshot) return "inactive";
  return JSON.stringify([snapshot.sessionId, isStepInspectionActive(snapshot), snapshot.viewState.filterModel]);
}

function decodeViewSortTargetToken(value: unknown):
  | { readonly kind: "token"; readonly token: string }
  | {
      readonly kind: "invalid";
    } {
  if (typeof value === "string") return decodeViewSortToken(value);
  if (!isOwnRecord(value)) return { kind: "invalid" };

  if (Object.prototype.hasOwnProperty.call(value, "viewSortHandle")) {
    return decodeViewSortHandle(value.viewSortHandle);
  }
  if (Object.prototype.hasOwnProperty.call(value, "id")) {
    return decodeViewSortToken(value.id);
  }
  if (Object.prototype.hasOwnProperty.call(value, "command") && isOwnRecord(value.command)) {
    const args = value.command.arguments;
    if (Array.isArray(args)) {
      for (const arg of args.slice(0, 2)) {
        const decoded = decodeViewSortHandle(arg);
        if (decoded.kind === "token") return decoded;
      }
    }
  }
  return { kind: "invalid" };
}

function decodeViewSortHandle(value: unknown):
  | { readonly kind: "token"; readonly token: string }
  | {
      readonly kind: "invalid";
    } {
  if (!isOwnRecord(value)) return { kind: "invalid" };
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "token") return { kind: "invalid" };
  if (value.kind !== VIEW_SORT_HANDLE_KIND || typeof value.token !== "string") return { kind: "invalid" };
  return decodeViewSortToken(value.token);
}

function decodeViewSortToken(value: unknown):
  | { readonly kind: "token"; readonly token: string }
  | {
      readonly kind: "invalid";
    } {
  if (typeof value !== "string") return { kind: "invalid" };
  const token = value.startsWith(VIEW_SORT_TREE_ID_PREFIX) ? value.slice(VIEW_SORT_TREE_ID_PREFIX.length) : value;
  return VIEW_SORT_TOKEN_PATTERN.test(token) ? { kind: "token", token } : { kind: "invalid" };
}

function isOwnRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class CodePreviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private snapshot: ActiveSessionSnapshot | undefined;
  private readonly subscription: vscode.Disposable;
  private generatedCode = "";
  private inspectionStepId: string | undefined;
  private displayedCode = "# Open a dataframe to preview generated code.";

  constructor(
    private readonly context: vscode.ExtensionContext,
    coordinator: SessionCoordinator
  ) {
    this.snapshot = coordinator.activeSession();
    this.generatedCode = this.snapshot?.code ?? "";
    this.inspectionStepId = this.snapshot?.stepInspection?.stepId;
    this.displayedCode = this.generatedCode || placeholderCode(this.snapshot);
    this.subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      const nextGenerated = snapshot?.code ?? "";
      const nextInspectionStepId = snapshot?.stepInspection?.stepId;
      if (
        snapshot?.sessionId !== this.snapshot?.sessionId ||
        nextGenerated !== this.generatedCode ||
        nextInspectionStepId !== this.inspectionStepId
      ) {
        this.generatedCode = nextGenerated;
        this.displayedCode = nextGenerated || placeholderCode(snapshot);
      }
      this.inspectionStepId = nextInspectionStepId;
      this.snapshot = snapshot;
      this.render();
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "media"))]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isCodePreviewWebviewMessage(message)) return;
      if (message.kind === "ready") this.render();
      if (message.kind === "codeChanged" && this.generatedCode) this.displayedCode = message.code;
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }

  codeForExport(): string | undefined {
    return this.snapshot && this.generatedCode ? this.displayedCode : undefined;
  }

  setCodeForExportForTests(code: string): void {
    this.generatedCode = code;
    this.displayedCode = code;
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const runtimeIdentity = this.snapshot ? runtimeIdentityForSessionMetadata(this.snapshot.metadata) : null;
    const message: CodePreviewHostMessage = {
      kind: "codePreview",
      code: this.displayedCode,
      editable: Boolean(this.snapshot && this.generatedCode && runtimeIdentity?.codeDialect),
      runtimeIdentity
    };
    this.view.description = codeDialectLanguageLabel(message.runtimeIdentity?.codeDialect ?? null);
    void this.view.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "codePreview.js"))
    );
    const nonce = randomNonce();
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;overflow:hidden;background:var(--vscode-editor-background)}</style></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

export interface NativeViewsTestController {
  setCodeForExport(code: string): void;
  exportCodeTo(destination: vscode.Uri): Promise<void>;
  notebookInsertionStatus(): NotebookInsertionDiagnosticStatus | undefined;
  viewSortDispatchStatus(): ViewSortDispatchStatus | undefined;
}

export function registerNativeViews(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  pythonVariables?: PythonLiveVariableProvider,
  rVariables?: RLiveVariableProvider
): NativeViewsTestController {
  const updatePlanContexts = (snapshot: ActiveSessionSnapshot | undefined) => {
    const hasDraft = Boolean(snapshot?.metadata.draftStep);
    const canChangePlan = canEditLatestStep(snapshot?.metadata);
    void vscode.commands.executeCommand("setContext", "openWrangler.hasDraft", hasDraft);
    void vscode.commands.executeCommand("setContext", "openWrangler.canChangePlan", canChangePlan);
    void vscode.commands.executeCommand(
      "setContext",
      "openWrangler.canInsertNotebookCode",
      snapshot?.metadata.capabilities?.notebookInsert === true
    );
    void vscode.commands.executeCommand(
      "setContext",
      "openWrangler.canInsertRDocumentCode",
      snapshot?.metadata.capabilities?.documentInsert === true
    );
  };
  updatePlanContexts(coordinator.activeSession());
  const contextSubscription = coordinator.onDidChangeActiveSession(updatePlanContexts);
  const filterProvider = new OpenWranglerTreeProvider("filters", coordinator);
  const providers = {
    "openWrangler.operations": new OpenWranglerTreeProvider("operations", coordinator, pythonVariables, rVariables),
    "openWrangler.summary": new OpenWranglerTreeProvider("summary", coordinator),
    "openWrangler.filters": filterProvider,
    "openWrangler.cleaningSteps": new OpenWranglerTreeProvider("steps", coordinator)
  };
  for (const [id, provider] of Object.entries(providers)) {
    context.subscriptions.push(provider, vscode.window.registerTreeDataProvider(id, provider));
  }
  const codePreview = new CodePreviewViewProvider(context, coordinator);
  let lastNotebookInsertionStatus: NotebookInsertionDiagnosticStatus | undefined;
  let lastViewSortDispatchStatus: ViewSortDispatchStatus | undefined;
  const exportPinnedData = (sessionId: string, revision: number) =>
    exportSessionData(coordinator, { sessionId, revision });
  const sendViewSortAction = (node: unknown, action: ViewSortAction): ViewSortDispatchStatus => {
    const resolution = filterProvider.resolveViewSortTarget(node);
    if (resolution.kind === "invalid") return "invalid-target";
    if (resolution.kind === "stale") return "stale-target";
    const target = resolution.target;
    const snapshot = target ? coordinator.sessionSnapshot(target.sessionId) : undefined;
    const active = coordinator.activeSession();
    if (!snapshot || active?.sessionId !== target.sessionId || target.sessionId !== snapshot.sessionId) {
      return "stale-target";
    }
    if (!supportsViewingCapability(snapshot.metadata.capabilities, "sort")) return "unsupported";
    if (isStepInspectionActive(snapshot)) return "inspection-active";
    if (target.modelSignature !== viewSortModelSignature(snapshot.viewState.filterModel)) return "stale-target";
    const matchingIndexes = snapshot.viewState.filterModel.sort.flatMap((rule, index) =>
      rule.column === target.column ? [index] : []
    );
    if (matchingIndexes.length !== 1 || matchingIndexes[0] !== target.index) return "stale-target";
    const index = target.index;
    if (
      (action === "moveUp" && index === 0) ||
      (action === "moveDown" && index === snapshot.viewState.filterModel.sort.length - 1)
    ) {
      return "priority-boundary";
    }
    return OpenWranglerPanel.sendEditorAction({
      action: "changeViewSort",
      column: target.column,
      sortAction: action,
      expectedSessionId: target.sessionId,
      expectedSortModelSignature: target.modelSignature,
      expectedSortIndex: target.index
    })
      ? "sent"
      : "panel-unavailable";
  };
  const runViewSortAction = (node: unknown, action: ViewSortAction): boolean => {
    const status = sendViewSortAction(node, action);
    lastViewSortDispatchStatus = status;
    if (status === "invalid-target") {
      void vscode.window.showInformationMessage(
        "This editor could not identify that sort action. Reopen Filters / Sorts and try again."
      );
    } else if (status === "stale-target") {
      void vscode.window.showInformationMessage("The sort order changed. Use the refreshed Filters / Sorts action.");
    } else if (status === "inspection-active") {
      void vscode.window.showInformationMessage("Return to the current view before changing sort priority.");
    } else if (status === "priority-boundary") {
      void vscode.window.showInformationMessage(
        action === "moveUp"
          ? "This sort already has the highest priority."
          : "This sort already has the lowest priority."
      );
    } else if (status === "panel-unavailable") {
      void vscode.window.showInformationMessage("Open the active dataframe editor before changing sort order.");
    } else if (status === "unsupported") {
      void vscode.window.showInformationMessage("Sorting is unavailable for this dataframe.");
    }
    return status === "sent";
  };
  context.subscriptions.push(
    contextSubscription,
    vscode.commands.registerCommand("openWrangler.clearViewFilterColumn", async (column?: unknown) => {
      const snapshot = coordinator.activeSession();
      if (
        typeof column !== "string" ||
        !snapshot ||
        !supportsViewingCapability(snapshot.metadata.capabilities, "filter") ||
        isStepInspectionActive(snapshot) ||
        !snapshot?.viewState.filterModel.filters.some(
          (filter) => filter.column === column && isActiveColumnFilter(filter)
        )
      ) {
        return;
      }
      if (!OpenWranglerPanel.sendEditorAction({ action: "clearFilterColumn", column })) {
        void vscode.window.showInformationMessage("Open the active dataframe editor before removing a viewing filter.");
      }
    }),
    vscode.commands.registerCommand("openWrangler.openViewSort", async (column?: unknown) => {
      const snapshot = coordinator.activeSession();
      if (!snapshot || isStepInspectionActive(snapshot)) {
        void vscode.window.showInformationMessage(
          snapshot && isStepInspectionActive(snapshot)
            ? "Return to the current view before editing viewing sorts."
            : "Open a dataframe in Open Wrangler before editing viewing sorts."
        );
        return;
      }
      if (!supportsViewingCapability(snapshot.metadata.capabilities, "sort")) {
        void vscode.window.showInformationMessage("Sorting is unavailable for this dataframe.");
        return;
      }
      if (
        column !== undefined &&
        (typeof column !== "string" ||
          snapshot.viewState.filterModel.sort.filter((rule) => rule.column === column).length !== 1)
      ) {
        return;
      }
      if (!OpenWranglerPanel.sendEditorAction({ action: "openFilters", ...(column ? { column } : {}) })) {
        void vscode.window.showInformationMessage("Open the active dataframe editor before editing viewing sorts.");
      }
    }),
    vscode.commands.registerCommand("openWrangler.moveViewSortUp", (node?: unknown) =>
      runViewSortAction(node, "moveUp")
    ),
    vscode.commands.registerCommand("openWrangler.moveViewSortDown", (node?: unknown) =>
      runViewSortAction(node, "moveDown")
    ),
    vscode.commands.registerCommand("openWrangler.removeViewSort", (node?: unknown) =>
      runViewSortAction(node, "remove")
    ),
    vscode.commands.registerCommand("openWrangler.startOperation", async (kind?: OperationKind) => {
      if (kind !== undefined && !operationCatalog.some((operation) => operation.kind === kind)) return;
      const snapshot = coordinator.activeSession();
      if (!snapshot) {
        void vscode.window.showInformationMessage("Open a dataframe in Open Wrangler before adding a cleaning step.");
        return;
      }
      if (kind !== undefined && !supportsOperation(snapshot.metadata.capabilities, kind)) {
        void vscode.window.showInformationMessage(
          `${operationByKind(kind).title} is not available for this dataframe.`
        );
        return;
      }
      if (!canStartOperation(snapshot.metadata, kind)) {
        void vscode.window.showInformationMessage(
          snapshot.metadata.draftStep
            ? "Apply or discard the current draft before adding another cleaning step."
            : "Open an editable dataframe before adding a cleaning step."
        );
        return;
      }
      if (
        !(await OpenWranglerPanel.sendEditorActionForSession({
          action: "openOperation",
          expectedSessionId: snapshot.sessionId,
          expectedRevision: snapshot.metadata.revision,
          ...(kind === undefined ? {} : { operationKind: kind })
        }))
      ) {
        void vscode.window.showInformationMessage("Open a dataframe in Open Wrangler before adding a cleaning step.");
      }
    }),
    vscode.commands.registerCommand("openWrangler.applyStep", () =>
      OpenWranglerPanel.sendEditorAction({ action: "applyDraft" })
    ),
    vscode.commands.registerCommand("openWrangler.discardStep", () =>
      OpenWranglerPanel.sendEditorAction({ action: "discardDraft" })
    ),
    vscode.commands.registerCommand("openWrangler.editLatestStep", async () => {
      const snapshot = coordinator.activeSession();
      if (!snapshot || !canEditLatestStep(snapshot.metadata)) {
        void vscode.window.showInformationMessage(
          snapshot?.metadata.draftStep
            ? "Apply or discard the current draft before editing the latest step."
            : "Apply a cleaning step before editing the latest step."
        );
        return;
      }
      if (
        !(await OpenWranglerPanel.sendEditorActionForSession({
          action: "editLatest",
          expectedSessionId: snapshot.sessionId,
          expectedRevision: snapshot.metadata.revision
        }))
      ) {
        void vscode.window.showInformationMessage(
          "Open the active dataframe editor before editing the latest cleaning step."
        );
      }
    }),
    vscode.commands.registerCommand("openWrangler.selectStep", async (stepId?: unknown) => {
      const snapshot = coordinator.activeSession();
      if (!snapshot) {
        void vscode.window.showInformationMessage(
          "Open a dataframe in Open Wrangler before selecting a cleaning step."
        );
        return;
      }
      if (
        stepId !== undefined &&
        (typeof stepId !== "string" || !snapshot.metadata.steps.some((step) => step.id === stepId))
      ) {
        void vscode.window.showWarningMessage("That cleaning step is no longer available in the active dataframe.");
        return;
      }
      if (stepId === undefined) coordinator.clearActiveStepInspection();
      if (
        !(await OpenWranglerPanel.sendEditorActionForSession({
          action: "selectStep",
          expectedSessionId: snapshot.sessionId,
          expectedRevision: snapshot.metadata.revision,
          ...(stepId ? { stepId } : {})
        }))
      ) {
        void vscode.window.showInformationMessage("Open the active dataframe editor before selecting a cleaning step.");
      }
    }),
    vscode.commands.registerCommand("openWrangler.undoStep", () =>
      OpenWranglerPanel.sendEditorAction({ action: "undoStep" })
    ),
    vscode.commands.registerCommand("openWrangler.copyCode", async () => {
      const code = codePreview.codeForExport();
      if (!code) {
        void vscode.window.showInformationMessage("Add a cleaning step before copying generated code.");
        return;
      }
      await vscode.env.clipboard.writeText(code);
      void vscode.window.showInformationMessage("Open Wrangler code copied to the clipboard.");
      return code;
    }),
    vscode.commands.registerCommand("openWrangler.exportCode", async () => {
      if (!(await requireTrustedWorkspace("export code"))) return;
      const snapshot = coordinator.activeSession();
      const code = codePreview.codeForExport();
      if (!snapshot || !code) {
        void vscode.window.showInformationMessage("Add a cleaning step before exporting generated code.");
        return;
      }
      const destination = await vscode.window.showSaveDialog(generatedScriptSaveOptions(snapshot));
      if (!destination) return false;
      if (!(await requireTrustedWorkspace("export code"))) return false;
      try {
        await exportGeneratedCode(snapshot, code, destination);
        const destinationLabel = destination.scheme === "file" ? destination.fsPath : destination.toString();
        void vscode.window.showInformationMessage(`Exported Open Wrangler code to ${destinationLabel}.`);
        return true;
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not export Open Wrangler code: ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      }
    }),
    vscode.commands.registerCommand("openWrangler.insertRDocumentCode", async () => {
      lastNotebookInsertionStatus = undefined;
      if (!(await requireTrustedWorkspace("insert generated code into an R document"))) {
        lastNotebookInsertionStatus = "untrusted";
        return false;
      }
      const snapshot = coordinator.activeSession();
      const code = codePreview.codeForExport();
      if (!snapshot || !code) {
        lastNotebookInsertionStatus = "missing-code";
        void vscode.window.showInformationMessage("Add a cleaning step before inserting generated code.");
        return false;
      }
      if (!snapshot.metadata.capabilities.documentInsert || snapshot.metadata.source.kind !== "documentVariable") {
        lastNotebookInsertionStatus = "unsupported-source";
        void vscode.window.showWarningMessage("The active Open Wrangler session did not come from an R document.");
        return false;
      }
      if (snapshot.metadata.backend !== "r") {
        lastNotebookInsertionStatus = "unsupported-source";
        void vscode.window.showWarningMessage("Only generated R can be inserted into an R source document.");
        return false;
      }
      const origin = coordinator.activeTextDocumentOrigin();
      if (!origin) {
        lastNotebookInsertionStatus = "missing-source-document";
        void vscode.window.showWarningMessage(
          "Reopen and run the originating R document before inserting generated code."
        );
        return false;
      }
      lastNotebookInsertionStatus = "dispatching";
      const insertion = await insertGeneratedRDocumentCode(origin, code);
      lastNotebookInsertionStatus = insertion.status;
      if (insertion.status === "stale") {
        void vscode.window.showWarningMessage(
          "The originating R document changed before Open Wrangler could insert the generated code. Run the document again."
        );
        return false;
      }
      if (insertion.status === "indeterminate") {
        void vscode.window.showWarningMessage(
          "VS Code accepted the R source edit, but Open Wrangler could not confirm its result. Inspect the file before retrying."
        );
        return false;
      }
      if (insertion.status === "rejected") {
        void vscode.window.showErrorMessage("VS Code could not insert the generated Open Wrangler R code.");
        return false;
      }
      void vscode.window.showInformationMessage(
        `Inserted generated R into ${path.basename(origin.document.uri.fsPath)}.`
      );
      return true;
    }),
    vscode.commands.registerCommand("openWrangler.insertNotebookCode", async () => {
      lastNotebookInsertionStatus = undefined;
      if (!(await requireTrustedWorkspace("insert generated code into a notebook"))) {
        lastNotebookInsertionStatus = "untrusted";
        return false;
      }
      const snapshot = coordinator.activeSession();
      const code = codePreview.codeForExport();
      if (!snapshot || !code) {
        lastNotebookInsertionStatus = "missing-code";
        void vscode.window.showInformationMessage("Add a cleaning step before inserting generated code.");
        return false;
      }
      if (!snapshot.metadata.capabilities.notebookInsert || snapshot.metadata.source.kind !== "notebookVariable") {
        lastNotebookInsertionStatus = "unsupported-source";
        void vscode.window.showWarningMessage("The active Open Wrangler session did not come from a notebook.");
        return false;
      }
      const notebook = coordinator.activeNotebookDocument();
      if (!notebook || notebook.isClosed || !vscode.workspace.notebookDocuments.includes(notebook)) {
        lastNotebookInsertionStatus = "missing-notebook";
        void vscode.window.showWarningMessage("Reopen the originating notebook before inserting generated code.");
        return false;
      }
      lastNotebookInsertionStatus = "dispatching";
      const activeEditor = vscode.window.activeNotebookEditor;
      const insertionIndex =
        activeEditor?.notebook === notebook
          ? (activeEditor.selections[0]?.end ?? notebook.cellCount)
          : notebook.cellCount;
      const insertion = await insertGeneratedNotebookCell(notebook, insertionIndex, code, {
        source: snapshot.metadata.source.label,
        backend: snapshot.metadata.backend,
        languageId: runtimeIdentityForSessionMetadata(snapshot.metadata).runtimeLanguage
      });
      lastNotebookInsertionStatus = insertion.status;
      if (insertion.status === "stale") {
        void vscode.window.showWarningMessage(
          "The originating notebook changed or was replaced before Open Wrangler could insert the generated code. Reopen it and try again."
        );
        return false;
      }
      if (insertion.status === "indeterminate") {
        void vscode.window.showWarningMessage(
          "VS Code accepted the notebook edit, but Open Wrangler could not confirm it was applied to the originating notebook. Inspect the notebook before retrying."
        );
        return false;
      }
      if (insertion.status === "rejected") {
        void vscode.window.showErrorMessage("VS Code could not insert the generated Open Wrangler code.");
        return false;
      }
      void vscode.window.showInformationMessage("Inserted the generated cleaning code into its notebook.");
      return true;
    }),
    vscode.commands.registerCommand("openWrangler.exportData", async () => {
      const snapshot = coordinator.activeSession();
      if (!snapshot) {
        if (!(await requireTrustedWorkspace("export cleaned data"))) return false;
        void vscode.window.showInformationMessage("Open a dataframe in Open Wrangler before exporting cleaned data.");
        return false;
      }
      return exportPinnedData(snapshot.sessionId, snapshot.metadata.revision);
    }),
    vscode.commands.registerCommand(SESSION_BOUND_EXPORT_DATA_COMMAND, async (sessionId: unknown, revision: unknown) =>
      typeof sessionId === "string" &&
      sessionId.length > 0 &&
      typeof revision === "number" &&
      Number.isSafeInteger(revision) &&
      revision >= 0
        ? exportPinnedData(sessionId, revision)
        : false
    ),
    codePreview,
    vscode.window.registerWebviewViewProvider("openWrangler.codePreview", codePreview, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("openWrangler.openSourceFile", async () => {
      const snapshot = coordinator.activeSession() ?? (await waitForActiveSession(coordinator, 30_000));
      const source = snapshot ? sourceUri(snapshot) : undefined;
      if (!source) {
        void vscode.window.showInformationMessage("The active Open Wrangler session has no reopenable source.");
        return;
      }
      await vscode.commands.executeCommand("vscode.open", source);
    }),
    vscode.commands.registerCommand("openWrangler.openWalkthrough", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", "Matt17BR.openwrangler#gettingStarted", false)
    ),
    vscode.commands.registerCommand("openWrangler.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Matt17BR.openwrangler")
    ),
    vscode.commands.registerCommand("openWrangler.reportIssue", () =>
      vscode.env.openExternal(
        vscode.Uri.parse(
          `https://github.com/Matt17BR/openwrangler/issues/new?title=${encodeURIComponent("Open Wrangler issue")}&body=${encodeURIComponent(`VS Code: ${vscode.version}\nOS: ${process.platform}\n\nSteps to reproduce:\n`)}`
        )
      )
    )
  );

  return {
    setCodeForExport: (code) => codePreview.setCodeForExportForTests(code),
    notebookInsertionStatus: () => lastNotebookInsertionStatus,
    viewSortDispatchStatus: () => lastViewSortDispatchStatus,
    exportCodeTo: async (destination) => {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before Open Wrangler can export code.");
      const snapshot = coordinator.activeSession();
      const code = codePreview.codeForExport();
      if (!snapshot || !code) throw new Error("Add a cleaning step before exporting generated code.");
      await exportGeneratedCode(snapshot, code, destination);
    }
  };
}

async function waitForActiveSession(
  coordinator: SessionCoordinator,
  timeoutMs: number
): Promise<ActiveSessionSnapshot | undefined> {
  const current = coordinator.activeSession();
  if (current) return current;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (snapshot: ActiveSessionSnapshot | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      subscription.dispose();
      resolve(snapshot);
    };
    const subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      if (snapshot) finish(snapshot);
    });
    const timeout = setTimeout(() => finish(undefined), timeoutMs);
  });
}

export function sourceUri(snapshot: ActiveSessionSnapshot): vscode.Uri | undefined {
  const source = snapshot.metadata.source;
  if (source.uri) {
    try {
      return vscode.Uri.parse(source.uri, true);
    } catch {
      // Fall back to a concrete path retained by older or malformed source metadata.
    }
  }
  return source.path ? vscode.Uri.file(source.path) : undefined;
}

function operationNodes(
  metadata: SessionMetadata | undefined,
  pythonVariables: PythonLiveVariableSnapshot | undefined,
  rVariables: RLiveVariableSnapshot | undefined
): ViewNode[] {
  const liveVariables = [...pythonLiveVariableNodes(pythonVariables), ...rLiveVariableNodes(rVariables)];
  if (!metadata) {
    return [
      ...liveVariables,
      new ViewNode("Open a data file", "Choose CSV, Parquet, Excel, or JSONL", "folder-opened", {
        command: "openWrangler.openPath",
        title: "Open a data file"
      })
    ];
  }
  const editable = metadata.mode === "editing";
  const canStart = canStartOperation(metadata);
  return [
    ...liveVariables,
    ...supportedOperationCatalog(metadata.capabilities).map(
      (operation) =>
        new ViewNode(
          operation.title,
          operation.group,
          operation.icon,
          canStart
            ? {
                command: "openWrangler.startOperation",
                title: `Start ${operation.title}`,
                arguments: [operation.kind]
              }
            : undefined,
          undefined,
          !editable
            ? "Available in editing mode"
            : metadata.draftStep
              ? "Apply or discard the current draft first"
              : undefined
        )
    )
  ];
}

function pythonLiveVariableNodes(snapshot: PythonLiveVariableSnapshot | undefined): ViewNode[] {
  if (!snapshot) return [];
  const refresh = new ViewNode("Refresh Python dataframes", snapshot.notebookLabel, "refresh", {
    command: "openWrangler.refreshNotebookVariables",
    title: "Refresh Python dataframes"
  });
  if (snapshot.state !== "ready") {
    return [
      new ViewNode(snapshot.message, snapshot.notebookLabel, snapshot.state === "error" ? "warning" : "info"),
      refresh
    ];
  }
  return [
    ...snapshot.variables.map(
      (variable) =>
        new ViewNode(variable.label, variable.description, "symbol-variable", {
          command: "openWrangler.openCachedNotebookVariable",
          title: `Open ${variable.label}`,
          arguments: [variable.handle]
        })
    ),
    refresh
  ];
}

function rLiveVariableNodes(snapshot: RLiveVariableSnapshot | undefined): ViewNode[] {
  if (!snapshot) return [];
  const refresh = new ViewNode("Refresh R dataframes", snapshot.message, "refresh", {
    command: "openWrangler.refreshRInteractiveVariables",
    title: "Refresh R dataframes"
  });
  if (snapshot.state === "idle") return [refresh];
  if (snapshot.state !== "ready") {
    return [
      new ViewNode(snapshot.message, snapshot.terminalLabel, snapshot.state === "error" ? "warning" : "info"),
      ...(snapshot.state === "loading" ? [] : [refresh])
    ];
  }
  return [
    ...snapshot.variables.map(
      (variable) =>
        new ViewNode(variable.label, variable.description, "symbol-variable", {
          command: "openWrangler.openCachedRInteractiveVariable",
          title: `Open ${variable.label}`,
          arguments: [variable.handle]
        })
    ),
    refresh
  ];
}

function cleaningStepNodes(snapshot: ActiveSessionSnapshot): ViewNode[] {
  const { metadata, stepInspection } = snapshot;
  const nodes: ViewNode[] = [
    new ViewNode("Original data", stepInspection ? "Show current view" : "Selected", "database", {
      command: "openWrangler.selectStep",
      title: "Show original data",
      arguments: []
    })
  ];
  nodes.push(
    ...metadata.steps.map((step, index) => {
      const operation = operationByKind(step.kind);
      const isLatest = index === metadata.steps.length - 1;
      const selected = stepInspection?.stepId === step.id;
      return new ViewNode(
        `${index + 1}. ${operation.title}`,
        selected
          ? `Selected · ${isLatest ? "latest applied step" : "applied"}`
          : isLatest
            ? "Latest applied step"
            : "Applied",
        operation.icon,
        {
          command: "openWrangler.selectStep",
          title: `Inspect ${operation.title}`,
          arguments: [step.id]
        },
        isLatest && !metadata.draftStep ? "openWrangler.latestCleaningStep" : "openWrangler.cleaningStep"
      );
    })
  );
  if (metadata.draftStep) {
    const draft = operationByKind(metadata.draftStep.kind);
    nodes.push(new ViewNode(`Draft · ${draft.title}`, "Previewing. Apply or discard.", draft.icon));
  }
  return nodes;
}

function summaryNodes(snapshot: ActiveSessionSnapshot): ViewNode[] {
  const { metadata, viewState } = snapshot;
  const stats = metadata.stats;
  const profileSupported = supportsViewingCapability(metadata.capabilities, "profile");
  const selectedColumn = metadata.schema.find((column) => column.id === viewState.selectedColumnId);
  const selectedColumnLabel = selectedColumn
    ? metadata.schema.filter((column) => column.name === selectedColumn.name).length > 1
      ? `${selectedColumn.name} (column ${selectedColumn.position + 1})`
      : selectedColumn.name
    : "None";
  const nodes = [
    new ViewNode(metadata.source.label, `${dataBackendLabel(metadata.backend)} · ${metadata.mode}`, "table"),
    new ViewNode(
      "Shape",
      `${formatSessionRowCount(metadata.filteredShape.rows)} × ${metadata.filteredShape.columns.toLocaleString()}`,
      "symbol-array"
    ),
    new ViewNode("Columns", metadata.schema.length.toLocaleString(), "list-tree"),
    new ViewNode("Selected column", selectedColumnLabel, "symbol-field")
  ];
  if (!profileSupported) {
    nodes.push(new ViewNode("Profiles unavailable", "This dataframe does not support profiling", "info"));
    return nodes;
  }
  nodes.push(
    new ViewNode("Missing cells", stats ? stats.missingCells.toLocaleString() : "Profiling…", "question"),
    new ViewNode("Duplicate rows", stats ? stats.duplicateRows.toLocaleString() : "Profiling…", "copy")
  );
  return nodes;
}

function filterNodes(
  snapshot: ActiveSessionSnapshot,
  registerViewSortTarget: (target: ViewSortTarget) => ViewSortHandle
): ViewNode[] {
  const model = snapshot.viewState.filterModel;
  const modelSignature = viewSortModelSignature(model);
  const inspectionMode = isStepInspectionActive(snapshot);
  const filterSupported = supportsViewingCapability(snapshot.metadata.capabilities, "filter");
  const sortSupported = supportsViewingCapability(snapshot.metadata.capabilities, "sort");
  if (!filterSupported && !sortSupported) {
    return [new ViewNode("Filters and sorts unavailable", "Not supported by this dataframe", "info")];
  }
  const filters = (filterSupported ? model.filters.filter(isActiveColumnFilter) : []).map(
    (filter) =>
      new ViewNode(
        filter.column,
        filterNodeDescription(filter),
        "filter",
        inspectionMode
          ? undefined
          : {
              command: "openWrangler.clearViewFilterColumn",
              title: `Remove ${filter.column} filter`,
              arguments: [filter.column]
            },
        inspectionMode ? undefined : "openWrangler.viewFilter",
        inspectionMode ? "Return to the current view to edit filters and sorts" : undefined
      )
  );
  const sorts = (sortSupported ? model.sort : []).map((sort, index) => {
    const handle = inspectionMode
      ? undefined
      : registerViewSortTarget({
          sessionId: snapshot.sessionId,
          column: sort.column,
          index,
          modelSignature
        });
    return new ViewNode(
      sort.column,
      `Priority ${index + 1} · ${sort.direction === "asc" ? "Ascending" : "Descending"} · nulls ${sort.nulls}`,
      "sort-precedence",
      inspectionMode
        ? undefined
        : {
            command: "openWrangler.openViewSort",
            title: `Edit ${sort.column} sort`,
            arguments: handle ? [sort.column, handle] : [sort.column]
          },
      inspectionMode ? undefined : viewSortContext(index, model.sort.length),
      inspectionMode ? "Return to the current view to edit filters and sorts" : undefined,
      handle
    );
  });
  if (inspectionMode) {
    return [
      new ViewNode("Filters and sorts paused", "Inspecting an applied step", "lock", {
        command: "openWrangler.selectStep",
        title: "Return to current view",
        arguments: []
      }),
      ...filters,
      ...sorts
    ];
  }
  const unavailable = [
    ...(!filterSupported ? [new ViewNode("Filtering unavailable", "Not supported by this dataframe", "info")] : []),
    ...(!sortSupported ? [new ViewNode("Sorting unavailable", "Not supported by this dataframe", "info")] : [])
  ];
  return filters.length || sorts.length
    ? [...unavailable, ...filters, ...sorts]
    : [...unavailable, new ViewNode("No filters or sorts", "Current view", "filter")];
}

function isStepInspectionActive(snapshot: ActiveSessionSnapshot | undefined): boolean {
  return Boolean(snapshot?.stepInspectionActive || snapshot?.stepInspection);
}

function viewSortContext(index: number, length: number): string {
  if (length === 1) return "openWrangler.viewSortOnly";
  if (index === 0) return "openWrangler.viewSortFirst";
  if (index === length - 1) return "openWrangler.viewSortLast";
  return "openWrangler.viewSortMiddle";
}

function filterNodeDescription(filter: FilterModel["filters"][number]): string {
  const parts: string[] = [];
  if (filter.valueFilter) {
    const selected = filter.valueFilter.selectedValues.length;
    if (selected > 0) parts.push(`${selected} selected ${selected === 1 ? "value" : "values"}`);
    if (filter.valueFilter.includeNulls) parts.push("null");
    if (filter.valueFilter.includeNaN) parts.push("NaN");
  }
  const predicates = filter.predicates.length;
  if (predicates > 0) parts.push(`${predicates} ${predicates === 1 ? "condition" : "conditions"}`);
  return parts.join(" · ");
}

function placeholderCode(snapshot: ActiveSessionSnapshot | undefined): string {
  if (snapshot?.metadata.source.kind === "notebookOutput") {
    return `# ${snapshot.metadata.source.label}\n# Read-only saved notebook snapshot. Executable cleaning lineage is not embedded in notebook output.`;
  }
  return snapshot
    ? `# ${snapshot.metadata.source.label}\n# Add or select a cleaning step to preview generated code.`
    : "# Open a dataframe to preview generated code.";
}

export function defaultExportUri(snapshot: ActiveSessionSnapshot, suffix: string): vscode.Uri {
  const baseName = path.basename(snapshot.metadata.source.label, path.extname(snapshot.metadata.source.label));
  const fileName = `${baseName || "cleaned-data"}${suffix}`;
  const source = sourceUri(snapshot);
  if (source && (source.scheme === "file" || source.scheme === "vscode-remote")) {
    return vscode.Uri.joinPath(source, "..", fileName);
  }
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  return workspace ? vscode.Uri.joinPath(workspace, fileName) : vscode.Uri.file(path.join(process.cwd(), fileName));
}

function generatedScriptSaveOptions(snapshot: ActiveSessionSnapshot): vscode.SaveDialogOptions {
  const runtimeIdentity = runtimeIdentityForSessionMetadata(snapshot.metadata);
  if (runtimeIdentity.codeDialect === "r.base") {
    return {
      title: "Export Open Wrangler R Code",
      defaultUri: defaultExportUri(snapshot, ".clean.R"),
      filters: { "R script": ["R", "r"] },
      saveLabel: "Export code"
    };
  }
  return {
    title: "Export Open Wrangler Python Code",
    defaultUri: defaultExportUri(snapshot, ".clean.py"),
    filters: { "Python script": ["py"] },
    saveLabel: "Export code"
  };
}

async function exportGeneratedCode(
  snapshot: ActiveSessionSnapshot,
  code: string,
  destination: vscode.Uri
): Promise<void> {
  const protectedSources = sourceUris(snapshot);
  const remoteSource = protectedSources.find((source) => source.scheme === "vscode-remote");
  const remoteWorkspace = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === "vscode-remote"
  )?.uri;
  if (remoteSource && remoteWorkspace && remoteSource.authority !== remoteWorkspace.authority) {
    throw new Error("The active source no longer belongs to the current VS Code remote workspace host.");
  }
  await exportFileSafely({
    destination,
    protectedSources,
    contents: Buffer.from(code, "utf8"),
    remoteAuthority: remoteWorkspace?.authority ?? remoteSource?.authority
  });
}

function sourceUris(snapshot: ActiveSessionSnapshot): vscode.Uri[] {
  const source = snapshot.metadata.source;
  const candidates: vscode.Uri[] = [];
  if (source.uri) {
    try {
      candidates.push(vscode.Uri.parse(source.uri, true));
    } catch {
      // The concrete path below still protects a file source with malformed URI metadata.
    }
  }
  if (source.path) candidates.push(vscode.Uri.file(source.path));
  const concreteCandidates = candidates.filter((candidate) => Boolean(candidate.fsPath));
  return concreteCandidates.filter(
    (candidate, index) =>
      concreteCandidates.findIndex(
        (other) =>
          other.scheme === candidate.scheme &&
          other.authority === candidate.authority &&
          other.fsPath === candidate.fsPath
      ) === index
  );
}

interface SessionExportPin {
  readonly sessionId: string;
  readonly revision: number;
}

async function exportSessionData(coordinator: SessionCoordinator, pin: SessionExportPin): Promise<boolean> {
  if (!(await requireTrustedWorkspace("export cleaned data"))) return false;
  const initial = pinnedExportSnapshot(coordinator, pin);
  if (!initial) return false;
  if (initial.metadata.draftStep) {
    void vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
    return false;
  }
  const choices = [
    initial.metadata.capabilities.exportCsv
      ? { label: "CSV", description: "Comma-separated values", format: "csv" as const }
      : undefined,
    initial.metadata.capabilities.exportParquet
      ? { label: "Parquet", description: "Typed columnar data", format: "parquet" as const }
      : undefined
  ].filter((choice): choice is NonNullable<typeof choice> => Boolean(choice));
  if (!choices.length) {
    void vscode.window.showWarningMessage("This dataframe does not support cleaned-data export.");
    return false;
  }
  const selected = await vscode.window.showQuickPick(choices, {
    title: "Export Cleaned Data",
    placeHolder: "Choose a file format"
  });
  if (!selected) return false;
  const confirmedBeforeSave = pinnedExportSnapshot(coordinator, pin);
  if (!confirmedBeforeSave || confirmedBeforeSave.metadata.draftStep) {
    if (confirmedBeforeSave?.metadata.draftStep) {
      void vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
    }
    return false;
  }
  const stillSupported =
    selected.format === "csv"
      ? confirmedBeforeSave.metadata.capabilities.exportCsv
      : confirmedBeforeSave.metadata.capabilities.exportParquet;
  if (!stillSupported) {
    void vscode.window.showWarningMessage("The selected export format is no longer available for this dataframe.");
    return false;
  }
  const extension = selected.format === "csv" ? ".cleaned.csv" : ".cleaned.parquet";
  const destination = await vscode.window.showSaveDialog({
    title: "Export Cleaned Data",
    defaultUri: defaultExportUri(confirmedBeforeSave, extension),
    filters: selected.format === "csv" ? { CSV: ["csv"] } : { Parquet: ["parquet"] },
    saveLabel: "Export data"
  });
  if (!destination) return false;
  if (destination.scheme !== "file") {
    void vscode.window.showErrorMessage("Cleaned-data export currently requires a file-system destination.");
    return false;
  }
  if (!(await requireTrustedWorkspace("export cleaned data"))) return false;
  const confirmedBeforeDispatch = pinnedExportSnapshot(coordinator, pin);
  if (!confirmedBeforeDispatch || confirmedBeforeDispatch.metadata.draftStep) {
    if (confirmedBeforeDispatch?.metadata.draftStep) {
      void vscode.window.showWarningMessage("Apply or discard the draft step before exporting cleaned data.");
    }
    return false;
  }
  const dispatchSupported =
    selected.format === "csv"
      ? confirmedBeforeDispatch.metadata.capabilities.exportCsv
      : confirmedBeforeDispatch.metadata.capabilities.exportParquet;
  if (!dispatchSupported) {
    void vscode.window.showWarningMessage("The selected export format is no longer available for this dataframe.");
    return false;
  }
  try {
    const exported = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Exporting cleaned data…", cancellable: false },
      () => coordinator.exportData(pin.sessionId, pin.revision, destination.fsPath, selected.format)
    );
    void vscode.window.showInformationMessage(
      `Exported ${exported.shape.rows.toLocaleString()} rows × ${exported.shape.columns.toLocaleString()} columns to ${exported.path}.`
    );
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function pinnedExportSnapshot(
  coordinator: SessionCoordinator,
  pin: SessionExportPin
): ActiveSessionSnapshot | undefined {
  const snapshot = coordinator.sessionSnapshot(pin.sessionId);
  if (!snapshot) {
    void vscode.window.showWarningMessage("The dataframe that started this export is no longer open.");
    return undefined;
  }
  if (snapshot.metadata.revision !== pin.revision) {
    void vscode.window.showWarningMessage(
      "The dataframe changed while export was open. Review the current data and try again."
    );
    return undefined;
  }
  return snapshot;
}

async function requireTrustedWorkspace(action: string): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage(`Trust this workspace before Open Wrangler can ${action}.`);
  return false;
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
}
