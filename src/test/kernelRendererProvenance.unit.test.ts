import type { Jupyter, Kernel } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenWranglerRequest } from "../shared/protocol";
import {
  closeNotebook,
  closeRequest,
  controllableKernel,
  createKernelBridge,
  deferred,
  fakeKernel,
  initializeRequest,
  initializedResponse,
  kernelExecution,
  mockKernel,
  notebookDocument,
  openedResponse,
  openRequest,
  resetKernelBridgeTestState,
  setOpenNotebookDocuments
} from "./kernelBridge.testFixtures";

afterEach(resetKernelBridgeTestState);

describe("renderer notebook provenance", () => {
  it("treats stable Jupyter kernel discovery as lookup-only when no user-started kernel exists", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const getKernel = vi.fn(async () => undefined);
    const activate = vi.fn(async () => ({ kernels: { getKernel } }));
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({ activate } as never);
    const bridge = createKernelBridge(document);

    await expect(bridge.prepareNotebookFormatter()).rejects.toThrow(
      "Select or start a Python kernel, run the cell that defines the dataframe"
    );

    expect(activate).toHaveBeenCalledOnce();
    expect(getKernel).toHaveBeenCalledOnce();
    expect(getKernel).toHaveBeenCalledWith(document.uri);
  });

  it("rejects simultaneous open documents with the captured URI before activating Jupyter", async () => {
    const original = notebookDocument("/workspace/notebook.ipynb");
    const overlappingReplacement = notebookDocument("/workspace/notebook.ipynb");
    const getExtension = vi.spyOn(vscode.extensions, "getExtension");

    setOpenNotebookDocuments(original, overlappingReplacement);
    await expect(createKernelBridge(original).request(initializeRequest())).rejects.toThrow(
      "originated this Open Wrangler session is no longer open"
    );

    expect(getExtension).not.toHaveBeenCalled();
  });

  it("rejects a stale document object before activating Jupyter", async () => {
    const original = notebookDocument("/workspace/notebook.ipynb");
    const replacement = notebookDocument("/workspace/notebook.ipynb");
    const getExtension = vi.spyOn(vscode.extensions, "getExtension");

    setOpenNotebookDocuments(replacement);
    await expect(createKernelBridge(original).request(initializeRequest())).rejects.toThrow(
      "originated this Open Wrangler session is no longer open"
    );

    expect(getExtension).not.toHaveBeenCalled();
  });

  it("rejects provenance lost while Jupyter activation is pending before asking for a kernel", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const activation = deferred<Jupyter>();
    const getKernel = vi.fn(async () => fakeKernel(() => initializedResponse));
    const activate = vi.fn(() => activation.promise);
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({ activate } as never);
    const bridge = createKernelBridge(document);

    const request = bridge.request(initializeRequest());
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    (document as unknown as { isClosed: boolean }).isClosed = true;
    const reopenedDocument = notebookDocument();
    setOpenNotebookDocuments(reopenedDocument);
    activation.resolve({ kernels: { getKernel } } as unknown as Jupyter);

    await expect(request).rejects.toThrow("originated this Open Wrangler session is no longer open");
    expect(getKernel).not.toHaveBeenCalled();
  });

  it("rejects provenance lost while getKernel is pending before bootstrapping", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const kernelResult = deferred<Kernel | undefined>();
    const getKernel = vi.fn(() => kernelResult.promise);
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel } })
    } as never);
    const executeCode = vi.fn();
    const kernel = { language: "python", executeCode } as unknown as Kernel;
    const bridge = createKernelBridge(document);

    const request = bridge.request(initializeRequest());
    await vi.waitFor(() => expect(getKernel).toHaveBeenCalledOnce());
    (document as unknown as { isClosed: boolean }).isClosed = true;
    const reopenedDocument = notebookDocument();
    setOpenNotebookDocuments(reopenedDocument);
    kernelResult.resolve(kernel);

    await expect(request).rejects.toThrow("originated this Open Wrangler session is no longer open");
    expect(executeCode).not.toHaveBeenCalled();
  });

  it("rejects an overlapping same-URI document introduced while getKernel is pending", async () => {
    const document = notebookDocument();
    const overlappingReplacement = notebookDocument();
    setOpenNotebookDocuments(document);
    const kernelResult = deferred<Kernel | undefined>();
    const getKernel = vi.fn(() => kernelResult.promise);
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel } })
    } as never);
    const executeCode = vi.fn();
    const kernel = { language: "python", executeCode } as unknown as Kernel;
    const bridge = createKernelBridge(document);

    const request = bridge.request(initializeRequest());
    await vi.waitFor(() => expect(getKernel).toHaveBeenCalledOnce());
    setOpenNotebookDocuments(document, overlappingReplacement);
    kernelResult.resolve(kernel);

    await expect(request).rejects.toThrow("originated this Open Wrangler session is no longer open");
    expect(executeCode).not.toHaveBeenCalled();
  });

  it("stops after bootstrap when the originating document closes during bootstrap", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const bootstrapStarted = deferred<void>();
    const releaseBootstrap = deferred<void>();
    const requests: OpenWranglerRequest[] = [];
    const kernel = controllableKernel((code: string) => {
      if (code.includes("__ow_payload =")) {
        return kernelExecution(code, (request) => {
          requests.push(request);
          return initializedResponse;
        });
      }
      return (async function* () {
        bootstrapStarted.resolve();
        await releaseBootstrap.promise;
        yield { text: "" };
      })();
    }).kernel;
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge(document);

    const request = bridge.request(openRequest());
    await bootstrapStarted.promise;
    closeNotebook(document);
    releaseBootstrap.resolve();

    await expect(request).rejects.toThrow("originated this Open Wrangler session is no longer open");
    expect(requests).toEqual([]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("closes the host-known candidate on the cached kernel when provenance is lost during open dispatch", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const openDispatched = deferred<void>();
    const releaseOpen = deferred<void>();
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") {
        openDispatched.resolve();
        await releaseOpen.promise;
        return openedResponse(request.requestedSessionId!);
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge(document);

    const pending = bridge.request(openRequest());
    await openDispatched.promise;
    closeNotebook(document);
    releaseOpen.resolve();

    await expect(pending).rejects.toThrow("originated this Open Wrangler session is no longer open");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ kind: "openSession", requestedSessionId: expect.any(String) });
    expect(requests[1]).toEqual({
      kind: "closeSession",
      sessionId: (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId,
      revision: 0
    });
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("allows closeSession to use the mapped original kernel after the document closes", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
      return request.kind === "closeSession"
        ? { kind: "sessionClosed", sessionId: request.sessionId }
        : initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge(document);
    const opened = await bridge.request(openRequest());
    expect(opened.kind).toBe("sessionOpened");
    const sessionId = opened.kind === "sessionOpened" ? opened.metadata.sessionId : "unexpected";
    closeNotebook(document);

    await expect(bridge.request(closeRequest(sessionId))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId
    });
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("does not acquire a kernel for cleanup of an unknown candidate", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(
      bridge.request(closeRequest("unknown-candidate"), { startRuntimeIfNeeded: false })
    ).resolves.toMatchObject({
      kind: "error",
      code: "unknown_session",
      sessionId: "unknown-candidate"
    });

    expect(requests).toEqual([]);
    expect(getExtension).not.toHaveBeenCalled();
  });

  it("closes an established session on its mapped kernel after lifecycle execution failure", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
      if (request.kind === "initialize") throw new Error("generation transport failed");
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();
    const opened = await bridge.request(openRequest());
    if (opened.kind !== "sessionOpened") throw new Error("Expected the test session to open.");

    await expect(bridge.request(initializeRequest())).rejects.toThrow("generation transport failed");
    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: opened.metadata.sessionId
    });
    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toMatchObject({
      kind: "error",
      code: "unknown_session",
      sessionId: opened.metadata.sessionId
    });

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "initialize", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("never reacquires a kernel for closeSession after a stale origin invalidates the cached generation", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge(document);
    await bridge.request(initializeRequest());
    bridge.onIdle();
    closeNotebook(document);

    await expect(bridge.request(closeRequest("stale-session"))).rejects.toThrow(
      "originated this Open Wrangler session is no longer open"
    );
    expect(requests.map((request) => request.kind)).toEqual(["initialize"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });
});
