import { vi } from "vitest";
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
  registrationAttempt: 0,
  failRegistrationAttempt: undefined as number | undefined,
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
  const beginRegistration = (label: string): void => {
    mocks.registrationAttempt += 1;
    if (mocks.registrationAttempt === mocks.failRegistrationAttempt) {
      throw new Error(`notebook cell result registration failed at ${label}`);
    }
  };
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
        beginRegistration(id);
        mocks.commands.set(id, handler);
        return { dispose: () => mocks.commands.delete(id) };
      }
    },
    notebooks: {
      registerNotebookCellStatusBarItemProvider(notebookType: string, provider: NotebookCellStatusBarItemProvider) {
        beginRegistration(notebookType);
        const registration = { notebookType, provider };
        mocks.providers.push(registration);
        return {
          dispose: () => {
            const index = mocks.providers.indexOf(registration);
            if (index >= 0) mocks.providers.splice(index, 1);
          }
        };
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
        beginRegistration("onDidChangeNotebookDocument");
        mocks.notebookChanges.push(listener);
        return {
          dispose: () => {
            const index = mocks.notebookChanges.indexOf(listener);
            if (index >= 0) mocks.notebookChanges.splice(index, 1);
          }
        };
      },
      onDidCloseNotebookDocument(listener: (document: NotebookDocument) => void) {
        beginRegistration("onDidCloseNotebookDocument");
        mocks.notebookCloses.push(listener);
        return {
          dispose: () => {
            const index = mocks.notebookCloses.indexOf(listener);
            if (index >= 0) mocks.notebookCloses.splice(index, 1);
          }
        };
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

export function notebookCellResultApi(): {
  readonly NotebookCellResultTracker: typeof NotebookCellResultTracker;
  readonly notebookCellResultStatusItem: typeof notebookCellResultStatusItem;
  readonly registerNotebookCellResultAction: typeof registerNotebookCellResultAction;
  readonly OPEN_WRANGLER_MIME_V2: typeof OPEN_WRANGLER_MIME_V2;
} {
  return {
    NotebookCellResultTracker,
    notebookCellResultStatusItem,
    registerNotebookCellResultAction,
    OPEN_WRANGLER_MIME_V2
  };
}

export function notebookCellResultMocks(): typeof mocks {
  return mocks;
}

export function resetNotebookCellResultTest(): void {
  mocks.trusted = true;
  mocks.registrationAttempt = 0;
  mocks.failRegistrationAttempt = undefined;
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
}

export function coordinator(): SessionCoordinator {
  return { createBridge: mocks.createBridge } as unknown as SessionCoordinator;
}

export function trackerInternals(tracker: NotebookCellResultTracker): {
  readonly pendingCells: WeakMap<NotebookCell, unknown>;
  readonly notebookStates: WeakMap<NotebookDocument, { readonly trackedCells: Set<NotebookCell> }>;
} {
  return tracker as unknown as {
    readonly pendingCells: WeakMap<NotebookCell, unknown>;
    readonly notebookStates: WeakMap<NotebookDocument, { readonly trackedCells: Set<NotebookCell> }>;
  };
}

export function command(): CommandHandler {
  const registered = mocks.commands.get("openWrangler.openNotebookCellResult");
  if (!registered) throw new Error("Expected the cell result command to be registered.");
  return registered;
}

export async function trackedStatusItem(cell: NotebookCell, supported = true) {
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

export function recordExecution(cell: NotebookCell): void {
  const event = executionEvent(cell);
  for (const listener of mocks.notebookChanges) listener(event);
}

export async function recordExecutionAndWait(cell: NotebookCell): Promise<void> {
  const started = executionStartedEvent(cell);
  for (const listener of mocks.notebookChanges) listener(started);
  await settleInspection();
  recordExecution(cell);
  await settleInspection();
}

export async function settleInspection(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

export function executionEvent(cell: NotebookCell): unknown {
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

export function outputOnlyEvent(cell: NotebookCell): unknown {
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

export function executionStartedEvent(
  cell: NotebookCell,
  executionOrder = cell.executionSummary?.executionOrder
): unknown {
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

export function notebook(uri = "file:///notebook.ipynb"): NotebookDocument {
  const document = {
    uri: { toString: () => uri },
    notebookType: "jupyter-notebook",
    isClosed: false,
    getCells: () => []
  } as unknown as NotebookDocument;
  return document;
}

export function setCells(document: NotebookDocument, cells: readonly NotebookCell[]): void {
  Object.defineProperty(document, "getCells", { configurable: true, value: () => [...cells] });
}

export function codeCell(
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

export function output(
  text: string,
  mime = "text/plain",
  outputType = "execute_result"
): { items: Array<{ mime: string; data: Uint8Array }>; metadata: { outputType: string } } {
  return { items: [{ mime, data: new TextEncoder().encode(text) }], metadata: { outputType } };
}

export function testBinding() {
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

export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
