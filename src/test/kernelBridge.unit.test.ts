import type { Kernel } from "@vscode/jupyter-extension";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KernelBridge,
  NotebookFormatterPreparationPendingError,
  isIdempotentKernelReadRequest,
  withKernelSessionIdentity
} from "../extension/notebooks/kernelBridge";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type { OpenSessionRequest, OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";
import {
  cancellationSource,
  closeRequest,
  controllableKernel,
  controlledFakeKernel,
  controlledNonPySparkKernel,
  controlledPySparkKernel,
  createKernelBridge,
  deferred,
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
  unpinnedOpenRequest
} from "./kernelBridge.testFixtures";

afterEach(resetKernelBridgeTestState);

describe("kernel retry classification", () => {
  it("reports Spark preparation for pinned and auto-detected PySpark opens", async () => {
    const kernel = fakeKernel((request) => {
      if (request.kind === "openSession") {
        return openedResponse(request.requestedSessionId!, request.backend ?? "pyspark");
      }
      return initializedResponse;
    });
    mockKernel(kernel);
    const bridge = createKernelBridge();
    const sparkStages: string[] = [];

    await expect(
      bridge.request(openRequest(undefined, "pyspark"), {
        onOpenProgress: (stage) => sparkStages.push(stage)
      })
    ).resolves.toMatchObject({ kind: "sessionOpened", metadata: { backend: "pyspark" } });
    expect(sparkStages).toEqual(["acquiringKernel", "bootstrappingRuntime", "preparingSparkView"]);

    const polarsStages: string[] = [];
    await expect(
      createKernelBridge().request(openRequest(undefined, "polars"), {
        onOpenProgress: (stage) => polarsStages.push(stage)
      })
    ).resolves.toMatchObject({ kind: "sessionOpened", metadata: { backend: "polars" } });
    expect(polarsStages).toEqual(["acquiringKernel", "bootstrappingRuntime", "openingNotebookVariable"]);

    const autoDetectedSparkStages: string[] = [];
    await expect(
      createKernelBridge().request(unpinnedOpenRequest(), {
        onOpenProgress: (stage) => autoDetectedSparkStages.push(stage)
      })
    ).resolves.toMatchObject({ kind: "sessionOpened", metadata: { backend: "pyspark" } });
    expect(autoDetectedSparkStages).toEqual(["acquiringKernel", "bootstrappingRuntime", "preparingSparkView"]);
  });

  it("keeps an unpinned non-PySpark variable on the generic one-dispatch open path", async () => {
    const requests: OpenWranglerRequest[] = [];
    const controller = controlledNonPySparkKernel("pandas", requests);
    mockKernel(controller.kernel);
    const stages: string[] = [];

    await expect(
      createKernelBridge().request(unpinnedOpenRequest("auto-pandas"), {
        onOpenProgress: (stage) => stages.push(stage)
      })
    ).resolves.toMatchObject({ kind: "sessionOpened", metadata: { backend: "pandas", sessionId: "auto-pandas" } });

    expect(controller.preflightExecutionCount()).toBe(1);
    expect(requests.map((request) => request.kind)).toEqual(["openSession"]);
    expect(stages).toEqual(["acquiringKernel", "bootstrappingRuntime", "openingNotebookVariable"]);
  });

  it("rejects a pinned PySpark open when the variable is no longer a PySpark DataFrame", async () => {
    const requests: OpenWranglerRequest[] = [];
    const controller = controlledNonPySparkKernel("pandas", requests);
    mockKernel(controller.kernel);

    await expect(createKernelBridge().request(openRequest("stale-spark", "pyspark"))).rejects.toThrow(
      "The selected variable is no longer a supported PySpark DataFrame. Rerun the defining cell and try again."
    );
    expect(controller.preflightExecutionCount()).toBe(1);
    expect(requests).toEqual([]);
  });

  it.each([
    ["pinned 4.1", "4.1.3", openRequest("unsupported-pinned", "pyspark")],
    ["auto-detected 4.1", "4.1.3", unpinnedOpenRequest("unsupported-auto")],
    ["pinned 4.20", "4.20.0", openRequest("unsupported-future-minor", "pyspark")],
    ["auto-detected missing version", null, unpinnedOpenRequest("unsupported-missing")]
  ] as const)(
    "rejects an unsupported %s PySpark variable before runtime open dispatch",
    async (_label, version, request) => {
      const requests: OpenWranglerRequest[] = [];
      const controller = controlledPySparkKernel(version, requests);
      mockKernel(controller.kernel);
      const bridge = createKernelBridge();

      await expect(bridge.request(request)).rejects.toThrow("Open Wrangler requires PySpark 4.2.x");

      expect(controller.preflightExecutionCount()).toBe(1);
      expect(requests).toEqual([]);
    }
  );

  it("rejects a malformed PySpark probe with recovery guidance and zero runtime dispatch", async () => {
    const requests: OpenWranglerRequest[] = [];
    let preflightExecutions = 0;
    const controller = controllableKernel((code) => {
      if (code.includes("__OPEN_WRANGLER_PYSPARK_VERSION_START_")) {
        preflightExecutions += 1;
        return malformedPySparkPreflightExecution(code);
      }
      return kernelExecution(code, (request) => {
        requests.push(request);
        return initializedResponse;
      });
    });
    mockKernel(controller.kernel);

    await expect(createKernelBridge().request(openRequest("malformed-spark", "pyspark"))).rejects.toThrow(
      "Restart or reselect the kernel, rerun the cell that creates the DataFrame, and try again."
    );
    expect(preflightExecutions).toBe(1);
    expect(requests).toEqual([]);
  });

  it.each([
    ["supported", "4.2.0", true],
    ["unsupported", "4.3.0", false]
  ] as const)("reacquires and reprobes kernel B after a silent A→B switch (%s)", async (_label, versionB, opens) => {
    const requestsA: OpenWranglerRequest[] = [];
    const requestsB: OpenWranglerRequest[] = [];
    let currentKernel: Kernel;
    const kernelB = controlledPySparkKernel(versionB, requestsB);
    const kernelA = controlledPySparkKernel("4.2.0", requestsA, () => {
      currentKernel = kernelB.kernel;
    });
    currentKernel = kernelA.kernel;
    const getExtension = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel: async () => currentKernel } })
    } as never);
    const bridge = createKernelBridge();
    const operation = bridge.request(openRequest(`switch-${_label}`, "pyspark"));

    if (opens) {
      await expect(operation).resolves.toMatchObject({
        kind: "sessionOpened",
        metadata: { backend: "pyspark", sessionId: "switch-supported" }
      });
    } else {
      await expect(operation).rejects.toThrow("selected notebook kernel has PySpark 4.3.0");
    }

    expect(kernelA.preflightExecutionCount()).toBe(1);
    expect(requestsA).toEqual([]);
    expect(kernelB.preflightExecutionCount()).toBe(1);
    expect(requestsB.map((request) => request.kind)).toEqual(opens ? ["openSession"] : []);
    expect(getExtension).toHaveBeenCalledTimes(2);
  });

  it("reprobes a replacement kernel after an observed restart", async () => {
    const requestsA: OpenWranglerRequest[] = [];
    const requestsB: OpenWranglerRequest[] = [];
    const kernelA = controlledPySparkKernel("4.2.0", requestsA);
    const kernelB = controlledPySparkKernel("4.2.1", requestsB);
    let currentKernel = kernelA.kernel;
    const getExtension = vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel: async () => currentKernel } })
    } as never);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest("restart-a", "pyspark"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: "restart-a" }
    });
    currentKernel = kernelB.kernel;
    kernelA.setStatus("restarting");
    await expect(bridge.request(openRequest("restart-b", "pyspark"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: "restart-b" }
    });

    expect(kernelA.preflightExecutionCount()).toBe(1);
    expect(kernelB.preflightExecutionCount()).toBe(1);
    expect(requestsA.map((request) => request.kind)).toEqual(["openSession"]);
    expect(requestsB.map((request) => request.kind)).toEqual(["openSession"]);
    expect(getExtension).toHaveBeenCalledTimes(2);
  });

  it("never redirects a live-source recovery open to a newly selected kernel", async () => {
    const requestsA: OpenWranglerRequest[] = [];
    const requestsB: OpenWranglerRequest[] = [];
    const kernelA = controlledPySparkKernel("4.2.0", requestsA);
    const kernelB = controlledPySparkKernel("4.2.0", requestsB);
    let currentKernel = kernelA.kernel;
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel: async () => currentKernel } })
    } as never);
    const bridge = createKernelBridge();

    await expect(bridge.request(openRequest("originating-spark-session", "pyspark"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: "originating-spark-session" }
    });
    currentKernel = kernelB.kernel;

    await expect(
      bridge.request(openRequest("rebound-spark-session", "pyspark"), {
        requiredKernelSessionId: "originating-spark-session"
      })
    ).rejects.toThrow("recover the live variable on its originating kernel");

    expect(requestsA.map((request) => request.kind)).toEqual(["openSession"]);
    expect(requestsB).toEqual([]);
  });

  it("never redirects a panel open away from its exact executed-result kernel during bootstrap", async () => {
    const document = notebookDocument("/workspace/pinned-inline-panel.ipynb");
    setOpenNotebookDocuments(document);
    const bootstrapStarted = deferred<void>();
    const releaseBootstrap = deferred<void>();
    const requestsA: OpenWranglerRequest[] = [];
    const requestsB: OpenWranglerRequest[] = [];
    const kernelA = controllableKernel((code) => {
      if (!code.includes("__ow_payload =")) {
        return (async function* () {
          bootstrapStarted.resolve(undefined);
          await releaseBootstrap.promise;
          yield* [];
        })();
      }
      return kernelExecution(code, (request) => {
        requestsA.push(request);
        return request.kind === "openSession"
          ? openedResponse(request.requestedSessionId!, "polars")
          : initializedResponse;
      });
    });
    const kernelB = controlledFakeKernel((request) => {
      requestsB.push(request);
      return request.kind === "openSession"
        ? openedResponse(request.requestedSessionId!, "polars")
        : initializedResponse;
    });
    let currentKernel = kernelA.kernel;
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel: async () => currentKernel } })
    } as never);
    const binding = resultBinding(kernelA.kernel, "polars");
    type PinnedKernelBridgeConstructor = new (
      context: vscode.ExtensionContext,
      notebook: vscode.NotebookDocument,
      registerFormatters: boolean,
      fileOperations: Record<string, never>,
      requiredBinding: typeof binding
    ) => KernelBridge;
    const PinnedKernelBridge = KernelBridge as unknown as PinnedKernelBridgeConstructor;
    const bridge = new PinnedKernelBridge(
      { extensionPath: process.cwd() } as vscode.ExtensionContext,
      document,
      true,
      {},
      binding
    );

    const opening = bridge.request(openRequest("pinned-inline-panel", "polars"));
    await bootstrapStarted.promise;
    currentKernel = kernelB.kernel;
    releaseBootstrap.resolve(undefined);

    await expect(opening).rejects.toThrow("selected notebook kernel changed");
    expect(requestsA).toEqual([]);
    expect(requestsB).toEqual([]);
  });

  it("keeps a Viewing session when Editing mode would open on a newly selected Python kernel", async () => {
    const document = notebookDocument("/workspace/editing-kernel.ipynb");
    setOpenNotebookDocuments(document);
    const requestsA: OpenWranglerRequest[] = [];
    const requestsB: OpenWranglerRequest[] = [];
    const respond =
      (requests: OpenWranglerRequest[]) =>
      (request: OpenWranglerRequest): OpenWranglerResponse => {
        requests.push(request);
        if (request.kind === "openSession") {
          const opened = openedResponse(request.requestedSessionId!, "pandas");
          if (opened.kind !== "sessionOpened") throw new Error("Expected a session-opened fixture.");
          return {
            ...opened,
            metadata: {
              ...opened.metadata,
              source: request.source,
              mode: request.mode ?? "viewing",
              capabilities: {
                ...opened.metadata.capabilities,
                notebookInsert: true,
                supportedOperations: ["sortRows"]
              }
            }
          };
        }
        if (request.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        return initializedResponse;
      };
    const kernelA = controlledFakeKernel(respond(requestsA));
    const kernelB = controlledFakeKernel(respond(requestsB));
    let currentKernel = kernelA.kernel;
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel: async () => currentKernel } })
    } as never);
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(createKernelBridge(document), document);
    const source = {
      kind: "notebookVariable" as const,
      label: "orders",
      variableName: "orders",
      uri: document.uri.toString()
    };

    try {
      const opened = await bridge.request({ ...openRequest(undefined, "pandas"), source });
      if (opened.kind !== "sessionOpened") throw new Error("Expected the Viewing session to open.");
      currentKernel = kernelB.kernel;
      kernelA.setStatus("restarting");

      await expect(
        bridge.reconfigureLiveSessionMode?.(opened.metadata.sessionId, opened.metadata.revision, "editing", {
          columnWidths: new Map(),
          viewport: { firstVisibleRow: 0, scrollLeft: 0 }
        })
      ).resolves.toMatchObject({ kind: "error", code: "editing_mode_open_failed" });

      expect(requestsA.map((request) => request.kind)).toEqual(["openSession"]);
      expect(requestsB).toEqual([]);
      expect(coordinator.activeSession()).toMatchObject({
        sessionId: opened.metadata.sessionId,
        metadata: { mode: "viewing" }
      });
    } finally {
      await coordinator.shutdown();
    }
  });

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

  it("keeps formatter preparation single-flight after its host deadline until the kernel execution settles", async () => {
    vi.useFakeTimers();
    const formatterStarted = deferred<void>();
    const releaseFormatter = deferred<void>();
    let formatterExecutions = 0;
    const controller = controllableKernel((code) => {
      return (async function* () {
        if (code.includes("__ow_payload =")) return;
        formatterExecutions += 1;
        formatterStarted.resolve();
        await releaseFormatter.promise;
        yield { text: "" };
      })();
    });
    const getExtension = mockKernel(controller.kernel);
    const bridge = createKernelBridge();

    const first = bridge.prepareNotebookFormatter().then(
      () => undefined,
      (error: unknown) => error
    );
    await formatterStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    const timeout = await first;
    expect(timeout).toBeInstanceOf(NotebookFormatterPreparationPendingError);
    expect((timeout as NotebookFormatterPreparationPendingError).message).toContain("timed out after 30000 ms");

    await expect(bridge.prepareNotebookFormatter()).rejects.toBeInstanceOf(NotebookFormatterPreparationPendingError);
    expect(formatterExecutions).toBe(1);
    expect(controller.executionTokens()).toHaveLength(1);
    expect(controller.executionTokens()[0]?.isCancellationRequested).toBe(false);

    releaseFormatter.resolve();
    await expect((timeout as NotebookFormatterPreparationPendingError).settlement).resolves.toEqual({
      kind: "prepared"
    });
    await bridge.prepareNotebookFormatter();

    expect(formatterExecutions).toBe(1);
    expect(controller.executionTokens()).toHaveLength(1);
    expect(controller.executionTokens()[0]?.isCancellationRequested).toBe(false);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("allows a timed-out formatter retry only after the exact observed kernel generation changes", async () => {
    vi.useFakeTimers();
    const firstFormatterStarted = deferred<void>();
    let formatterExecutions = 0;
    const controller = controllableKernel((code) => {
      return (async function* () {
        if (code.includes("__ow_payload =")) return;
        formatterExecutions += 1;
        if (formatterExecutions === 1) {
          firstFormatterStarted.resolve();
          await new Promise<never>(() => undefined);
        }
        yield { text: "" };
      })();
    });
    const getExtension = mockKernel(controller.kernel);
    const bridge = createKernelBridge();

    const first = bridge.prepareNotebookFormatter().catch((error: unknown) => error);
    await firstFormatterStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    const timeout = await first;
    expect(timeout).toBeInstanceOf(NotebookFormatterPreparationPendingError);
    expect(formatterExecutions).toBe(1);

    controller.setStatus("restarting");
    controller.setStatus("idle");
    await expect((timeout as NotebookFormatterPreparationPendingError).settlement).resolves.toEqual({
      kind: "generationChanged"
    });
    await bridge.prepareNotebookFormatter();

    expect(formatterExecutions).toBe(2);
    expect(controller.executionTokens()).toHaveLength(2);
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
    expect(getExtension).toHaveBeenCalledTimes(2);
  });

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
        request.kind === "openSession"
          ? `open:${request.requestedSessionId}`
          : request.kind === "closeSession"
            ? `close:${request.sessionId}`
            : request.kind
      )
    ).toEqual(["open:old-duckdb-session", "close:old-duckdb-session"]);
    expect(
      replacementRequests.map((request) =>
        request.kind === "openSession"
          ? `open:${request.requestedSessionId}`
          : request.kind === "closeSession"
            ? `close:${request.sessionId}`
            : request.kind
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
      const staleRejection = expect(staleRequest).rejects.toMatchObject({
        name: "DetachedBridgeRequestError",
        reason: abortKind,
        dispatched: true
      });
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
      code: "unknown_session",
      sessionId: candidate
    });
    await expect(bridge.request(openRequest(candidate))).rejects.toThrow(`already retired kernel session ${candidate}`);
    expect(requests).toHaveLength(2);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it.each([
    ["pandas", "cancellation"],
    ["polars", "cancellation"],
    ["duckdb", "cancellation"],
    ["pyspark", "cancellation"],
    ["pyspark", "timeout"]
  ] as const)(
    "detaches a dispatched %s live open on host %s without interrupting Jupyter",
    async (backend, abortKind) => {
      if (abortKind === "timeout") vi.useFakeTimers();
      const openDispatched = deferred<void>();
      const releaseOpen = deferred<void>();
      const requests: OpenWranglerRequest[] = [];
      let openSettled = false;
      const controller = controlledFakeKernel(async (request) => {
        requests.push(request);
        if (request.kind === "openSession") {
          openDispatched.resolve();
          await releaseOpen.promise;
          openSettled = true;
          return openedResponse(request.requestedSessionId!, backend);
        }
        if (request.kind === "closeSession") {
          if (!openSettled) throw new Error("Candidate cleanup overtook its original open execution.");
          return { kind: "sessionClosed", sessionId: request.sessionId };
        }
        return initializedResponse;
      });
      const getExtension = mockKernel(controller.kernel);
      const bridge = createKernelBridge();
      const cancellation = cancellationSource();

      const pending = bridge.request(openRequest(undefined, backend), {
        ...(abortKind === "cancellation" ? { cancellation: cancellation.token } : {}),
        timeoutMs: 30
      });
      await openDispatched.promise;
      if (abortKind === "cancellation") cancellation.cancel();
      else await vi.advanceTimersByTimeAsync(30);

      await expect(pending).resolves.toMatchObject({
        kind: "error",
        code: "kernel_open_indeterminate",
        message: expect.stringContaining(`host ${abortKind}`)
      });
      // The cleanup must not even be dispatched until the exact open has
      // settled; an early unknown_session response is not authoritative.
      expect(requests.map((request) => request.kind)).toEqual(["openSession"]);
      expect(controller.executionTokens()).toHaveLength(backend === "pyspark" ? 3 : 2);
      expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
      bridge.onIdle();
      expect(controller.statusListenerCount()).toBe(1);

      if (abortKind === "timeout") vi.useRealTimers();
      releaseOpen.resolve();
      await vi.waitFor(() => expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]));
      expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
      expect(controller.executionTokens()).toHaveLength(backend === "pyspark" ? 4 : 3);
      expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
      await vi.waitFor(() => expect(controller.statusListenerCount()).toBe(0));
      expect(getExtension).toHaveBeenCalledOnce();
    }
  );

  it("bounds an exact close without interrupting it and retires a late correlated response", async () => {
    vi.useFakeTimers();
    const closeDispatched = deferred<void>();
    const releaseClose = deferred<void>();
    const requests: OpenWranglerRequest[] = [];
    const controller = controlledFakeKernel(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!, "pyspark");
      if (request.kind === "closeSession") {
        closeDispatched.resolve();
        await releaseClose.promise;
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      return initializedResponse;
    });
    mockKernel(controller.kernel);
    const bridge = createKernelBridge();
    await expect(bridge.request(openRequest("late-close", "pyspark"))).resolves.toMatchObject({
      kind: "sessionOpened"
    });

    const pending = bridge.request(closeRequest("late-close"), {
      timeoutMs: 30
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "DetachedBridgeRequestError",
      reason: "timeout",
      dispatched: true
    });
    await closeDispatched.promise;
    await vi.advanceTimersByTimeAsync(30);
    await rejection;

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(controller.executionTokens()).toHaveLength(4);
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
    releaseClose.resolve();
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(
        (bridge as unknown as { retiredSessionIds: ReadonlySet<string> }).retiredSessionIds.has("late-close")
      ).toBe(true)
    );

    await expect(bridge.request(openRequest("late-close", "pyspark"))).rejects.toThrow(
      "already retired kernel session late-close"
    );
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
  });

  it("detaches a timed-out page request without cancelling its Jupyter execution token", async () => {
    vi.useFakeTimers();
    const pageDispatched = deferred<void>();
    const releasePage = deferred<void>();
    const opened = openedResponse("safe-page-session", "pyspark") as Extract<
      OpenWranglerResponse,
      { kind: "sessionOpened" }
    >;
    const requests: OpenWranglerRequest[] = [];
    const controller = controlledFakeKernel(async (request) => {
      requests.push(request);
      if (request.kind === "openSession") return opened;
      if (request.kind === "getPage") {
        pageDispatched.resolve();
        await releasePage.promise;
        return {
          kind: "page",
          revision: 0,
          viewRequestId: request.viewRequestId,
          metadata: opened.metadata,
          page: { offset: 0, limit: request.limit, totalRows: 0, columnIds: [], rows: [] }
        };
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    mockKernel(controller.kernel);
    const bridge = createKernelBridge();
    await expect(bridge.request(openRequest("safe-page-session", "pyspark"))).resolves.toMatchObject({
      kind: "sessionOpened"
    });

    const pending = bridge.request(
      {
        kind: "getPage",
        sessionId: "safe-page-session",
        revision: 0,
        viewRequestId: "timed-page",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 16,
        filterModel: { logic: "and", filters: [], sort: [] }
      },
      { timeoutMs: 30 }
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "DetachedBridgeRequestError",
      reason: "timeout",
      dispatched: true
    });
    await pageDispatched.promise;
    await vi.advanceTimersByTimeAsync(30);
    await rejection;

    expect(controller.executionTokens()).toHaveLength(4);
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);

    releasePage.resolve();
    vi.useRealTimers();
    await expect(bridge.request(closeRequest("safe-page-session"))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "safe-page-session"
    });
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "getPage", "closeSession"]);
    expect(controller.executionTokens()).toHaveLength(5);
    expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
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

  it("returns cancellation before dispatch without acquiring a kernel or creating a candidate", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();
    const cancellation = cancellationSource();
    cancellation.cancel();

    await expect(
      bridge.request(openRequest(), { cancellation: cancellation.token, timeoutMs: 60_000 })
    ).resolves.toEqual({ kind: "cancelled", targetRequestId: "session-open" });
    expect(requests).toEqual([]);
    expect(getExtension).not.toHaveBeenCalled();
  });

  it("returns ordinary cancellation when an open reporting deadline expires before kernel acquisition", async () => {
    vi.useFakeTimers();
    const getKernel = vi.fn(() => new Promise<Kernel>(() => undefined));
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel } })
    } as never);
    const bridge = createKernelBridge();

    const pending = bridge.request(openRequest(), { timeoutMs: 30 });
    await vi.waitFor(() => expect(getKernel).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30);

    await expect(pending).resolves.toEqual({ kind: "cancelled", targetRequestId: "session-open" });
    expect((bridge as unknown as { sessionKernels: ReadonlyMap<string, Kernel> }).sessionKernels.size).toBe(0);
  });

  it.each(["timeout", "cancellation"] as const)(
    "joins one already-dispatched bootstrap after host %s instead of starting another kernel execution",
    async (abortKind) => {
      if (abortKind === "timeout") vi.useFakeTimers();
      const bootstrapStarted = deferred<void>();
      const releaseBootstrap = deferred<void>();
      let bootstrapExecutions = 0;
      const controller = controllableKernel((code) => {
        if (!code.includes("__ow_payload =")) {
          bootstrapExecutions += 1;
          return (async function* (): AsyncIterable<unknown> {
            bootstrapStarted.resolve(undefined);
            await releaseBootstrap.promise;
            yield* [];
          })();
        }
        return kernelExecution(code, (request) => {
          if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
          if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
          return initializedResponse;
        });
      });
      const getExtension = mockKernel(controller.kernel);
      const firstCancellation = cancellationSource();
      const secondCancellation = cancellationSource();
      const bridge = createKernelBridge();

      const first = bridge.request(openRequest("bootstrap-detached"), {
        timeoutMs: abortKind === "timeout" ? 30 : 60_000,
        ...(abortKind === "cancellation" ? { cancellation: firstCancellation.token } : {})
      });
      await bootstrapStarted.promise;
      if (abortKind === "timeout") await vi.advanceTimersByTimeAsync(30);
      else firstCancellation.cancel();
      await expect(first).resolves.toEqual({ kind: "cancelled", targetRequestId: "session-open" });

      // Coordinator release may request idleness immediately after the host
      // waiter detaches. The bridge must retain the in-flight bootstrap so a
      // fresh open joins it rather than queuing another executeCode call. A
      // second detached joiner must preserve that same generation for a third
      // request as well.
      bridge.onIdle();
      const joined = bridge.request(openRequest("bootstrap-joined"), {
        timeoutMs: abortKind === "timeout" ? 30 : 60_000,
        ...(abortKind === "cancellation" ? { cancellation: secondCancellation.token } : {})
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(bootstrapExecutions).toBe(1);
      expect(controller.executionTokens()).toHaveLength(1);
      expect(controller.executionTokens()[0]?.isCancellationRequested).toBe(false);
      if (abortKind === "timeout") await vi.advanceTimersByTimeAsync(30);
      else secondCancellation.cancel();
      await expect(joined).resolves.toEqual({ kind: "cancelled", targetRequestId: "session-open" });

      bridge.onIdle();
      const retry = bridge.request(openRequest("bootstrap-retry"), { timeoutMs: 60_000 });
      await Promise.resolve();
      await Promise.resolve();
      expect(bootstrapExecutions).toBe(1);
      expect(controller.executionTokens()).toHaveLength(1);

      releaseBootstrap.resolve(undefined);
      await expect(retry).resolves.toMatchObject({
        kind: "sessionOpened",
        metadata: { sessionId: "bootstrap-retry" }
      });
      expect(bootstrapExecutions).toBe(1);
      expect(controller.executionTokens()).toHaveLength(2);
      expect(controller.executionTokens().every((token) => !token.isCancellationRequested)).toBe(true);
      expect(getExtension).toHaveBeenCalledOnce();
      await expect(bridge.request(closeRequest("bootstrap-retry"))).resolves.toEqual({
        kind: "sessionClosed",
        sessionId: "bootstrap-retry"
      });
    }
  );

  it("does not retain a failed bootstrap marker while its retry acquisition is detached", async () => {
    vi.useFakeTimers();
    const hungRetryAcquisition = deferred<Kernel>();
    const failedBootstrap = controllableKernel((code) => {
      if (!code.includes("__ow_payload =")) {
        return (async function* (): AsyncIterable<unknown> {
          yield await Promise.reject(new Error("first bootstrap failed"));
        })();
      }
      return kernelExecution(code, () => initializedResponse);
    });
    const replacement = controlledFakeKernel((request) => {
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      return initializedResponse;
    });
    const retryAcquisitionStarted = deferred<void>();
    const getKernel = vi
      .fn<() => Promise<Kernel>>()
      .mockResolvedValueOnce(failedBootstrap.kernel)
      .mockImplementationOnce(() => {
        retryAcquisitionStarted.resolve(undefined);
        return hungRetryAcquisition.promise;
      })
      .mockResolvedValueOnce(replacement.kernel);
    vi.spyOn(vscode.extensions, "getExtension").mockReturnValue({
      activate: async () => ({ kernels: { getKernel } })
    } as never);
    const bridge = createKernelBridge();

    const detached = bridge.request(openRequest("failed-bootstrap"), { timeoutMs: 30 });
    await retryAcquisitionStarted.promise;
    await vi.advanceTimersByTimeAsync(30);
    await expect(detached).resolves.toEqual({ kind: "cancelled", targetRequestId: "session-open" });

    // This mirrors coordinator release after an open that never dispatched.
    // The rejected generation must not remain in detachedKernelOperations and
    // prevent onIdle from discarding the hung retry acquisition.
    bridge.onIdle();
    const reopened = bridge.request(openRequest("replacement-after-bootstrap-failure"), {
      timeoutMs: 60_000
    });
    await expect(reopened).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { sessionId: "replacement-after-bootstrap-failure" }
    });

    expect(getKernel).toHaveBeenCalledTimes(3);
    expect(failedBootstrap.executionTokens()).toHaveLength(1);
    expect(replacement.bootstrapExecutionCount()).toBe(1);
    expect(replacement.executionTokens()).toHaveLength(2);
    expect(
      [...failedBootstrap.executionTokens(), ...replacement.executionTokens()].every(
        (token) => !token.isCancellationRequested
      )
    ).toBe(true);
    await expect(bridge.request(closeRequest("replacement-after-bootstrap-failure"))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "replacement-after-bootstrap-failure"
    });

    hungRetryAcquisition.resolve(failedBootstrap.kernel);
    vi.useRealTimers();
  });

  it("classifies a pre-dispatch cancelled non-open request as host detachment, not transport loss", async () => {
    const kernel = fakeKernel(() => initializedResponse);
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();
    const cancellation = cancellationSource();
    cancellation.cancel();

    const outcome = await bridge
      .request(initializeRequest(), { cancellation: cancellation.token, timeoutMs: 60_000 })
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(DetachedBridgeRequestError);
    expect(outcome).toMatchObject({ reason: "cancellation", dispatched: false });
    expect(getExtension).not.toHaveBeenCalled();
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
    expect(controller.statusListenerCount()).toBe(1);
    expect(controller.statusListenerDisposalCount()).toBe(0);
    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "delayed-close-session"
    });
    bridge.onIdle();
    expect(controller.statusListenerCount()).toBe(0);
    expect(controller.statusListenerDisposalCount()).toBe(1);

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
      code: "unknown_session",
      sessionId: "already-absent-session"
    });
    await expect(bridge.request(openRequest(opened.metadata.sessionId))).rejects.toThrow(
      "already retired kernel session already-absent-session"
    );

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("retires only the exact kernel mapping after terminal session cleanup fails", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
      if (request.kind === "closeSession") {
        return {
          kind: "error",
          code: "session_cleanup_failed",
          message: "The stopped Spark session could not release its owned Open Wrangler frame.",
          recoverable: false,
          sessionId: request.sessionId
        };
      }
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();
    const opened = await bridge.request(openRequest("cleanup-failed-session"));
    if (opened.kind !== "sessionOpened") throw new Error("Expected the test session to open.");

    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toMatchObject({
      kind: "error",
      code: "session_cleanup_failed",
      recoverable: false,
      sessionId: "cleanup-failed-session"
    });
    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toMatchObject({
      kind: "error",
      code: "unknown_session",
      sessionId: "cleanup-failed-session"
    });
    await expect(bridge.request(openRequest(opened.metadata.sessionId))).rejects.toThrow(
      "already retired kernel session cleanup-failed-session"
    );

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });

  it("does not retire a kernel mapping for a malformed recoverable cleanup-failure response", async () => {
    const requests: OpenWranglerRequest[] = [];
    const kernel = fakeKernel((request) => {
      requests.push(request);
      if (request.kind === "openSession") return openedResponse(request.requestedSessionId!);
      if (request.kind === "closeSession") {
        return {
          kind: "error",
          code: "session_cleanup_failed",
          message: "Malformed cleanup response that still claims recovery is possible.",
          recoverable: true,
          sessionId: request.sessionId
        };
      }
      return initializedResponse;
    });
    const getExtension = mockKernel(kernel);
    const bridge = createKernelBridge();
    const opened = await bridge.request(openRequest("malformed-cleanup-session"));
    if (opened.kind !== "sessionOpened") throw new Error("Expected the test session to open.");

    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toMatchObject({
      kind: "error",
      code: "session_cleanup_failed",
      recoverable: true,
      sessionId: "malformed-cleanup-session"
    });
    await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toMatchObject({
      kind: "error",
      code: "session_cleanup_failed",
      recoverable: true,
      sessionId: "malformed-cleanup-session"
    });

    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession", "closeSession"]);
    expect(getExtension).toHaveBeenCalledOnce();
  });
});

describe("kernel data export publication", () => {
  it("sends only the reserved target to the kernel and reports the final destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-kernel-export-"));
    try {
      const destinationPath = join(directory, "cleaned.parquet");
      await writeFile(destinationPath, "prior destination");
      let runtimeExport: Extract<OpenWranglerRequest, { kind: "exportData" }> | undefined;
      const kernel = fakeKernel(async (request) => {
        if (request.kind === "openSession") return openedResponse(request.requestedSessionId!, "pandas");
        if (request.kind === "exportData") {
          runtimeExport = request;
          await writeFile(request.path, "PAR1cleanedPAR1");
          return {
            kind: "dataExported",
            revision: request.revision,
            path: request.path,
            format: request.options.format,
            shape: { rows: 1, columns: 1 }
          };
        }
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        return initializedResponse;
      });
      mockKernel(kernel);
      const bridge = createKernelBridge();
      const opened = await bridge.request(openRequest("kernel-export-session", "pandas"));
      if (opened.kind !== "sessionOpened") throw new Error("Expected the kernel session to open.");

      await expect(
        bridge.request({
          kind: "exportData",
          sessionId: opened.metadata.sessionId,
          revision: 0,
          path: destinationPath,
          options: { format: "parquet", rowAxisPolicy: "preserve" }
        })
      ).resolves.toMatchObject({ kind: "dataExported", path: destinationPath });

      expect(runtimeExport?.path).not.toBe(destinationPath);
      expect(runtimeExport?.targetIdentity).toEqual({
        device: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/u),
        inode: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/u)
      });
      expect(await readFile(destinationPath, "utf8")).toBe("PAR1cleanedPAR1");
      expect((await readdir(directory)).filter((entry) => entry.startsWith(".openwrangler-"))).toEqual([]);
      await expect(bridge.request(closeRequest(opened.metadata.sessionId))).resolves.toEqual({
        kind: "sessionClosed",
        sessionId: opened.metadata.sessionId
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
