import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionContext,
  NotebookCell,
  NotebookCellStatusBarItemProvider,
  NotebookDocument,
  NotebookEditor
} from "vscode";
import type { SessionCoordinator } from "../extension/sessionCoordinator";

type CommandHandler = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  trusted: true,
  commands: new Map<string, CommandHandler>(),
  providers: [] as Array<{ notebookType: string; provider: NotebookCellStatusBarItemProvider }>,
  notebookDocuments: [] as NotebookDocument[],
  visibleEditors: [] as NotebookEditor[],
  warning: vi.fn(async () => undefined),
  createPanel: vi.fn(),
  createBridge: vi.fn((bridge: unknown) => bridge),
  capture: vi.fn(async () => ({
    backend: "pandas" as const,
    label: "DataFrame",
    variableName: "__openwrangler_live_result_0123456789abcdef0123456789abcdef"
  })),
  observe: vi.fn(),
  inspect: vi.fn(),
  kernelCurrent: vi.fn(async () => true),
  bindings: [] as Array<ReturnType<typeof testBinding>>,
  disposed: 0,
  bridgeDocuments: [] as NotebookDocument[],
  notebookChanges: [] as Array<(event: unknown) => void>,
  notebookCloses: [] as Array<(document: NotebookDocument) => void>
}));

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  class NotebookCellStatusBarItem {
    command?: unknown;
    tooltip?: string;
    accessibilityInformation?: unknown;
    priority?: number;
    constructor(
      readonly text: string,
      readonly alignment: number
    ) {}
  }
  return {
    EventEmitter,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarAlignment: { Left: 1, Right: 2 },
    NotebookCellKind: { Markup: 1, Code: 2 },
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand(id: string, handler: CommandHandler) {
        mocks.commands.set(id, handler);
        return { dispose: () => undefined };
      }
    },
    notebooks: {
      registerNotebookCellStatusBarItemProvider(notebookType: string, provider: NotebookCellStatusBarItemProvider) {
        mocks.providers.push({ notebookType, provider });
        return { dispose: () => undefined };
      }
    },
    workspace: {
      get isTrusted() {
        return mocks.trusted;
      },
      get notebookDocuments() {
        return mocks.notebookDocuments;
      },
      onDidChangeNotebookDocument(listener: (event: unknown) => void) {
        mocks.notebookChanges.push(listener);
        return { dispose: () => undefined };
      },
      onDidCloseNotebookDocument(listener: (document: NotebookDocument) => void) {
        mocks.notebookCloses.push(listener);
        return { dispose: () => undefined };
      }
    },
    window: {
      get visibleNotebookEditors() {
        return mocks.visibleEditors;
      },
      showWarningMessage: mocks.warning,
      withProgress: async (_options: unknown, task: () => Promise<unknown>) => task()
    }
  };
});

vi.mock("../extension/notebooks/kernelBridge", () => ({
  shouldRegisterNotebookFormatters: () => true,
  fingerprintNotebookCellSource: (source: string) => (source === "frame" ? "a" : "b").repeat(64),
  observeExecutedNotebookCellResultKernel: mocks.observe,
  inspectExecutedNotebookCellResult: mocks.inspect,
  isExecutedNotebookCellResultKernelCurrent: mocks.kernelCurrent,
  KernelBridge: class {
    constructor(_context: ExtensionContext, document: NotebookDocument) {
      mocks.bridgeDocuments.push(document);
    }
    captureExecutedCellResult = mocks.capture;
    dispose(): void {
      mocks.disposed += 1;
    }
  }
}));

vi.mock("../extension/webviewPanel", () => ({ OpenWranglerPanel: { create: mocks.createPanel } }));

import {
  NotebookCellResultTracker,
  notebookCellResultStatusItem,
  registerNotebookCellResultAction
} from "../extension/notebooks/notebookCellResult";
import { OPEN_WRANGLER_MIME_V2 } from "../shared/notebookOutput";

describe("executed notebook cell result action", () => {
  beforeEach(() => {
    mocks.trusted = true;
    mocks.commands.clear();
    mocks.providers.length = 0;
    mocks.notebookDocuments.length = 0;
    mocks.visibleEditors.length = 0;
    mocks.warning.mockClear();
    mocks.createPanel.mockReset();
    mocks.createBridge.mockClear();
    mocks.capture.mockReset();
    mocks.capture.mockResolvedValue({
      backend: "pandas",
      label: "DataFrame",
      variableName: "__openwrangler_live_result_0123456789abcdef0123456789abcdef"
    });
    mocks.observe.mockReset();
    mocks.observe.mockImplementation(async () => {
      const binding = testBinding();
      mocks.bindings.push(binding);
      return binding;
    });
    mocks.inspect.mockReset();
    mocks.inspect.mockImplementation(async (_document, _executionOrder, _fingerprint, binding) => binding);
    mocks.kernelCurrent.mockReset();
    mocks.kernelCurrent.mockResolvedValue(true);
    mocks.bindings.length = 0;
    mocks.disposed = 0;
    mocks.bridgeDocuments.length = 0;
    mocks.notebookChanges.length = 0;
    mocks.notebookCloses.length = 0;
  });

  it("offers one action only for a supported execute_result observed in this extension session", async () => {
    const document = notebook();
    const cell = codeCell(document, 4);

    expect(notebookCellResultStatusItem(cell, new NotebookCellResultTracker())).toBeUndefined();
    const item = await trackedStatusItem(cell);

    expect(item?.text).toBe("$(open-preview) Open in Open Wrangler");
    expect(item?.command).toMatchObject({
      command: "openWrangler.openNotebookCellResult",
      arguments: [cell]
    });
    expect(await trackedStatusItem(codeCell(document, 4, [output("{}", OPEN_WRANGLER_MIME_V2)]))).toBeUndefined();
    expect(await trackedStatusItem(codeCell(document, 0))).toBeUndefined();
    expect(await trackedStatusItem(codeCell(document, 4, [], "r"))).toBeUndefined();
    expect(await trackedStatusItem(codeCell(document, 4, [output("42")]), false)).toBeUndefined();
    expect(
      await trackedStatusItem(codeCell(document, 4, [output("<div>hello</div>", "text/html")]), false)
    ).toBeUndefined();
    expect(
      await trackedStatusItem(
        codeCell(document, 4, [output("<table><tr><td>styled</td></tr></table>", "text/html")]),
        false
      )
    ).toBeUndefined();
    expect(
      await trackedStatusItem(
        codeCell(document, 4, [output("<table><tr><td>1</td></tr></table>", "text/html", "display_data")])
      )
    ).toBeUndefined();
    expect(
      await trackedStatusItem(codeCell(document, 4, [output("printed polars table", "text/plain", "stream")]))
    ).toBeUndefined();
    expect(await trackedStatusItem(codeCell(document, 4, [output("DataFrame[id: bigint]")]))).toBeDefined();
  });

  it("publishes an eligible status item without waiting for another kernel lookup", async () => {
    const document = notebook("file:///synchronous-status-item.ipynb");
    const cell = codeCell(document, 4);
    setCells(document, [cell]);
    const tracker = new NotebookCellResultTracker();
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator(), tracker);
    await recordExecutionAndWait(cell);
    mocks.kernelCurrent.mockImplementation(() => new Promise<boolean>(() => undefined));

    const provided = mocks.providers[0]?.provider.provideCellStatusBarItems(cell, {} as never);

    expect(provided).toMatchObject({ text: "$(open-preview) Open in Open Wrangler" });
    expect(provided).not.toBeInstanceOf(Promise);
    expect(mocks.kernelCurrent).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it("opens the exact executed result without consulting another active notebook", async () => {
    const document = notebook("file:///origin.ipynb");
    const cell = codeCell(document, 8);
    setCells(document, [cell]);
    const originEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(originEditor);
    const context = { subscriptions: [] } as unknown as ExtensionContext;
    registerNotebookCellResultAction(context, coordinator());
    await recordExecutionAndWait(cell);

    await command()(cell);

    expect(mocks.bridgeDocuments).toEqual([document]);
    expect(mocks.capture).toHaveBeenCalledWith(8, "a".repeat(64), mocks.bindings[0]);
    expect(mocks.createBridge).toHaveBeenCalledWith(expect.anything(), document);
    expect(mocks.createPanel).toHaveBeenCalledWith(
      context,
      expect.anything(),
      {
        kind: "notebookVariable",
        label: "DataFrame",
        variableName: "__openwrangler_live_result_0123456789abcdef0123456789abcdef",
        uri: "file:///origin.ipynb"
      },
      "pandas"
    );
    expect(mocks.disposed).toBe(0);
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

  it("rejects an edited cell instead of using its old execution result", async () => {
    const document = notebook();
    const cell = codeCell(document, 2);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);
    (cell.document as unknown as { text: string }).text = "replacement";

    await command()(cell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });

  it("fails closed when the same notebook is visible in more than one editor", async () => {
    const document = notebook();
    const cell = codeCell(document, 2);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor, { notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);

    await command()(cell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });
});

function coordinator(): SessionCoordinator {
  return { createBridge: mocks.createBridge } as unknown as SessionCoordinator;
}

function command(): CommandHandler {
  const registered = mocks.commands.get("openWrangler.openNotebookCellResult");
  if (!registered) throw new Error("Expected the cell result command to be registered.");
  return registered;
}

async function trackedStatusItem(cell: NotebookCell, supported = true) {
  if (!supported) mocks.inspect.mockResolvedValueOnce(undefined);
  const tracker = new NotebookCellResultTracker();
  tracker.start();
  tracker.recordDocumentChange(executionStartedEvent(cell) as never);
  await settleInspection();
  tracker.recordDocumentChange(executionEvent(cell) as never);
  await settleInspection();
  const item = notebookCellResultStatusItem(cell, tracker);
  tracker.dispose();
  return item;
}

function recordExecution(cell: NotebookCell): void {
  const event = executionEvent(cell);
  for (const listener of mocks.notebookChanges) listener(event);
}

async function recordExecutionAndWait(cell: NotebookCell): Promise<void> {
  const started = executionStartedEvent(cell);
  for (const listener of mocks.notebookChanges) listener(started);
  await settleInspection();
  recordExecution(cell);
  await settleInspection();
}

async function settleInspection(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function executionEvent(cell: NotebookCell): unknown {
  return {
    notebook: cell.notebook,
    metadata: undefined,
    contentChanges: [],
    cellChanges: [
      {
        cell,
        document: undefined,
        metadata: undefined,
        outputs: cell.outputs,
        executionSummary: cell.executionSummary
      }
    ]
  };
}

function outputOnlyEvent(cell: NotebookCell): unknown {
  return {
    notebook: cell.notebook,
    metadata: undefined,
    contentChanges: [],
    cellChanges: [
      {
        cell,
        document: undefined,
        metadata: undefined,
        outputs: cell.outputs,
        executionSummary: undefined
      }
    ]
  };
}

function executionStartedEvent(cell: NotebookCell, executionOrder = cell.executionSummary?.executionOrder): unknown {
  return {
    notebook: cell.notebook,
    metadata: undefined,
    contentChanges: [],
    cellChanges: [
      {
        cell,
        document: undefined,
        metadata: undefined,
        outputs: undefined,
        executionSummary: {
          executionOrder,
          success: undefined
        }
      }
    ]
  };
}

function notebook(uri = "file:///notebook.ipynb"): NotebookDocument {
  const document = {
    uri: { toString: () => uri },
    notebookType: "jupyter-notebook",
    isClosed: false,
    getCells: () => []
  } as unknown as NotebookDocument;
  return document;
}

function setCells(document: NotebookDocument, cells: readonly NotebookCell[]): void {
  Object.defineProperty(document, "getCells", { configurable: true, value: () => [...cells] });
}

function codeCell(
  notebookDocument: NotebookDocument,
  executionOrder: number,
  outputs: Array<{ items: Array<{ mime: string; data: Uint8Array }>; metadata?: Record<string, unknown> }> = [
    output("┌─────┐\n│ x   │\n├─────┤\n│ 1   │\n└─────┘")
  ],
  languageId = "python"
): NotebookCell {
  const source = { text: "frame", getText: () => source.text, languageId };
  return {
    notebook: notebookDocument,
    kind: 2,
    document: source,
    executionSummary: { executionOrder, success: true },
    outputs
  } as unknown as NotebookCell;
}

function output(
  text: string,
  mime = "text/plain",
  outputType = "execute_result"
): { items: Array<{ mime: string; data: Uint8Array }>; metadata: { outputType: string } } {
  return { items: [{ mime, data: new TextEncoder().encode(text) }], metadata: { outputType } };
}

function testBinding() {
  let valid = true;
  const listeners = new Set<() => void>();
  return {
    backend: "pandas" as const,
    kernel: { id: "kernel" },
    onDidInvalidate(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    isValid: () => valid,
    isGenerationValid: () => valid,
    invalidate() {
      if (!valid) return;
      valid = false;
      for (const listener of listeners) listener();
    },
    dispose() {
      valid = false;
      listeners.clear();
    }
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
