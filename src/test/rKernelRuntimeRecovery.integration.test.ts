import type { Jupyter, Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RKernelBridge } from "../extension/r/rKernelBridge";
import {
  discoverRNotebookVariables,
  verifyRNotebookVariableSelection,
  type RNotebookVariableDescriptor
} from "../extension/r/rNotebookVariableDiscovery";
import { R_KERNEL_TRANSPORT_VERSION, type RKernelRequest } from "../extension/r/rKernelProtocol";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type { OpenSessionRequest, OpenWranglerRequest } from "../shared/protocol";
import { rKernelFrameContract } from "./rKernelBridgeTestFixtures";

const source: OpenSessionRequest["source"] = {
  kind: "notebookVariable",
  label: "frame",
  uri: "file:///workspace/r-recovery.ipynb",
  variableName: "frame"
};

afterEach(() => {
  vi.restoreAllMocks();
  setWorkspaceState();
});

describe("Native-R verified bridge runtime recovery", () => {
  it("rebinds an invalidated verified bridge through the real factory and routes the next public page", async () => {
    const document = notebookDocument();
    setWorkspaceState(document);
    const original = controlledRKernel({ name: "frame", backend: "r", dataframeFlavor: "r.data.frame" });
    const replacement = controlledRKernel({ name: "frame", backend: "r", dataframeFlavor: "r.data.frame" });
    let currentKernel = original.kernel;
    installJupyterMock(async () => currentKernel);

    const discovery = await discoverRNotebookVariables(document);
    const selected = discovery.variables[0];
    if (!selected) throw new Error("Expected the original R dataframe discovery.");
    const verified = await verifyRNotebookVariableSelection(document, discovery, selected);
    const factory = vi.spyOn(RKernelBridge, "fromVerifiedSelection");
    const recoveryFactory = vi.spyOn(RKernelBridge.prototype, "createRuntimeRecoveryDelegate");
    const oldDelegate = RKernelBridge.fromVerifiedSelection(extensionContext(), document, verified);
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(oldDelegate);
    const opened = await bridge.request(openRequest());
    if (opened.kind !== "sessionOpened") throw new Error("Expected the verified R session to open.");
    const publicSessionId = opened.metadata.sessionId;
    const confirmedBefore = coordinator.activeSession();

    original.setStatus("restarting");
    currentKernel = replacement.kernel;
    const loss = await bridge.request(pageRequest(publicSessionId, "lost-kernel"));

    expect(loss).toMatchObject({
      kind: "error",
      code: "r_kernel_changed",
      recoverable: true,
      sessionId: publicSessionId,
      viewRequestId: "lost-kernel"
    });
    expect(recoveryFactory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(coordinator.activeSession()).toMatchObject({
      sessionId: publicSessionId,
      metadata: { source, revision: confirmedBefore?.metadata.revision },
      code: confirmedBefore?.code,
      viewState: confirmedBefore?.viewState
    });
    expect(original.runtimeRequests().filter((request) => request.kind === "getPage")).toHaveLength(0);

    const candidatePagesBefore = replacement.runtimeRequests().filter((request) => request.kind === "getPage").length;
    const recovered = await bridge.request(pageRequest(publicSessionId, "replacement-page"));
    expect(recovered).toMatchObject({
      kind: "page",
      viewRequestId: "replacement-page",
      metadata: { sessionId: publicSessionId, source }
    });
    expect(replacement.runtimeRequests().filter((request) => request.kind === "openSession")).toHaveLength(1);
    expect(replacement.runtimeRequests().filter((request) => request.kind === "getPage")).toHaveLength(
      candidatePagesBefore + 1
    );

    await bridge.request({ kind: "closeSession", sessionId: publicSessionId, revision: opened.metadata.revision });
    await coordinator.dispose();
    await vi.waitFor(() => {
      expect(original.listenerCount()).toBe(0);
      expect(replacement.listenerCount()).toBe(0);
    });
  });

  it.each([
    { name: "renamed", backend: "r" as const, dataframeFlavor: "r.data.frame" as const },
    { name: "frame", backend: "r" as const, dataframeFlavor: "r.tibble" as const }
  ])(
    "keeps the exact public session unpublished when replacement discovery drifts to $name/$dataframeFlavor",
    async (drift) => {
      const document = notebookDocument();
      setWorkspaceState(document);
      const original = controlledRKernel({ name: "frame", backend: "r", dataframeFlavor: "r.data.frame" });
      const replacement = controlledRKernel(drift);
      let currentKernel = original.kernel;
      installJupyterMock(async () => currentKernel);

      const discovery = await discoverRNotebookVariables(document);
      const selected = discovery.variables[0];
      if (!selected) throw new Error("Expected the original R dataframe discovery.");
      const verified = await verifyRNotebookVariableSelection(document, discovery, selected);
      const factory = vi.spyOn(RKernelBridge, "fromVerifiedSelection");
      const oldDelegate = RKernelBridge.fromVerifiedSelection(extensionContext(), document, verified);
      const coordinator = new SessionCoordinator();
      const bridge = coordinator.createBridge(oldDelegate);
      const opened = await bridge.request(openRequest());
      if (opened.kind !== "sessionOpened") throw new Error("Expected the verified R session to open.");
      const publicSessionId = opened.metadata.sessionId;
      const confirmedBefore = coordinator.activeSession();

      original.setStatus("restarting");
      currentKernel = replacement.kernel;
      const loss = await bridge.request(pageRequest(publicSessionId, "drifted-replacement"));

      expect(loss).toMatchObject({
        kind: "error",
        code: "r_kernel_changed",
        sessionId: publicSessionId,
        viewRequestId: "drifted-replacement"
      });
      expect(coordinator.activeSession()).toEqual(confirmedBefore);
      expect(factory).toHaveBeenCalledOnce();
      expect(replacement.runtimeRequests()).toEqual([]);
      expect(replacement.listenerCount()).toBe(0);

      await bridge.request({ kind: "closeSession", sessionId: publicSessionId, revision: opened.metadata.revision });
      await coordinator.dispose();
      await vi.waitFor(() => expect(original.listenerCount()).toBe(0));
    }
  );

  it("keeps the public session unchanged when the original NotebookDocument is replaced before factory re-verification", async () => {
    const document = notebookDocument();
    const replacementDocument = notebookDocument();
    setWorkspaceState(document);
    const original = controlledRKernel({ name: "frame", backend: "r", dataframeFlavor: "r.data.frame" });
    const replacement = controlledRKernel({ name: "frame", backend: "r", dataframeFlavor: "r.data.frame" });
    let currentKernel = original.kernel;
    installJupyterMock(async () => currentKernel);

    const discovery = await discoverRNotebookVariables(document);
    const selected = discovery.variables[0];
    if (!selected) throw new Error("Expected the original R dataframe discovery.");
    const verified = await verifyRNotebookVariableSelection(document, discovery, selected);
    const factory = vi.spyOn(RKernelBridge, "fromVerifiedSelection");
    const recoveryFactory = vi.spyOn(RKernelBridge.prototype, "createRuntimeRecoveryDelegate");
    const oldDelegate = RKernelBridge.fromVerifiedSelection(extensionContext(), document, verified);
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(oldDelegate);
    const opened = await bridge.request(openRequest());
    if (opened.kind !== "sessionOpened") throw new Error("Expected the verified R session to open.");
    const publicSessionId = opened.metadata.sessionId;
    const confirmedBefore = coordinator.activeSession();

    original.setStatus("restarting");
    currentKernel = replacement.kernel;
    setWorkspaceState(replacementDocument);
    await expect(bridge.request(pageRequest(publicSessionId, "replaced-notebook"))).resolves.toMatchObject({
      kind: "error",
      code: "r_kernel_changed",
      sessionId: publicSessionId,
      viewRequestId: "replaced-notebook"
    });

    expect(recoveryFactory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(replacement.runtimeRequests()).toEqual([]);
    expect(replacement.listenerCount()).toBe(0);
    expect(coordinator.activeSession()).toEqual(confirmedBefore);

    setWorkspaceState(document);
    await bridge.request({ kind: "closeSession", sessionId: publicSessionId, revision: opened.metadata.revision });
    await coordinator.dispose();
    await vi.waitFor(() => expect(original.listenerCount()).toBe(0));
  });

  it("disposes one real replacement delegate without publication when the owning read is superseded", async () => {
    const document = notebookDocument();
    setWorkspaceState(document);
    const firstSelectionProbeStarted = deferred<void>();
    const releaseFirstSelectionProbe = deferred<void>();
    const secondSelectionProbeStarted = deferred<void>();
    const releaseSecondSelectionProbe = deferred<void>();
    const original = controlledRKernel({ name: "frame", backend: "r", dataframeFlavor: "r.data.frame" });
    const replacement = controlledRKernel(
      { name: "frame", backend: "r", dataframeFlavor: "r.data.frame" },
      async (discoveryExecution) => {
        if (discoveryExecution === 2) {
          firstSelectionProbeStarted.resolve();
          await releaseFirstSelectionProbe.promise;
        }
        if (discoveryExecution === 4) {
          secondSelectionProbeStarted.resolve();
          await releaseSecondSelectionProbe.promise;
        }
      }
    );
    let currentKernel = original.kernel;
    installJupyterMock(async () => currentKernel);

    const discovery = await discoverRNotebookVariables(document);
    const selected = discovery.variables[0];
    if (!selected) throw new Error("Expected the original R dataframe discovery.");
    const verified = await verifyRNotebookVariableSelection(document, discovery, selected);
    const factory = vi.spyOn(RKernelBridge, "fromVerifiedSelection");
    const disposeDelegate = vi.spyOn(RKernelBridge.prototype, "dispose");
    const oldDelegate = RKernelBridge.fromVerifiedSelection(extensionContext(), document, verified);
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(oldDelegate);
    const opened = await bridge.request(openRequest());
    if (opened.kind !== "sessionOpened") throw new Error("Expected the verified R session to open.");
    const publicSessionId = opened.metadata.sessionId;
    const confirmedBefore = coordinator.activeSession();

    original.setStatus("restarting");
    currentKernel = replacement.kernel;
    const losingRead = bridge.request(pageRequest(publicSessionId, "superseded-loss"));
    await firstSelectionProbeStarted.promise;
    const supersedingRead = bridge.request(pageRequest(publicSessionId, "current-loss"));
    releaseFirstSelectionProbe.resolve();
    await secondSelectionProbeStarted.promise;

    await expect(losingRead).resolves.toMatchObject({
      kind: "error",
      code: "r_kernel_changed",
      sessionId: publicSessionId,
      viewRequestId: "superseded-loss"
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(disposeDelegate).toHaveBeenCalledOnce();
    expect(replacement.runtimeRequests()).toEqual([]);
    expect(coordinator.activeSession()).toEqual(confirmedBefore);

    releaseSecondSelectionProbe.resolve();
    await expect(supersedingRead).resolves.toMatchObject({
      kind: "error",
      code: "r_kernel_changed",
      sessionId: publicSessionId,
      viewRequestId: "current-loss"
    });

    await bridge.request({ kind: "closeSession", sessionId: publicSessionId, revision: opened.metadata.revision });
    await coordinator.dispose();
    await vi.waitFor(() => {
      expect(original.listenerCount()).toBe(0);
      expect(replacement.listenerCount()).toBe(0);
    });
  });
});

function extensionContext(): vscode.ExtensionContext {
  return {
    extensionPath: process.cwd(),
    extension: { packageJSON: { version: "1.99.7" } },
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

function openRequest(): OpenSessionRequest {
  return {
    kind: "openSession",
    source,
    backend: "r",
    mode: "viewing",
    pageSize: 20,
    columnOffset: 0,
    columnLimit: 8
  };
}

function pageRequest(sessionId: string, viewRequestId: string): Extract<OpenWranglerRequest, { kind: "getPage" }> {
  return {
    kind: "getPage",
    sessionId,
    revision: 0,
    viewRequestId,
    offset: 0,
    limit: 20,
    columnOffset: 0,
    columnLimit: 8,
    filterModel: { filters: [], sort: [] }
  };
}

function controlledRKernel(
  variable: RNotebookVariableDescriptor,
  beforeDiscoveryOutput?: (execution: number) => Promise<void>
): {
  readonly kernel: Kernel;
  listenerCount(): number;
  runtimeRequests(): readonly RKernelRequest[];
  setStatus(status: KernelStatus): void;
} {
  let status: KernelStatus = "idle";
  let discoveryExecutions = 0;
  const listeners = new Set<(status: KernelStatus) => unknown>();
  const runtimeRequests: RKernelRequest[] = [];
  const kernel = {
    language: "r",
    get status() {
      return status;
    },
    onDidChangeStatus(listener: (next: KernelStatus) => unknown) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    executeCode(code: string) {
      if (code.includes("__OPEN_WRANGLER_R_VARIABLES_START_")) {
        discoveryExecutions += 1;
        const marker = code.match(/__OPEN_WRANGLER_R_VARIABLES_START_([a-f0-9]{32})__/)?.[1];
        if (!marker) throw new Error("The test could not decode the R variable marker.");
        return output(
          [
            `__OPEN_WRANGLER_R_VARIABLES_START_${marker}__`,
            JSON.stringify({
              protocolVersion: 1,
              truncated: false,
              variables: [{ name: variable.name, dataframeFlavor: variable.dataframeFlavor }]
            }),
            `__OPEN_WRANGLER_R_VARIABLES_END_${marker}__`
          ].join("\n"),
          () => beforeDiscoveryOutput?.(discoveryExecutions)
        );
      }
      if (!code.includes("__OPEN_WRANGLER_R_START_")) return emptyOutput();
      return dispatchOutput(code, (request) => {
        runtimeRequests.push(request);
        const sessionId = request.payload.sessionId;
        if (request.kind === "openSession" || request.kind === "getPage") {
          const page = rKernelFrameContract();
          const requestedPage = request.payload.page;
          const projected = {
            ...page,
            page: {
              ...page.page,
              offset: requestedPage.rowOffset,
              limit: requestedPage.rowLimit,
              columnIds: page.schema
                .slice(requestedPage.columnOffset, requestedPage.columnOffset + requestedPage.columnLimit)
                .map((column) => column.id)
            }
          };
          return response(request, { kind: "page", sessionId, page: projected });
        }
        if (request.kind === "closeSession") return response(request, { kind: "closed", sessionId });
        throw new Error(`Unexpected direct recovery request: ${request.kind}`);
      });
    }
  } as unknown as Kernel;
  return {
    kernel,
    listenerCount: () => listeners.size,
    runtimeRequests: () => runtimeRequests,
    setStatus(next) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    }
  };
}

function installJupyterMock(getKernel: () => Promise<Kernel>): void {
  const jupyter = { kernels: { getKernel } } as unknown as Jupyter;
  vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({ activate: async () => jupyter } as never);
}

async function* dispatchOutput(
  code: string,
  respond: (request: RKernelRequest) => unknown
): AsyncIterable<{ text: string }> {
  const marker = code.match(/__OPEN_WRANGLER_R_START_([a-f0-9]{32})__/)?.[1];
  const payload = code.match(/\.__ow_payload <- rawToChar\(jsonlite::base64_dec\("([A-Za-z0-9+/=]+)"\)\)/u)?.[1];
  if (!marker || !payload) throw new Error("The test could not decode the R dispatch frame.");
  const request = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as RKernelRequest;
  yield {
    text: [
      `__OPEN_WRANGLER_R_START_${marker}__`,
      JSON.stringify(respond(request)),
      `__OPEN_WRANGLER_R_END_${marker}__`
    ].join("\n")
  };
}

function response(request: RKernelRequest, body: Record<string, unknown>): Record<string, unknown> {
  return {
    transportVersion: R_KERNEL_TRANSPORT_VERSION,
    requestId: request.requestId,
    ...(request.kind === "openSession" && body.kind === "page" ? { exportFormats: ["csv"] } : {}),
    ...body
  };
}

async function* output(
  text: string,
  before?: () => Promise<void> | undefined
): AsyncIterable<{ items: Array<{ mime: string; data: Uint8Array }> }> {
  await before?.();
  yield { items: [{ mime: "application/x.notebook.stream.stdout", data: Buffer.from(text, "utf8") }] };
}

async function* emptyOutput(): AsyncIterable<unknown> {}

function notebookDocument(): vscode.NotebookDocument {
  return {
    uri: vscode.Uri.file("/workspace/r-recovery.ipynb"),
    isClosed: false
  } as vscode.NotebookDocument;
}

function setWorkspaceState(...documents: vscode.NotebookDocument[]): void {
  Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, value: true });
  Object.defineProperty(vscode.workspace, "notebookDocuments", { configurable: true, value: documents });
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete as (value?: T) => void;
  });
  return { promise, resolve };
}
