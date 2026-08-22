import { createHash } from "node:crypto";
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
import { withKernelTimeout } from "./kernelLifecycle";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";

const OPEN_NOTEBOOK_CELL_RESULT_COMMAND = "openWrangler.openNotebookCellResult";
const NOTEBOOK_RESULT_OUTPUT_GRACE_MS = 10_000;
const NOTEBOOK_RESULT_KERNEL_LOOKUP_TIMEOUT_MS = 10_000;
const INLINE_UPGRADE_MAX_HTML_BYTES = 32 * 1024;
const INLINE_UPGRADE_MAX_SCAN_BYTES = 16 * 1024 * 1024;
export const INLINE_UPGRADE_MAX_CELLS = 10_000;
export const INLINE_UPGRADE_MAX_OUTPUT_CONTAINERS = 100_000;
const INLINE_UPGRADE_MAX_OUTPUT_ITEMS = 100_000;

export interface InlineNotebookOutputCandidate {
  readonly byteLength: number;
  readonly sha256: string;
}

export interface InlineNotebookCellResultBinding extends vscode.Disposable {
  readonly cell: vscode.NotebookCell;
  readonly notebook: vscode.NotebookDocument;
  readonly editor: vscode.NotebookEditor;
  readonly executionOrder: number;
  readonly sourceFingerprint: string;
  readonly kernelBinding: ExecutedNotebookCellResultBinding;
  readonly onDidInvalidate: vscode.Event<void>;
  isCurrent(): boolean;
  hasCurrentKernel(): Promise<boolean>;
}

interface InlineRawOutputMatch {
  readonly cell: vscode.NotebookCell;
  readonly output: vscode.NotebookCellOutput;
  readonly item: vscode.NotebookCellOutputItem;
}

interface InlineRawOutputCellSnapshot {
  readonly cell: vscode.NotebookCell;
  readonly outputs: readonly vscode.NotebookCellOutput[];
}

interface InlineRawOutputSnapshot {
  readonly editor: vscode.NotebookEditor;
  readonly notebook: vscode.NotebookDocument;
  readonly cellArray: readonly vscode.NotebookCell[];
  readonly cells: readonly InlineRawOutputCellSnapshot[];
}

interface InlineRawOutputItemsSnapshot {
  readonly output: vscode.NotebookCellOutput;
  readonly itemArray: readonly vscode.NotebookCellOutputItem[];
  readonly items: readonly vscode.NotebookCellOutputItem[];
}

export interface NotebookCellResultTrackerDiagnostics {
  readonly stage: "unseen" | "awaiting-result" | "completion-kernel" | "probe" | "eligible" | "rejected";
  readonly statusItem: "not-requested" | "withheld" | "offered";
  readonly reason:
    | "kernel-unavailable"
    | "completion-kernel-timeout"
    | "completion-kernel-error"
    | "probe-rejected"
    | "probe-error"
    | undefined;
}

export function registerNotebookCellResultAction(
  context: vscode.ExtensionContext,
  coordinator: SessionCoordinator,
  tracker = new NotebookCellResultTracker()
): void {
  registerAtomically(context.subscriptions, () => {
    tracker.start();
    context.subscriptions.push(tracker);
    const provider: vscode.NotebookCellStatusBarItemProvider = {
      onDidChangeCellStatusBarItems: tracker.onDidChangeCellStatusBarItems,
      provideCellStatusBarItems: (cell) => notebookCellResultStatusItem(cell, tracker)
    };
    context.subscriptions.push(
      vscode.notebooks.registerNotebookCellStatusBarItemProvider("jupyter-notebook", provider)
    );
    context.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider("interactive", provider));
    context.subscriptions.push(
      vscode.commands.registerCommand(OPEN_NOTEBOOK_CELL_RESULT_COMMAND, (cell: unknown) =>
        openNotebookCellResult(context, coordinator, tracker, cell)
      )
    );
  });
}

export function notebookCellResultStatusItem(
  cell: vscode.NotebookCell,
  tracker: NotebookCellResultTracker
): vscode.NotebookCellStatusBarItem | undefined {
  if (!vscode.workspace.isTrusted || tracker.current(cell) === undefined) {
    tracker.recordStatusItemForTesting("withheld");
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
  tracker.recordStatusItemForTesting("offered");
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
  readonly observation?: PendingKernelObservation;
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
  private readonly inlineChanged = new vscode.EventEmitter<void>();
  private readonly notebookStates = new WeakMap<vscode.NotebookDocument, NotebookExecutionState>();
  private readonly activeStates = new Set<NotebookExecutionState>();
  private readonly eligibleCells = new WeakMap<vscode.NotebookCell, ExecutedCellEligibility>();
  private readonly pendingCells = new WeakMap<vscode.NotebookCell, PendingCellInspection>();
  private readonly kernelObservations = new WeakMap<vscode.NotebookCell, PendingKernelObservation>();
  private readonly workspaceSubscriptions: vscode.Disposable[] = [];
  private readonly diagnosticState: {
    stage: NotebookCellResultTrackerDiagnostics["stage"];
    statusItem: NotebookCellResultTrackerDiagnostics["statusItem"];
    reason: NotebookCellResultTrackerDiagnostics["reason"];
  } = {
    stage: "unseen",
    statusItem: "not-requested",
    reason: undefined
  };
  private started = false;

  readonly onDidChangeCellStatusBarItems = this.changed.event;

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      registerAtomically(this.workspaceSubscriptions, () => {
        this.workspaceSubscriptions.push(
          vscode.workspace.onDidChangeNotebookDocument((event) => this.recordDocumentChange(event))
        );
        this.workspaceSubscriptions.push(
          vscode.workspace.onDidCloseNotebookDocument((notebook) => this.forgetNotebook(notebook))
        );
      });
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  recordDocumentChange(event: vscode.NotebookDocumentChangeEvent): void {
    if (!isSupportedNotebook(event.notebook)) return;
    const state = this.stateFor(event.notebook);
    let changed = false;
    const inlineProvenanceChanged = event.contentChanges.length > 0 || event.cellChanges.length > 0;

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
        if (reportedSummary !== undefined || completedExecuteResult) {
          state.maxExecutionOrder = Math.max(state.maxExecutionOrder, executionOrder);
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
    if (inlineProvenanceChanged) this.inlineChanged.fire();
  }

  forgetNotebook(notebook: vscode.NotebookDocument): void {
    const state = this.notebookStates.get(notebook);
    if (state) {
      this.notebookStates.delete(notebook);
      this.activeStates.delete(state);
      if (this.clearState(state)) this.changed.fire();
    }
    this.inlineChanged.fire();
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

  async bindInlineUpgrade(
    editor: vscode.NotebookEditor,
    candidate: InlineNotebookOutputCandidate,
    cancellation?: vscode.CancellationToken
  ): Promise<InlineNotebookCellResultBinding | undefined> {
    if (
      !this.started ||
      cancellation?.isCancellationRequested ||
      !isInlineUpgradeCandidate(candidate) ||
      !isExactVisibleNotebookEditor(editor) ||
      !isSupportedNotebook(editor.notebook)
    ) {
      return undefined;
    }
    const rawMatch = findInlineRawOutputMatch(editor, candidate);
    if (!rawMatch || rawMatch.output.metadata?.outputType !== "execute_result") return undefined;
    const immediate = this.current(rawMatch.cell);
    if (immediate) return this.createInlineUpgradeBinding(editor, candidate, rawMatch, immediate);

    return new Promise((resolve) => {
      let settled = false;
      let observedInspection = this.pendingCells.has(rawMatch.cell) || this.kernelObservations.has(rawMatch.cell);
      const subscriptions: vscode.Disposable[] = [];
      const finish = (binding: InlineNotebookCellResultBinding | undefined): void => {
        if (settled) {
          binding?.dispose();
          return;
        }
        settled = true;
        for (const subscription of subscriptions.splice(0)) subscription.dispose();
        resolve(binding);
      };
      const inspect = (): void => {
        if (
          settled ||
          !this.started ||
          cancellation?.isCancellationRequested ||
          !matchesInlineRawOutput(editor, candidate, rawMatch)
        ) {
          finish(undefined);
          return;
        }
        const eligibility = this.current(rawMatch.cell);
        if (eligibility) {
          finish(this.createInlineUpgradeBinding(editor, candidate, rawMatch, eligibility));
          return;
        }
        const inspectionActive = this.pendingCells.has(rawMatch.cell) || this.kernelObservations.has(rawMatch.cell);
        if (inspectionActive) observedInspection = true;
        else if (observedInspection) finish(undefined);
      };
      subscriptions.push(this.inlineChanged.event(inspect));
      if (cancellation) subscriptions.push(cancellation.onCancellationRequested(() => finish(undefined)));
      inspect();
    });
  }

  diagnosticsForTesting(): NotebookCellResultTrackerDiagnostics | undefined {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS !== "1") return undefined;
    return Object.freeze({ ...this.diagnosticState });
  }

  recordStatusItemForTesting(statusItem: "withheld" | "offered"): void {
    if (process.env.OPEN_WRANGLER_EXTENSION_TESTS === "1") this.diagnosticState.statusItem = statusItem;
  }

  async hasCurrentKernel(cell: vscode.NotebookCell, expected?: ExecutedCellEligibility): Promise<boolean> {
    const eligibility = this.current(cell);
    if (!eligibility || (expected && eligibility !== expected)) return false;
    const current = await isExecutedNotebookCellResultKernelCurrent(eligibility.notebook, eligibility.binding);
    if (current || this.eligibleCells.get(cell) !== eligibility) return current;
    const state = this.notebookStates.get(eligibility.notebook);
    if (state && this.forgetCell(state, cell)) {
      this.changed.fire();
      this.inlineChanged.fire();
    }
    return false;
  }

  dispose(): void {
    for (const subscription of this.workspaceSubscriptions.splice(0)) subscription.dispose();
    this.started = false;
    for (const state of this.activeStates) this.clearState(state);
    this.activeStates.clear();
    this.inlineChanged.fire();
    this.changed.dispose();
    this.inlineChanged.dispose();
  }

  private createInlineUpgradeBinding(
    editor: vscode.NotebookEditor,
    candidate: InlineNotebookOutputCandidate,
    rawMatch: InlineRawOutputMatch,
    eligibility: ExecutedCellEligibility
  ): InlineNotebookCellResultBinding {
    let active = true;
    const invalidated = new vscode.EventEmitter<void>();
    const subscriptions: vscode.Disposable[] = [];
    const isCurrent = (): boolean =>
      active && matchesInlineRawOutput(editor, candidate, rawMatch) && this.current(rawMatch.cell) === eligibility;
    const stop = (notify: boolean): void => {
      if (!active) return;
      active = false;
      if (notify) invalidated.fire();
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
      invalidated.dispose();
    };
    subscriptions.push(
      this.inlineChanged.event(() => {
        if (!isCurrent()) stop(true);
      })
    );
    return {
      cell: rawMatch.cell,
      notebook: editor.notebook,
      editor,
      executionOrder: eligibility.executionOrder,
      sourceFingerprint: eligibility.sourceFingerprint,
      kernelBinding: eligibility.binding,
      onDidInvalidate: invalidated.event,
      isCurrent,
      hasCurrentKernel: async () =>
        isCurrent() && (await this.hasCurrentKernel(rawMatch.cell, eligibility)) && isCurrent(),
      dispose: () => stop(false)
    };
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
    this.recordDiagnostic("awaiting-result");
    let completionReason: NonNullable<NotebookCellResultTrackerDiagnostics["reason"]> | undefined;
    let probeAttempted = false;
    state.trackedCells.add(cell);
    this.pendingCells.set(cell, pending);
    void (
      pending.observation ? observeKernelWithinDeadline(pending.observation.completion) : Promise.resolve(undefined)
    )
      .then(async (observed) => {
        if (!observed) {
          if (
            !this.started ||
            this.pendingCells.get(cell) !== pending ||
            !this.matchesPendingCell(state, cell, pending)
          ) {
            this.abandonPendingInspection(state, cell, pending);
            return undefined;
          }
          this.recordDiagnostic("completion-kernel");
          observed = await observeCompletionKernel(pending.notebook, (category) => {
            completionReason = category;
          });
        }
        if (!observed) {
          if (
            !this.started ||
            this.pendingCells.get(cell) !== pending ||
            !this.matchesPendingCell(state, cell, pending)
          ) {
            this.abandonPendingInspection(state, cell, pending);
            return undefined;
          }
          this.recordDiagnostic("rejected", completionReason ?? "kernel-unavailable");
          return undefined;
        }
        pending.activeBinding = observed;
        if (
          !this.started ||
          this.pendingCells.get(cell) !== pending ||
          !this.matchesPendingCell(state, cell, pending)
        ) {
          if (!this.abandonPendingInspection(state, cell, pending)) observed.dispose();
          return undefined;
        }
        probeAttempted = true;
        this.recordDiagnostic("probe");
        return inspectExecutedNotebookCellResult(
          pending.notebook,
          pending.executionOrder,
          pending.sourceFingerprint,
          observed
        );
      })
      .then(
        (binding) => {
          if (
            !this.started ||
            this.pendingCells.get(cell) !== pending ||
            !this.matchesPendingCell(state, cell, pending)
          ) {
            binding?.dispose();
            this.abandonPendingInspection(state, cell, pending);
            return;
          }
          this.pendingCells.delete(cell);
          if (!binding?.isValid()) {
            binding?.dispose();
            state.trackedCells.delete(cell);
            if (probeAttempted) this.recordDiagnostic("rejected", "probe-rejected");
            this.inlineChanged.fire();
            return;
          }
          const eligibility: ExecutedCellEligibility = { ...pending, binding };
          eligibility.invalidationSubscription = binding.onDidInvalidate(() => {
            if (this.eligibleCells.get(cell) === eligibility && this.forgetCell(state, cell)) {
              this.changed.fire();
              this.inlineChanged.fire();
            }
          });
          if (!binding.isValid()) {
            eligibility.invalidationSubscription.dispose();
            binding.dispose();
            state.trackedCells.delete(cell);
            this.recordDiagnostic("rejected", "probe-rejected");
            this.inlineChanged.fire();
            return;
          }
          this.eligibleCells.set(cell, eligibility);
          this.recordDiagnostic("eligible");
          this.changed.fire();
          this.inlineChanged.fire();
        },
        () => {
          if (this.pendingCells.get(cell) !== pending) return;
          this.abandonPendingInspection(state, cell, pending);
          this.recordDiagnostic("rejected", "probe-error");
        }
      );
  }

  private abandonPendingInspection(
    state: NotebookExecutionState,
    cell: vscode.NotebookCell,
    pending: PendingCellInspection
  ): boolean {
    if (this.pendingCells.get(cell) !== pending) return false;
    this.pendingCells.delete(cell);
    state.trackedCells.delete(cell);
    pending.activeBinding?.dispose();
    delete pending.activeBinding;
    this.disposeObservation(pending.observation);
    this.inlineChanged.fire();
    return true;
  }

  private recordDiagnostic(
    stage: NotebookCellResultTrackerDiagnostics["stage"],
    reason?: NonNullable<NotebookCellResultTrackerDiagnostics["reason"]>
  ): void {
    this.diagnosticState.stage = stage;
    this.diagnosticState.reason = reason;
  }

  private matchesPendingCell(
    state: NotebookExecutionState,
    cell: vscode.NotebookCell,
    pending: PendingCellInspection
  ): boolean {
    return (
      state.maxExecutionOrder === pending.executionOrder &&
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
      const receivedConcreteOrder = existing.executionOrder === undefined && executionOrder !== undefined;
      existing.executionOrder ??= executionOrder;
      return receivedConcreteOrder ? this.recordExecutionStart(state, cell, executionOrder) : false;
    }

    let changed = this.forgetCell(state, cell);
    if (executionOrder !== undefined) {
      changed = this.recordExecutionStart(state, cell, executionOrder) || changed;
    }
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

  private recordExecutionStart(
    state: NotebookExecutionState,
    cell: vscode.NotebookCell,
    executionOrder: number
  ): boolean {
    if (executionOrder >= state.maxExecutionOrder) {
      state.maxExecutionOrder = executionOrder;
      return false;
    }
    const changed = this.clearState(state, cell);
    state.maxExecutionOrder = executionOrder;
    return changed;
  }

  private takeKernelObservation(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    executionOrder: number,
    sourceFingerprint: string
  ): PendingKernelObservation | undefined {
    const pending = this.claimKernelObservation(cell);
    if (pending && !matchesKernelObservation(pending, notebook, executionOrder, sourceFingerprint)) {
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

function findInlineRawOutputMatch(
  editor: vscode.NotebookEditor,
  candidate: InlineNotebookOutputCandidate
): InlineRawOutputMatch | undefined {
  const snapshot = snapshotInlineRawOutputContainers(editor);
  if (!snapshot) return undefined;
  let visitedItems = 0;
  let scannedBytes = 0;
  let match: InlineRawOutputMatch | undefined;
  const itemSnapshots: InlineRawOutputItemsSnapshot[] = [];
  try {
    for (let cellIndex = 0; cellIndex < snapshot.cells.length; cellIndex += 1) {
      const cellSnapshot = snapshot.cells[cellIndex];
      if (!cellSnapshot) return undefined;
      for (let outputIndex = 0; outputIndex < cellSnapshot.outputs.length; outputIndex += 1) {
        const output = cellSnapshot.outputs[outputIndex];
        if (!output) return undefined;
        const itemArray = output.items;
        const items = snapshotBoundedIndexedReferences(itemArray, INLINE_UPGRADE_MAX_OUTPUT_ITEMS - visitedItems);
        if (!items) return undefined;
        visitedItems += items.length;
        itemSnapshots.push({ output, itemArray, items });
      }
    }
    if (!isInlineRawOutputSnapshotCurrent(snapshot) || !areInlineRawOutputItemsSnapshotsCurrent(itemSnapshots)) {
      return undefined;
    }
    let itemSnapshotIndex = 0;
    for (let cellIndex = 0; cellIndex < snapshot.cells.length; cellIndex += 1) {
      const cellSnapshot = snapshot.cells[cellIndex];
      if (!cellSnapshot) return undefined;
      for (let outputIndex = 0; outputIndex < cellSnapshot.outputs.length; outputIndex += 1) {
        const output = cellSnapshot.outputs[outputIndex];
        const itemSnapshot = itemSnapshots[itemSnapshotIndex];
        itemSnapshotIndex += 1;
        if (!output || !itemSnapshot || itemSnapshot.output !== output) return undefined;
        for (let itemIndex = 0; itemIndex < itemSnapshot.items.length; itemIndex += 1) {
          const item = itemSnapshot.items[itemIndex];
          if (!item || item.mime !== "text/html") continue;
          const data = item.data;
          if (!ArrayBuffer.isView(data) || data.BYTES_PER_ELEMENT !== 1) return undefined;
          const byteLength = data.byteLength;
          if (byteLength !== candidate.byteLength) continue;
          if (scannedBytes > INLINE_UPGRADE_MAX_SCAN_BYTES - byteLength) return undefined;
          scannedBytes += byteLength;
          if (!matchesInlineUpgradeBytes(data, byteLength, candidate)) continue;
          if (match) return undefined;
          match = { cell: cellSnapshot.cell, output, item };
        }
      }
    }
    if (
      itemSnapshotIndex !== itemSnapshots.length ||
      !isInlineRawOutputSnapshotCurrent(snapshot) ||
      !areInlineRawOutputItemsSnapshotsCurrent(itemSnapshots)
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return match;
}

function snapshotInlineRawOutputContainers(editor: vscode.NotebookEditor): InlineRawOutputSnapshot | undefined {
  if (!isExactVisibleNotebookEditor(editor)) return undefined;
  const notebook = editor.notebook;
  try {
    const cellArray = snapshotBoundedIndexedReferences(notebook.getCells(), INLINE_UPGRADE_MAX_CELLS);
    if (!cellArray) return undefined;
    let visitedOutputs = 0;
    const cellSnapshots = new Array<InlineRawOutputCellSnapshot>(cellArray.length);
    for (let cellIndex = 0; cellIndex < cellArray.length; cellIndex += 1) {
      const cell = cellArray[cellIndex];
      if (!cell) return undefined;
      if (cell.notebook !== notebook) return undefined;
      const outputArray = cell.outputs;
      const outputs = snapshotBoundedIndexedReferences(
        outputArray,
        INLINE_UPGRADE_MAX_OUTPUT_CONTAINERS - visitedOutputs
      );
      if (!outputs) return undefined;
      visitedOutputs += outputs.length;
      cellSnapshots[cellIndex] = { cell, outputs };
    }
    const snapshot = { editor, notebook, cellArray, cells: cellSnapshots };
    return isInlineRawOutputSnapshotCurrent(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function isInlineRawOutputSnapshotCurrent(snapshot: InlineRawOutputSnapshot): boolean {
  const { editor, notebook } = snapshot;
  if (editor.notebook !== notebook || !isExactVisibleNotebookEditor(editor)) return false;
  try {
    const cells = notebook.getCells();
    if (!hasExactIndexedReferences(cells, snapshot.cellArray)) return false;
    const outputArrays = new Array<readonly vscode.NotebookCellOutput[]>(snapshot.cells.length);
    for (let cellIndex = 0; cellIndex < snapshot.cells.length; cellIndex += 1) {
      const cellSnapshot = snapshot.cells[cellIndex];
      const cell = cells[cellIndex];
      if (!cellSnapshot || cell !== cellSnapshot.cell || cell.notebook !== notebook) return false;
      const outputArray = cell.outputs;
      outputArrays[cellIndex] = outputArray;
      if (!hasExactIndexedReferences(outputArray, cellSnapshot.outputs)) return false;
    }
    if (!hasExactIndexedReferences(cells, snapshot.cellArray)) return false;
    for (let cellIndex = 0; cellIndex < snapshot.cells.length; cellIndex += 1) {
      const cellSnapshot = snapshot.cells[cellIndex];
      const outputArray = outputArrays[cellIndex];
      if (
        !cellSnapshot ||
        !outputArray ||
        cellSnapshot.cell.notebook !== notebook ||
        !hasExactIndexedReferences(outputArray, cellSnapshot.outputs)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function areInlineRawOutputItemsSnapshotsCurrent(snapshots: readonly InlineRawOutputItemsSnapshot[]): boolean {
  try {
    const itemArrays = new Array<readonly vscode.NotebookCellOutputItem[]>(snapshots.length);
    for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex += 1) {
      const snapshot = snapshots[snapshotIndex];
      if (!snapshot) return false;
      const itemArray = snapshot.output.items;
      itemArrays[snapshotIndex] = itemArray;
      if (itemArray !== snapshot.itemArray || !hasExactIndexedReferences(itemArray, snapshot.items)) return false;
    }
    for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex += 1) {
      const snapshot = snapshots[snapshotIndex];
      const itemArray = itemArrays[snapshotIndex];
      if (
        !snapshot ||
        !itemArray ||
        itemArray !== snapshot.itemArray ||
        !hasExactIndexedReferences(itemArray, snapshot.items)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function snapshotBoundedIndexedReferences<T>(values: readonly T[], maximumLength: number): readonly T[] | undefined {
  const length = values.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) return undefined;
  const snapshot = new Array<T>(length);
  for (let index = 0; index < length; index += 1) snapshot[index] = values[index]!;
  return hasExactIndexedReferences(values, snapshot) ? snapshot : undefined;
}

function hasExactIndexedReferences<T>(values: readonly T[], expected: readonly T[]): boolean {
  const length = values.length;
  if (!Number.isSafeInteger(length) || length < 0 || length !== expected.length) return false;
  for (let index = 0; index < length; index += 1) {
    if (values[index] !== expected[index]) return false;
  }
  if (values.length !== length) return false;
  for (let index = 0; index < length; index += 1) {
    if (values[index] !== expected[index]) return false;
  }
  return true;
}

function matchesInlineRawOutput(
  editor: vscode.NotebookEditor,
  candidate: InlineNotebookOutputCandidate,
  expected: InlineRawOutputMatch
): boolean {
  const current = findInlineRawOutputMatch(editor, candidate);
  return current?.cell === expected.cell && current.output === expected.output && current.item === expected.item;
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

function matchesKernelObservation(
  pending: PendingKernelObservation | undefined,
  notebook: vscode.NotebookDocument,
  executionOrder: number,
  sourceFingerprint: string
): pending is PendingKernelObservation {
  return (
    pending !== undefined &&
    pending.notebook === notebook &&
    pending.sourceFingerprint === sourceFingerprint &&
    (pending.executionOrder === undefined || pending.executionOrder === executionOrder)
  );
}

async function observeCompletionKernel(
  notebook: vscode.NotebookDocument,
  onError: (category: "completion-kernel-timeout" | "completion-kernel-error") => void
): Promise<ObservedNotebookCellResultKernel | undefined> {
  return observeKernelWithinDeadline(observeExecutedNotebookCellResultKernel(notebook), onError);
}

async function observeKernelWithinDeadline(
  operation: Promise<ObservedNotebookCellResultKernel | undefined>,
  onError?: (category: "completion-kernel-timeout" | "completion-kernel-error") => void
): Promise<ObservedNotebookCellResultKernel | undefined> {
  let detached = false;
  try {
    return await withKernelTimeout(operation, NOTEBOOK_RESULT_KERNEL_LOOKUP_TIMEOUT_MS, () => {
      detached = true;
    });
  } catch {
    onError?.(detached ? "completion-kernel-timeout" : "completion-kernel-error");
    return undefined;
  } finally {
    if (detached) {
      void operation.then(
        (binding) => binding?.dispose(),
        () => undefined
      );
    }
  }
}

function isSupportedNotebook(notebook: vscode.NotebookDocument): boolean {
  return notebook.notebookType === "jupyter-notebook" || notebook.notebookType === "interactive";
}

function isExactVisibleNotebookEditor(editor: vscode.NotebookEditor): boolean {
  const notebook = editor?.notebook;
  if (
    !vscode.workspace.isTrusted ||
    !notebook ||
    notebook.isClosed ||
    !vscode.workspace.notebookDocuments.includes(notebook) ||
    !isSoleOpenNotebookDocument(notebook)
  ) {
    return false;
  }
  const editors = vscode.window.visibleNotebookEditors.filter((candidate) => candidate.notebook === notebook);
  return editors.length === 1 && editors[0] === editor;
}

function isInlineUpgradeCandidate(candidate: InlineNotebookOutputCandidate): boolean {
  return (
    Number.isSafeInteger(candidate.byteLength) &&
    candidate.byteLength > 0 &&
    candidate.byteLength <= INLINE_UPGRADE_MAX_HTML_BYTES &&
    /^[a-f0-9]{64}$/u.test(candidate.sha256)
  );
}

function matchesInlineUpgradeBytes(
  data: Uint8Array,
  byteLength: number,
  candidate: InlineNotebookOutputCandidate
): boolean {
  return byteLength === candidate.byteLength && createHash("sha256").update(data).digest("hex") === candidate.sha256;
}

function isPositiveExecutionOrder(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0;
}

function hasOpenWranglerOutput(cell: vscode.NotebookCell): boolean {
  const outputs = boundedNotebookCellOutputs(cell);
  return outputs?.some((output) => output.items.some((item) => item.mime === OPEN_WRANGLER_MIME_V2)) === true;
}

function hasExecuteResultOutput(cell: vscode.NotebookCell): boolean {
  const outputs = boundedNotebookCellOutputs(cell);
  return outputs?.some((output) => output.metadata?.outputType === "execute_result") === true;
}

function boundedNotebookCellOutputs(cell: vscode.NotebookCell): readonly vscode.NotebookCellOutput[] | undefined {
  const outputs = cell.outputs;
  return outputs.length <= INLINE_UPGRADE_MAX_OUTPUT_CONTAINERS ? outputs : undefined;
}

function registerAtomically(subscriptions: vscode.Disposable[], register: () => void): void {
  const start = subscriptions.length;
  try {
    register();
  } catch (error) {
    const failures: unknown[] = [error];
    for (const disposable of subscriptions.splice(start).reverse()) {
      try {
        disposable.dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "Open Wrangler notebook-result registration failed during rollback.");
  }
}
