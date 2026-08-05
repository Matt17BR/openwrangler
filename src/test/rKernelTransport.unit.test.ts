import type { Jupyter, Kernel, KernelStatus } from "@vscode/jupyter-extension";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import {
  R_KERNEL_TRANSPORT_VERSION,
  decodeRKernelResponseJson,
  encodeRKernelRequest,
  type RKernelRequest
} from "../extension/r/rKernelProtocol";
import { RKernelOpenDetachedError, RKernelSessionTransport } from "../extension/r/rKernelTransport";
import { R_KERNEL_RUNTIME_BINDING, buildRKernelBootstrapCode } from "../extension/r/rKernelRuntimeBundle";

const sessionId = "11111111-1111-4111-8111-111111111111";
const openRequestId = "22222222-2222-4222-8222-222222222222";
const pageRequestId = "33333333-3333-4333-8333-333333333333";
const closeRequestId = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setOpenNotebookDocuments();
});

describe("native R kernel runtime bundle", () => {
  it("embeds the pure-R runtime without referencing the extension filesystem", () => {
    const code = buildRKernelBootstrapCode({
      "frame_contract.R": "openwrangler_r_frame_contract <- list()\n",
      "kernel_agent.R": "openwrangler_r_kernel_agent <- list()\n"
    });

    expect(code).toContain(R_KERNEL_RUNTIME_BINDING);
    expect(code).toContain("jsonlite::base64_dec");
    expect(code).not.toContain("openwrangler_r_frame_contract <- list()");
    expect(code).not.toContain("extensionPath");
  });

  it("rejects incomplete and unexpected R runtime bundles", () => {
    expect(() => buildRKernelBootstrapCode({ "frame_contract.R": "" })).toThrow("incomplete");
    expect(() =>
      buildRKernelBootstrapCode({
        "frame_contract.R": "",
        "kernel_agent.R": "",
        "../escape.R": ""
      })
    ).toThrow("incomplete");
  });
});

describe("native R kernel protocol", () => {
  it("decodes a correlated typed page and rejects a stale request ID", () => {
    const encoded = JSON.stringify({
      transportVersion: R_KERNEL_TRANSPORT_VERSION,
      requestId: openRequestId,
      kind: "page",
      sessionId,
      page: minimalFramePage()
    });

    expect(decodeRKernelResponseJson(encoded, openRequestId)).toMatchObject({
      kind: "page",
      sessionId,
      page: { dataframeFlavor: "r.data.frame", shape: { rows: 1, columns: 1 } }
    });
    expect(() => decodeRKernelResponseJson(encoded, pageRequestId)).toThrow("stale or mis-correlated");
  });

  it("validates page windows and repeated stable sort identities before dispatch", () => {
    const valid = openRequest();
    expect(JSON.parse(encodeRKernelRequest(valid))).toEqual(valid);
    const repeated: RKernelRequest = {
      ...valid,
      payload: {
        ...valid.payload,
        page: {
          ...valid.payload.page,
          sorts: [sortRule(), sortRule()]
        }
      }
    };
    expect(() => encodeRKernelRequest(repeated)).toThrow("repeated column identity");
    expect(() =>
      encodeRKernelRequest({
        ...valid,
        payload: { ...valid.payload, variableName: String.fromCharCode(0xd800) }
      })
    ).toThrow("bounded string");
  });

  it("rejects extra or malformed request fields before kernel dispatch", () => {
    const valid = openRequest();
    const invalidRequests = [
      { ...valid, extra: true },
      { ...valid, payload: { ...valid.payload, extra: true } },
      { ...valid, payload: { ...valid.payload, page: { ...valid.payload.page, extra: true } } },
      {
        ...valid,
        payload: {
          ...valid.payload,
          page: { ...valid.payload.page, sorts: [{ ...sortRule(), extra: true }] }
        }
      },
      {
        ...valid,
        payload: {
          ...valid.payload,
          page: {
            ...valid.payload.page,
            sorts: [{ ...sortRule(), column: { ...sortRule().column, extra: true } }]
          }
        }
      }
    ];

    for (const request of invalidRequests) {
      expect(() => encodeRKernelRequest(request as unknown as RKernelRequest)).toThrow("invalid fields");
    }
    expect(() => encodeRKernelRequest(null as unknown as RKernelRequest)).toThrow("must be an object");
  });

  it("rejects malformed response fields and oversized diagnostics", () => {
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: 1,
          requestId: openRequestId,
          kind: "closed",
          sessionId,
          extra: true
        }),
        openRequestId
      )
    ).toThrow("invalid fields");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: 1,
          requestId: openRequestId,
          kind: "error",
          code: "runtime_error",
          message: "x".repeat(4_097),
          recoverable: false
        }),
        openRequestId
      )
    ).toThrow("UTF-8 byte limit");
    expect(() =>
      decodeRKernelResponseJson(
        JSON.stringify({
          transportVersion: 1,
          requestId: openRequestId,
          kind: "error",
          code: "unsupported-row-names",
          message: "legacy frame error",
          recoverable: false
        }),
        openRequestId
      )
    ).toThrow("invalid diagnostic code");
  });
});

describe("exact IRkernel session transport", () => {
  it("opens, pages, and closes one immutable R session on its exact kernel", async () => {
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "closeSession") {
        return response(request, { kind: "closed", sessionId: request.payload.sessionId });
      }
      return response(request, {
        kind: "page",
        sessionId: request.payload.sessionId,
        page: minimalFramePage()
      });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, pageRequestId, closeRequestId]);

    await expect(transport.open("frame", pageWindow())).resolves.toMatchObject({
      sessionId,
      page: { dataframeFlavor: "r.data.frame" }
    });
    await expect(transport.getPage(sessionId, pageWindow([sortRule()]))).resolves.toMatchObject({
      page: { rows: [{ id: "r:r:0" }] }
    });
    await expect(transport.close(sessionId)).resolves.toBeUndefined();

    expect(controller.bootstrapExecutions()).toBe(1);
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "getPage", "closeSession"]);
    expect(requests[1]).toMatchObject({
      payload: { page: { sorts: [{ column: { id: "r:c:0", name: "value" } }] } }
    });
  });

  it("rejects a replacement document with the same URI before dispatch", async () => {
    const controller = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId, page: minimalFramePage() })
    );
    let lookup = 0;
    const original = notebookDocument();
    const replacement = notebookDocument();
    setOpenNotebookDocuments(original);
    mockKernel(controller.kernel, async () => {
      lookup += 1;
      if (lookup === 2) setOpenNotebookDocuments(replacement);
      return controller.kernel;
    });
    const transport = createTransport(original, [sessionId, openRequestId]);

    await expect(transport.open("frame", pageWindow())).rejects.toThrow("no longer the sole open document");
    expect(controller.dispatchExecutions()).toBe(0);
  });

  it("invalidates mapped sessions when the exact IRkernel restarts", async () => {
    const controller = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() })
    );
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, pageRequestId]);
    const invalidated = vi.fn();
    transport.onDidInvalidateKernel(invalidated);

    await transport.open("frame", pageWindow());
    controller.setStatus("restarting");

    expect(invalidated).toHaveBeenCalledOnce();
    await expect(transport.getPage(sessionId, pageWindow())).rejects.toThrow("no live R kernel session");
  });

  it("closes only the host-created candidate when an open response names another session", async () => {
    const wrongSessionId = "55555555-5555-4555-8555-555555555555";
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") {
        return response(request, { kind: "page", sessionId: wrongSessionId, page: minimalFramePage() });
      }
      return response(request, { kind: "closed", sessionId: request.payload.sessionId });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    await expect(transport.open("frame", pageWindow())).rejects.toThrow("mismatched session identity");
    expect(
      requests.map((request) =>
        request.kind === "openSession" ? `open:${request.payload.sessionId}` : `close:${request.payload.sessionId}`
      )
    ).toEqual([`open:${sessionId}`, `close:${sessionId}`]);
    const attempts = (
      transport as unknown as {
        cleanupAttempts: WeakMap<Kernel, ReadonlyMap<string, Promise<boolean>>>;
      }
    ).cleanupAttempts.get(controller.kernel);
    expect(attempts?.size ?? 0).toBe(0);
  });

  it("retires a normal close that succeeds after the host deadline", async () => {
    vi.useFakeTimers();
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const controller = controlledRKernel(async (request) => {
      if (request.kind === "closeSession") {
        closeStarted.resolve();
        await releaseClose.promise;
        return response(request, { kind: "closed", sessionId: request.payload.sessionId });
      }
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    await transport.open("frame", pageWindow());
    const closing = transport.close(sessionId, { timeoutMs: 30 });
    const closeRejection = expect(closing).rejects.toThrow();
    await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    await closeRejection;
    expect(mappedSessions(transport).has(sessionId)).toBe(true);

    releaseClose.resolve();
    vi.useRealTimers();
    await vi.waitFor(() => expect(mappedSessions(transport).has(sessionId)).toBe(false));
  });

  it("keeps failed-open cleanup deduplicated until a late exact close settles", async () => {
    vi.useFakeTimers();
    const wrongSessionId = "55555555-5555-4555-8555-555555555555";
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const controller = controlledRKernel(async (request) => {
      if (request.kind === "openSession") {
        return response(request, { kind: "page", sessionId: wrongSessionId, page: minimalFramePage() });
      }
      closeStarted.resolve();
      await releaseClose.promise;
      return response(request, { kind: "closed", sessionId: request.payload.sessionId });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    const opening = transport.open("frame", pageWindow());
    const openRejection = expect(opening).rejects.toThrow("mismatched session identity");
    await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    await openRejection;
    expect(cleanupAttempts(transport, controller.kernel)?.size).toBe(1);
    expect(mappedSessions(transport).has(sessionId)).toBe(true);

    releaseClose.resolve();
    vi.useRealTimers();
    await vi.waitFor(() => expect(mappedSessions(transport).has(sessionId)).toBe(false));
    expect(cleanupAttempts(transport, controller.kernel)?.size ?? 0).toBe(0);
  });

  it("bounds retired session identity bookkeeping", () => {
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, []);
    const internals = transport as unknown as {
      rememberRetiredSessionId(sessionId: string): void;
      retiredSessionIds: ReadonlySet<string>;
    };

    for (let index = 0; index < 1_025; index += 1) {
      internals.rememberRetiredSessionId(`00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    }

    expect(internals.retiredSessionIds.size).toBe(1_024);
    expect(internals.retiredSessionIds.has("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(internals.retiredSessionIds.has("00000000-0000-4000-8000-000000000001")).toBe(true);
  });

  it("bounds pending failed-open cleanup bookkeeping", () => {
    const controller = controlledRKernel(async () => {
      throw new Error("should not dispatch");
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, []);
    const internals = transport as unknown as {
      rememberCleanupAttempt(kernel: Kernel, sessionId: string, attempt: Promise<boolean>): void;
      cleanupAttempts: WeakMap<Kernel, ReadonlyMap<string, Promise<boolean>>>;
    };

    for (let index = 0; index < 65; index += 1) {
      internals.rememberCleanupAttempt(
        controller.kernel,
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        new Promise<boolean>(() => undefined)
      );
    }

    const attempts = internals.cleanupAttempts.get(controller.kernel);
    expect(attempts?.size).toBe(64);
    expect(attempts?.has("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(attempts?.has("00000000-0000-4000-8000-000000000001")).toBe(true);
  });

  it("detaches host cancellation without interrupting IRkernel and cleans the candidate after settlement", async () => {
    const pending = deferred<unknown>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") return pending.promise;
      return response(request, { kind: "closed", sessionId: request.payload.sessionId });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const ids = [sessionId, openRequestId, closeRequestId];
    const transport = createTransport(document, ids);
    const cancellation = cancellationSource();
    const opening = transport.open("frame", pageWindow(), { cancellation: cancellation.token });
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    cancellation.cancel();
    await expect(opening).rejects.toBeInstanceOf(RKernelOpenDetachedError);
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);

    pending.resolve(response(requests[0]!, { kind: "page", sessionId, page: minimalFramePage() }));
    await vi.waitFor(() => expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]));
  });

  it("parks the next page request behind a cancelled page execution", async () => {
    const pendingPage = deferred<unknown>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "getPage" && request.requestId === pageRequestId) return pendingPage.promise;
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, pageRequestId, closeRequestId]);
    await transport.open("frame", pageWindow());

    const cancellation = cancellationSource();
    const firstPage = transport.getPage(sessionId, pageWindow(), { cancellation: cancellation.token }).then(
      (result) => result,
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    cancellation.cancel();
    const detached = await firstPage;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
    expect(detached).toMatchObject({ reason: "cancellation", dispatched: true });

    const nextPage = transport.getPage(sessionId, pageWindow());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(2);

    pendingPage.resolve(response(requests[1]!, { kind: "page", sessionId, page: minimalFramePage() }));
    await (detached as DetachedBridgeRequestError).settlement;
    await expect(nextPage).resolves.toMatchObject({ page: { rows: [{ id: "r:r:0" }] } });
    expect(requests.map((request) => request.requestId)).toEqual([openRequestId, pageRequestId, closeRequestId]);
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
  });

  it("parks the next page request behind a timed-out page execution", async () => {
    vi.useFakeTimers();
    const pageStarted = deferred<void>();
    const pendingPage = deferred<unknown>();
    const requests: RKernelRequest[] = [];
    const controller = controlledRKernel(async (request) => {
      requests.push(request);
      if (request.kind === "getPage" && request.requestId === pageRequestId) {
        pageStarted.resolve();
        return pendingPage.promise;
      }
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, pageRequestId, closeRequestId]);
    await transport.open("frame", pageWindow());

    const firstPage = transport.getPage(sessionId, pageWindow(), { timeoutMs: 30 }).then(
      (result) => result,
      (error: unknown) => error
    );
    await pageStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    const detached = await firstPage;
    expect(detached).toBeInstanceOf(DetachedBridgeRequestError);
    expect(detached).toMatchObject({ reason: "timeout", dispatched: true });

    const nextPage = transport.getPage(sessionId, pageWindow(), { timeoutMs: 1_000 });
    await Promise.resolve();
    expect(requests).toHaveLength(2);

    pendingPage.resolve(response(requests[1]!, { kind: "page", sessionId, page: minimalFramePage() }));
    await (detached as DetachedBridgeRequestError).settlement;
    await expect(nextPage).resolves.toMatchObject({ page: { rows: [{ id: "r:r:0" }] } });
    expect(requests.map((request) => request.requestId)).toEqual([openRequestId, pageRequestId, closeRequestId]);
  });

  it("rejects non-R kernels before bootstrap", async () => {
    const controller = controlledRKernel(async () => {
      throw new Error("should not dispatch");
    }, "python");
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);

    await expect(createTransport(document, [sessionId, openRequestId]).open("frame", pageWindow())).rejects.toThrow(
      "requires an R notebook kernel"
    );
    expect(controller.bootstrapExecutions()).toBe(0);
  });

  it("rejects an out-of-range host deadline before touching Jupyter", async () => {
    const getExtension = vi.spyOn(vscode.extensions, "getExtension");
    const document = notebookDocument();
    setOpenNotebookDocuments(document);

    await expect(
      createTransport(document, [sessionId]).open("frame", pageWindow(), { timeoutMs: 2_147_483_648 })
    ).rejects.toThrow("outside the supported integer range");
    expect(getExtension).not.toHaveBeenCalled();
  });

  it("makes disposal single-flight and rejects an open that is still preparing", async () => {
    const secondLookupStarted = deferred<void>();
    const releaseSecondLookup = deferred<Kernel>();
    const controller = controlledRKernel(async (request) =>
      response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() })
    );
    let lookups = 0;
    mockKernel(controller.kernel, async () => {
      lookups += 1;
      if (lookups === 2) {
        secondLookupStarted.resolve();
        return releaseSecondLookup.promise;
      }
      return controller.kernel;
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId]);

    const opening = transport.open("frame", pageWindow());
    await secondLookupStarted.promise;
    const firstDisposal = transport.dispose();
    const secondDisposal = transport.dispose();
    expect(firstDisposal).toBe(secondDisposal);
    releaseSecondLookup.resolve(controller.kernel);

    await expect(opening).rejects.toThrow("transport is disposed");
    await expect(firstDisposal).resolves.toBeUndefined();
    expect(controller.dispatchExecutions()).toBe(0);
    await expect(transport.open("frame", pageWindow())).rejects.toThrow("transport is disposed");
  });

  it("does not install a kernel observer after pre-dispatch timeout and disposal", async () => {
    vi.useFakeTimers();
    const lookupStarted = deferred<void>();
    const releaseLookup = deferred<Kernel>();
    const controller = controlledRKernel(async () => {
      throw new Error("should not dispatch");
    });
    mockKernel(controller.kernel, async () => {
      lookupStarted.resolve();
      return releaseLookup.promise;
    });
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId]);

    const opening = transport.open("frame", pageWindow(), { timeoutMs: 30 });
    const openRejection = expect(opening).rejects.toThrow("timed out after 30 ms");
    await lookupStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    await openRejection;
    await expect(transport.dispose()).resolves.toBeUndefined();

    releaseLookup.resolve(controller.kernel);
    vi.useRealTimers();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.statusListenerCount()).toBe(0);
    expect(controller.bootstrapExecutions()).toBe(0);
  });

  it("finishes host disposal even when the kernel close reports an error", async () => {
    const controller = controlledRKernel(async (request) => {
      if (request.kind === "closeSession") {
        return response(request, {
          kind: "error",
          code: "runtime_error",
          message: "close failed",
          recoverable: false
        });
      }
      return response(request, { kind: "page", sessionId: request.payload.sessionId, page: minimalFramePage() });
    });
    mockKernel(controller.kernel);
    const document = notebookDocument();
    setOpenNotebookDocuments(document);
    const transport = createTransport(document, [sessionId, openRequestId, closeRequestId]);

    await transport.open("frame", pageWindow());
    const disposal = transport.dispose();
    await expect(disposal).rejects.toThrow("could not close every R kernel session");

    expect(controller.statusListenerCount()).toBe(0);
    expect(mappedSessions(transport).size).toBe(0);
    expect(transport.dispose()).toBe(disposal);
    await expect(transport.open("frame", pageWindow())).rejects.toThrow("transport is disposed");
  });
});

function openRequest(): Extract<RKernelRequest, { kind: "openSession" }> {
  return {
    transportVersion: 1,
    requestId: openRequestId,
    kind: "openSession",
    payload: { sessionId, variableName: "frame", page: pageWindow() }
  };
}

function pageWindow(sorts: readonly ReturnType<typeof sortRule>[] = []) {
  return { rowOffset: 0, rowLimit: 100, columnOffset: 0, columnLimit: 100, sorts } as const;
}

function sortRule() {
  return { column: { id: "r:c:0", name: "value" }, direction: "asc", nulls: "last" } as const;
}

function minimalFramePage() {
  return {
    contractVersion: 1,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 1, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "automatic", keyColumnIds: [] },
    schema: [
      {
        id: "r:c:0",
        name: "value",
        position: 0,
        rawType: "integer",
        type: "integer",
        nullable: false,
        semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
      }
    ],
    page: {
      offset: 0,
      limit: 100,
      totalRows: 1,
      columnOffset: 0,
      columnLimit: 100,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }]
        }
      ]
    }
  } as const;
}

function response(request: RKernelRequest, body: Record<string, unknown>) {
  return { transportVersion: 1, requestId: request.requestId, ...body };
}

function createTransport(document: vscode.NotebookDocument, ids: readonly string[]): RKernelSessionTransport {
  let index = 0;
  return new RKernelSessionTransport({ extensionPath: process.cwd() } as vscode.ExtensionContext, document, () => {
    const id = ids[index++];
    if (!id) throw new Error("The test exhausted its deterministic IDs.");
    return id;
  });
}

function mappedSessions(transport: RKernelSessionTransport): ReadonlyMap<string, Kernel> {
  return (transport as unknown as { sessionKernels: ReadonlyMap<string, Kernel> }).sessionKernels;
}

function cleanupAttempts(
  transport: RKernelSessionTransport,
  kernel: Kernel
): ReadonlyMap<string, Promise<boolean>> | undefined {
  return (
    transport as unknown as {
      cleanupAttempts: WeakMap<Kernel, ReadonlyMap<string, Promise<boolean>>>;
    }
  ).cleanupAttempts.get(kernel);
}

interface ControlledRKernel {
  readonly kernel: Kernel;
  bootstrapExecutions(): number;
  dispatchExecutions(): number;
  executionTokens(): readonly vscode.CancellationToken[];
  statusListenerCount(): number;
  setStatus(status: KernelStatus): void;
}

function controlledRKernel(
  respond: (request: RKernelRequest) => unknown | Promise<unknown>,
  language = "r"
): ControlledRKernel {
  let bootstrapExecutions = 0;
  let dispatchExecutions = 0;
  let status: KernelStatus = "idle";
  const listeners = new Set<(status: KernelStatus) => unknown>();
  const tokens: vscode.CancellationToken[] = [];
  const kernel = {
    language,
    get status() {
      return status;
    },
    onDidChangeStatus(listener: (next: KernelStatus) => unknown) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    executeCode(code: string, token: vscode.CancellationToken) {
      tokens.push(token);
      if (!code.includes("__OPEN_WRANGLER_R_START_")) {
        bootstrapExecutions += 1;
        return emptyOutput();
      }
      dispatchExecutions += 1;
      return rKernelOutput(code, respond);
    }
  } as unknown as Kernel;
  return {
    kernel,
    bootstrapExecutions: () => bootstrapExecutions,
    dispatchExecutions: () => dispatchExecutions,
    executionTokens: () => tokens,
    statusListenerCount: () => listeners.size,
    setStatus(next) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    }
  };
}

async function* emptyOutput(): AsyncIterable<unknown> {}

async function* rKernelOutput(
  code: string,
  respond: (request: RKernelRequest) => unknown | Promise<unknown>
): AsyncIterable<unknown> {
  const marker = code.match(/__OPEN_WRANGLER_R_START_([a-f0-9]{32})__/)?.[1];
  const payload = code.match(/\.__ow_payload <- rawToChar\(jsonlite::base64_dec\("([A-Za-z0-9+/=]+)"\)\)/u)?.[1];
  if (!marker || !payload) throw new Error("The R kernel test could not decode the dispatch frame.");
  const request = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as RKernelRequest;
  const result = await respond(request);
  yield {
    text: [`__OPEN_WRANGLER_R_START_${marker}__`, JSON.stringify(result), `__OPEN_WRANGLER_R_END_${marker}__`].join(
      "\n"
    )
  };
}

function mockKernel(kernel: Kernel, getKernel: () => Promise<Kernel | undefined> = async () => kernel): void {
  const jupyter = { kernels: { getKernel } } as unknown as Jupyter;
  vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({ activate: async () => jupyter } as never);
}

function notebookDocument(): vscode.NotebookDocument {
  return { uri: vscode.Uri.file("/workspace/r-notebook.ipynb"), isClosed: false } as vscode.NotebookDocument;
}

function setOpenNotebookDocuments(...documents: vscode.NotebookDocument[]): void {
  Object.defineProperty(vscode.workspace, "notebookDocuments", { configurable: true, value: documents });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cancellationSource(): {
  readonly token: {
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
      onCancellationRequested(listener) {
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
