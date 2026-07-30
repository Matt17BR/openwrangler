import type { Jupyter, Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KernelBridge,
  isIdempotentKernelReadRequest,
  kernelOutputsToText,
  parseKernelResponse,
  withKernelSessionIdentity
} from "../extension/notebooks/kernelBridge";
import { buildKernelBootstrapCode } from "../extension/notebooks/kernelRuntimeBundle";
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setOpenNotebookDocuments();
});

describe("remote kernel runtime bootstrap", () => {
  it("embeds a deterministic runtime bundle without referencing the extension filesystem", () => {
    const code = buildKernelBootstrapCode({
      "openwrangler_runtime/__init__.py": "VERSION = 2\n",
      "openwrangler_runtime/kernel_agent.py": "def dispatch_json(value): return value\n"
    });

    expect(code).toContain('Path(__ow_bundle_tempfile.gettempdir()) / "openwrangler-runtime"');
    expect(code).toContain("base64.b64decode");
    expect(code).toContain(".complete");
    expect(code).not.toContain("VERSION = 2");
    expect(code).not.toContain("extensionPath");
  });

  it("rejects incomplete or unsafe bundles", () => {
    expect(() => buildKernelBootstrapCode({ "openwrangler_runtime/kernel_agent.py": "" })).toThrow(
      "missing openwrangler_runtime/__init__.py"
    );
    expect(() =>
      buildKernelBootstrapCode({
        "openwrangler_runtime/__init__.py": "",
        "openwrangler_runtime/../escape.py": ""
      })
    ).toThrow("Unsafe bundled kernel runtime path");
  });
});

describe("kernel protocol responses", () => {
  const marker = "requestmarker";
  const requestId = "request-id";

  function marked(response: unknown): string {
    return [`__OPEN_WRANGLER_START_${marker}__`, JSON.stringify(response), `__OPEN_WRANGLER_END_${marker}__`].join(
      "\n"
    );
  }

  it("returns a logical runtime error without treating it as a transport failure", () => {
    const response = {
      kind: "error" as const,
      code: "engine_error",
      message: "Unknown session: missing-session",
      recoverable: true,
      viewRequestId: "view-unknown-session"
    };

    expect(parseKernelResponse(marked({ protocolVersion: 2, requestId, response }), marker, requestId)).toEqual(
      response
    );
  });

  it("rejects malformed and stale response envelopes", () => {
    expect(() =>
      parseKernelResponse(marked({ requestId, response: { kind: "initialized" } }), marker, requestId)
    ).toThrow("invalid or stale protocol response");
    expect(() =>
      parseKernelResponse(
        marked({ protocolVersion: 2, requestId: "other-request", response: { kind: "initialized" } }),
        marker,
        requestId
      )
    ).toThrow("invalid or stale protocol response");
  });

  it("collects marker output from the stable Jupyter stdout MIME", async () => {
    const encoder = new TextEncoder();
    async function* outputs() {
      yield {
        items: [{ mime: "application/x.notebook.stream.stderr", data: encoder.encode("kernel warning\n") }]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(`__OPEN_WRANGLER_START_${marker}__\n`)
          }
        ]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(
              `${JSON.stringify({ protocolVersion: 2, requestId, response: initializedResponse })}\n`
            )
          }
        ]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(`__OPEN_WRANGLER_END_${marker}__\n`)
          }
        ]
      };
    }

    const text = await kernelOutputsToText(outputs());
    expect(text).toContain(`__OPEN_WRANGLER_START_${marker}__`);
    expect(text).toContain(`__OPEN_WRANGLER_END_${marker}__`);
    expect(parseKernelResponse(text, marker, requestId)).toEqual(initializedResponse);
  });

  it("surfaces stable Jupyter kernel error output instead of reporting a missing marker", async () => {
    const encoder = new TextEncoder();
    async function* outputs() {
      yield {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: encoder.encode(JSON.stringify({ name: "ModuleNotFoundError", message: "No module named 'polars'" }))
          }
        ]
      };
    }

    await expect(kernelOutputsToText(outputs())).rejects.toThrow(
      "Open Wrangler kernel execution failed (ModuleNotFoundError): No module named 'polars'"
    );
  });
});

describe("kernel retry classification", () => {
  it("assigns a stable host-known identity to kernel session opens", () => {
    const request: OpenSessionRequest = {
      kind: "openSession",
      source: { kind: "notebookVariable", label: "df", variableName: "df" },
      backend: "polars",
      mode: "viewing",
      pageSize: 200,
      columnOffset: 0,
      columnLimit: 16
    };

    expect(withKernelSessionIdentity(request, () => "candidate-session")).toEqual({
      ...request,
      requestedSessionId: "candidate-session"
    });
    expect(
      withKernelSessionIdentity({ ...request, requestedSessionId: "existing-session" }, () => "unused-session")
    ).toMatchObject({ requestedSessionId: "existing-session" });
  });

  it.each(["getPage", "getSummary", "getDatasetStats", "getColumnValues"] as const)(
    "marks %s as an explicitly idempotent read",
    (kind) => {
      expect(isIdempotentKernelReadRequest({ kind } as OpenWranglerRequest)).toBe(true);
    }
  );

  it.each([
    "initialize",
    "openSession",
    "previewStep",
    "applyDraft",
    "discardDraft",
    "undoStep",
    "exportData",
    "closeSession",
    "cancelRequest"
  ] as const)("never treats %s as replay-safe after dispatch", (kind) => {
    expect(isIdempotentKernelReadRequest({ kind } as OpenWranglerRequest)).toBe(false);
  });

  it.each(["restarting", "autorestarting", "terminating", "dead"] as const)(
    "bootstraps once per observed kernel generation and rebootstraps after %s",
    async (invalidatingStatus) => {
      const controller = controlledFakeKernel(() => initializedResponse);
      const getExtension = mockKernel(controller.kernel);
      const bridge = createKernelBridge();

      await expect(bridge.request(initializeRequest())).resolves.toEqual(initializedResponse);
      await expect(bridge.request(initializeRequest())).resolves.toEqual(initializedResponse);

      expect(controller.bootstrapExecutionCount()).toBe(1);
      expect(controller.statusListenerCount()).toBe(1);
      expect(getExtension).toHaveBeenCalledOnce();

      controller.setStatus(invalidatingStatus);
      expect(controller.statusListenerCount()).toBe(0);
      expect(controller.statusListenerDisposalCount()).toBe(1);
      controller.setStatus("idle");

      await expect(bridge.request(initializeRequest())).resolves.toEqual(initializedResponse);

      expect(controller.bootstrapExecutionCount()).toBe(2);
      expect(controller.statusListenerCount()).toBe(1);
      expect(getExtension).toHaveBeenCalledTimes(2);
    }
  );

  it("keeps old and replacement DuckDB sessions mapped to their exact kernel generations", async () => {
    const oldRequests: OpenWranglerRequest[] = [];
    const replacementRequests: OpenWranglerRequest[] = [];
    const oldKernel = controlledFakeKernel((request) => {
      oldRequests.push(request);
      if (request.kind === "openSession") {
        return openedResponse(request.requestedSessionId!, request.backend ?? "polars");
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const replacementKernel = controlledFakeKernel((request) => {
      replacementRequests.push(request);
      if (request.kind === "openSession") {
        return openedResponse(request.requestedSessionId!, request.backend ?? "polars");
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    let currentKernel = oldKernel.kernel;
    const getExtension = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel: async () => currentKernel } })
    } as never);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest("old-duckdb-session", "duckdb"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: "old-duckdb-session", backend: "duckdb" }
    });
    currentKernel = replacementKernel.kernel;
    oldKernel.setStatus("restarting");
    await expect(bridge.request(openRequest("replacement-duckdb-session", "duckdb"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: "replacement-duckdb-session", backend: "duckdb" }
    });

    await expect(bridge.request(closeRequest("old-duckdb-session"))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "old-duckdb-session"
    });
    await expect(bridge.request(closeRequest("replacement-duckdb-session"))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "replacement-duckdb-session"
    });

    expect(
      oldRequests.map((request) =>
        request.kind === "openSession" ? `open:${request.requestedSessionId}` : `close:${request.sessionId}`
      )
    ).toEqual(["open:old-duckdb-session", "close:old-duckdb-session"]);
    expect(
      replacementRequests.map((request) =>
        request.kind === "openSession" ? `open:${request.requestedSessionId}` : `close:${request.sessionId}`
      )
    ).toEqual(["open:replacement-duckdb-session", "close:replacement-duckdb-session"]);
    expect(getExtension).toHaveBeenCalledTimes(2);
  });

  it("does not replay a non-idempotent request when status invalidates its dispatched generation", async () => {
    const requests: OpenWranglerRequest[] = [];
    let invalidateOnce = true;
    const controller = controlledFakeKernel((request) => {
      requests.push(request);
      if (invalidateOnce) {
        invalidateOnce = false;
        controller.setStatus("restarting");
        controller.setStatus("idle");
      }
      return initializedResponse;
    });
    mockKernel(controller.kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(initializeRequest())).rejects.toThrow("stale kernel generation");
    expect(requests).toEqual([initializeRequest()]);

    await expect(bridge.request(initializeRequest())).resolves.toEqual(initializedResponse);
    expect(requests).toEqual([initializeRequest(), initializeRequest()]);
    expect(controller.bootstrapExecutionCount()).toBe(2);
  });

  it("does not let a late stale request invalidate a newer observation of the same kernel", async () => {
    const firstDispatched = deferred<void>();
    const releaseFirst = deferred<void>();
    let initializeRequests = 0;
    const controller = controlledFakeKernel(async (request) => {
      if (request.kind === "initialize" && initializeRequests++ === 0) {
        firstDispatched.resolve();
        await releaseFirst.promise;
      }
      return initializedResponse;
    });
    const getExtension = mockKernel(controller.kernel);
    const bridge = createKernelBridge();

    const staleRequest = bridge.request(initializeRequest());
    await firstDispatched.promise;
    controller.setStatus("restarting");
    controller.setStatus("idle");

    await expect(bridge.request(initializeRequest())).resolves.toEqual(initializedResponse);
    releaseFirst.resolve();
    await expect(staleRequest).rejects.toThrow("stale kernel generation");
    await expect(bridge.request(initializeRequest())).resolves.toEqual(initializedResponse);

    expect(initializeRequests).toBe(3);
    expect(controller.bootstrapExecutionCount()).toBe(2);
    expect(controller.statusListenerCount()).toBe(1);
    expect(getExtension).toHaveBeenCalledTimes(2);
  });

  it.each(["timeout", "cancellation"] as const)(
    "does not let an old generation %s invalidate a concurrently executing replacement",
    async (abortKind) => {
      if (abortKind === "timeout") vi.useFakeTimers();
      const firstDispatched = deferred<void>();
      const secondDispatched = deferred<void>();
      const releaseFirst = deferred<void>();
      const releaseSecond = deferred<void>();
      let initializeRequests = 0;
      const controller = controlledFakeKernel(async (request) => {
        if (request.kind === "initialize") {
          initializeRequests += 1;
          if (initializeRequests === 1) {
            firstDispatched.resolve();
            await releaseFirst.promise;
          } else if (initializeRequests === 2) {
            secondDispatched.resolve();
            await releaseSecond.promise;
          }
        }
        return initializedResponse;
      });
      const getExtension = mockKernel(controller.kernel);
      const cancellation = cancellationSource();
      const bridge = createKernelBridge();

      const staleRequest = bridge.request(initializeRequest(), {
        timeoutMs: abortKind === "timeout" ? 30 : 60_000,
        ...(abortKind === "cancellation" ? { cancellation: cancellation.token } : {})
      });
      const staleRejection = expect(staleRequest).rejects.toThrow(
        abortKind === "timeout" ? "timed out after 30 ms" : "kernel request was cancelled"
      );
      await firstDispatched.promise;
      controller.setStatus("restarting");
      controller.setStatus("idle");

      const replacementRequest = bridge.request(initializeRequest(), { timeoutMs: 60_000 });
      await secondDispatched.promise;
      expect(controller.statusListenerCount()).toBe(1);

      if (abortKind === "timeout") await vi.advanceTimersByTimeAsync(30);
      else cancellation.cancel();
      await staleRejection;
      expect(controller.statusListenerCount()).toBe(1);

      releaseSecond.resolve();
      await expect(replacementRequest).resolves.toEqual(initializedResponse);
      releaseFirst.resolve();
      await Promise.resolve();

      expect(initializeRequests).toBe(2);
      expect(controller.bootstrapExecutionCount()).toBe(2);
      expect(controller.statusListenerCount()).toBe(1);
      expect(getExtension).toHaveBeenCalledTimes(2);
    }
  );

  it.each(["error", "cancelled"] as const)(
    "closes the host-known candidate after an open returns %s",
    async (outcome) => {
      const requests: OpenWranglerRequest[] = [];
      const kernel = fakeKernel((request, requestId) => {
        requests.push(request);
        if (request.kind === "openSession") {
          return outcome === "error"
            ? { kind: "error", code: "engine_error", message: "open failed", recoverable: true }
            : { kind: "cancelled", targetRequestId: requestId };
        }
        if (request.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        return initializedResponse;
      });
      mockKernel(kernel);
      const bridge = createKernelBridge();

      const response = await bridge.request(openRequest());

      expect(response.kind).toBe(outcome);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ kind: "openSession", requestedSessionId: expect.any(String) });
      expect(requests[1]).toEqual({
        kind: "closeSession",
        sessionId: (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId,
        revision: 0
      });
    }
  );

  it("closes the host-known candidate after a malformed open response", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return { kind: "sessionOpened" };
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest())).rejects.toThrow("invalid or stale protocol response");

    const candidate = (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId!;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      kind: "closeSession",
      sessionId: candidate,
      revision: 0
    });
    await expect(bridge.request(closeRequest(candidate))).resolves.toMatchObject({
      kind: "error",
      code: "unknown_session"
    });
    await expect(bridge.request(openRequest(candidate))).rejects.toThrow(`already retired kernel session ${candidate}`);
    expect(requests).toHaveLength(2);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("closes a timed-out DuckDB candidate on its exact kernel after the notebook reopens at the same URI", async () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return HANG;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge(document);

    const pending = bridge.request(openRequest(undefined, "duckdb"), { timeoutMs: 30 });
    const rejection = expect(pending).rejects.toThrow("timed out after 30 ms");
    await vi.waitFor(() => expect(requests[0]?.kind).toBe("openSession"));
    (document as unknown as { isClosed: boolean }).isClosed = true;
    setOpenNotebookDocuments(notebookDocument());

    await rejection;

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ kind: "openSession", backend: "duckdb" });
    expect(requests[1]).toEqual({
      kind: "closeSession",
      sessionId: (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId,
      revision: 0
    });
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("uses the dedicated configured deadline for a cold kernel session open", async () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(key: string, fallback: T): T =>
        (key === "sessionOpenTimeoutMs" ? 25 : key === "requestTimeoutMs" ? 5_000 : fallback) as T
    } as vscode.WorkspaceConfiguration);
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return HANG;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest())).rejects.toThrow("timed out after 25 ms");

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("closes both identities on the exact kernel when a wrong-id response arrives after provenance is lost", async () => {
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
        return openedResponse("unexpected-runtime-session");
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge(document);

    const pending = bridge.request(openRequest());
    await openDispatched.promise;
    (document as unknown as { isClosed: boolean }).isClosed = true;
    setOpenNotebookDocuments(notebookDocument());
    releaseOpen.resolve();

    await expect(pending).rejects.toThrow("originated this Open Wrangler session is no longer open");

    const candidate = (requests[0] as Extract<OpenWranglerRequest, { kind: "openSession" }>).requestedSessionId;
    expect(
      new Set(
        requests
          .slice(1)
          .map((request) => (request.kind === "closeSession" ? request.sessionId : `unexpected:${request.kind}`))
      )
    ).toEqual(new Set([candidate, "unexpected-runtime-session"]));
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("closes a candidate directly on its exact kernel after a thrown transport failure", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") throw new Error("kernel transport failed");
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest())).rejects.toThrow("kernel transport failed");

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("uses a fresh uncancelled exact-kernel close after cancelling a DuckDB open", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return HANG;
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();
    const cancellation = cancellationSource();

    const pending = bridge.request(openRequest(undefined, "duckdb"), {
      cancellation: cancellation.token,
      timeoutMs: 60_000
    });
    await vi.waitFor(() => expect(requests[0]?.kind).toBe("openSession"));
    cancellation.cancel();

    await expect(pending).rejects.toThrow("kernel request was cancelled");
    expect(requests[0]).toMatchObject({ kind: "openSession", backend: "duckdb" });
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate requested session identity before dispatch without replacing its kernel mapping", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest("fixed-session"))).resolves.toMatchObject({ kind: "sessionOpened" });
    await expect(bridge.request(openRequest("fixed-session"))).rejects.toThrow(
      "already has a live kernel session named fixed-session"
    );
    await expect(bridge.request(closeRequest("fixed-session"))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "fixed-session"
    });

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("does not close an existing mapped session when a second open returns its identity", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") {
        return openedResponse(
          request.requestedSessionId === "candidate-session" ? "existing-session" : request.requestedSessionId!
        );
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest("existing-session"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: "existing-session" }
    });
    await expect(bridge.request(openRequest("candidate-session"))).rejects.toThrow(
      "session identity that did not match"
    );
    await expect(bridge.request(closeRequest("existing-session"))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "existing-session"
    });

    expect(
      requests.map((request) =>
        request.kind === "openSession"
          ? `open:${request.requestedSessionId}`
          : request.kind === "closeSession"
            ? `close:${request.sessionId}`
            : request.kind
      )
    ).toEqual(["open:existing-session", "open:candidate-session", "close:candidate-session", "close:existing-session"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("retains exact-kernel mappings across an early onIdle for delayed terminal cleanup", async () => {
    const requests: OpenWranglerRequest[] = [];
    const controller = controlledFakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const getExtension = mockKernel(controller.kernel);
    const bridge = createKernelBridge();
    const opened = await bridge.request(openRequest("delayed-close-session"));
    if (opened.kind !== "sessionOpened") throw new Error("Expected the test session to open.");
    expect(controller.statusListenerCount()).toBe(1);

    bridge.onIdle();
    bridge.onIdle();
    expect(controller.statusListenerCount()).toBe(0);
    expect(controller.statusListenerDisposalCount()).toBe(1);
    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "delayed-close-session"
    });

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("retires an exact-kernel mapping when close confirms the session is already absent", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
      if (request.kind === "closeSession") {
        return {
          kind: "error",
          code: "unknown_session",
          message: `Unknown session: ${request.sessionId}`,
          recoverable: true,
          sessionId: request.sessionId
        };
      }
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();
    const opened = await bridge.request(openRequest("already-absent-session"));
    if (opened.kind !== "sessionOpened") throw new Error("Expected the test session to open.");

    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toMatchObject({
      kind: "error",
      code: "unknown_session",
      sessionId: "already-absent-session"
    });
    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toMatchObject({
      kind: "error",
      code: "unknown_session"
    });
    await expect(bridge.request(openRequest(opened.metadata.sessionId))).rejects.toThrow(
      "already retired kernel session already-absent-session"
    );

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });
});

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
      code: "unknown_session"
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
      code: "unknown_session"
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

function openRequest(requestedSessionId?: string, backend: TestBackend = "polars"): OpenWranglerRequest {
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

function fakeKernel(respond: (request: OpenWranglerRequest, requestId: string) => unknown | Promise<unknown>): Kernel {
  return controlledFakeKernel(respond).kernel;
}

interface ControllableKernel {
  readonly kernel: Kernel;
  setStatus(status: KernelStatus): void;
  statusListenerCount(): number;
  statusListenerDisposalCount(): number;
}

interface ControlledFakeKernel extends ControllableKernel {
  bootstrapExecutionCount(): number;
}

function controlledFakeKernel(
  respond: (request: OpenWranglerRequest, requestId: string) => unknown | Promise<unknown>
): ControlledFakeKernel {
  let bootstrapExecutions = 0;
  const controller = controllableKernel((code) => {
    if (!code.includes("__ow_payload =")) bootstrapExecutions += 1;
    return kernelExecution(code, respond);
  });
  return {
    ...controller,
    bootstrapExecutionCount: () => bootstrapExecutions
  };
}

function controllableKernel(executeCode: (code: string) => AsyncIterable<unknown>): ControllableKernel {
  let status: KernelStatus = "idle";
  let listenerDisposals = 0;
  const listeners = new Set<(status: KernelStatus) => unknown>();
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
    executeCode
  } as unknown as Kernel;
  return {
    kernel,
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
      filterModel: { logic: "and", filters: [], sort: [] },
      steps: []
    },
    page: { offset: 0, limit: 200, totalRows: 0, columnIds: [], rows: [] },
    summaries: []
  };
}
