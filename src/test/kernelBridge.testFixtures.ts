import type { Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { vi } from "vitest";
import { KernelBridge } from "../extension/notebooks/kernelBridge";
import type { OpenSessionRequest, OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";

const HANG = Symbol("hang kernel request");
type TestBackend = NonNullable<OpenSessionRequest["backend"]>;

const initializedResponse: OpenWranglerResponse = {
  kind: "initialized",
  protocolVersion: 2,
  runtimeVersion: "test-runtime",
  capabilities: {
    editable: true,
    lazy: true,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: true
  }
};

function resetKernelBridgeTestState(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setOpenNotebookDocuments();
}

function openRequest(
  requestedSessionId?: string,
  backend: TestBackend = "polars"
): Extract<OpenWranglerRequest, { kind: "openSession" }> {
  return {
    kind: "openSession",
    source: { kind: "notebookVariable", label: "df", variableName: "df" },
    ...(requestedSessionId ? { requestedSessionId } : {}),
    backend,
    mode: "viewing",
    pageSize: 200,
    columnOffset: 0,
    columnLimit: 16
  };
}

function unpinnedOpenRequest(requestedSessionId?: string): Extract<OpenWranglerRequest, { kind: "openSession" }> {
  const { backend: _backend, ...request } = openRequest(requestedSessionId);
  return request;
}

function createKernelBridge(document?: vscode.NotebookDocument): KernelBridge {
  const exactDocument = document ?? notebookDocument();
  if (!document) setOpenNotebookDocuments(exactDocument);
  return new KernelBridge({ extensionPath: process.cwd() } as vscode.ExtensionContext, exactDocument);
}

function mockKernel(kernel: Kernel): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
    activate: async () => ({ kernels: { getKernel: async () => kernel } })
  } as never);
}

function resultBinding(kernel: Kernel, backend: "pandas" | "polars" | "duckdb" | "pyspark") {
  let valid = true;
  return {
    backend,
    kernel,
    onDidInvalidate: ((_listener: () => unknown) => ({ dispose: () => undefined })) as vscode.Event<void>,
    isValid: () => valid,
    dispose: () => {
      valid = false;
    }
  };
}

function fakeKernel(respond: (request: OpenWranglerRequest, requestId: string) => unknown | Promise<unknown>): Kernel {
  return controlledFakeKernel(respond).kernel;
}

interface ControllableKernel {
  readonly kernel: Kernel;
  executionTokens(): readonly vscode.CancellationToken[];
  setStatus(status: KernelStatus): void;
  statusListenerCount(): number;
  statusListenerDisposalCount(): number;
}

interface ControlledFakeKernel extends ControllableKernel {
  bootstrapExecutionCount(): number;
}

interface ControlledPySparkKernel extends ControllableKernel {
  preflightExecutionCount(): number;
}

function controlledFakeKernel(
  respond: (request: OpenWranglerRequest, requestId: string) => unknown | Promise<unknown>
): ControlledFakeKernel {
  let bootstrapExecutions = 0;
  const controller = controllableKernel((code) => {
    if (code.includes("__OPEN_WRANGLER_PYSPARK_VERSION_START_")) {
      return pySparkPreflightExecution(code, true, "4.2.0");
    }
    if (!code.includes("__ow_payload =")) bootstrapExecutions += 1;
    return kernelExecution(code, respond);
  });
  return {
    ...controller,
    bootstrapExecutionCount: () => bootstrapExecutions
  };
}

function controlledPySparkKernel(
  version: string | null,
  requests: OpenWranglerRequest[],
  onPreflight: () => void = () => undefined
): ControlledPySparkKernel {
  let preflightExecutions = 0;
  const controller = controllableKernel((code) => {
    if (code.includes("__OPEN_WRANGLER_PYSPARK_VERSION_START_")) {
      preflightExecutions += 1;
      onPreflight();
      return pySparkPreflightExecution(code, true, version);
    }
    return kernelExecution(code, (request) => {
      requests.push(request);
      if (request.kind === "openSession") {
        return openedResponse(request.requestedSessionId!, "pyspark");
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
  });
  return { ...controller, preflightExecutionCount: () => preflightExecutions };
}

function controlledNonPySparkKernel(
  backend: Exclude<TestBackend, "pyspark">,
  requests: OpenWranglerRequest[],
  onPreflight: () => void = () => undefined
): ControlledPySparkKernel {
  let preflightExecutions = 0;
  const controller = controllableKernel((code) => {
    if (code.includes("__OPEN_WRANGLER_PYSPARK_VERSION_START_")) {
      preflightExecutions += 1;
      onPreflight();
      return pySparkPreflightExecution(code, false, null);
    }
    return kernelExecution(code, (request) => {
      requests.push(request);
      if (request.kind === "openSession") {
        return openedResponse(request.requestedSessionId!, backend);
      }
      return initializedResponse;
    });
  });
  return { ...controller, preflightExecutionCount: () => preflightExecutions };
}

function controllableKernel(
  executeCode: (code: string, token: vscode.CancellationToken) => AsyncIterable<unknown>
): ControllableKernel {
  let status: KernelStatus = "idle";
  let listenerDisposals = 0;
  const listeners = new Set<(status: KernelStatus) => unknown>();
  const executionTokens: vscode.CancellationToken[] = [];
  const kernel = {
    get status(): KernelStatus {
      return status;
    },
    language: "python",
    onDidChangeStatus(listener: (nextStatus: KernelStatus) => unknown) {
      listeners.add(listener);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (listeners.delete(listener)) listenerDisposals += 1;
        }
      };
    },
    executeCode(code: string, token: vscode.CancellationToken) {
      executionTokens.push(token);
      return executeCode(code, token);
    }
  } as unknown as Kernel;
  return {
    kernel,
    executionTokens: () => executionTokens,
    setStatus(nextStatus) {
      status = nextStatus;
      for (const listener of [...listeners]) listener(nextStatus);
    },
    statusListenerCount: () => listeners.size,
    statusListenerDisposalCount: () => listenerDisposals
  };
}

async function* kernelExecution(
  code: string,
  respond: (request: OpenWranglerRequest, requestId: string) => unknown | Promise<unknown>
): AsyncIterable<unknown> {
  const markerMatch = code.match(/__OPEN_WRANGLER_START_([A-Za-z0-9]+)__/);
  if (!markerMatch) return;
  const payloadMatch = code.match(/__ow_payload = __ow_base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/);
  if (!payloadMatch) throw new Error("Kernel test request did not contain an encoded protocol payload.");
  const envelope = JSON.parse(Buffer.from(payloadMatch[1], "base64").toString("utf8")) as {
    protocolVersion: 2;
    requestId: string;
    request: OpenWranglerRequest;
  };
  const response = await respond(envelope.request, envelope.requestId);
  if (response === HANG) {
    await new Promise<never>(() => undefined);
  }
  yield {
    text: [
      `__OPEN_WRANGLER_START_${markerMatch[1]}__`,
      JSON.stringify({ protocolVersion: 2, requestId: envelope.requestId, response }),
      `__OPEN_WRANGLER_END_${markerMatch[1]}__`
    ].join("\n")
  };
}

async function* pySparkPreflightExecution(
  code: string,
  isPySpark: boolean,
  version: string | null
): AsyncIterable<unknown> {
  const marker = code.match(/__OPEN_WRANGLER_PYSPARK_VERSION_START_([a-f0-9]{32})__/)?.[1];
  if (!marker) throw new Error("Kernel test preflight did not contain a response marker.");
  yield {
    text: [
      `__OPEN_WRANGLER_PYSPARK_VERSION_START_${marker}__`,
      JSON.stringify({ isPySpark, protocolVersion: 1, version }),
      `__OPEN_WRANGLER_PYSPARK_VERSION_END_${marker}__`
    ].join("\n")
  };
}

async function* malformedPySparkPreflightExecution(code: string): AsyncIterable<unknown> {
  const marker = code.match(/__OPEN_WRANGLER_PYSPARK_VERSION_START_([a-f0-9]{32})__/)?.[1];
  if (!marker) throw new Error("Kernel test preflight did not contain a response marker.");
  yield {
    text: [
      `__OPEN_WRANGLER_PYSPARK_VERSION_START_${marker}__`,
      '{"isPySpark":true,"protocolVersion":1,"version":',
      `__OPEN_WRANGLER_PYSPARK_VERSION_END_${marker}__`
    ].join("\n")
  };
}

async function* emptyKernelExecution(): AsyncIterable<unknown> {
  yield* [];
}

async function* textKernelExecution(text: string): AsyncIterable<unknown> {
  yield { text };
}

function initializeRequest(): OpenWranglerRequest {
  return { kind: "initialize" };
}

function closeRequest(sessionId: string): OpenWranglerRequest {
  return { kind: "closeSession", sessionId, revision: 0 };
}

function notebookDocument(path = "/workspace/notebook.ipynb"): vscode.NotebookDocument {
  return {
    uri: vscode.Uri.file(path),
    isClosed: false
  } as unknown as vscode.NotebookDocument;
}

function closeNotebook(document: vscode.NotebookDocument): void {
  (document as unknown as { isClosed: boolean }).isClosed = true;
  setOpenNotebookDocuments();
}

function setOpenNotebookDocuments(...documents: vscode.NotebookDocument[]): void {
  Object.defineProperty(vscode.workspace, "notebookDocuments", {
    configurable: true,
    value: documents
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cancellationSource(): {
  token: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
  };
  cancel(): void;
} {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener: () => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    },
    cancel() {
      cancelled = true;
      for (const listener of listeners) listener();
    }
  };
}

function openedResponse(sessionId: string, backend: TestBackend = "polars"): OpenWranglerResponse {
  return {
    kind: "sessionOpened",
    metadata: {
      protocolVersion: 2,
      sessionId,
      revision: 0,
      backend,
      mode: "viewing",
      source: { kind: "notebookVariable", label: "df", variableName: "df" },
      capabilities: {
        editable: true,
        lazy: true,
        cancel: false,
        exportCsv: true,
        exportParquet: true,
        notebookInsert: true
      },
      shape: { rows: 0, columns: 0 },
      filteredShape: { rows: 0, columns: 0 },
      schema: [],
      ...(backend === "pandas" ? { rowAxis: { kind: "positional" as const, levelNames: [] } } : {}),
      filterModel: { logic: "and", filters: [], sort: [] },
      steps: []
    },
    page: { offset: 0, limit: 200, totalRows: 0, columnIds: [], rows: [] },
    summaries: []
  };
}

export {
  HANG,
  cancellationSource,
  closeNotebook,
  closeRequest,
  controllableKernel,
  controlledFakeKernel,
  controlledNonPySparkKernel,
  controlledPySparkKernel,
  createKernelBridge,
  deferred,
  emptyKernelExecution,
  fakeKernel,
  initializeRequest,
  initializedResponse,
  kernelExecution,
  malformedPySparkPreflightExecution,
  mockKernel,
  notebookDocument,
  openedResponse,
  openRequest,
  resetKernelBridgeTestState,
  resultBinding,
  setOpenNotebookDocuments,
  textKernelExecution,
  unpinnedOpenRequest
};
