import * as vscode from "vscode";
import { OPEN_WRANGLER_MIME_V2 } from "../../shared/notebookOutput";
import type { SessionSource } from "../../shared/protocol";
import { SessionCoordinator } from "../sessionCoordinator";
import { OpenWranglerPanel } from "../webviewPanel";
import {
  type ExecutedNotebookCellResultBinding,
  type ObservedNotebookCellResultKernel,
  KernelBridge,
  fingerprintNotebookCellSource,
  inspectExecutedNotebookCellResult,
  isExecutedNotebookCellResultKernelCurrent,
  observeExecutedNotebookCellResultKernel,
  shouldRegisterNotebookFormatters
} from "./kernelBridge";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

const OPEN_NOTEBOOK_CELL_RESULT_COMMAND = "openWrangler.openNotebookCellResult";
const NOTEBOOK_RESULT_OUTPUT_GRACE_MS = 10_000;

export function registerNotebookCellResultAction(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  tracker = new NotebookCellResultTracker()
): void {
  tracker.start();
  const provider: vscode.NotebookCellStatusBarItemProvider = {
    onDidChangeCellStatusBarItems: tracker.onDidChangeCellStatusBarItems,
    provideCellStatusBarItems: async (cell) => {
      if (!(await tracker.hasCurrentKernel(cell))) return undefined;
      return notebookCellResultStatusItem(cell, tracker);
    }
  };
  context.subscriptions.push(
    tracker,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider("jupyter-notebook", provider),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider("interactive", provider),
    vscode.commands.registerCommand(OPEN_NOTEBOOK_CELL_RESULT_COMMAND, (cell: unknown) =>
      openNotebookCellResult(context, coordinator, tracker, cell)
    )
  );
}

export function notebookCellResultStatusItem(
  cell: vscode.NotebookCell,
  tracker: NotebookCellResultTracker
): vscode.NotebookCellStatusBarItem | undefined {
  if (!vscode.workspace.isTrusted || tracker.current(cell) === undefined) {
    return undefined;
  }
  const item = new vscode.NotebookCellStatusBarItem(
    "$(open-preview) Open in Open Wrangler",
    vscode.NotebookCellStatusBarAlignment.Right
  );
  item.command = {
    command: OPEN_NOTEBOOK_CELL_RESULT_COMMAND,
    title: "Open executed dataframe result in Open Wrangler",
    arguments: [cell]
  };
  item.tooltip = "Open this executed result if it is a supported live dataframe";
  item.accessibilityInformation = { label: "Open executed dataframe result in Open Wrangler" };
  item.priority = 120;
  return item;
}

async function openNotebookCellResult(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  tracker: NotebookCellResultTracker,
  candidate: unknown
): Promise<void> {
  const origin = exactExecutedCellOrigin(candidate, tracker);
  if (!origin) {
    void vscode.window.showWarningMessage(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
    return;
  }
  if (
    !(await tracker.hasCurrentKernel(origin.cell, origin.eligibility)) ||
    !matchesExecutedCellOrigin(origin, tracker)
  ) {
    void vscode.window.showWarningMessage(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
    return;
  }

  const delegate = new KernelBridge(context, origin.notebook, shouldRegisterNotebookFormatters());
  try {
    const captured = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Opening this notebook result in Open Wrangler"
      },
      () =>
        delegate.captureExecutedCellResult(origin.executionOrder, origin.sourceFingerprint, origin.eligibility.binding)
    );
    if (!matchesExecutedCellOrigin(origin, tracker)) {
      delegate.dispose();
      void vscode.window.showWarningMessage(
        "The notebook cell or selected kernel changed while Open Wrangler was opening its result. Try again."
      );
      return;
    }
    const source: SessionSource = {
      kind: "notebookVariable",
      label: captured.label,
      variableName: captured.variableName,
      uri: origin.notebook.uri.toString()
    };
    const bridge = coordinator.createBridge(delegate, origin.notebook);
    OpenWranglerPanel.create(context, bridge, source, captured.backend);
  } catch (error) {
    delegate.dispose();
    const detail = error instanceof Error ? error.message : "Open Wrangler could not read this cell result.";
    void vscode.window.showWarningMessage(detail);
  }
}

interface ExecutedCellOrigin {
  readonly cell: vscode.NotebookCell;
  readonly notebook: vscode.NotebookDocument;
  readonly editor: vscode.NotebookEditor;
  readonly executionOrder: number;
  readonly sourceFingerprint: string;
  readonly eligibility: ExecutedCellEligibility;
}

function exactExecutedCellOrigin(
  candidate: unknown,
  tracker: NotebookCellResultTracker
): ExecutedCellOrigin | undefined {
  if (!vscode.workspace.isTrusted || typeof candidate !== "object" || candidate === null) return undefined;
  const cell = candidate as vscode.NotebookCell;
  const notebook = cell.notebook;
  const eligibility = tracker.current(cell);
  if (
    !notebook ||
    (notebook.notebookType !== "jupyter-notebook" && notebook.notebookType !== "interactive") ||
    eligibility === undefined ||
    !isExactCellInNotebook(cell, notebook) ||
    !isSoleOpenNotebookDocument(notebook)
  ) {
    return undefined;
  }
  const editors = vscode.window.visibleNotebookEditors.filter(
    (candidateEditor) => candidateEditor.notebook === notebook
  );
  if (editors.length !== 1) return undefined;
  return {
    cell,
    notebook,
    editor: editors[0]!,
    executionOrder: eligibility.executionOrder,
    sourceFingerprint: eligibility.sourceFingerprint,
    eligibility
  };
}

function matchesExecutedCellOrigin(origin: ExecutedCellOrigin, tracker: NotebookCellResultTracker): boolean {
  const visibleEditors = vscode.window.visibleNotebookEditors.filter(
    (candidateEditor) => candidateEditor.notebook === origin.notebook
  );
  return (
    vscode.workspace.isTrusted &&
    origin.editor.notebook === origin.notebook &&
    visibleEditors.length === 1 &&
    visibleEditors[0] === origin.editor &&
    isSoleOpenNotebookDocument(origin.notebook) &&
    isExactCellInNotebook(origin.cell, origin.notebook) &&
    tracker.current(origin.cell) === origin.eligibility
  );
}

interface ExecutedCellEligibility {
  readonly notebook: vscode.NotebookDocument;
  readonly executionOrder: number;
  readonly sourceFingerprint: string;
  readonly binding: ExecutedNotebookCellResultBinding;
  invalidationSubscription?: vscode.Disposable;
}

interface PendingCellInspection {
  readonly notebook: vscode.NotebookDocument;
  readonly executionOrder: number;
  readonly sourceFingerprint: string;
  readonly observation: PendingKernelObservation;
  activeBinding?: ObservedNotebookCellResultKernel;
}

interface PendingKernelObservation {
  readonly notebook: vscode.NotebookDocument;
  readonly sourceFingerprint: string;
  readonly completion: Promise<ObservedNotebookCellResultKernel | undefined>;
  executionOrder?: number;
  claimed: boolean;
  retirement?: NodeJS.Timeout;
}

interface NotebookExecutionState {
  maxExecutionOrder: number;
  readonly trackedCells: Set<vscode.NotebookCell>;
}

export class NotebookCellResultTracker implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly notebookStates = new WeakMap<vscode.NotebookDocument, NotebookExecutionState>();
  private readonly activeStates = new Set<NotebookExecutionState>();
  private readonly eligibleCells = new WeakMap<vscode.NotebookCell, ExecutedCellEligibility>();
  private readonly pendingCells = new WeakMap<vscode.NotebookCell, PendingCellInspection>();
  private readonly kernelObservations = new WeakMap<vscode.NotebookCell, PendingKernelObservation>();
  private readonly workspaceSubscriptions: vscode.Disposable[] = [];
  private started = false;

  readonly onDidChangeCellStatusBarItems = this.changed.event;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.workspaceSubscriptions.push(
      vscode.workspace.onDidChangeNotebookDocument((event) => this.recordDocumentChange(event)),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => this.forgetNotebook(notebook))
    );
  }

  recordDocumentChange(event: vscode.NotebookDocumentChangeEvent): void {
    if (!isSupportedNotebook(event.notebook)) return;
    const state = this.stateFor(event.notebook);
    let changed = false;

    for (const contentChange of event.contentChanges) {
      for (const removedCell of contentChange.removedCells) {
        changed = this.forgetCell(state, removedCell) || changed;
      }
    }

    for (const change of event.cellChanges) {
      const reportedSummary = change.executionSummary;
      const summary = reportedSummary ?? (change.outputs !== undefined ? change.cell.executionSummary : undefined);
      const executionOrder = summary?.executionOrder;
      const completedExecuteResult =
        change.outputs !== undefined &&
        summary?.success !== false &&
        isPositiveExecutionOrder(executionOrder) &&
        isExecutedPythonResult(change.cell) &&
        hasExecuteResultOutput(change.cell) &&
        !hasOpenWranglerOutput(change.cell);
      if (reportedSummary !== undefined && reportedSummary.success === undefined && !completedExecuteResult) {
        changed = this.observeCellKernel(state, change.cell, event.notebook, reportedSummary.executionOrder) || changed;
      } else if ((summary?.success === true || completedExecuteResult) && isPositiveExecutionOrder(executionOrder)) {
        const sourceFingerprint = fingerprintNotebookCellSource(change.cell.document.getText());
        if (
          isExecutedPythonResult(change.cell) &&
          hasExecuteResultOutput(change.cell) &&
          !hasOpenWranglerOutput(change.cell) &&
          this.matchesTrackedCompletion(change.cell, event.notebook, executionOrder, sourceFingerprint)
        ) {
          continue;
        }
        if (reportedSummary !== undefined) {
          if (executionOrder <= state.maxExecutionOrder) {
            changed = this.clearState(state, change.cell) || changed;
          }
          state.maxExecutionOrder = executionOrder;
        }
        if (
          isExecutedPythonResult(change.cell) &&
          hasExecuteResultOutput(change.cell) &&
          !hasOpenWranglerOutput(change.cell)
        ) {
          const observation = this.takeKernelObservation(
            change.cell,
            event.notebook,
            executionOrder,
            sourceFingerprint
          );
          changed = this.forgetCell(state, change.cell) || changed;
          if (!observation) continue;
          this.inspectCellResult(state, change.cell, {
            notebook: event.notebook,
            executionOrder,
            sourceFingerprint,
            observation
          });
        } else if (change.cell.outputs.length > 0) {
          const observation = this.claimKernelObservation(change.cell);
          changed = this.forgetCell(state, change.cell) || changed;
          this.disposeObservation(observation);
        } else if (reportedSummary !== undefined) {
          this.scheduleObservationRetirement(state, change.cell);
        }
      } else if (reportedSummary !== undefined || (change.outputs !== undefined && change.cell.outputs.length === 0)) {
        changed = this.forgetCell(state, change.cell) || changed;
      }
    }

    if (changed) this.changed.fire();
  }

  forgetNotebook(notebook: vscode.NotebookDocument): void {
    const state = this.notebookStates.get(notebook);
    if (!state) return;
    this.notebookStates.delete(notebook);
    this.activeStates.delete(state);
    if (this.clearState(state)) this.changed.fire();
  }

  current(cell: vscode.NotebookCell): ExecutedCellEligibility | undefined {
    const eligibility = this.eligibleCells.get(cell);
    if (
      eligibility === undefined ||
      cell.notebook !== eligibility.notebook ||
      !isExecutedPythonResult(cell) ||
      !hasExecuteResultOutput(cell) ||
      hasOpenWranglerOutput(cell) ||
      !eligibility.binding.isValid() ||
      cell.executionSummary?.executionOrder !== eligibility.executionOrder ||
      fingerprintNotebookCellSource(cell.document.getText()) !== eligibility.sourceFingerprint
    ) {
      return undefined;
    }
    return eligibility;
  }

  async hasCurrentKernel(cell: vscode.NotebookCell, expected?: ExecutedCellEligibility): Promise<boolean> {
    const eligibility = this.current(cell);
    if (!eligibility || (expected && eligibility !== expected)) return false;
    const current = await isExecutedNotebookCellResultKernelCurrent(eligibility.notebook, eligibility.binding);
    if (current || this.eligibleCells.get(cell) !== eligibility) return current;
    const state = this.notebookStates.get(eligibility.notebook);
    if (state && this.forgetCell(state, cell)) this.changed.fire();
    return false;
  }

  dispose(): void {
    for (const subscription of this.workspaceSubscriptions.splice(0)) subscription.dispose();
    this.started = false;
    for (const state of this.activeStates) this.clearState(state);
    this.activeStates.clear();
    this.changed.dispose();
  }

  private stateFor(notebook: vscode.NotebookDocument): NotebookExecutionState {
    let state = this.notebookStates.get(notebook);
    if (!state) {
      state = { maxExecutionOrder: 0, trackedCells: new Set() };
      this.notebookStates.set(notebook, state);
      this.activeStates.add(state);
    }
    return state;
  }

  private forgetCell(state: NotebookExecutionState, cell: vscode.NotebookCell): boolean {
    const tracked = state.trackedCells.delete(cell);
    const pendingInspection = this.pendingCells.get(cell);
    pendingInspection?.activeBinding?.dispose();
    this.disposeObservation(pendingInspection?.observation);
    this.pendingCells.delete(cell);
    const observation = this.kernelObservations.get(cell);
    this.disposeObservation(observation);
    this.kernelObservations.delete(cell);
    const eligibility = this.eligibleCells.get(cell);
    eligibility?.invalidationSubscription?.dispose();
    eligibility?.binding.dispose();
    this.eligibleCells.delete(cell);
    return tracked;
  }

  private clearState(state: NotebookExecutionState, except?: vscode.NotebookCell): boolean {
    if (state.trackedCells.size === 0) return false;
    let changed = false;
    for (const cell of [...state.trackedCells]) {
      if (cell !== except) changed = this.forgetCell(state, cell) || changed;
    }
    return changed;
  }

  private inspectCellResult(
    state: NotebookExecutionState,
    cell: vscode.NotebookCell,
    pending: PendingCellInspection
  ): void {
    state.trackedCells.add(cell);
    this.pendingCells.set(cell, pending);
    void pending.observation.completion
      .then(async (observed) => {
        if (!observed) return undefined;
        pending.activeBinding = observed;
        if (!this.started || this.pendingCells.get(cell) !== pending || !this.matchesPendingCell(cell, pending)) {
          observed.dispose();
          return undefined;
        }
        return inspectExecutedNotebookCellResult(
          pending.notebook,
          pending.executionOrder,
          pending.sourceFingerprint,
          observed
        );
      })
      .then(
        (binding) => {
          if (!this.started || this.pendingCells.get(cell) !== pending || !this.matchesPendingCell(cell, pending)) {
            binding?.dispose();
            return;
          }
          this.pendingCells.delete(cell);
          if (!binding?.isValid()) {
            binding?.dispose();
            state.trackedCells.delete(cell);
            return;
          }
          const eligibility: ExecutedCellEligibility = { ...pending, binding };
          eligibility.invalidationSubscription = binding.onDidInvalidate(() => {
            if (this.eligibleCells.get(cell) === eligibility && this.forgetCell(state, cell)) this.changed.fire();
          });
          if (!binding.isValid()) {
            eligibility.invalidationSubscription.dispose();
            binding.dispose();
            state.trackedCells.delete(cell);
            return;
          }
          this.eligibleCells.set(cell, eligibility);
          this.changed.fire();
        },
        () => {
          if (this.pendingCells.get(cell) !== pending) return;
          this.pendingCells.delete(cell);
          state.trackedCells.delete(cell);
        }
      );
  }

  private matchesPendingCell(cell: vscode.NotebookCell, pending: PendingCellInspection): boolean {
    return (
      cell.notebook === pending.notebook &&
      isExecutedPythonResult(cell) &&
      hasExecuteResultOutput(cell) &&
      !hasOpenWranglerOutput(cell) &&
      cell.executionSummary?.executionOrder === pending.executionOrder &&
      fingerprintNotebookCellSource(cell.document.getText()) === pending.sourceFingerprint
    );
  }

  private matchesTrackedCompletion(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    executionOrder: number,
    sourceFingerprint: string
  ): boolean {
    if (this.kernelObservations.has(cell)) return false;
    const pending = this.pendingCells.get(cell);
    if (
      pending?.notebook === notebook &&
      pending.executionOrder === executionOrder &&
      pending.sourceFingerprint === sourceFingerprint
    ) {
      return true;
    }
    const eligibility = this.eligibleCells.get(cell);
    return (
      eligibility?.notebook === notebook &&
      eligibility.executionOrder === executionOrder &&
      eligibility.sourceFingerprint === sourceFingerprint &&
      eligibility.binding.isValid()
    );
  }

  private observeCellKernel(
    state: NotebookExecutionState,
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    reportedExecutionOrder: number | undefined
  ): boolean {
    const sourceFingerprint = fingerprintNotebookCellSource(cell.document.getText());
    const executionOrder = isPositiveExecutionOrder(reportedExecutionOrder) ? reportedExecutionOrder : undefined;
    const existing = this.kernelObservations.get(cell);
    if (
      existing &&
      existing.notebook === notebook &&
      existing.sourceFingerprint === sourceFingerprint &&
      (existing.executionOrder === undefined ||
        executionOrder === undefined ||
        existing.executionOrder === executionOrder)
    ) {
      existing.executionOrder ??= executionOrder;
      return false;
    }

    const changed = this.forgetCell(state, cell);
    const completion = observeExecutedNotebookCellResultKernel(notebook).catch(() => undefined);
    const pending: PendingKernelObservation = {
      notebook,
      sourceFingerprint,
      completion,
      executionOrder,
      claimed: false
    };
    state.trackedCells.add(cell);
    this.kernelObservations.set(cell, pending);
    void completion.then((binding) => {
      if (pending.claimed) return;
      if (!this.started || this.kernelObservations.get(cell) !== pending || cell.notebook !== notebook) {
        binding?.dispose();
        return;
      }
      if (!binding?.isGenerationValid()) {
        binding?.dispose();
        this.kernelObservations.delete(cell);
        state.trackedCells.delete(cell);
        return;
      }
    });
    return changed;
  }

  private takeKernelObservation(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    executionOrder: number,
    sourceFingerprint: string
  ): PendingKernelObservation | undefined {
    const pending = this.claimKernelObservation(cell);
    if (
      pending &&
      (pending.notebook !== notebook ||
        pending.sourceFingerprint !== sourceFingerprint ||
        (pending.executionOrder !== undefined && pending.executionOrder !== executionOrder))
    ) {
      this.disposeObservation(pending);
      return undefined;
    }
    return pending;
  }

  private claimKernelObservation(cell: vscode.NotebookCell): PendingKernelObservation | undefined {
    const pending = this.kernelObservations.get(cell);
    this.kernelObservations.delete(cell);
    if (!pending) return undefined;
    pending.claimed = true;
    if (pending.retirement) clearTimeout(pending.retirement);
    pending.retirement = undefined;
    return pending;
  }

  private disposeObservation(pending: PendingKernelObservation | undefined): void {
    if (!pending) return;
    pending.claimed = true;
    if (pending.retirement) clearTimeout(pending.retirement);
    pending.retirement = undefined;
    void pending.completion.then((binding) => binding?.dispose());
  }

  private scheduleObservationRetirement(state: NotebookExecutionState, cell: vscode.NotebookCell): void {
    const pending = this.kernelObservations.get(cell);
    if (!pending || pending.claimed || pending.retirement) return;
    pending.retirement = setTimeout(() => {
      pending.retirement = undefined;
      if (this.kernelObservations.get(cell) !== pending) return;
      this.kernelObservations.delete(cell);
      state.trackedCells.delete(cell);
      this.disposeObservation(pending);
    }, NOTEBOOK_RESULT_OUTPUT_GRACE_MS);
  }
}

function isExactCellInNotebook(cell: vscode.NotebookCell, notebook: vscode.NotebookDocument): boolean {
  try {
    return cell.notebook === notebook && notebook.getCells().includes(cell);
  } catch {
    return false;
  }
}

function isExecutedPythonResult(cell: vscode.NotebookCell): boolean {
  const executionOrder = cell.executionSummary?.executionOrder;
  return (
    cell.kind === vscode.NotebookCellKind.Code &&
    cell.document.languageId.toLowerCase() === "python" &&
    Number.isSafeInteger(executionOrder) &&
    executionOrder !== undefined &&
    executionOrder > 0 &&
    cell.executionSummary?.success !== false &&
    cell.outputs.length > 0
  );
}

function isSupportedNotebook(notebook: vscode.NotebookDocument): boolean {
  return notebook.notebookType === "jupyter-notebook" || notebook.notebookType === "interactive";
}

function isPositiveExecutionOrder(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0;
}

function hasOpenWranglerOutput(cell: vscode.NotebookCell): boolean {
  return cell.outputs.some((output) => output.items.some((item) => item.mime === OPEN_WRANGLER_MIME_V2));
}

function hasExecuteResultOutput(cell: vscode.NotebookCell): boolean {
  return cell.outputs.some((output) => output.metadata?.outputType === "execute_result");
}
