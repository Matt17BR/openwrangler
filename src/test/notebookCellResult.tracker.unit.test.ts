import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, NotebookEditor } from "vscode";
import {
  notebookCellResultMocks,
  notebookCellResultApi,
  resetNotebookCellResultTest,
  coordinator,
  trackerInternals,
  command,
  recordExecution,
  recordExecutionAndWait,
  settleInspection,
  executionEvent,
  outputOnlyEvent,
  executionStartedEvent,
  notebook,
  setCells,
  codeCell,
  output,
  testBinding,
  deferred
} from "./notebookCellResult.testSupport";

const mocks = notebookCellResultMocks();
const { NotebookCellResultTracker, notebookCellResultStatusItem, registerNotebookCellResultAction } =
  notebookCellResultApi();

describe("executed notebook cell result tracker", () => {
  beforeEach(() => {
    resetNotebookCellResultTest();
  });

  it("retains a first dataframe execution that finishes before commands and providers register", async () => {
    const document = notebook("file:///cold-start.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    await recordExecutionAndWait(cell);
    expect(mocks.providers).toHaveLength(0);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator(), tracker);

    expect(mocks.notebookChanges).toHaveLength(1);
    expect(mocks.notebookCloses).toHaveLength(1);
    expect(mocks.providers[0]?.provider.provideCellStatusBarItems(cell, {} as never)).toBeDefined();
    await command()(cell);
    expect(mocks.capture).toHaveBeenCalledWith(1, "a".repeat(64), mocks.bindings[0]);
    expect(mocks.createPanel).toHaveBeenCalledOnce();
  });

  it("observes the first result when execution summary and output arrive in separate events", async () => {
    const document = notebook("file:///split-events.ipynb");
    const cell = codeCell(document, 1, []);
    setCells(document, [cell]);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell) as never);
    await settleInspection();

    tracker.recordDocumentChange({
      notebook: document,
      metadata: undefined,
      contentChanges: [],
      cellChanges: [{ cell, executionSummary: cell.executionSummary }]
    } as never);
    expect(mocks.inspect).not.toHaveBeenCalled();

    Object.defineProperty(cell, "outputs", { configurable: true, value: [output("DataFrame[id: bigint]")] });
    tracker.recordDocumentChange({
      notebook: document,
      metadata: undefined,
      contentChanges: [],
      cellChanges: [{ cell, outputs: cell.outputs }]
    } as never);
    await settleInspection();

    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), mocks.bindings[0]);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("rechecks the selected kernel when it was not available at execution start", async () => {
    const previous = process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    const gatedTracker = new NotebookCellResultTracker();
    expect(gatedTracker.diagnosticsForTesting()).toBeUndefined();
    gatedTracker.dispose();
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    const document = notebook("file:///late-selected-kernel.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockResolvedValueOnce(undefined).mockResolvedValueOnce(binding);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    try {
      tracker.recordDocumentChange(executionStartedEvent(cell) as never);
      await settleInspection();
      tracker.recordDocumentChange(executionEvent(cell) as never);
      await settleInspection();

      expect(mocks.observe).toHaveBeenCalledTimes(2);
      expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), binding);
      expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
      const diagnostic = tracker.diagnosticsForTesting();
      expect(Object.isFrozen(diagnostic)).toBe(true);
      expect(diagnostic).toEqual({
        stage: "eligible",
        statusItem: "offered",
        reason: undefined
      });
    } finally {
      tracker.dispose();
      if (previous === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      else process.env.OPEN_WRANGLER_EXTENSION_TESTS = previous;
    }
  });

  it("reports a bounded completion-kernel error without exposing its message", async () => {
    const previous = process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    const document = notebook("file:///completion-kernel-error.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    mocks.observe.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("private kernel failure details"));
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    try {
      tracker.recordDocumentChange(executionStartedEvent(cell) as never);
      await settleInspection();
      tracker.recordDocumentChange(executionEvent(cell) as never);
      await settleInspection();

      const diagnostic = tracker.diagnosticsForTesting();
      expect(diagnostic).toMatchObject({
        stage: "rejected",
        statusItem: "not-requested",
        reason: "completion-kernel-error"
      });
      expect(JSON.stringify(diagnostic)).not.toContain("private kernel failure details");
    } finally {
      tracker.dispose();
      if (previous === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      else process.env.OPEN_WRANGLER_EXTENSION_TESTS = previous;
    }
  });

  it("checks the selected kernel when the first observed event already contains the result", async () => {
    const document = notebook("file:///completion-only-first-result.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockResolvedValueOnce(binding);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), binding);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("falls back after a hung execution-start lookup and disposes its late binding", async () => {
    vi.useFakeTimers();
    try {
      const document = notebook("file:///hung-execution-start.ipynb");
      const cell = codeCell(document, 1);
      setCells(document, [cell]);
      const initial = deferred<ReturnType<typeof testBinding> | undefined>();
      const lateBinding = testBinding();
      const fallbackBinding = testBinding();
      mocks.observe.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(fallbackBinding);
      const tracker = new NotebookCellResultTracker();
      tracker.start();

      tracker.recordDocumentChange(executionStartedEvent(cell) as never);
      tracker.recordDocumentChange(executionEvent(cell) as never);
      await settleInspection();
      expect(mocks.observe).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_000);
      await settleInspection();

      expect(mocks.observe).toHaveBeenCalledTimes(2);
      expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), fallbackBinding);
      expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();

      initial.resolve(lateBinding);
      await settleInspection();
      expect(lateBinding.isGenerationValid()).toBe(false);
      expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a completion-time kernel lookup after a newer execution starts", async () => {
    const document = notebook("file:///superseded-completion-lookup.ipynb");
    const firstCell = codeCell(document, 1);
    const newerCell = codeCell(document, 2);
    setCells(document, [firstCell, newerCell]);
    const lateObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const lateBinding = testBinding();
    mocks.observe.mockResolvedValueOnce(undefined).mockReturnValueOnce(lateObservation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(firstCell) as never);
    await settleInspection();
    tracker.recordDocumentChange(executionEvent(firstCell) as never);
    await settleInspection();
    expect(mocks.observe).toHaveBeenCalledTimes(2);

    tracker.recordDocumentChange(executionStartedEvent(newerCell) as never);
    lateObservation.resolve(lateBinding);
    await settleInspection();

    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(lateBinding.isGenerationValid()).toBe(false);
    expect(notebookCellResultStatusItem(firstCell, tracker)).toBeUndefined();
    tracker.dispose();
  });

  it("removes a superseded pending inspection while retaining the newer cell", async () => {
    const document = notebook("file:///superseded-pending-inspection.ipynb");
    const firstCell = codeCell(document, 1);
    const newerCell = codeCell(document, 2);
    setCells(document, [firstCell, newerCell]);
    const firstObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const newerObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const firstBinding = testBinding();
    const newerBinding = testBinding();
    mocks.observe.mockReturnValueOnce(firstObservation.promise).mockReturnValueOnce(newerObservation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(firstCell) as never);
    tracker.recordDocumentChange(executionEvent(firstCell) as never);
    tracker.recordDocumentChange(executionStartedEvent(newerCell) as never);
    firstObservation.resolve(firstBinding);
    await settleInspection();

    const internals = trackerInternals(tracker);
    const state = internals.notebookStates.get(document);
    expect(internals.pendingCells.has(firstCell)).toBe(false);
    expect(state?.trackedCells.has(firstCell)).toBe(false);
    expect(state?.trackedCells.has(newerCell)).toBe(true);
    expect(firstBinding.isGenerationValid()).toBe(false);

    tracker.dispose();
    newerObservation.resolve(newerBinding);
    await settleInspection();
    expect(newerBinding.isGenerationValid()).toBe(false);
  });

  it("does not let a late superseded inspection delete its replacement", async () => {
    const document = notebook("file:///replacement-pending-inspection.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const firstObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const replacementObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const firstBinding = testBinding();
    const replacementBinding = testBinding();
    mocks.observe.mockReturnValueOnce(firstObservation.promise).mockReturnValueOnce(replacementObservation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell, 1) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    Object.defineProperty(cell, "executionSummary", {
      configurable: true,
      value: { executionOrder: 2, success: true }
    });
    tracker.recordDocumentChange(executionStartedEvent(cell, 2) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    const internals = trackerInternals(tracker);
    const replacement = internals.pendingCells.get(cell);
    expect(replacement).toBeDefined();

    firstObservation.resolve(firstBinding);
    await settleInspection();

    expect(firstBinding.isGenerationValid()).toBe(false);
    expect(internals.pendingCells.get(cell)).toBe(replacement);

    replacementObservation.resolve(replacementBinding);
    await settleInspection();
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("recognizes an execute_result output when Jupyter leaves success unspecified", async () => {
    const document = notebook("file:///unspecified-success.ipynb");
    const cell = codeCell(document, 1);
    Object.defineProperty(cell, "executionSummary", {
      configurable: true,
      value: { executionOrder: 1, success: undefined }
    });
    setCells(document, [cell]);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell, 1) as never);
    await settleInspection();
    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();

    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), mocks.bindings[0]);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("retains an in-flight kernel observation when a fast first result completes", async () => {
    const document = notebook("file:///fast-first-result.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const observation = deferred<ReturnType<typeof testBinding> | undefined>();
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockReturnValueOnce(observation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();
    expect(mocks.inspect).not.toHaveBeenCalled();

    observation.resolve(binding);
    await settleInspection();

    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), binding);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("treats repeated completion events for the same execution as one result", async () => {
    const document = notebook("file:///repeated-completion.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const observation = deferred<ReturnType<typeof testBinding> | undefined>();
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockReturnValueOnce(observation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    observation.resolve(binding);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();

    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("ignores a delayed older completion after publishing a newer result", async () => {
    const document = notebook("file:///delayed-older-completion.ipynb");
    const olderCell = codeCell(document, 1);
    const currentCell = codeCell(document, 3);
    setCells(document, [olderCell, currentCell]);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(currentCell) as never);
    tracker.recordDocumentChange(executionEvent(currentCell) as never);
    await settleInspection();
    expect(notebookCellResultStatusItem(currentCell, tracker)).toBeDefined();

    tracker.recordDocumentChange(executionEvent(olderCell) as never);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(notebookCellResultStatusItem(currentCell, tracker)).toBeDefined();
    expect(notebookCellResultStatusItem(olderCell, tracker)).toBeUndefined();
    tracker.dispose();
  });

  it("keeps the consent-bound observation across repeated in-progress summaries", async () => {
    const document = notebook("file:///repeated-progress.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const observation = deferred<ReturnType<typeof testBinding> | undefined>();
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockReturnValueOnce(observation.promise).mockResolvedValueOnce(undefined);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell, undefined) as never);
    tracker.recordDocumentChange(executionStartedEvent(cell, 1) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    observation.resolve(binding);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), binding);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("restarts the pending observation when the concrete execution order changes", async () => {
    const document = notebook("file:///changed-execution.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const firstObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const firstBinding = testBinding();
    const secondBinding = testBinding();
    mocks.observe.mockReturnValueOnce(firstObservation.promise).mockResolvedValueOnce(secondBinding);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell, 1) as never);
    tracker.recordDocumentChange(executionStartedEvent(cell, 2) as never);
    Object.defineProperty(cell, "executionSummary", {
      configurable: true,
      value: { executionOrder: 2, success: true }
    });
    tracker.recordDocumentChange(executionEvent(cell) as never);
    firstObservation.resolve(firstBinding);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledTimes(2);
    expect(firstBinding.isGenerationValid()).toBe(false);
    expect(mocks.inspect).toHaveBeenCalledWith(document, 2, "a".repeat(64), secondBinding);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("retires a kernel observation when a successful cell produces no output", async () => {
    vi.useFakeTimers();
    try {
      const document = notebook("file:///silent-cell.ipynb");
      const cell = codeCell(document, 1, []);
      const tracker = new NotebookCellResultTracker();
      tracker.start();

      tracker.recordDocumentChange(executionStartedEvent(cell) as never);
      await settleInspection();
      tracker.recordDocumentChange(executionEvent(cell) as never);
      await settleInspection();
      expect(mocks.bindings[0]?.isGenerationValid()).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(mocks.bindings[0]?.isGenerationValid()).toBe(false);
      expect(mocks.inspect).not.toHaveBeenCalled();
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a cell rerun while the exact result lookup is pending", async () => {
    const document = notebook();
    const cell = codeCell(document, 3);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    const gate = deferred<{
      backend: "pandas";
      label: string;
      variableName: string;
    }>();
    mocks.capture.mockReturnValue(gate.promise);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);

    const opening = command()(cell);
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    Object.defineProperty(cell, "executionSummary", {
      configurable: true,
      value: { executionOrder: 4, success: true }
    });
    recordExecution(cell);
    gate.resolve({ backend: "pandas", label: "DataFrame", variableName: "frame" });
    await opening;

    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.disposed).toBe(1);
    expect(mocks.warning).toHaveBeenCalledWith(
      "The notebook cell or selected kernel changed while Open Wrangler was opening its result. Try again."
    );
  });

  it("rejects a second visible split opened while the result lookup is pending", async () => {
    const document = notebook();
    const cell = codeCell(document, 3);
    setCells(document, [cell]);
    const originEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(originEditor);
    const gate = deferred<{
      backend: "pandas";
      label: string;
      variableName: string;
    }>();
    mocks.capture.mockReturnValue(gate.promise);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);

    const opening = command()(cell);
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    gate.resolve({ backend: "pandas", label: "DataFrame", variableName: "frame" });
    await opening;

    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.disposed).toBe(1);
    expect(mocks.warning).toHaveBeenCalledWith(
      "The notebook cell or selected kernel changed while Open Wrangler was opening its result. Try again."
    );
  });

  it("does not retarget an observed result after the selected kernel changes", async () => {
    const document = notebook();
    const cell = codeCell(document, 5);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);
    mocks.kernelCurrent.mockResolvedValue(false);

    await command()(cell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });

  it("removes the action as soon as the observed kernel generation restarts", async () => {
    const document = notebook();
    const cell = codeCell(document, 5);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    tracker.recordDocumentChange(executionStartedEvent(cell) as never);
    await settleInspection();
    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();

    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    mocks.bindings[0]?.invalidate();

    expect(notebookCellResultStatusItem(cell, tracker)).toBeUndefined();
    tracker.dispose();
  });

  it("does not access a replacement or duplicate notebook document", async () => {
    const document = notebook();
    const replacement = notebook();
    const cell = codeCell(document, 2);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document, replacement);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);

    await command()(cell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });

  it("invalidates older cells when the observed execution count restarts", async () => {
    const document = notebook();
    const oldCell = codeCell(document, 7);
    const newCell = codeCell(document, 1);
    setCells(document, [oldCell, newCell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(oldCell);
    expect(mocks.providers[0]?.provider.provideCellStatusBarItems(oldCell, {} as never)).toBeDefined();

    await recordExecutionAndWait(newCell);
    expect(mocks.providers[0]?.provider.provideCellStatusBarItems(newCell, {} as never)).toBeDefined();
    await command()(oldCell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });

  it("tracks execution-order resets from output-only completion events", async () => {
    const document = notebook("file:///output-only-reset.ipynb");
    const oldCell = codeCell(document, 7);
    const newCell = codeCell(document, 1);
    for (const cell of [oldCell, newCell]) {
      Object.defineProperty(cell, "executionSummary", {
        configurable: true,
        value: { executionOrder: cell.executionSummary?.executionOrder, success: undefined }
      });
    }
    setCells(document, [oldCell, newCell]);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(oldCell, 7) as never);
    tracker.recordDocumentChange(outputOnlyEvent(oldCell) as never);
    await settleInspection();
    expect(notebookCellResultStatusItem(oldCell, tracker)).toBeDefined();

    tracker.recordDocumentChange(executionStartedEvent(newCell, 1) as never);
    expect(notebookCellResultStatusItem(oldCell, tracker)).toBeUndefined();
    tracker.recordDocumentChange(outputOnlyEvent(newCell) as never);
    await settleInspection();

    expect(notebookCellResultStatusItem(newCell, tracker)).toBeDefined();
    expect(notebookCellResultStatusItem(oldCell, tracker)).toBeUndefined();
    tracker.dispose();
  });
});
