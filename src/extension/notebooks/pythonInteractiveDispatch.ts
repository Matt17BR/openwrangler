import * as vscode from "vscode";
import { isSoleOpenNotebookDocument } from "./notebookProvenance";
import {
  freshJupyterKernelMetadata,
  isExactPythonOrigin,
  isOnlyNewInteractiveWindow,
  isUnchangedPythonOrigin,
  newlyExecutedCell,
  newlyOpenedBlankInteractiveWindow,
  newlyOpenedKernelSelectableInteractiveWindow,
  type PreviousInteractiveCells,
  type PythonCellOrigin
} from "./pythonInteractiveOrigin";

const PYTHON_CELL_PUBLICATION_TIMEOUT_MS = 10_000;
export const PYTHON_CELL_POST_KERNEL_PUBLICATION_GRACE_MS = 1_000;
export const PYTHON_CELL_EXECUTION_TIMEOUT_MS = 120_000;

export type PythonInteractiveDiagnosticStage =
  | "idle"
  | "dispatching-cell"
  | "waiting-for-cell-publication"
  | "opening-interactive-editor"
  | "selecting-kernel"
  | "restoring-source-editor"
  | "retrying-cell"
  | "waiting-for-cell-completion"
  | "discovering-variables"
  | "opening-variable"
  | "complete"
  | "failed";

export type PythonInteractiveActiveDiagnosticStage = Exclude<
  PythonInteractiveDiagnosticStage,
  "idle" | "complete" | "failed"
>;

export type PythonExecutedCellResult =
  | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "timedOut" }
  | { readonly kind: "stale" };

export type PythonInteractiveBootstrapResult =
  | { readonly kind: "ready"; readonly notebook: vscode.NotebookDocument }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "stale" }
  | { readonly kind: "timedOut" }
  | { readonly kind: "dispatchRejected" }
  | { readonly kind: "selectionFailed" };

export type PythonCellAttemptResult =
  | { readonly kind: "published"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
  | {
      readonly kind: "needsKernel";
      readonly notebook: vscode.NotebookDocument;
      readonly retryAllowed: true;
    }
  | {
      readonly kind: "needsKernel";
      readonly notebook: vscode.NotebookDocument;
      readonly retryAllowed: false;
      readonly pendingDispatch: PythonCellDispatch;
    }
  | { readonly kind: "dispatchRejected" }
  | { readonly kind: "dispatchTimedOut" }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "stale" };

type PythonCellDispatchOutcome =
  | { readonly kind: "fulfilled" }
  | { readonly kind: "rejected" }
  | { readonly kind: "timedOut" }
  | { readonly kind: "cancelled" };

interface PythonCellDispatch {
  readonly promise: Promise<PythonCellDispatchOutcome>;
  outcome(): PythonCellDispatchOutcome | undefined;
  dispose(): void;
}

export async function prepareFreshLiteratePythonInteractiveWindow(
  origin: PythonCellOrigin,
  observer: PythonCellDispatchObserver,
  operationDeadline: number,
  reportStage: (stage: PythonInteractiveDiagnosticStage) => void
): Promise<PythonInteractiveBootstrapResult> {
  if (!isExactPythonOrigin(origin)) return { kind: "stale" };
  const bootstrapDeadline = Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS);
  reportStage("opening-interactive-editor");
  const dispatched = await settleBeforeDeadline(
    () => vscode.commands.executeCommand("jupyter.execSelectionInteractive", ""),
    bootstrapDeadline
  );
  if (dispatched.kind === "rejected") return { kind: "dispatchRejected" };
  if (dispatched.kind === "timedOut") return { kind: "timedOut" };

  while (true) {
    // Jupyter moves focus to the newly created Interactive Window before its
    // system cell appears. Keep validating the captured source object/version
    // here; exact active-source focus is restored and revalidated after the
    // kernel picker, immediately before the real code dispatch.
    if (!isUnchangedPythonOrigin(origin)) return { kind: "stale" };
    const unexpectedCell = observer.snapshot();
    if (unexpectedCell.kind === "stale") return unexpectedCell;
    if (unexpectedCell.kind !== "missing") return { kind: "ambiguous" };
    const selectable = observer.kernelSelectableBlankWindow();
    if (selectable.kind === "ambiguous") return selectable;
    if (selectable.kind === "found") {
      const restored = await selectKernelAndRestorePythonOrigin(
        selectable.notebook,
        origin,
        operationDeadline,
        observer,
        reportStage,
        true,
        true
      );
      return restored ? { kind: "ready", notebook: selectable.notebook } : { kind: "selectionFailed" };
    }
    const remaining = bootstrapDeadline - Date.now();
    if (remaining <= 0) return { kind: "timedOut" };
    const event = await observer.waitForChange(remaining);
    if (event === "changed") continue;
    return event === "cancelled" ? { kind: "stale" } : { kind: "timedOut" };
  }
}

export async function selectKernelAndRestorePythonOrigin(
  notebook: vscode.NotebookDocument,
  origin: PythonCellOrigin,
  operationDeadline: number,
  observer: PythonCellDispatchObserver,
  reportStage: (stage: PythonInteractiveDiagnosticStage) => void,
  requireConfirmedSelection = false,
  requireFreshScaffold = false
): Promise<boolean> {
  if (
    !isUnchangedPythonOrigin(origin) ||
    !isSoleOpenNotebookDocument(notebook) ||
    !isPinnedKernelTarget(observer, notebook, requireFreshScaffold)
  ) {
    void vscode.window.showWarningMessage(
      "The Python file or Interactive Window changed while its kernel was being selected. Try again."
    );
    return false;
  }
  const visibleMatches = vscode.window.visibleNotebookEditors.filter(
    (candidate) => candidate.notebook.uri.toString() === notebook.uri.toString()
  );
  if (visibleMatches.length > 1 || (visibleMatches[0] && visibleMatches[0].notebook !== notebook)) {
    void vscode.window.showWarningMessage(
      "The Python file or Interactive Window changed while its kernel was being selected. Try again."
    );
    return false;
  }
  let notebookEditor = visibleMatches[0];
  if (!notebookEditor) {
    reportStage("opening-interactive-editor");
    if (requireFreshScaffold) {
      const revealed = await settleBeforeDeadline(
        () =>
          vscode.window.showNotebookDocument(notebook, {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: false,
            preview: false
          }),
        Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS)
      );
      if (revealed.kind === "timedOut") {
        void vscode.window.showWarningMessage("Jupyter did not finish opening the Interactive Window in time.");
        return false;
      }
      if (revealed.kind === "rejected") {
        void vscode.window.showWarningMessage("Jupyter could not reveal the Interactive Window.");
        return false;
      }
      notebookEditor = revealed.value;
    } else {
      const appeared = await waitForExactVisibleNotebookEditor(
        notebook,
        origin,
        observer,
        Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS),
        requireFreshScaffold
      );
      if (appeared.kind === "timedOut") {
        void vscode.window.showWarningMessage("Jupyter did not finish opening the Interactive Window in time.");
        return false;
      }
      if (appeared.kind === "stale") {
        void vscode.window.showWarningMessage(
          "The Python file or Interactive Window changed while its kernel was being selected. Try again."
        );
        return false;
      }
      notebookEditor = appeared.editor;
    }
  }
  if (
    notebookEditor.notebook !== notebook ||
    !isExactVisibleNotebookEditor(notebookEditor, notebook) ||
    !isSoleOpenNotebookDocument(notebook) ||
    !isUnchangedPythonOrigin(origin) ||
    !isPinnedKernelTarget(observer, notebook, requireFreshScaffold)
  ) {
    void vscode.window.showWarningMessage(
      "The Python file or Interactive Window changed while its kernel was being selected. Try again."
    );
    return false;
  }
  const initialMetadata = requireConfirmedSelection ? freshJupyterKernelMetadata(notebook) : "absent";
  if (requireConfirmedSelection && (initialMetadata === "notPython" || initialMetadata === "ambiguous")) {
    void vscode.window.showWarningMessage("Open Wrangler requires a Python kernel for this Interactive Window.");
    return false;
  }
  if (!requireConfirmedSelection || initialMetadata === "absent") {
    reportStage("selecting-kernel");
    const selected = await settleBeforeDeadline(
      () => vscode.commands.executeCommand("notebook.selectKernel", { notebookEditor }),
      operationDeadline
    );
    if (selected.kind === "timedOut") {
      void vscode.window.showWarningMessage("Kernel selection did not finish in time.");
      return false;
    }
    if (selected.kind === "rejected") {
      void vscode.window.showWarningMessage("Jupyter could not select a kernel for the Interactive Window.");
      return false;
    }
  }
  if (requireConfirmedSelection) {
    const confirmation = await confirmPythonKernelSelection(
      notebook,
      notebookEditor,
      origin,
      observer,
      Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS),
      requireFreshScaffold
    );
    if (confirmation !== "confirmed") {
      void vscode.window.showWarningMessage(
        confirmation === "notPython"
          ? "Open Wrangler requires a Python kernel for this Interactive Window."
          : confirmation === "timedOut"
            ? "No Python kernel selection was confirmed for the Interactive Window."
            : "The Python file or Interactive Window changed during kernel selection. Try again."
      );
      return false;
    }
  }
  if (
    !isUnchangedPythonOrigin(origin) ||
    !isSoleOpenNotebookDocument(notebook) ||
    !isExactVisibleNotebookEditor(notebookEditor, notebook) ||
    !isPinnedKernelTarget(observer, notebook, requireFreshScaffold) ||
    (requireConfirmedSelection && freshJupyterKernelMetadata(notebook) !== "python")
  ) {
    void vscode.window.showWarningMessage(
      "The Python file or Interactive Window changed during kernel selection. Try again."
    );
    return false;
  }
  reportStage("restoring-source-editor");
  const restoredResult = await settleBeforeDeadline(
    () =>
      vscode.window.showTextDocument(origin.document, {
        viewColumn: origin.viewColumn,
        preserveFocus: false,
        preview: false
      }),
    operationDeadline
  );
  if (restoredResult.kind === "timedOut") {
    void vscode.window.showWarningMessage("The Python file could not be restored in time.");
    return false;
  }
  if (restoredResult.kind === "rejected") {
    void vscode.window.showWarningMessage("Jupyter selected a kernel, but the Python file could not be restored.");
    return false;
  }
  const restored = restoredResult.value;
  if (restored.document !== origin.document || !isUnchangedPythonOrigin(origin)) {
    void vscode.window.showWarningMessage("The Python file changed while its kernel was being selected. Try again.");
    return false;
  }
  restored.selection = origin.selection;
  restored.selections = [...origin.selections];
  if (
    vscode.window.activeTextEditor !== restored ||
    !isExactPythonOrigin(origin) ||
    !isPinnedKernelTarget(observer, notebook, requireFreshScaffold) ||
    (requireConfirmedSelection && freshJupyterKernelMetadata(notebook) !== "python")
  ) {
    void vscode.window.showWarningMessage("The Python file could not be focused after kernel selection. Try again.");
    return false;
  }
  return true;
}

async function confirmPythonKernelSelection(
  notebook: vscode.NotebookDocument,
  notebookEditor: vscode.NotebookEditor,
  origin: PythonCellOrigin,
  observer: PythonCellDispatchObserver,
  deadline: number,
  requireFreshScaffold: boolean
): Promise<"confirmed" | "notPython" | "stale" | "timedOut"> {
  while (true) {
    if (
      !isUnchangedPythonOrigin(origin) ||
      !isSoleOpenNotebookDocument(notebook) ||
      !isExactVisibleNotebookEditor(notebookEditor, notebook)
    ) {
      return "stale";
    }
    const metadata = freshJupyterKernelMetadata(notebook);
    if (metadata !== "absent") {
      if (metadata === "notPython") return "notPython";
      if (metadata !== "python") return "stale";
      if (!isPinnedKernelTarget(observer, notebook, requireFreshScaffold)) return "stale";
      const yielded = await settleBeforeDeadline(
        () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        deadline
      );
      if (yielded.kind !== "fulfilled") return yielded.kind === "timedOut" ? "timedOut" : "stale";
      return isUnchangedPythonOrigin(origin) &&
        isSoleOpenNotebookDocument(notebook) &&
        isExactVisibleNotebookEditor(notebookEditor, notebook) &&
        freshJupyterKernelMetadata(notebook) === "python" &&
        isPinnedKernelTarget(observer, notebook, requireFreshScaffold)
        ? "confirmed"
        : "stale";
    }
    if (!isPinnedKernelTarget(observer, notebook, requireFreshScaffold)) return "stale";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timedOut";
    const changed = await observer.waitForChange(remaining);
    if (changed === "changed") continue;
    return changed === "cancelled" ? "stale" : "timedOut";
  }
}

function isExactVisibleNotebookEditor(editor: vscode.NotebookEditor, notebook: vscode.NotebookDocument): boolean {
  const uri = notebook.uri.toString();
  const matches = vscode.window.visibleNotebookEditors.filter((candidate) => candidate.notebook.uri.toString() === uri);
  return matches.length === 1 && matches[0] === editor && editor.notebook === notebook;
}

function waitForExactVisibleNotebookEditor(
  notebook: vscode.NotebookDocument,
  origin: PythonCellOrigin,
  observer: PythonCellDispatchObserver,
  deadline: number,
  requireFreshScaffold = false
): Promise<
  | { readonly kind: "found"; readonly editor: vscode.NotebookEditor }
  | { readonly kind: "stale" }
  | { readonly kind: "timedOut" }
> {
  const current = ():
    | { readonly kind: "found"; readonly editor: vscode.NotebookEditor }
    | { readonly kind: "missing" }
    | { readonly kind: "stale" } => {
    if (
      !isUnchangedPythonOrigin(origin) ||
      !isSoleOpenNotebookDocument(notebook) ||
      !isPinnedKernelTarget(observer, notebook, requireFreshScaffold)
    ) {
      return { kind: "stale" };
    }
    const uri = notebook.uri.toString();
    const matches = vscode.window.visibleNotebookEditors.filter(
      (candidate) => candidate.notebook.uri.toString() === uri
    );
    if (matches.length > 1 || (matches[0] && matches[0].notebook !== notebook)) return { kind: "stale" };
    return matches[0] ? { kind: "found", editor: matches[0] } : { kind: "missing" };
  };

  const immediate = current();
  if (immediate.kind !== "missing") return Promise.resolve(immediate);
  if (Date.now() >= deadline) return Promise.resolve({ kind: "timedOut" });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result:
        | { readonly kind: "found"; readonly editor: vscode.NotebookEditor }
        | { readonly kind: "stale" }
        | { readonly kind: "timedOut" }
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      resolve(result);
    };
    const check = (): void => {
      const result = current();
      if (result.kind !== "missing") finish(result);
    };
    const subscription = vscode.window.onDidChangeVisibleNotebookEditors(check);
    const timer = setTimeout(
      () => {
        const result = current();
        finish(result.kind === "missing" ? { kind: "timedOut" } : result);
      },
      Math.max(0, deadline - Date.now())
    );
    check();
  });
}

function settleBeforeDeadline<T>(
  work: () => Thenable<T>,
  deadline: number
): Promise<
  { readonly kind: "fulfilled"; readonly value: T } | { readonly kind: "rejected" } | { readonly kind: "timedOut" }
> {
  if (Date.now() >= deadline) return Promise.resolve({ kind: "timedOut" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result:
        | { readonly kind: "fulfilled"; readonly value: T }
        | { readonly kind: "rejected" }
        | { readonly kind: "timedOut" }
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "timedOut" }), Math.max(0, deadline - Date.now()));
    let pending: Thenable<T>;
    try {
      pending = work();
    } catch {
      finish({ kind: "rejected" });
      return;
    }
    void Promise.resolve(pending).then(
      (value) => finish({ kind: "fulfilled", value }),
      () => finish({ kind: "rejected" })
    );
  });
}

export class PythonCellDispatchObserver implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(
    private readonly origin: PythonCellOrigin,
    private readonly beforeCells: PreviousInteractiveCells,
    private readonly beforeInteractiveWindows: ReadonlySet<vscode.NotebookDocument>
  ) {
    const changed = (): void => this.changeEmitter.fire();
    this.subscriptions = [
      vscode.workspace.onDidOpenNotebookDocument(changed),
      vscode.workspace.onDidChangeNotebookDocument(changed),
      vscode.workspace.onDidCloseNotebookDocument(changed)
    ];
  }

  snapshot():
    | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
    | { readonly kind: "missing" }
    | { readonly kind: "ambiguous" }
    | { readonly kind: "stale" } {
    if (!isUnchangedPythonOrigin(this.origin)) return { kind: "stale" };
    return newlyExecutedCell(this.origin, this.beforeCells);
  }

  blankWindow():
    | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument }
    | { readonly kind: "missing" }
    | { readonly kind: "ambiguous" } {
    return newlyOpenedBlankInteractiveWindow(this.beforeInteractiveWindows, this.origin.sourceUri);
  }

  kernelSelectableBlankWindow():
    | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument }
    | { readonly kind: "missing" }
    | { readonly kind: "ambiguous" } {
    return newlyOpenedKernelSelectableInteractiveWindow(this.beforeInteractiveWindows);
  }

  isOnlyNewInteractiveWindow(expected: vscode.NotebookDocument): boolean {
    return isOnlyNewInteractiveWindow(this.beforeInteractiveWindows, expected);
  }

  waitForChange(timeoutMs: number): Promise<"changed" | "timedOut" | "cancelled"> {
    return this.cancelableWaitForChange(timeoutMs).promise;
  }

  cancelableWaitForChange(timeoutMs: number): {
    readonly promise: Promise<"changed" | "timedOut" | "cancelled">;
    dispose(): void;
  } {
    if (this.disposed || timeoutMs <= 0) {
      return { promise: Promise.resolve("timedOut"), dispose: () => undefined };
    }
    let cancel = (): void => undefined;
    const promise = new Promise<"changed" | "timedOut" | "cancelled">((resolve) => {
      let settled = false;
      const finish = (result: "changed" | "timedOut" | "cancelled"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription.dispose();
        resolve(result);
      };
      const subscription = this.changeEmitter.event(() => finish("changed"));
      const timer = setTimeout(() => finish("timedOut"), timeoutMs);
      cancel = () => finish("cancelled");
    });
    return { promise, dispose: () => cancel() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.changeEmitter.dispose();
  }
}

function isPinnedKernelRecoveryTarget(
  observer: PythonCellDispatchObserver,
  notebook: vscode.NotebookDocument
): boolean {
  const snapshot = observer.snapshot();
  const blankWindow = observer.blankWindow();
  if (blankWindow.kind === "ambiguous") return false;
  if (snapshot.kind === "found") {
    return snapshot.notebook === notebook && blankWindow.kind === "missing";
  }
  return snapshot.kind === "missing" && blankWindow.kind === "found" && blankWindow.notebook === notebook;
}

function isPinnedFreshLiterateBootstrapTarget(
  observer: PythonCellDispatchObserver,
  notebook: vscode.NotebookDocument
): boolean {
  const snapshot = observer.snapshot();
  const selectable = observer.kernelSelectableBlankWindow();
  return (
    snapshot.kind === "missing" &&
    selectable.kind === "found" &&
    selectable.notebook === notebook &&
    observer.isOnlyNewInteractiveWindow(notebook)
  );
}

function isPinnedFreshLiteratePythonTarget(
  observer: PythonCellDispatchObserver,
  notebook: vscode.NotebookDocument
): boolean {
  return isPinnedFreshLiterateBootstrapTarget(observer, notebook) && freshJupyterKernelMetadata(notebook) === "python";
}

function isPinnedKernelTarget(
  observer: PythonCellDispatchObserver,
  notebook: vscode.NotebookDocument,
  requireFreshScaffold: boolean
): boolean {
  return requireFreshScaffold
    ? isPinnedFreshLiterateBootstrapTarget(observer, notebook)
    : isPinnedKernelRecoveryTarget(observer, notebook);
}

export async function runPythonCellAttempt(
  origin: PythonCellOrigin,
  observer: PythonCellDispatchObserver,
  operationDeadline: number,
  allowKernelRecovery: boolean,
  reportStage: (stage: PythonInteractiveDiagnosticStage) => void,
  dispatchStage: "dispatching-cell" | "retrying-cell",
  expectedNotebook?: vscode.NotebookDocument,
  requireFreshDispatch = false
): Promise<PythonCellAttemptResult> {
  if (Date.now() >= operationDeadline) return { kind: "dispatchTimedOut" };
  if (requireFreshDispatch && (!expectedNotebook || !isPinnedFreshLiteratePythonTarget(observer, expectedNotebook))) {
    return { kind: "ambiguous" };
  }
  const initial = expectedPythonCellSnapshot(observer, expectedNotebook);
  if (initial.kind === "found") {
    return requireFreshDispatch
      ? { kind: "ambiguous" }
      : { kind: "published", notebook: initial.notebook, cell: initial.cell };
  }
  if (initial.kind !== "missing") return initial;
  if (!isExactPythonOrigin(origin)) return { kind: "stale" };

  const dispatchDeadline = Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS);
  reportStage(dispatchStage);
  if (requireFreshDispatch && (!expectedNotebook || !isPinnedFreshLiteratePythonTarget(observer, expectedNotebook))) {
    return { kind: "ambiguous" };
  }
  const dispatch = boundedPythonCellDispatch(origin, dispatchDeadline);
  let dispatchTransferred = false;
  try {
    while (true) {
      const snapshot = expectedPythonCellSnapshot(observer, expectedNotebook);
      if (snapshot.kind === "found") return { kind: "published", notebook: snapshot.notebook, cell: snapshot.cell };
      if (snapshot.kind !== "missing") return snapshot;

      const blankWindow = observer.blankWindow();
      if (blankWindow.kind === "ambiguous") return blankWindow;
      if (allowKernelRecovery && blankWindow.kind === "found") {
        for (let turn = 0; turn < 3 && dispatch.outcome() === undefined; turn += 1) {
          await Promise.resolve();
        }
        const afterBlank = expectedPythonCellSnapshot(observer, expectedNotebook);
        if (afterBlank.kind === "found") {
          return { kind: "published", notebook: afterBlank.notebook, cell: afterBlank.cell };
        }
        if (afterBlank.kind !== "missing") return afterBlank;
        const confirmedBlank = observer.blankWindow();
        if (confirmedBlank.kind === "ambiguous") return confirmedBlank;
        if (confirmedBlank.kind !== "found" || confirmedBlank.notebook !== blankWindow.notebook) continue;
        const dispatchOutcome = dispatch.outcome();
        if (dispatchOutcome?.kind === "rejected") return { kind: "dispatchRejected" };
        if (dispatchOutcome === undefined) {
          dispatchTransferred = true;
          return {
            kind: "needsKernel",
            notebook: confirmedBlank.notebook,
            retryAllowed: false,
            pendingDispatch: dispatch
          };
        }
      }

      const remaining = dispatchDeadline - Date.now();
      reportStage("waiting-for-cell-publication");
      const change = observer.cancelableWaitForChange(remaining);
      const event = await Promise.race([
        dispatch.promise.then((outcome) => ({ kind: "dispatch" as const, outcome })),
        change.promise.then((outcome) => ({ kind: "change" as const, outcome }))
      ]).finally(() => change.dispose());
      if (event.kind === "change" && event.outcome === "changed") continue;

      const afterDispatch = expectedPythonCellSnapshot(observer, expectedNotebook);
      if (afterDispatch.kind === "found") {
        return { kind: "published", notebook: afterDispatch.notebook, cell: afterDispatch.cell };
      }
      if (afterDispatch.kind !== "missing") return afterDispatch;
      if (event.kind === "change") return { kind: "dispatchTimedOut" };
      if (event.outcome.kind === "rejected") return { kind: "dispatchRejected" };
      if (event.outcome.kind === "timedOut" || event.outcome.kind === "cancelled") {
        return { kind: "dispatchTimedOut" };
      }
      break;
    }
  } finally {
    if (!dispatchTransferred) dispatch.dispose();
  }

  const publicationDeadline =
    origin.command === "jupyter.execSelectionInteractive" && !allowKernelRecovery
      ? operationDeadline
      : Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS);
  return await waitForPublishedCellAfterDispatch(observer, publicationDeadline, allowKernelRecovery, expectedNotebook);
}

function expectedPythonCellSnapshot(
  observer: PythonCellDispatchObserver,
  expectedNotebook?: vscode.NotebookDocument
):
  | { readonly kind: "found"; readonly notebook: vscode.NotebookDocument; readonly cell: vscode.NotebookCell }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "stale" } {
  const snapshot = observer.snapshot();
  if (!expectedNotebook) return snapshot;
  if (snapshot.kind === "found") {
    return snapshot.notebook === expectedNotebook ? snapshot : { kind: "ambiguous" };
  }
  if (snapshot.kind !== "missing") return snapshot;
  return observer.isOnlyNewInteractiveWindow(expectedNotebook) ? snapshot : { kind: "stale" };
}

function boundedPythonCellDispatch(origin: PythonCellOrigin, deadline: number): PythonCellDispatch {
  let cancel = (): void => undefined;
  let outcome: PythonCellDispatchOutcome | undefined;
  const promise = new Promise<PythonCellDispatchOutcome>((resolve) => {
    let settled = false;
    const finish = (result: PythonCellDispatchOutcome): void => {
      if (settled) return;
      settled = true;
      outcome = result;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "timedOut" }), Math.max(0, deadline - Date.now()));
    let command: Thenable<unknown>;
    try {
      command = vscode.commands.executeCommand(origin.command, ...origin.commandArguments);
    } catch {
      finish({ kind: "rejected" });
      return;
    }
    void Promise.resolve(command).then(
      () => finish({ kind: "fulfilled" }),
      () => finish({ kind: "rejected" })
    );
    cancel = () => finish({ kind: "cancelled" });
  });
  return { promise, outcome: () => outcome, dispose: () => cancel() };
}

export async function waitForTransferredDispatchAfterKernel(
  origin: PythonCellOrigin,
  observer: PythonCellDispatchObserver,
  notebook: vscode.NotebookDocument,
  dispatch: PythonCellDispatch,
  operationDeadline: number
): Promise<PythonCellAttemptResult> {
  const dispatchDeadline = Math.min(operationDeadline, Date.now() + PYTHON_CELL_PUBLICATION_TIMEOUT_MS);
  let publicationDeadline: number | undefined;
  while (true) {
    if (!isExactPythonOrigin(origin)) return { kind: "stale" };
    const snapshot = observer.snapshot();
    if (snapshot.kind === "found") {
      return { kind: "published", notebook: snapshot.notebook, cell: snapshot.cell };
    }
    if (snapshot.kind !== "missing") return snapshot;

    const blankWindow = observer.blankWindow();
    if (blankWindow.kind === "ambiguous") return blankWindow;
    if (blankWindow.kind !== "found" || blankWindow.notebook !== notebook) return { kind: "missing" };

    const outcome = dispatch.outcome();
    if (outcome?.kind === "rejected") return { kind: "dispatchRejected" };
    if (outcome?.kind === "timedOut" || outcome?.kind === "cancelled") {
      return { kind: "dispatchTimedOut" };
    }
    if (outcome?.kind === "fulfilled") {
      publicationDeadline ??= Math.min(
        operationDeadline,
        Date.now() +
          (origin.command === "jupyter.runcurrentcell"
            ? PYTHON_CELL_POST_KERNEL_PUBLICATION_GRACE_MS
            : PYTHON_CELL_PUBLICATION_TIMEOUT_MS)
      );
      const remaining = publicationDeadline - Date.now();
      if (remaining <= 0) return { kind: "missing" };
      const event = await observer.waitForChange(remaining);
      if (event === "changed") continue;
      if (event === "cancelled") return { kind: "dispatchTimedOut" };
      continue;
    }

    const remaining = dispatchDeadline - Date.now();
    if (remaining <= 0) return { kind: "dispatchTimedOut" };
    const change = observer.cancelableWaitForChange(remaining);
    const event = await Promise.race([
      dispatch.promise.then((settled) => ({ kind: "dispatch" as const, settled })),
      change.promise.then((settled) => ({ kind: "change" as const, settled }))
    ]).finally(() => change.dispose());
    if (event.kind === "dispatch" || event.settled === "changed") continue;
    if (event.settled === "cancelled") return { kind: "dispatchTimedOut" };
  }
}

export async function waitForPublishedCellAfterDispatch(
  observer: PythonCellDispatchObserver,
  publicationDeadline: number,
  allowKernelRecovery: boolean,
  expectedNotebook?: vscode.NotebookDocument
): Promise<PythonCellAttemptResult> {
  let pinnedBlankWindow: vscode.NotebookDocument | undefined;
  while (true) {
    const snapshot = expectedPythonCellSnapshot(observer, expectedNotebook);
    if (snapshot.kind === "found") {
      return { kind: "published", notebook: snapshot.notebook, cell: snapshot.cell };
    }
    if (snapshot.kind !== "missing") return snapshot;

    const blankWindow = observer.blankWindow();
    if (blankWindow.kind === "ambiguous") return blankWindow;
    if (blankWindow.kind === "found") {
      if (pinnedBlankWindow && pinnedBlankWindow !== blankWindow.notebook) return { kind: "ambiguous" };
      pinnedBlankWindow ??= blankWindow.notebook;
    } else if (pinnedBlankWindow) {
      return { kind: "missing" };
    }
    const event = await observer.waitForChange(publicationDeadline - Date.now());
    if (event === "changed") continue;

    const finalSnapshot = expectedPythonCellSnapshot(observer, expectedNotebook);
    if (finalSnapshot.kind === "found") {
      return { kind: "published", notebook: finalSnapshot.notebook, cell: finalSnapshot.cell };
    }
    if (finalSnapshot.kind !== "missing") return finalSnapshot;
    if (event === "cancelled") return { kind: "dispatchTimedOut" };
    if (pinnedBlankWindow) {
      const finalBlank = observer.blankWindow();
      if (finalBlank.kind === "ambiguous") return finalBlank;
      if (finalBlank.kind !== "found" || finalBlank.notebook !== pinnedBlankWindow) return { kind: "missing" };
      return allowKernelRecovery
        ? { kind: "needsKernel", notebook: pinnedBlankWindow, retryAllowed: true }
        : { kind: "missing" };
    }
    return { kind: "missing" };
  }
}

export function waitForPinnedCellCompletion(
  origin: PythonCellOrigin,
  before: PreviousInteractiveCells,
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  operationDeadline: number
): Promise<PythonExecutedCellResult> {
  const completedCandidate = (): PythonExecutedCellResult | undefined => {
    if (!isUnchangedPythonOrigin(origin)) return { kind: "stale" };
    const candidate = newlyExecutedCell(origin, before);
    if (candidate.kind !== "found") return candidate;
    if (candidate.notebook !== notebook || candidate.cell !== cell) return { kind: "ambiguous" };
    const summary = cell.executionSummary;
    if (summary?.success === undefined && summary?.timing?.endTime === undefined) return undefined;
    return { kind: "found", notebook, cell };
  };

  const immediate = completedCandidate();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (result: PythonExecutedCellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
      resolve(result);
    };
    const check = (): void => {
      const result = completedCandidate();
      if (result) finish(result);
    };
    subscriptions.push(
      vscode.workspace.onDidOpenNotebookDocument(check),
      vscode.workspace.onDidChangeNotebookDocument(check),
      vscode.workspace.onDidCloseNotebookDocument(check)
    );
    const timeout = setTimeout(
      () => {
        if (!isUnchangedPythonOrigin(origin)) {
          finish({ kind: "stale" });
          return;
        }
        finish({ kind: "timedOut" });
      },
      Math.max(0, operationDeadline - Date.now())
    );
    check();
  });
}
