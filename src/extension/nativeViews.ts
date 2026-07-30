import * as path from "path";
import * as vscode from "vscode";
import { isActiveColumnFilter } from "../shared/filterModel";
import { canEditLatestStep, canStartOperation, operationCatalog, operationByKind } from "../shared/operations";
import { dataBackendLabel } from "../shared/protocol";
import type { FilterModel, OperationKind, SessionMetadata } from "../shared/protocol";
import { SessionCoordinator, type ActiveSessionSnapshot } from "./sessionCoordinator";
import { OpenWranglerPanel, SESSION_BOUND_EXPORT_DATA_COMMAND } from "./webviewPanel";
import { insertGeneratedNotebookCell, type NotebookInsertionResult } from "./notebooks/notebookInsertion";
import { exportFileSafely } from "./files/safeFileExport";

type ViewKind = "operations" | "summary" | "filters" | "steps";
type ViewSortAction = "moveUp" | "moveDown" | "remove";
export type NotebookInsertionDiagnosticStatus =
  | NotebookInsertionResult["status"]
  | "untrusted"
  | "missing-code"
  | "unsupported-source"
  | "missing-notebook"
  | "dispatching";

class OpenWranglerTreeProvider implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ViewNode | undefined>();
  private snapshot: ActiveSessionSnapshot | undefined;
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly kind: ViewKind,
    coordinator: SessionCoordinator
  ) {
    this.snapshot = coordinator.activeSession();
    this.subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      this.snapshot = snapshot;
      this.changeEmitter.fire(undefined);
    });
  }

  getTreeItem(element: ViewNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ViewNode[] {
    if (this.kind === "operations") return operationNodes(this.snapshot?.metadata);
    if (!this.snapshot) return [new ViewNode("No active dataframe", "Open a data file or notebook variable", "info")];
    if (this.kind === "summary") return summaryNodes(this.snapshot);
    if (this.kind === "filters") return filterNodes(this.snapshot);
    return cleaningStepNodes(this.snapshot);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
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
    readonly viewSortTarget?: ViewSortTarget
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.contextValue = contextValue;
    const detail = disabledReason ? `${description}. ${disabledReason}` : description;
    this.tooltip = `${label}: ${detail}`;
    this.accessibilityInformation = { label: `${label}, ${detail}` };
  }
}

interface ViewSortTarget {
  readonly sessionId: string;
  readonly column: string;
  readonly index: number;
  readonly modelSignature: string;
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
      if (!isCodePreviewMessage(message)) return;
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
    void this.view.webview.postMessage({
      kind: "codePreview",
      code: this.displayedCode,
      editable: Boolean(this.snapshot && this.generatedCode)
    });
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
}

export function registerNativeViews(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator
): NativeViewsTestController {
  const updatePlanContexts = (snapshot: ActiveSessionSnapshot | undefined) => {
    const hasDraft = Boolean(snapshot?.metadata.draftStep);
    const canChangePlan = canEditLatestStep(snapshot?.metadata);
    void vscode.commands.executeCommand("setContext", "openWrangler.hasDraft", hasDraft);
    void vscode.commands.executeCommand("setContext", "openWrangler.canChangePlan", canChangePlan);
  };
  updatePlanContexts(coordinator.activeSession());
  const contextSubscription = coordinator.onDidChangeActiveSession(updatePlanContexts);
  const providers = {
    "openWrangler.operations": new OpenWranglerTreeProvider("operations", coordinator),
    "openWrangler.summary": new OpenWranglerTreeProvider("summary", coordinator),
    "openWrangler.filters": new OpenWranglerTreeProvider("filters", coordinator),
    "openWrangler.cleaningSteps": new OpenWranglerTreeProvider("steps", coordinator)
  };
  for (const [id, provider] of Object.entries(providers)) {
    context.subscriptions.push(provider, vscode.window.registerTreeDataProvider(id, provider));
  }
  const codePreview = new CodePreviewViewProvider(context, coordinator);
  let lastNotebookInsertionStatus: NotebookInsertionDiagnosticStatus | undefined;
  const exportPinnedData = (sessionId: string, revision: number) =>
    exportSessionData(coordinator, { sessionId, revision });
  const sendViewSortAction = (node: unknown, action: ViewSortAction): boolean => {
    const snapshot = coordinator.activeSession();
    const target = node instanceof ViewNode ? node.viewSortTarget : undefined;
    if (
      !target ||
      !snapshot ||
      snapshot.stepInspection ||
      target.sessionId !== snapshot.sessionId ||
      target.modelSignature !== viewSortModelSignature(snapshot.viewState.filterModel)
    ) {
      return false;
    }
    const matchingIndexes = snapshot.viewState.filterModel.sort.flatMap((rule, index) =>
      rule.column === target.column ? [index] : []
    );
    if (matchingIndexes.length !== 1 || matchingIndexes[0] !== target.index) return false;
    const index = target.index;
    if (
      (action === "moveUp" && index === 0) ||
      (action === "moveDown" && index === snapshot.viewState.filterModel.sort.length - 1)
    ) {
      return false;
    }
    return OpenWranglerPanel.sendEditorAction({
      action: "changeViewSort",
      column: target.column,
      sortAction: action
    });
  };
  context.subscriptions.push(
    contextSubscription,
    vscode.commands.registerCommand("openWrangler.clearViewFilterColumn", async (column?: unknown) => {
      const snapshot = coordinator.activeSession();
      if (
        typeof column !== "string" ||
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
      if (!snapshot || snapshot.stepInspection) {
        void vscode.window.showInformationMessage(
          snapshot?.stepInspection
            ? "Return to the current view before editing viewing sorts."
            : "Open a dataframe in Open Wrangler before editing viewing sorts."
        );
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
      sendViewSortAction(node, "moveUp")
    ),
    vscode.commands.registerCommand("openWrangler.moveViewSortDown", (node?: unknown) =>
      sendViewSortAction(node, "moveDown")
    ),
    vscode.commands.registerCommand("openWrangler.removeViewSort", (node?: unknown) =>
      sendViewSortAction(node, "remove")
    ),
    vscode.commands.registerCommand("openWrangler.startOperation", async (kind?: OperationKind) => {
      if (kind !== undefined && !operationCatalog.some((operation) => operation.kind === kind)) return;
      const snapshot = coordinator.activeSession();
      if (snapshot && !canStartOperation(snapshot.metadata)) {
        void vscode.window.showInformationMessage(
          snapshot.metadata.draftStep
            ? "Apply or discard the current draft before adding another cleaning step."
            : "Open an editable dataframe before adding a cleaning step."
        );
        return;
      }
      if (
        !OpenWranglerPanel.sendEditorAction({
          action: "openOperation",
          ...(kind === undefined ? {} : { operationKind: kind })
        })
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
      if (!canEditLatestStep(snapshot?.metadata)) {
        void vscode.window.showInformationMessage(
          snapshot?.metadata.draftStep
            ? "Apply or discard the current draft before editing the latest step."
            : "Apply a cleaning step before editing the latest step."
        );
        return;
      }
      if (!OpenWranglerPanel.sendEditorAction({ action: "editLatest" })) {
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
      if (!OpenWranglerPanel.sendEditorAction({ action: "selectStep", ...(stepId ? { stepId } : {}) })) {
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
      const destination = await vscode.window.showSaveDialog({
        title: "Export Open Wrangler Python Code",
        defaultUri: defaultExportUri(snapshot, ".clean.py"),
        filters: { "Python script": ["py"] },
        saveLabel: "Export code"
      });
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
        void vscode.window.showWarningMessage(
          "The active Open Wrangler session did not originate from a notebook variable."
        );
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
        backend: snapshot.metadata.backend
      });
      lastNotebookInsertionStatus = insertion.status;
      if (insertion.status === "stale") {
        void vscode.window.showWarningMessage(
          "The originating notebook changed or was replaced before Open Wrangler could insert the generated function. Reopen it and try again."
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
        void vscode.window.showErrorMessage("VS Code could not insert the generated Open Wrangler function.");
        return false;
      }
      void vscode.window.showInformationMessage("Inserted the generated cleaning function into its notebook.");
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

function operationNodes(metadata: SessionMetadata | undefined): ViewNode[] {
  if (!metadata) return [new ViewNode("Open a dataframe", "Operations appear here", "wand")];
  const editable = metadata.mode === "editing";
  const canStart = canStartOperation(metadata);
  return operationCatalog.map(
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
  );
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
  const selectedColumn = metadata.schema.find((column) => column.id === viewState.selectedColumnId);
  const selectedColumnLabel = selectedColumn
    ? metadata.schema.filter((column) => column.name === selectedColumn.name).length > 1
      ? `${selectedColumn.name} (column ${selectedColumn.position + 1})`
      : selectedColumn.name
    : "None";
  return [
    new ViewNode(
      metadata.source.label,
      `${metadata.backend === "pyspark" ? dataBackendLabel(metadata.backend) : metadata.backend} · ${metadata.mode}`,
      "table"
    ),
    new ViewNode(
      "Shape",
      `${metadata.filteredShape.rows.toLocaleString()} × ${metadata.filteredShape.columns.toLocaleString()}`,
      "symbol-array"
    ),
    new ViewNode("Columns", metadata.schema.length.toLocaleString(), "list-tree"),
    new ViewNode("Selected column", selectedColumnLabel, "symbol-field"),
    new ViewNode("Missing cells", stats ? stats.missingCells.toLocaleString() : "Profiling…", "question"),
    new ViewNode("Duplicate rows", stats ? stats.duplicateRows.toLocaleString() : "Profiling…", "copy")
  ];
}

function filterNodes(snapshot: ActiveSessionSnapshot): ViewNode[] {
  const model = snapshot.viewState.filterModel;
  const modelSignature = viewSortModelSignature(model);
  const filters = model.filters.filter(isActiveColumnFilter).map(
    (filter) =>
      new ViewNode(
        filter.column,
        filterNodeDescription(filter),
        "filter",
        {
          command: "openWrangler.clearViewFilterColumn",
          title: `Remove ${filter.column} filter`,
          arguments: [filter.column]
        },
        "openWrangler.viewFilter"
      )
  );
  const sorts = model.sort.map(
    (sort, index) =>
      new ViewNode(
        sort.column,
        `Priority ${index + 1} · ${sort.direction === "asc" ? "Ascending" : "Descending"} · nulls ${sort.nulls}`,
        "sort-precedence",
        {
          command: "openWrangler.openViewSort",
          title: `Edit ${sort.column} sort`,
          arguments: [sort.column]
        },
        viewSortContext(index, model.sort.length),
        undefined,
        {
          sessionId: snapshot.sessionId,
          column: sort.column,
          index,
          modelSignature
        }
      )
  );
  return filters.length || sorts.length
    ? [...filters, ...sorts]
    : [new ViewNode("No filters or sorts", "Current view", "filter")];
}

function viewSortModelSignature(model: FilterModel): string {
  return JSON.stringify(model.sort);
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

function isCodePreviewMessage(message: unknown): message is { kind: "ready" } | { kind: "codeChanged"; code: string } {
  if (typeof message !== "object" || message === null || !("kind" in message)) return false;
  if (message.kind === "ready") return true;
  return message.kind === "codeChanged" && "code" in message && typeof message.code === "string";
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join("");
}
