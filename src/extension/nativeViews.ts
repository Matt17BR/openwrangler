import * as vscode from "vscode";
import type { FilterModel, SessionMetadata } from "../shared/protocol";
import { SessionCoordinator, type ActiveSessionSnapshot } from "./sessionCoordinator";

type ViewKind = "operations" | "summary" | "filters" | "steps";

class DataExplorerTreeProvider implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
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
    if (this.kind === "summary") return summaryNodes(this.snapshot.metadata);
    if (this.kind === "filters") return filterNodes(this.snapshot.metadata.filterModel);
    return [new ViewNode("Original data", "No cleaning steps applied", "database")];
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

class ViewNode extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.tooltip = `${label}: ${description}`;
    this.accessibilityInformation = { label: `${label}, ${description}` };
  }
}

class CodePreviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private snapshot: ActiveSessionSnapshot | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(coordinator: SessionCoordinator) {
    this.snapshot = coordinator.activeSession();
    this.subscription = coordinator.onDidChangeActiveSession((snapshot) => {
      this.snapshot = snapshot;
      this.render();
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: false };
    this.render();
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private render(): void {
    if (!this.view) return;
    const source = this.snapshot?.metadata.source.label;
    const code = source
      ? `# ${escapeText(source)}\n# Add or select a cleaning step to preview generated code.`
      : "# Open a dataframe to preview generated code.";
    this.view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{padding:0;margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}pre{box-sizing:border-box;margin:0;min-height:100vh;padding:12px 16px;white-space:pre-wrap;color:var(--vscode-descriptionForeground)}</style></head><body><pre>${code}</pre></body></html>`;
  }
}

export function registerNativeViews(context: vscode.ExtensionContext, coordinator: SessionCoordinator): void {
  const providers = {
    "dataExplorer.operations": new DataExplorerTreeProvider("operations", coordinator),
    "dataExplorer.summary": new DataExplorerTreeProvider("summary", coordinator),
    "dataExplorer.filters": new DataExplorerTreeProvider("filters", coordinator),
    "dataExplorer.cleaningSteps": new DataExplorerTreeProvider("steps", coordinator)
  };
  for (const [id, provider] of Object.entries(providers)) {
    context.subscriptions.push(provider, vscode.window.registerTreeDataProvider(id, provider));
  }
  const codePreview = new CodePreviewViewProvider(coordinator);
  context.subscriptions.push(
    codePreview,
    vscode.window.registerWebviewViewProvider("dataExplorer.codePreview", codePreview, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dataExplorer.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Matt17BR.data-explorer")
    ),
    vscode.commands.registerCommand("dataExplorer.reportIssue", () =>
      vscode.env.openExternal(
        vscode.Uri.parse(
          `https://github.com/Matt17BR/data-explorer/issues/new?title=${encodeURIComponent("Data Explorer issue")}&body=${encodeURIComponent(`VS Code: ${vscode.version}\nOS: ${process.platform}\n\nSteps to reproduce:\n`)}`
        )
      )
    )
  );
}

function operationNodes(metadata: SessionMetadata | undefined): ViewNode[] {
  if (!metadata) return [new ViewNode("Open a dataframe", "Operations appear here", "wand")];
  const disabled = metadata.mode === "viewing" ? "Viewing mode" : "Choose an operation";
  return [
    new ViewNode("Rows and order", disabled, "list-ordered"),
    new ViewNode("Columns and types", disabled, "symbol-field"),
    new ViewNode("Text and categories", disabled, "symbol-string"),
    new ViewNode("Numbers and dates", disabled, "symbol-numeric"),
    new ViewNode("Group and aggregate", disabled, "group-by-ref-type"),
    new ViewNode("Custom code", disabled, "code")
  ];
}

function summaryNodes(metadata: SessionMetadata): ViewNode[] {
  const stats = metadata.stats;
  return [
    new ViewNode(metadata.source.label, `${metadata.backend} · ${metadata.mode}`, "table"),
    new ViewNode(
      "Shape",
      `${metadata.filteredShape.rows.toLocaleString()} × ${metadata.filteredShape.columns.toLocaleString()}`,
      "symbol-array"
    ),
    new ViewNode("Columns", metadata.schema.length.toLocaleString(), "list-tree"),
    new ViewNode("Missing cells", stats ? stats.missingCells.toLocaleString() : "Profiling…", "question"),
    new ViewNode("Duplicate rows", stats ? stats.duplicateRows.toLocaleString() : "Profiling…", "copy")
  ];
}

function filterNodes(model: FilterModel): ViewNode[] {
  const filters = model.filters.map(
    (filter) =>
      new ViewNode(
        filter.column,
        `${filter.predicates.length} predicates${filter.valueFilter ? " · values" : ""}`,
        "filter"
      )
  );
  const sorts = model.sort.map(
    (sort) =>
      new ViewNode(
        sort.column,
        `${sort.direction === "asc" ? "Ascending" : "Descending"} · nulls ${sort.nulls}`,
        "sort-precedence"
      )
  );
  return filters.length || sorts.length
    ? [...filters, ...sorts]
    : [new ViewNode("No filters or sorts", "Viewing state is separate from cleaning steps", "filter")];
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
