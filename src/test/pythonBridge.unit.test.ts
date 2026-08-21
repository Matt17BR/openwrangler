import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ErrorResponse,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope,
  SessionBoundRequest,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource
} from "../shared/protocol";
import type { CancellationTokenLike } from "../extension/dataBridge";
import {
  DEPENDENCY_GUARD_PROTOCOL,
  DependencyGuardCommandError,
  DependencyGuardCommandTimeoutError,
  DependencyInstallExitUnconfirmedError,
  getDependencyGuardStatus,
  type DependencyGuardStatus,
  type DependencyGuardValidation,
  type OwnedDependencyGuardCommand,
  type OwnedDependencyInstall,
  startDependencyGuardStatus,
  startDependencyGuardValidation,
  validateDependencyGuard,
  waitForDependencyInstallExit
} from "../extension/dependencyInstaller";
import * as pythonEnvironment from "../extension/pythonEnvironment";
import { PythonBridge } from "../extension/pythonBridge";
import { PythonDependencyProbeRegistry } from "../extension/pythonDependencyState";
import { requiredDependencies, type PythonDependency } from "../extension/pythonEnvironmentModel";
import { PythonRuntimeScopeRegistry } from "../extension/pythonRuntimeScopeRegistry";
import { PythonRuntimeTransport } from "../extension/pythonRuntimeTransport";
import { PythonSessionOwnership } from "../extension/pythonSessionOwnership";

vi.mock("../extension/pythonEnvironment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extension/pythonEnvironment")>();
  return {
    ...actual,
    probeDependencies: vi.fn(),
    resolvePythonEnvironment: vi.fn()
  };
});

vi.mock("../extension/dependencyInstaller", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extension/dependencyInstaller")>();
  return {
    ...actual,
    getDependencyGuardStatus: vi.fn(),
    startDependencyGuardStatus: vi.fn(),
    startDependencyGuardValidation: vi.fn(),
    validateDependencyGuard: vi.fn()
  };
});

const initializeRequest: OpenWranglerRequest = { kind: "initialize" };
const TEST_PACKAGE_ROOT_IDENTITY = testPackageRootIdentity("/env");
const TEST_EXECUTABLE_IDENTITY = testExecutableIdentity("/env/bin/python");
const TEST_DEPENDENCY_TOKEN = "11111111-1111-4111-8111-111111111111";
const TEST_DEPENDENCIES: readonly PythonDependency[] = requiredDependencies("pandas", {
  kind: "file",
  label: "legacy.xls",
  path: testPythonExecutablePath("/data/legacy.xls")
});
const TEST_DEPENDENCY_REQUIREMENTS = TEST_DEPENDENCIES.map((dependency) => dependency.installSpec);

beforeEach(() => {
  vi.mocked(getDependencyGuardStatus).mockReset().mockResolvedValue({
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "status",
    state: "clean",
    token: null
  });
  vi.mocked(validateDependencyGuard)
    .mockReset()
    .mockImplementation(async (_environment, expectedToken) => ({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "validated",
      token: expectedToken
    }));
  vi.mocked(startDependencyGuardStatus)
    .mockReset()
    .mockImplementation((environment, options) =>
      ownedDependencyGuardCommand("status", environment.executable, getDependencyGuardStatus(environment, options))
    );
  vi.mocked(startDependencyGuardValidation)
    .mockReset()
    .mockImplementation((environment, expectedToken, options) =>
      ownedDependencyGuardCommand(
        "validate",
        environment.executable,
        validateDependencyGuard(environment, expectedToken, options)
      )
    );
});

function testPackageRootIdentity(packageRoot: string): { device: string; inode: string } {
  let hash = 2_166_136_261;
  for (const codePoint of packageRoot) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return { device: "1", inode: String(hash >>> 0) };
}

function testExecutableIdentity(executable: string): {
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
} {
  const inode = testPackageRootIdentity(`executable:${executable}`).inode;
  return {
    device: "2",
    inode,
    size: String(16_384 + (Number(inode) % 4096)),
    mtimeNs: String(1_700_000_000_000_000_000n + BigInt(inode)),
    ctimeNs: String(1_700_000_100_000_000_000n + BigInt(inode))
  };
}

function testPythonExecutablePath(posixPath: string): string {
  return process.platform === "win32" ? win32.join("C:\\", ...posixPath.split("/").filter(Boolean)) : posixPath;
}

function testExtensionContext(): vscode.ExtensionContext {
  return {
    extensionPath: "/extension",
    asAbsolutePath: (relativePath: string) => join("/extension", relativePath)
  } as vscode.ExtensionContext;
}

describe("PythonBridge cancellation", () => {
  it("does not start the runtime when cancellation arrives during request preparation", async () => {
    const prepared = deferred<OpenWranglerRequest | ErrorResponse>();
    const token = new ManualCancellation();
    const harness = createHarness(() => prepared.promise);

    const response = harness.bridge.request(initializeRequest, { cancellation: token, timeoutMs: 5_000 });
    token.cancel();
    prepared.resolve(initializeRequest);

    await expect(response).resolves.toEqual({ kind: "cancelled", targetRequestId: "not-started" });
    expect(harness.ensureProcess).not.toHaveBeenCalled();
    expect(harness.writes()).toEqual([]);
  });

  it("retries one transient runtime-selection change before an open-session request is dispatched", async () => {
    const request = openSessionRequest(remoteFileSource());
    const prepare = vi
      .fn<(request: OpenWranglerRequest) => Promise<OpenWranglerRequest | ErrorResponse>>()
      .mockRejectedValueOnce(new pythonEnvironment.PythonEnvironmentResolutionSupersededError())
      .mockResolvedValueOnce(request);
    const harness = createHarness(prepare);

    const response = harness.bridge.request(request);
    await harness.waitForWrites(1);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(harness.ensureProcess).toHaveBeenCalledOnce();
    const dispatched = harness.writes()[0]!;
    expect(dispatched.request).toEqual(request);
    harness.respond(dispatched.requestId, openedFor(request, "session"));
    await expect(response).resolves.toMatchObject({ kind: "sessionOpened" });
  });

  it("bounds pre-dispatch open-session recovery to one retry when runtime selection keeps changing", async () => {
    const request = openSessionRequest(remoteFileSource());
    const prepare = vi.fn(async () => {
      throw new pythonEnvironment.PythonEnvironmentResolutionSupersededError();
    });
    const harness = createHarness(prepare);

    await expect(harness.bridge.request(request)).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed",
      recoverable: true
    });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(harness.ensureProcess).not.toHaveBeenCalled();
    expect(harness.writes()).toEqual([]);
  });

  it("never retries a runtime-selection error returned after the open-session request was dispatched", async () => {
    const request = openSessionRequest(remoteFileSource());
    const prepare = vi.fn(async () => request);
    const harness = createHarness(prepare);

    const response = harness.bridge.request(request);
    await harness.waitForWrites(1);
    const dispatched = harness.writes()[0]!;
    harness.respond(dispatched.requestId, {
      kind: "error",
      code: "runtime_selection_changed",
      message: "The runtime changed after dispatch.",
      recoverable: true
    });

    await expect(response).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(harness.writes()).toHaveLength(1);
  });

  it("aborts an unresolved scope selection and returns the existing not-started cancellation", async () => {
    const token = new ManualCancellation();
    const source = remoteSourceAt("/resolution/cancelled.csv");
    vi.mocked(pythonEnvironment.resolvePythonEnvironment)
      .mockReset()
      .mockImplementation(
        (_context, _resource, _broker, control) =>
          new Promise<pythonEnvironment.PythonEnvironment>((_resolve, reject) => {
            control?.signal?.addEventListener("abort", () => reject(control.signal?.reason), { once: true });
          })
      );
    const bridge = new PythonBridge(testExtensionContext());
    const raw = bridge as unknown as RawBridgeInternals;

    const response = bridge.request(openSessionRequest(source), { cancellation: token });
    await vi.waitFor(() => expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledOnce());
    const selection = raw.environmentSelections.get(source.uri!);
    expect(selection?.resolvedEnvironment).toBeUndefined();

    token.cancel();

    await expect(response).resolves.toEqual({ kind: "cancelled", targetRequestId: "not-started" });
    expect(selection?.resolutionController.signal.reason).toBeInstanceOf(
      pythonEnvironment.PythonEnvironmentResolutionCancelledError
    );
    await vi.waitFor(() => expect(raw.environmentSelections.has(source.uri!)).toBe(false));
    await bridge.shutdown();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
  });

  it("fails same-scope joiners stale when one caller cancels the shared unresolved selection", async () => {
    const cancellingToken = new ManualCancellation();
    const joinedToken = new ManualCancellation();
    const source = remoteSourceAt("/resolution/joined.csv");
    vi.mocked(pythonEnvironment.resolvePythonEnvironment)
      .mockReset()
      .mockImplementation(
        (_context, _resource, _broker, control) =>
          new Promise<pythonEnvironment.PythonEnvironment>((_resolve, reject) => {
            control?.signal?.addEventListener("abort", () => reject(control.signal?.reason), { once: true });
          })
      );
    const bridge = new PythonBridge(testExtensionContext());

    const cancelling = bridge.request(openSessionRequest(source), { cancellation: cancellingToken });
    const joined = bridge.request(openSessionRequest(source), { cancellation: joinedToken });
    await vi.waitFor(() => expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledOnce());

    cancellingToken.cancel();

    await expect(cancelling).resolves.toEqual({ kind: "cancelled", targetRequestId: "not-started" });
    await expect(joined).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed",
      recoverable: true
    });
    expect(joinedToken.isCancellationRequested).toBe(false);
    await bridge.shutdown();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
  });

  it("does not abort or evict a confirmed environment when cancellation arrives later", async () => {
    const token = new ManualCancellation();
    const source = remoteSourceAt("/resolution/confirmed.csv");
    const confirmedEnvironment: pythonEnvironment.PythonEnvironment = {
      executable: testPythonExecutablePath("/env/bin/python"),
      executableIdentity: TEST_EXECUTABLE_IDENTITY,
      packageRoot: "/env",
      packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
      version: "3.12.4",
      source: "configuration"
    };
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset().mockResolvedValue(confirmedEnvironment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });
    const bridge = new PythonBridge(testExtensionContext());
    const raw = bridge as unknown as RawBridgeInternals;
    const confirmed = await raw.processSelectionFor(openSessionRequest(source));
    await vi.waitFor(() => expect(confirmed.selection.resolvedEnvironment).toEqual(confirmedEnvironment));

    token.cancel();
    await expect(bridge.request(openSessionRequest(source), { cancellation: token })).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "not-started"
    });

    expect(confirmed.selection.resolutionController.signal.aborted).toBe(false);
    expect(raw.environmentSelections.get(source.uri!)).toBe(confirmed.selection);
    expect(confirmed.selection.resolvedEnvironment).toEqual(confirmedEnvironment);
    await bridge.shutdown();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  it.each<SessionBoundRequest>([
    {
      kind: "closeSession",
      sessionId: "candidate-session",
      revision: 0
    },
    {
      kind: "getSummary",
      sessionId: "confirmed-session",
      revision: 3,
      viewRequestId: "summary-after-runtime-stop",
      filterModel: { filters: [], sort: [] }
    }
  ])("does not start a stopped runtime for session-bound request $kind", async (request) => {
    const harness = createHarness();
    (harness.bridge as unknown as { process?: ChildProcessWithoutNullStreams }).process = undefined;

    await expect(harness.bridge.request(request)).resolves.toMatchObject({
      kind: "error",
      code: "unknown_session",
      message: expect.stringContaining(request.sessionId)
    });

    expect(harness.ensureProcess).not.toHaveBeenCalled();
    expect(harness.writes()).toEqual([]);
  });

  it("does not start a stopped runtime for a direct cancellation request", async () => {
    const harness = createHarness();
    (harness.bridge as unknown as { process?: ChildProcessWithoutNullStreams }).process = undefined;

    await expect(
      harness.bridge.request({ kind: "cancelRequest", targetRequestId: "missing-request" })
    ).resolves.toMatchObject({
      kind: "error",
      code: "cancellation_unavailable",
      message: expect.stringContaining("missing-request")
    });
    expect(harness.ensureProcess).not.toHaveBeenCalled();
    expect(harness.writes()).toEqual([]);
  });

  it("rejects a file request when selection changes after preparation resolves but before dispatch", async () => {
    const request = openSessionRequest(remoteFileSource());
    const prepared = deferred<OpenWranglerRequest | ErrorResponse>();
    const harness = createHarness(() => prepared.promise);

    const response = harness.bridge.request(request);
    harness.advanceSelectionEpoch();
    prepared.resolve(request);

    await expect(response).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(harness.ensureProcess).not.toHaveBeenCalled();
  });

  it("rejects a file request when selection changes while process acquisition is pending", async () => {
    const request = openSessionRequest(remoteFileSource());
    const processReady = deferred<ChildProcessWithoutNullStreams>();
    const harness = createHarness();
    harness.ensureProcess.mockReturnValue(processReady.promise);

    const response = harness.bridge.request(request);
    await vi.waitFor(() => expect(harness.ensureProcess).toHaveBeenCalledOnce());
    harness.advanceSelectionEpoch();
    processReady.resolve({} as ChildProcessWithoutNullStreams);

    await expect(response).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(harness.writes()).toEqual([]);
  });
});

describe("PythonBridge transport validation and timeout isolation", () => {
  it("uses the dedicated configured deadline for a cold session open", async () => {
    const configuration = vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(key: string, fallback: T): T =>
        (key === "sessionOpenTimeoutMs" ? 25 : key === "requestTimeoutMs" ? 5_000 : fallback) as T
    } as vscode.WorkspaceConfiguration);
    try {
      const harness = createHarness();
      const response = harness.bridge.request(openSessionRequest(remoteFileSource()));
      const outcome = response.catch((error: unknown) => error);
      await vi.waitFor(() => expect(harness.writes()[0]?.request.kind).toBe("openSession"));

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("openSession timed out after 25 ms");
      expect(harness.restart).toHaveBeenCalledOnce();
    } finally {
      configuration.mockRestore();
    }
  });
});

describe("PythonBridge process-slot routing", () => {
  it("keeps independent workspace sessions on their owning process even with the same interpreter", async () => {
    const harness = createMultiScopeHarness();
    const firstRequest = {
      ...openSessionRequest(remoteSourceAt("/first/data.csv")),
      requestedSessionId: "first-session"
    };
    const secondRequest = {
      ...openSessionRequest(remoteSourceAt("/second/data.csv")),
      requestedSessionId: "second-session"
    };

    const firstOpen = harness.bridge.request(firstRequest);
    const secondOpen = harness.bridge.request(secondRequest);
    await harness.waitForWrites("first", 1);
    await harness.waitForWrites("second", 1);
    expect(harness.sessionOwnership.confirmedOwner("first-session")).toBeUndefined();
    expect(harness.sessionOwnership.provisionalClaim("first-session")?.runtime).toBe(harness.runtimes.first);
    harness.respond("first", harness.writes("first")[0].requestId, openedFor(firstRequest, "first-session"));
    harness.respond("second", harness.writes("second")[0].requestId, openedFor(secondRequest, "second-session"));
    await expect(firstOpen).resolves.toMatchObject({ kind: "sessionOpened" });
    await expect(secondOpen).resolves.toMatchObject({ kind: "sessionOpened" });
    expect(harness.sessionOwnership.provisionalClaim("first-session")).toBeUndefined();
    expect(harness.sessionOwnership.confirmedOwner("first-session")).toBe(harness.runtimes.first);

    const closeFirst = harness.bridge.request({
      kind: "closeSession",
      sessionId: "first-session",
      revision: 0
    });
    await harness.waitForWrites("first", 2);
    expect(harness.writes("second")).toHaveLength(1);
    harness.respond("first", harness.writes("first")[1].requestId, {
      kind: "sessionClosed",
      sessionId: "first-session"
    });
    await expect(closeFirst).resolves.toEqual({ kind: "sessionClosed", sessionId: "first-session" });

    expect(harness.stopRuntime).toHaveBeenCalledOnce();
    expect(harness.stopRuntime).toHaveBeenCalledWith(
      harness.runtimes.first,
      "Open Wrangler runtime stopped after its last session closed."
    );
    expect(harness.runtimes.second.process).toBe(harness.processes.second);
    expect(harness.sessionOwnership.confirmedOwner("second-session")).toBe(harness.runtimes.second);
  });

  it("routes cancellation to the process that owns the pending request", async () => {
    const harness = createMultiScopeHarness();
    const token = new ManualCancellation();
    const request = {
      ...openSessionRequest(remoteSourceAt("/first/data.csv")),
      requestedSessionId: "first-candidate"
    };
    const response = harness.bridge.request(request, { cancellation: token, timeoutMs: 5_000 });
    await harness.waitForWrites("first", 1);

    token.cancel();
    await harness.waitForWrites("first", 2);
    expect(harness.writes("second")).toEqual([]);
    const original = harness.writes("first")[0];
    const cancellation = harness.writes("first")[1];
    expect(cancellation.request).toEqual({ kind: "cancelRequest", targetRequestId: original.requestId });

    harness.respond("first", cancellation.requestId, {
      kind: "cancelled",
      targetRequestId: original.requestId
    });
    harness.respond("first", original.requestId, {
      kind: "cancelled",
      targetRequestId: original.requestId
    });
    await expect(response).resolves.toEqual({ kind: "cancelled", targetRequestId: original.requestId });
    expect(harness.sessionOwnership.confirmedOwner("first-candidate")).toBeUndefined();
  });

  it("does not route ordinary session queries through an unconfirmed candidate reservation", async () => {
    const harness = createMultiScopeHarness();
    const request = {
      ...openSessionRequest(remoteSourceAt("/first/data.csv")),
      requestedSessionId: "pending-candidate"
    };
    const opening = harness.bridge.request(request);
    await harness.waitForWrites("first", 1);

    await expect(
      harness.bridge.request({
        kind: "getSummary",
        sessionId: "pending-candidate",
        revision: 0,
        viewRequestId: "pending-query",
        filterModel: { filters: [], sort: [] }
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "unknown_session",
      sessionId: "pending-candidate"
    });
    expect(harness.writes("first")).toHaveLength(1);

    const closing = harness.bridge.request({
      kind: "closeSession",
      sessionId: "pending-candidate",
      revision: 0
    });
    await harness.waitForWrites("first", 2);
    expect(harness.sessionOwnership.provisionalClaim("pending-candidate")?.state).toBe("closing");
    harness.respond("first", harness.writes("first")[1].requestId, {
      kind: "error",
      code: "engine_error",
      message: "Cleanup did not confirm absence.",
      recoverable: true,
      sessionId: "pending-candidate"
    });
    await expect(closing).resolves.toMatchObject({ kind: "error", code: "engine_error" });

    harness.respond("first", harness.writes("first")[0].requestId, openedFor(request, "pending-candidate"));
    await expect(opening).resolves.toMatchObject({
      kind: "error",
      code: "invalid_runtime_response",
      sessionId: "pending-candidate"
    });
    expect(harness.restartRuntime).toHaveBeenCalledWith(
      harness.runtimes.first,
      expect.stringContaining("reservation ended")
    );
  });

  it("forces a targeted restart when an open timeout explicitly suppresses generic restart", async () => {
    vi.useFakeTimers();
    try {
      const harness = createMultiScopeHarness();
      const request = {
        ...openSessionRequest(remoteSourceAt("/first/data.csv")),
        requestedSessionId: "timeout-candidate"
      };
      const opening = harness.bridge.request(request, {
        timeoutMs: 10,
        restartRuntimeOnTimeout: false
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.sessionOwnership.provisionalClaim("timeout-candidate")).toBeDefined();

      const rejection = expect(opening).rejects.toThrow("timed out after 10 ms");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(harness.sessionOwnership.provisionalClaim("timeout-candidate")).toBeUndefined();
      expect(harness.sessionOwnership.confirmedOwner("timeout-candidate")).toBeUndefined();
      expect(harness.restartRuntime).toHaveBeenCalledOnce();
      expect(harness.restartRuntime).toHaveBeenCalledWith(harness.runtimes.first, expect.stringContaining("timed out"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts only the timed-out process slot", async () => {
    vi.useFakeTimers();
    try {
      const harness = createMultiScopeHarness();
      const firstRequest = openSessionRequest(remoteSourceAt("/first/data.csv"));
      const secondRequest = openSessionRequest(remoteSourceAt("/second/data.csv"));
      const firstOpen = harness.bridge.request(firstRequest, { timeoutMs: 10 });
      const secondOpen = harness.bridge.request(secondRequest, { timeoutMs: 5_000 });
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.writes("first")).toHaveLength(1);
      expect(harness.writes("second")).toHaveLength(1);
      harness.respond("second", harness.writes("second")[0].requestId, openedFor(secondRequest, "second-session"));
      await expect(secondOpen).resolves.toMatchObject({ kind: "sessionOpened" });

      const rejection = expect(firstOpen).rejects.toThrow("timed out after 10 ms");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(harness.restartRuntime).toHaveBeenCalledOnce();
      expect(harness.restartRuntime).toHaveBeenCalledWith(harness.runtimes.first, expect.stringContaining("timed out"));
      expect(harness.runtimes.second.process).toBe(harness.processes.second);
      expect(harness.sessionOwnership.confirmedOwner("second-session")).toBe(harness.runtimes.second);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PythonBridge process lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
  });

  it("reports the runtime as running until graceful shutdown confirms process exit", async () => {
    const { bridge, internals, process } = createLifecycleHarness();

    expect(bridge.runtimeRunning).toBe(true);
    bridge.onIdle();

    expect(process.stdin.end).toHaveBeenCalledOnce();
    expect(bridge.runtimeRunning).toBe(true);
    const stopping = internals.processStop;
    expect(stopping).toBeDefined();

    process.emit("exit", 0, null);
    await expect(stopping).resolves.toBeUndefined();
    await Promise.resolve();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("joins terminal shutdown until the exact process exits and disposes owned resources once", async () => {
    const { bridge, internals, process, configurationSubscription, output } = createLifecycleHarness();

    const first = bridge.shutdown();
    const second = bridge.shutdown();

    expect(second).toBe(first);
    expect(internals.disposed).toBe(true);
    expect(process.stdin.end).toHaveBeenCalledOnce();
    expect(configurationSubscription.dispose).toHaveBeenCalledOnce();
    expect(output.dispose).not.toHaveBeenCalled();

    process.emit("exit", 0, null);
    await expect(first).resolves.toBeUndefined();
    expect(output.dispose).toHaveBeenCalledOnce();

    bridge.dispose();
    await expect(bridge.shutdown()).resolves.toBeUndefined();
    expect(configurationSubscription.dispose).toHaveBeenCalledOnce();
    expect(output.dispose).toHaveBeenCalledOnce();
  });

  it("still stops the child and disposes output when configuration-listener disposal fails", async () => {
    const { bridge, process, configurationSubscription, output } = createLifecycleHarness();
    const listenerFailure = new Error("configuration listener disposal failed");
    configurationSubscription.dispose.mockImplementation(() => {
      throw listenerFailure;
    });

    const shutdown = bridge.shutdown();
    expect(process.stdin.end).toHaveBeenCalledOnce();
    expect(output.dispose).not.toHaveBeenCalled();

    process.emit("exit", 0, null);
    await expect(shutdown).rejects.toBe(listenerFailure);
    expect(output.dispose).toHaveBeenCalledOnce();
  });

  it("still stops the child when the shutdown diagnostic channel is unavailable", async () => {
    const { bridge, process, output } = createLifecycleHarness();
    output.appendLine.mockImplementationOnce(() => {
      throw new Error("diagnostic channel unavailable");
    });

    const shutdown = bridge.shutdown();
    expect(process.stdin.end).toHaveBeenCalledOnce();

    process.emit("exit", 0, null);
    await expect(shutdown).resolves.toBeUndefined();
    expect(output.dispose).toHaveBeenCalledOnce();
  });

  it("retains process-stop and output-disposal failures in cleanup order", async () => {
    vi.useFakeTimers();
    const { bridge, process, output } = createLifecycleHarness();
    const outputFailure = new Error("output disposal failed");
    output.dispose.mockImplementation(() => {
      throw outputFailure;
    });

    const shutdown = bridge.shutdown();
    const rejected = shutdown.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    const error = await rejected;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringContaining("could not confirm that its Python runtime exited")
    });
    expect((error as AggregateError).errors[1]).toBe(outputFailure);
    expect(process.kill).toHaveBeenCalledOnce();

    process.emit("exit", null, "SIGKILL");
  });

  it("awaits every process slot and preserves shutdown failures in stable slot order", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process: first } = createLifecycleHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const second = new LifecycleChildProcess();
    first.kill.mockReturnValue(false);
    second.kill.mockImplementation(() => {
      throw new Error("second slot termination failed");
    });
    const secondRuntime = testRuntimeSlot(
      "second-scope",
      second as unknown as ChildProcessWithoutNullStreams,
      internals.runtime.processSelection
    );
    raw.runtimeSlots.set(secondRuntime.key, secondRuntime);

    const shutdown = bridge.shutdown();
    const rejected = shutdown.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    const error = await rejected;

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringContaining("operating system did not accept the termination signal")
    });
    expect((error as AggregateError).errors[1]).toMatchObject({
      message: expect.stringContaining("second slot termination failed")
    });
    first.emit("exit", null, "SIGKILL");
    second.emit("exit", null, "SIGKILL");
  });

  it("surfaces missing exit confirmation through awaited shutdown while synchronous dispose observes it", async () => {
    vi.useFakeTimers();
    const { bridge, process, configurationSubscription, output } = createLifecycleHarness();

    const shutdown = bridge.shutdown();
    bridge.dispose();
    const rejection = expect(shutdown).rejects.toThrow("could not confirm that its Python runtime exited");

    await vi.advanceTimersByTimeAsync(4_000);
    await rejection;
    expect(process.kill).toHaveBeenCalledOnce();
    expect(configurationSubscription.dispose).toHaveBeenCalledOnce();
    expect(output.dispose).toHaveBeenCalledOnce();
    expect(bridge.shutdown()).toBe(shutdown);

    process.emit("exit", null, "SIGKILL");
  });

  it("does not start a replacement until the preceding shutdown settles", async () => {
    const { internals } = createLifecycleHarness();
    const stopping = deferred<void>();
    internals.process = undefined;
    internals.processStop = stopping.promise;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockClear();

    const starting = internals.ensureProcess(initializeRequest);
    await Promise.resolve();
    expect(internals.spawnProcess).not.toHaveBeenCalled();

    internals.runtimeEpoch += 1;
    stopping.resolve(undefined);
    await expect(starting).rejects.toThrow("runtime start was cancelled");
    expect(internals.spawnProcess).not.toHaveBeenCalled();
  });

  it("fails closed instead of spawning after forced shutdown lacks exit confirmation", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process } = createLifecycleHarness();
    const raw = bridge as unknown as RawBridgeInternals;

    bridge.onIdle();
    const stopping = internals.processStop;
    expect(stopping).toBeDefined();
    addInactiveScopePressure(raw, 160, "failed-stop-pressure");
    expect(raw.runtimeSlots.get(internals.runtime.key)).toBe(internals.runtime);
    expect(internals.runtime.leaseCount).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(4_000);
    const stopFailure = await stopping!.catch((error: unknown) => error);
    expect(stopFailure).toMatchObject({
      message: expect.stringContaining("could not confirm that its Python runtime exited")
    });
    expect(process.kill).toHaveBeenCalledOnce();
    expect(bridge.runtimeRunning).toBe(true);
    expect(raw.runtimeSlots.get(internals.runtime.key)).toBe(internals.runtime);
    expect(internals.runtime.stoppingProcesses.has(process as unknown as ChildProcessWithoutNullStreams)).toBe(true);
    await expect(internals.ensureProcess(initializeRequest)).rejects.toThrow(
      "could not confirm shutdown of its previous Python runtime"
    );
    expect(internals.spawnProcess).not.toHaveBeenCalled();
    expect(raw.runtimeSlots.get(internals.runtime.key)).toBe(internals.runtime);

    const shutdown = bridge.shutdown();
    await expect(shutdown).rejects.toBe(stopFailure);
    expect(raw.runtimeSlots.get(internals.runtime.key)).toBe(internals.runtime);
    expect(bridge.runtimeRunning).toBe(true);

    process.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("releases an overlapping rejected stop barrier after every exact child later exits", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process: first } = createLifecycleHarness();
    const second = new LifecycleChildProcess();
    internals.process = undefined;

    internals.trackProcessStop(first as unknown as ChildProcessWithoutNullStreams, 0);
    await vi.advanceTimersByTimeAsync(1_000);
    internals.trackProcessStop(second as unknown as ChildProcessWithoutNullStreams, 0);
    const overlappingStop = internals.processStop;
    expect(overlappingStop).toBeDefined();
    let stopSettled = false;
    void overlappingStop?.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      }
    );
    const rejection = expect(overlappingStop).rejects.toThrow("could not confirm that its Python runtime exited");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopSettled).toBe(false);
    expect(bridge.runtimeRunning).toBe(true);

    second.emit("exit", null, "SIGKILL");
    await rejection;
    expect(stopSettled).toBe(true);
    expect(bridge.runtimeRunning).toBe(true);

    first.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(internals.processStop).toBeUndefined();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("waits for and preserves every overlapping bounded stop failure in order", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process: first } = createLifecycleHarness();
    const second = new LifecycleChildProcess();
    first.kill.mockReturnValue(false);
    second.kill.mockImplementation(() => {
      throw new Error("second child termination threw");
    });
    internals.process = undefined;

    internals.trackProcessStop(first as unknown as ChildProcessWithoutNullStreams, 0);
    internals.trackProcessStop(second as unknown as ChildProcessWithoutNullStreams, 0);
    const overlappingStop = internals.processStop;
    expect(overlappingStop).toBeDefined();
    const rejected = overlappingStop?.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringContaining("operating system did not accept the termination signal")
    });
    expect((error as AggregateError).errors[1]).toMatchObject({
      message: expect.stringContaining("second child termination threw")
    });
    expect(bridge.runtimeRunning).toBe(true);

    first.emit("exit", null, "SIGKILL");
    second.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(internals.processStop).toBeUndefined();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("releases a pre-exited overlapping child independently of an earlier failed stop", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process: first } = createLifecycleHarness();
    const alreadyExited = new LifecycleChildProcess();
    alreadyExited.exitCode = 0;
    internals.process = undefined;

    internals.trackProcessStop(first as unknown as ChildProcessWithoutNullStreams, 0);
    internals.trackProcessStop(alreadyExited as unknown as ChildProcessWithoutNullStreams, 0);
    const overlappingStop = internals.processStop;
    expect(overlappingStop).toBeDefined();
    const rejection = expect(overlappingStop).rejects.toThrow("could not confirm that its Python runtime exited");

    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(bridge.runtimeRunning).toBe(true);

    first.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(internals.processStop).toBeUndefined();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("forces restart termination immediately but retains ownership until exit", async () => {
    vi.useFakeTimers();
    const { bridge, internals, process } = createLifecycleHarness();

    bridge.restart("Acceptance restart.");

    expect(process.kill).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(bridge.runtimeRunning).toBe(true);
    const stopping = internals.processStop;
    expect(stopping).toBeDefined();
    process.emit("exit", null, "SIGTERM");
    await expect(stopping).resolves.toBeUndefined();
    await Promise.resolve();
    expect(bridge.runtimeRunning).toBe(false);
  });

  it("spawns one replacement only after restart observes the prior process exit", async () => {
    const { bridge, internals, process } = createLifecycleHarness();
    const replacement = new LifecycleChildProcess();
    internals.spawnProcess.mockReturnValue(replacement as unknown as ChildProcessWithoutNullStreams);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      executable: testPythonExecutablePath("/env/bin/python"),
      executableIdentity: TEST_EXECUTABLE_IDENTITY,
      packageRoot: "/env",
      packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
      version: "3.12.4",
      source: "configuration"
    });

    bridge.restart("Acceptance restart.");
    const starting = internals.ensureProcess(initializeRequest);
    await Promise.resolve();
    await Promise.resolve();
    expect(internals.spawnProcess).not.toHaveBeenCalled();

    process.emit("exit", null, "SIGKILL");
    await expect(starting).resolves.toBe(replacement);
    expect(internals.spawnProcess).toHaveBeenCalledOnce();
    const [executable, args, options] = internals.spawnProcess.mock.calls[0] ?? [];
    expect(executable).toBe(testPythonExecutablePath("/env/bin/python"));
    expect(args).toEqual(["-s", "-m", "openwrangler_runtime.server"]);
    expect(options).toMatchObject({
      cwd: "/extension",
      shell: false,
      windowsHide: true,
      env: expect.objectContaining({
        PYTHONNOUSERSITE: "1",
        PYTHONPATH: join("/extension", "python"),
        PYTHONSAFEPATH: "1"
      })
    });

    bridge.restart("Acceptance cleanup.");
    const cleanup = internals.processStop;
    replacement.emit("exit", null, "SIGKILL");
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("rejects an unpinned runtime executable before spawning", async () => {
    const { internals } = createLifecycleHarness();
    internals.process = undefined;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      executable: process.platform === "win32" ? "\\root-relative\\python.exe" : "python3",
      executableIdentity: TEST_EXECUTABLE_IDENTITY,
      packageRoot: "/env",
      packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
      version: "3.12.4",
      source: "configuration"
    });

    await expect(internals.ensureProcess(initializeRequest)).rejects.toThrow(
      "requires an absolute Python executable path"
    );
    expect(internals.spawnProcess).not.toHaveBeenCalled();
  });

  it("keeps a concurrent reopen attached to its exact slot while the prior process stops", async () => {
    const { bridge, internals, process } = createLifecycleHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const replacement = new LifecycleChildProcess();
    internals.spawnProcess.mockReturnValue(replacement as unknown as ChildProcessWithoutNullStreams);

    bridge.onIdle();
    const stopping = internals.processStop;
    expect(stopping).toBeDefined();
    const reopening = internals.ensureProcess(initializeRequest);
    await Promise.resolve();
    await Promise.resolve();
    expect(internals.spawnProcess).not.toHaveBeenCalled();

    addInactiveScopePressure(raw, 160, "reopen-pressure");
    expect(raw.runtimeSlots.get(internals.runtime.key)).toBe(internals.runtime);
    expect(internals.runtime.leaseCount).toBeGreaterThanOrEqual(2);

    process.emit("exit", 0, null);
    await expect(stopping).resolves.toBeUndefined();
    await expect(reopening).resolves.toBe(replacement);
    expect(internals.spawnProcess).toHaveBeenCalledOnce();
    expect(raw.runtimeSlots.get(internals.runtime.key)).toBe(internals.runtime);
    expect(internals.runtime.process).toBe(replacement);

    bridge.onIdle();
    const cleanup = internals.processStop;
    replacement.emit("exit", 0, null);
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("rotates the shared process only after a different selected interpreter shuts down cleanly", async () => {
    const { bridge, internals, process } = createLifecycleHarness();
    const replacement = new LifecycleChildProcess();
    const nextEnvironment = {
      executable: testPythonExecutablePath("/second-env/bin/python"),
      executableIdentity: testExecutableIdentity("/second-env/bin/python"),
      packageRoot: "/second-env",
      packageRootIdentity: testPackageRootIdentity("/second-env"),
      version: "3.13.2",
      source: "pythonExtension" as const
    };
    internals.spawnProcess.mockReturnValue(replacement as unknown as ChildProcessWithoutNullStreams);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(nextEnvironment);

    const starting = internals.ensureProcess(openSessionRequest(remoteFileSource()));
    await vi.waitFor(() => expect(process.stdin.end).toHaveBeenCalledOnce());
    expect(internals.spawnProcess).not.toHaveBeenCalled();

    process.emit("exit", 0, null);
    await expect(starting).resolves.toBe(replacement);
    expect(internals.spawnProcess).toHaveBeenCalledOnce();
    expect(internals.spawnProcess.mock.calls[0]?.[0]).toBe(nextEnvironment.executable);

    bridge.restart("Interpreter rotation cleanup.");
    const cleanup = internals.processStop;
    replacement.emit("exit", null, "SIGKILL");
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("reuses the shared process when another resource resolves to the same interpreter", async () => {
    const { internals, process } = createLifecycleHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      executable: testPythonExecutablePath("/env/bin/python"),
      executableIdentity: TEST_EXECUTABLE_IDENTITY,
      packageRoot: "/env",
      packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
      version: "3.12.4",
      source: "pythonExtension"
    });

    await expect(internals.ensureProcess(openSessionRequest(remoteFileSource()))).resolves.toBe(process);
    expect(process.stdin.end).not.toHaveBeenCalled();
    expect(internals.spawnProcess).not.toHaveBeenCalled();
  });
});

describe("PythonBridge trusted pickle preflight", () => {
  afterEach(() => {
    setWorkspaceTrust(true);
    vi.restoreAllMocks();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  it("probes the conversion dependencies and re-resolves only immediately before execution", async () => {
    setWorkspaceTrust(true);
    const source = vscode.Uri.file("/workspace/orders.pkl");
    const environment: pythonEnvironment.PythonEnvironment = {
      executable: testPythonExecutablePath("/env/bin/python"),
      executableIdentity: TEST_EXECUTABLE_IDENTITY,
      packageRoot: "/env",
      packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
      version: "3.12.4",
      source: "configuration"
    };
    const context = testExtensionContext();
    const bridge = new PythonBridge(context);
    const raw = bridge as unknown as RawBridgeInternals;
    const ensureProcess = vi.spyOn(raw, "ensureProcess");
    const spawnProcess = vi.fn();
    const unrelatedTarget = missingDependencies();
    raw.lastMissingDependencies = unrelatedTarget;
    Object.assign(bridge as object, { spawnProcess });
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({
      missing: ["pandas>=2.3.3,<4", "pyarrow>=25,<26"],
      available: []
    });
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);

    try {
      const preflight = await bridge.preflightTrustedPickleConversion(source);

      expect(preflight).toEqual({
        executable: environment.executable,
        version: environment.version,
        source: environment.source,
        missing: ["pandas>=2.3.3,<4", "pyarrow>=25,<26"]
      });
      expect(pythonEnvironment.probeDependencies).toHaveBeenCalledWith(environment.executable, [
        {
          importModule: "pandas",
          distribution: "pandas",
          installSpec: "pandas>=2.3.3,<4",
          minimumVersion: "2.3.3",
          maximumVersionExclusive: "4"
        },
        {
          importModule: "pyarrow",
          distribution: "pyarrow",
          installSpec: "pyarrow>=25,<26",
          minimumVersion: "25",
          maximumVersionExclusive: "26"
        }
      ]);
      expect(raw.lastMissingDependencies).toBe(unrelatedTarget);

      const leaseGate = deferred<void>();
      const leasedConversion = bridge.withTrustedPicklePreflightLease(preflight, () => leaseGate.promise);
      await expect(bridge.installTrustedPickleDependencies(preflight)).resolves.toBe(false);
      expect(warning).not.toHaveBeenCalled();
      leaseGate.resolve();
      await expect(leasedConversion).resolves.toBeUndefined();

      await expect(bridge.installTrustedPickleDependencies(preflight)).resolves.toBe(false);
      expect(warning).toHaveBeenCalledWith(
        `Install pandas>=2.3.3,<4, pyarrow>=25,<26 into ${environment.executable}?`,
        { modal: true, detail: "Open Wrangler never installs packages without this confirmation." },
        "Install"
      );
      expect(raw.lastMissingDependencies).toBe(unrelatedTarget);

      vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockClear();
      expect(bridge.isTrustedPicklePreflightCurrent(preflight)).toBe(true);
      expect(bridge.isTrustedPicklePreflightCurrent(preflight)).toBe(true);
      expect(pythonEnvironment.resolvePythonEnvironment).not.toHaveBeenCalled();

      await expect(bridge.revalidateTrustedPicklePreflight(preflight)).resolves.toBe(true);
      expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledOnce();
      expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledWith(
        context,
        source,
        expect.anything(),
        expect.objectContaining({ isCurrent: expect.any(Function), isTrusted: expect.any(Function) })
      );

      bridge.clearRuntimeSelection();
      vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockClear();
      expect(bridge.isTrustedPicklePreflightCurrent(preflight)).toBe(false);
      await expect(bridge.revalidateTrustedPicklePreflight(preflight)).resolves.toBe(false);
      expect(pythonEnvironment.resolvePythonEnvironment).not.toHaveBeenCalled();
      expect(ensureProcess).not.toHaveBeenCalled();
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(bridge.runtimeRunning).toBe(false);
    } finally {
      await bridge.shutdown();
    }
  });
});

describe("PythonBridge dependency installation", () => {
  const originalExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;

  beforeEach(() => {
    delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    setWorkspaceTrust(true);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  afterEach(() => {
    if (originalExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    else process.env.OPEN_WRANGLER_EXTENSION_TESTS = originalExtensionTests;
    setWorkspaceTrust(true);
    vi.restoreAllMocks();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  it("requires the exact production modal and retains its diagnostic when the user cancels", async () => {
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);

    await expect(bridge.installMissingDependencies()).resolves.toBe(false);

    expect(warning).toHaveBeenCalledWith(
      `Install ${TEST_DEPENDENCY_REQUIREMENTS.join(", ")} into ${testPythonExecutablePath("/env/bin/python")}?`,
      { modal: true, detail: "Open Wrangler never installs packages without this confirmation." },
      "Install"
    );
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toMatchObject({
      environment: missingDependencies().environment,
      requirements: missingDependencies().requirements,
      selectionEpoch: 0
    });
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(internals.runtimeEpoch).toBe(0);
  });

  it("installs the exact requirements only after the production modal returns Install", async () => {
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    await expect(bridge.installMissingDependencies()).resolves.toBe(true);

    expect(launchDependencyInstall).toHaveBeenCalledOnce();
    expect(launchDependencyInstall).toHaveBeenCalledWith(
      missingDependencies().environment,
      missingDependencies().dependencies,
      { helperPath: join("/extension", "python", "openwrangler_runtime", "dependency_guard.py") }
    );
    expect(validateDependencyGuard).toHaveBeenCalledWith(missingDependencies().environment, TEST_DEPENDENCY_TOKEN, {
      helperPath: join("/extension", "python", "openwrangler_runtime", "dependency_guard.py")
    });
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(internals.runtimeEpoch).toBe(1);
    expect(internals.selectionEpoch).toBe(1);
    expect(information).toHaveBeenCalledWith("Open Wrangler runtime dependencies were installed.");
  });

  it("releases the mutation barrier before an informational success toast is dismissed", async () => {
    const { bridge, raw } = createDependencyHarness();
    const toast = deferred<undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    vi.spyOn(vscode.window, "showInformationMessage").mockReturnValue(toast.promise as unknown as Thenable<never>);

    await expect(bridge.installMissingDependencies()).resolves.toBe(true);

    expect(raw.dependencyMutations.size).toBe(0);
    expect(raw.dependencyInstallOperation).toBeUndefined();
    toast.resolve(undefined);
  });

  it("releases install single-flight and its mutation barrier without waiting for an invalid-target toast", async () => {
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const expectedEnvironment = missingDependencies().environment;
    const neverSettlingToast = new Promise<never>(() => undefined);
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi
      .spyOn(vscode.window, "showInformationMessage")
      .mockReturnValue(neverSettlingToast as unknown as Thenable<never>);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      ...expectedEnvironment,
      version: "3.13.0"
    } as pythonEnvironment.PythonEnvironment);

    const first = bridge.installMissingDependencies();
    const joined = bridge.installMissingDependencies();
    await expect(Promise.all([first, joined])).resolves.toEqual([false, false]);

    expect(warning).toHaveBeenCalledOnce();
    expect(information).toHaveBeenCalledWith(
      "The selected Python runtime or its missing dependencies changed before installation. Run Install Runtime Dependencies again."
    );
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(0);
    expect(raw.dependencyInstallOperation).toBeUndefined();

    const retrySelection = testEnvironmentSelection("<workspace-default>", expectedEnvironment, {
      epoch: raw.selectionEpochs.get("<workspace-default>") ?? 0
    });
    raw.environmentSelections.set(retrySelection.key, retrySelection);
    raw.lastMissingDependencies = missingDependencies(retrySelection);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(
      expectedEnvironment as pythonEnvironment.PythonEnvironment
    );

    await expect(bridge.installMissingDependencies()).resolves.toBe(true);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(launchDependencyInstall).toHaveBeenCalledOnce();
  });

  it("unrefs post-install validation during shutdown without waiting or publishing success", async () => {
    const validation = controlledDependencyGuardCommand<DependencyGuardValidation>(
      "validate",
      testPythonExecutablePath("/env/bin/python")
    );
    vi.mocked(startDependencyGuardValidation).mockReturnValueOnce(validation.command);
    const { bridge, raw } = createDependencyHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(startDependencyGuardValidation).toHaveBeenCalledOnce());
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);
    expect(raw.dependencyMutations.size).toBe(1);

    await expect(bridge.shutdown()).resolves.toBeUndefined();
    expect(validation.command.unref).toHaveBeenCalledOnce();
    expect(validation.command.didClose()).toBe(false);
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);

    validation.closeSuccessfully({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "validated",
      token: TEST_DEPENDENCY_TOKEN
    });
    await expect(installation).resolves.toBe(false);
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(0));
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(information).not.toHaveBeenCalledWith("Open Wrangler runtime dependencies were installed.");
  });

  it("exposes only a safe decline behind the environment-gated test method", async () => {
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage");

    await expect(bridge.declineMissingDependencyInstallForTesting()).rejects.toThrow(
      "available only to the Open Wrangler test harness"
    );

    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    await expect(bridge.declineMissingDependencyInstallForTesting()).resolves.toBe(false);
    expect(warning).not.toHaveBeenCalled();
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toMatchObject({
      environment: missingDependencies().environment,
      requirements: missingDependencies().requirements,
      selectionEpoch: 0
    });
  });

  it("keeps a test decline independent from an already-open production install", async () => {
    const { bridge, launchDependencyInstall } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";

    const productionInstallation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());
    const testDecline = bridge.declineMissingDependencyInstallForTesting();
    modal.resolve("Install");

    await expect(Promise.all([productionInstallation, testDecline])).resolves.toEqual([true, false]);
    expect(launchDependencyInstall).toHaveBeenCalledOnce();
  });

  it("never lets a test decline suppress the next production confirmation modal", async () => {
    const { bridge, launchDependencyInstall } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    const warning = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockReturnValue(modal.promise as unknown as Thenable<never>);
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";

    const testDecline = bridge.declineMissingDependencyInstallForTesting();
    const productionInstallation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    modal.resolve(undefined);

    await expect(Promise.all([testDecline, productionInstallation])).resolves.toEqual([false, false]);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
  });

  it("joins concurrent install commands to one modal and one pip invocation", async () => {
    const { bridge, launchDependencyInstall } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    const warning = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockReturnValue(modal.promise as unknown as Thenable<never>);

    const first = bridge.installMissingDependencies();
    const second = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    modal.resolve("Install");

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(warning).toHaveBeenCalledOnce();
    expect(launchDependencyInstall).toHaveBeenCalledOnce();
  });

  it("rejects an affirmative modal when its exact dependency target was replaced", async () => {
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());
    const replacement = {
      environment: {
        executable: testPythonExecutablePath("/env/bin/python"),
        executableIdentity: TEST_EXECUTABLE_IDENTITY,
        packageRoot: "/env",
        packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
        version: "3.12.4",
        source: "configuration" as const
      },
      dependencies: [{ importModule: "polars", distribution: "polars", installSpec: "polars" }],
      requirements: ["polars"],
      selection: missingDependencies().selection,
      selectionEpoch: 0
    };
    internals.lastMissingDependencies = replacement;

    modal.resolve("Install");
    await expect(installation).resolves.toBe(false);

    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toBe(replacement);
  });

  it("revalidates selection and trust after an affirmative modal before running pip", async () => {
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());

    setWorkspaceTrust(false);
    modal.resolve("Install");
    await expect(installation).resolves.toBe(false);

    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toMatchObject({
      environment: missingDependencies().environment,
      requirements: missingDependencies().requirements,
      selectionEpoch: 0
    });
  });

  it("lets shutdown complete while its modal is open and never runs pip after the decision arrives", async () => {
    const { bridge, launchDependencyInstall } = createDependencyHarness();
    const modal = deferred<"Install" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const information = vi.spyOn(vscode.window, "showInformationMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());

    const shutdown = bridge.shutdown();
    await expect(shutdown).resolves.toBeUndefined();
    modal.resolve("Install");

    await expect(installation).resolves.toBe(false);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(information).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not run pip when shutdown wins before a deferred progress callback starts", async () => {
    const { bridge, launchDependencyInstall } = createDependencyHarness();
    let progressTask: (() => Promise<boolean>) | undefined;
    const progressResult = deferred<boolean>();
    const progressWindow = vscode.window as unknown as TestProgressWindow;
    vi.spyOn(progressWindow, "withProgress").mockImplementation((_options, task) => {
      progressTask = task as () => Promise<boolean>;
      return progressResult.promise;
    });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(progressTask).toBeDefined());
    await expect(bridge.shutdown()).resolves.toBeUndefined();

    const result = await progressTask!();
    progressResult.resolve(result);
    await expect(installation).resolves.toBe(false);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
  });

  it("awaits an active pip process during shutdown without killing it or publishing stale success", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    const shutdown = bridge.shutdown();
    let settled = false;
    void shutdown.finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(controlled.child.kill).not.toHaveBeenCalled();
    controlled.closeSuccessfully();

    await expect(shutdown).resolves.toBeUndefined();
    await expect(installation).resolves.toBe(false);
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(controlled.child.kill).not.toHaveBeenCalled();
    expect(controlled.child.unref).not.toHaveBeenCalled();
    expect(information).not.toHaveBeenCalled();
  });

  it("reports a nonzero pip result after invalidating stale dependency state and releases its barrier", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, internals, launchDependencyInstall } = createDependencyHarness();
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(raw.dependencyMutations.size).toBe(1);

    controlled.closeWithFailure(new Error("pip exited with code 9"));
    await expect(installation).rejects.toThrow("pip exited with code 9");
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(controlled.child.kill).not.toHaveBeenCalled();
    expect(information).not.toHaveBeenCalled();
  });

  it("does not retain mutation uncertainty when the authorized pre-write integrity check finds a prior conflict", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const failure = new DependencyGuardCommandError(
      "install",
      "environment_inconsistent",
      missingDependencies().environment.executable
    );

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    controlled.closeWithFailure(failure);

    await expect(installation).rejects.toBe(failure);
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(0);
  });

  it("retains the exact mutation token when the post-write integrity check finds a new conflict", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const failure = new DependencyGuardCommandError(
      "install",
      "post_install_inconsistent",
      missingDependencies().environment.executable
    );

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    controlled.closeWithFailure(failure);

    await expect(installation).rejects.toBe(failure);
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect([...raw.dependencyEnvironmentUncertainty.values()]).toEqual([
      expect.objectContaining({ token: TEST_DEPENDENCY_TOKEN })
    ]);
  });

  it("treats exact nonzero pip close as sufficient shutdown proof without reporting install success", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    const shutdown = bridge.shutdown();
    controlled.closeWithFailure(new Error("pip exited with code 17"));

    await expect(shutdown).resolves.toBeUndefined();
    await expect(installation).resolves.toBe(false);
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(controlled.child.kill).not.toHaveBeenCalled();
    expect(information).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("fails shutdown closed after its pip wait bound, unreferences once, and releases only on late close", async () => {
    vi.useFakeTimers();
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    const firstShutdown = bridge.shutdown();
    const secondShutdown = bridge.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    const shutdownError = firstShutdown.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);
    const error = await shutdownError;
    expect(error).toBeInstanceOf(DependencyInstallExitUnconfirmedError);
    expect(await secondShutdown.catch((reason: unknown) => reason)).toBe(error);
    expect(controlled.child.unref).toHaveBeenCalledOnce();
    expect(controlled.child.kill).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(1);

    controlled.closeSuccessfully();
    await expect(installation).resolves.toBe(false);
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(controlled.child.kill).not.toHaveBeenCalled();
    expect(information).not.toHaveBeenCalled();
  });

  it("retains the mutation barrier after the command timeout and latches that exact uncertainty through shutdown", async () => {
    vi.useFakeTimers();
    const controlled = controlledDependencyInstall();
    const { bridge, raw, internals, launchDependencyInstall } = createDependencyHarness();
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    const installError = installation.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(600_000);
    const error = await installError;
    expect(error).toBeInstanceOf(DependencyInstallExitUnconfirmedError);
    expect(controlled.operation.unref).toHaveBeenCalledOnce();
    expect(controlled.child.kill).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(1);
    expect(raw.dependencyInstallOperation?.phase).toBe("uncertain");
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(information).not.toHaveBeenCalled();

    const firstShutdown = bridge.shutdown();
    const secondShutdown = bridge.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    expect(await firstShutdown.catch((reason: unknown) => reason)).toBe(error);
    expect(await secondShutdown.catch((reason: unknown) => reason)).toBe(error);
    expect(controlled.operation.unref).toHaveBeenCalledOnce();
    expect(raw.dependencyMutations.size).toBe(1);

    controlled.closeSuccessfully();
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(controlled.child.kill).not.toHaveBeenCalled();
    expect(information).not.toHaveBeenCalled();
  });

  it("cancels a pending replacement and waits for its same-interpreter predecessor before pip", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection, environment: missingDependencies().environment };
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    bridge.onIdle();
    expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce();
    const pendingReplacement = raw.ensureProcess(runtime, {
      selection,
      environment: missingDependencies().environment
    });
    await Promise.resolve();
    const installation = bridge.installMissingDependencies();
    await Promise.resolve();
    await Promise.resolve();
    expect(launchDependencyInstall).not.toHaveBeenCalled();

    runtimeProcess.emit("exit", 0, null);
    await expect(pendingReplacement).rejects.toThrow("runtime start was cancelled");
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    controlled.closeSuccessfully();
    await expect(installation).resolves.toBe(true);
    expect(runtimeProcess.kill).not.toHaveBeenCalled();
  });

  it("does not wait for an already-stopping runtime owned by a different interpreter", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = {
      selection,
      environment: {
        executable: testPythonExecutablePath("/other/bin/python"),
        executableIdentity: testExecutableIdentity("/other/bin/python"),
        packageRoot: "/other",
        packageRootIdentity: testPackageRootIdentity("/other"),
        version: "3.12.4",
        source: "configuration"
      }
    };
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    bridge.onIdle();
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());

    controlled.closeSuccessfully();
    await expect(installation).resolves.toBe(true);
    expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce();
    expect(runtimeProcess.kill).not.toHaveBeenCalled();
    runtimeProcess.emit("exit", 0, null);
  });

  it("keeps a colon-prefixed but distinct package root independent during cache invalidation", async () => {
    const { bridge, raw, internals } = createDependencyHarness();
    const installTarget = internals.lastMissingDependencies!;
    const independentEnvironment: TestPythonEnvironment = {
      executable: testPythonExecutablePath("/env:independent/bin/python"),
      executableIdentity: testExecutableIdentity("/env:independent/bin/python"),
      packageRoot: "/env:independent",
      packageRootIdentity: testPackageRootIdentity("/env:independent"),
      version: "3.12.4",
      source: "pythonExtension"
    };
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(independentEnvironment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: ["polars"], available: [] });

    await expect(
      internals.prepareRequest(openSessionRequest(remoteSourceAt("/independent/data.csv")))
    ).resolves.toMatchObject({
      kind: "error",
      code: "missing_dependencies"
    });
    const independentSelection = [...raw.environmentSelections.values()].find(
      (selection) => selection.resolvedEnvironment === independentEnvironment
    );
    expect(independentSelection).toBeDefined();
    const independentDependencyKeys = [...independentSelection!.dependencyKeys];
    expect(independentDependencyKeys).toHaveLength(1);
    internals.lastMissingDependencies = installTarget;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(
      installTarget.environment as pythonEnvironment.PythonEnvironment
    );
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    await expect(bridge.installMissingDependencies()).resolves.toBe(true);

    expect(raw.environmentSelections.get(independentSelection!.key)).toBe(independentSelection);
    expect(raw.dependencyProbes.completedMissing(independentDependencyKeys[0]!)).toEqual(["polars"]);
  });

  it("keeps a failed pre-pip quiescence barrier until late runtime exit, then permits a clean retry", async () => {
    vi.useFakeTimers();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection, environment: missingDependencies().environment };
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    const rejected = installation.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    const error = await rejected;

    expect(error).toMatchObject({
      message: expect.stringContaining("could not confirm that its Python runtime exited")
    });
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(1);
    expect(raw.dependencyInstallOperation?.phase).toBe("uncertain");
    expect(runtimeProcess.kill).toHaveBeenCalledOnce();

    runtimeProcess.emit("exit", null, "SIGKILL");
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(raw.dependencyInstallOperation).toBeUndefined();

    const retrySelection = testEnvironmentSelection("<workspace-default>", missingDependencies().environment, {
      epoch: raw.selectionEpochs.get("<workspace-default>") ?? 0
    });
    raw.environmentSelections.set(retrySelection.key, retrySelection);
    raw.lastMissingDependencies = missingDependencies(retrySelection);

    await expect(bridge.installMissingDependencies()).resolves.toBe(true);
    expect(launchDependencyInstall).toHaveBeenCalledOnce();
  });

  it("blocks probes and process starts through an executable alias of the mutating package environment", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const aliasEnvironment = {
      ...missingDependencies().environment,
      executable: testPythonExecutablePath("/env/bin/python3")
    };
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(aliasEnvironment);
    await expect(raw.prepareRequest(openSessionRequest(remoteFileSource()))).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();

    const selection = testEnvironmentSelection("<workspace-default>", aliasEnvironment);
    const runtime = raw.runtimeSlot(selection.key);
    await expect(raw.ensureProcess(runtime, { selection, environment: aliasEnvironment })).rejects.toThrow(
      "while its Python dependencies are being changed"
    );

    controlled.closeSuccessfully();
    await expect(installation).resolves.toBe(true);
  });

  it("quiesces a live runtime reached through another executable alias before starting pip", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const target = missingDependencies();
    const aliasEnvironment: TestPythonEnvironment = {
      ...target.environment,
      executable: testPythonExecutablePath("/env/bin/python3")
    };
    const aliasSelection = testEnvironmentSelection("alias-scope", aliasEnvironment);
    const runtimeProcess = new LifecycleChildProcess();
    const aliasRuntime = testRuntimeSlot(
      aliasSelection.key,
      runtimeProcess as unknown as ChildProcessWithoutNullStreams,
      { selection: aliasSelection, environment: aliasEnvironment }
    );
    raw.environmentSelections.set(aliasSelection.key, aliasSelection);
    raw.runtimeSlots.set(aliasRuntime.key, aliasRuntime);
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce());
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(aliasRuntime.stoppingProcesses.size).toBe(1);

    runtimeProcess.emit("exit", 0, null);
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    controlled.closeSuccessfully();
    await expect(installation).resolves.toBe(true);
    expect(runtimeProcess.kill).not.toHaveBeenCalled();
  });

  it("retains child ownership when a pending cancellation listener throws during quiescence cleanup", async () => {
    const controlled = controlledDependencyInstall();
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection, environment: missingDependencies().environment };
    const dispose = vi.fn(() => {
      throw new Error("listener cleanup failed");
    });
    const pending = raw.runtimeTransport
      .dispatch(
        runtime,
        runtimeProcess as unknown as ChildProcessWithoutNullStreams,
        initializeRequest,
        {
          timeoutMs: 60_000,
          cancellation: {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose })
          }
        },
        vi.fn()
      )
      .catch((error: unknown) => error);
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce());
    expect(dispose).toHaveBeenCalledOnce();
    await expect(pending).resolves.toBeInstanceOf(Error);
    expect(runtime.stoppingProcesses.has(runtimeProcess as unknown as ChildProcessWithoutNullStreams)).toBe(true);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(raw.output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("could not dispose a runtime cancellation listener")
    );

    runtimeProcess.emit("exit", 0, null);
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    controlled.closeSuccessfully();
    await expect(installation).resolves.toBe(true);
    expect(runtimeProcess.kill).not.toHaveBeenCalled();
  });

  it("rechecks Workspace Trust after runtime quiescence and before starting pip", async () => {
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection, environment: missingDependencies().environment };
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce());
    setWorkspaceTrust(false);
    runtimeProcess.emit("exit", 0, null);

    await expect(installation).resolves.toBe(false);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(0);
  });

  it("rejects a dependency-target authorization event that arrives during runtime quiescence", async () => {
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection, environment: missingDependencies().environment };
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce());
    raw.dependencyAuthorizationEpoch += 1;
    runtimeProcess.emit("exit", 0, null);

    await expect(installation).resolves.toBe(false);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(0);
  });

  it("freshly resolves the approved interpreter after quiescence and rejects a replacement target", async () => {
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection, environment: missingDependencies().environment };
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce());
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      ...missingDependencies().environment,
      executable: testPythonExecutablePath("/replacement/bin/python"),
      packageRoot: "/replacement",
      packageRootIdentity: testPackageRootIdentity("/replacement")
    } as pythonEnvironment.PythonEnvironment);
    runtimeProcess.emit("exit", 0, null);

    await expect(installation).resolves.toBe(false);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(0);
  });

  it("rejects a same-path package root whose filesystem identity changed during quiescence", async () => {
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection, environment: missingDependencies().environment };
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce());
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      ...missingDependencies().environment,
      packageRootIdentity: { device: "1", inode: "2" }
    } as pythonEnvironment.PythonEnvironment);
    runtimeProcess.emit("exit", 0, null);

    await expect(installation).resolves.toBe(false);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(0);
  });

  it("rejects Python version drift within the same executable and package root after quiescence", async () => {
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    const runtime = raw.runtimeSlots.get("<workspace-default>")!;
    const selection = raw.environmentSelections.get("<workspace-default>")!;
    const runtimeProcess = new LifecycleChildProcess();
    runtime.process = runtimeProcess as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection, environment: missingDependencies().environment };
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(runtimeProcess.stdin.end).toHaveBeenCalledOnce());
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      ...missingDependencies().environment,
      version: "3.14.0"
    } as pythonEnvironment.PythonEnvironment);
    runtimeProcess.emit("exit", 0, null);

    await expect(installation).resolves.toBe(false);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(0);
  });

  it("revalidates the target inside the progress callback immediately before pip", async () => {
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness();
    const enteredProgress = deferred<void>();
    const releaseProgress = deferred<void>();
    const progressWindow = vscode.window as unknown as TestProgressWindow;
    vi.spyOn(progressWindow, "withProgress").mockImplementation(async (_options, task) => {
      enteredProgress.resolve();
      await releaseProgress.promise;
      return task();
    });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await enteredProgress.promise;
    internals.lastMissingDependencies = {
      environment: {
        executable: testPythonExecutablePath("/env/bin/python"),
        executableIdentity: TEST_EXECUTABLE_IDENTITY,
        packageRoot: "/env",
        packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
        version: "3.12.4",
        source: "configuration"
      },
      dependencies: [{ importModule: "polars", distribution: "polars", installSpec: "polars" }],
      requirements: ["polars"],
      selection: missingDependencies().selection,
      selectionEpoch: 0
    };
    releaseProgress.resolve();

    await expect(installation).resolves.toBe(false);
    expect(launchDependencyInstall).not.toHaveBeenCalled();
  });

  it("never clears or restarts a newer selection after an old pip process finishes", async () => {
    const execution = deferred<void>();
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness(() => execution.promise);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());

    bridge.clearRuntimeSelection();
    const newerTarget = {
      environment: {
        executable: testPythonExecutablePath("/new/bin/python"),
        executableIdentity: testExecutableIdentity("/new/bin/python"),
        packageRoot: "/new",
        packageRootIdentity: testPackageRootIdentity("/new"),
        version: "3.13.1",
        source: "configuration" as const
      },
      dependencies: [{ importModule: "polars", distribution: "polars", installSpec: "polars" }],
      requirements: ["polars"],
      selection: testEnvironmentSelection(
        "<workspace-default>",
        {
          executable: testPythonExecutablePath("/new/bin/python"),
          executableIdentity: testExecutableIdentity("/new/bin/python"),
          packageRoot: "/new",
          packageRootIdentity: testPackageRootIdentity("/new"),
          version: "3.13.1",
          source: "configuration"
        },
        { epoch: 1 }
      ),
      selectionEpoch: 1
    };
    internals.lastMissingDependencies = newerTarget;
    const newerDependencyKey = await cacheDependencyProbe(
      internals.dependencyProbes,
      newerTarget.environment,
      newerTarget.dependencies,
      ["polars"]
    );
    newerTarget.selection.dependencyKeys.add(newerDependencyKey);
    const runtimeEpochAfterSelectionChange = internals.runtimeEpoch;
    execution.resolve();

    await expect(installation).resolves.toBe(true);
    expect(internals.lastMissingDependencies).toBe(newerTarget);
    expect(internals.dependencyProbes.completedMissing(newerDependencyKey)).toEqual(["polars"]);
    expect(internals.runtimeEpoch).toBe(runtimeEpochAfterSelectionChange);
  });

  it("invalidates every current scope still using the interpreter mutated by a stale pip target", async () => {
    const execution = deferred<void>();
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness(() => execution.promise);
    const raw = bridge as unknown as RawBridgeInternals;
    const sharedEnvironment = missingDependencies().environment;
    const sharedSelection = testEnvironmentSelection("shared-second-scope", sharedEnvironment);
    const sharedRuntime = testRuntimeSlot("shared-second-scope", undefined, {
      selection: sharedSelection,
      environment: sharedEnvironment
    });
    raw.environmentSelections.set(sharedSelection.key, sharedSelection);
    raw.runtimeSlots.set(sharedRuntime.key, sharedRuntime);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());

    raw.environmentSelections.delete("<workspace-default>");
    const newerEnvironment: TestPythonEnvironment = {
      executable: testPythonExecutablePath("/new/bin/python"),
      executableIdentity: testExecutableIdentity("/new/bin/python"),
      packageRoot: "/new",
      packageRootIdentity: testPackageRootIdentity("/new"),
      version: "3.13.1",
      source: "configuration"
    };
    const newerSelection = testEnvironmentSelection("<workspace-default>", newerEnvironment, { epoch: 1 });
    raw.environmentSelections.set(newerSelection.key, newerSelection);
    const newerTarget: TestMissingDependencies = {
      environment: newerEnvironment,
      dependencies: [{ importModule: "polars", distribution: "polars", installSpec: "polars" }],
      requirements: ["polars"],
      selection: newerSelection,
      selectionEpoch: 1
    };
    internals.lastMissingDependencies = newerTarget;
    const newerDependencyKey = await cacheDependencyProbe(
      internals.dependencyProbes,
      newerTarget.environment,
      newerTarget.dependencies,
      ["polars"]
    );
    newerTarget.selection.dependencyKeys.add(newerDependencyKey);
    execution.resolve();

    await expect(installation).resolves.toBe(true);
    expect(raw.environmentSelections.get("<workspace-default>")).toBe(newerSelection);
    expect(raw.environmentSelections.has(sharedSelection.key)).toBe(false);
    expect(sharedRuntime.runtimeEpoch).toBe(1);
    expect(internals.lastMissingDependencies).toBe(newerTarget);
    expect(internals.dependencyProbes.completedMissing(newerDependencyKey)).toEqual(["polars"]);
  });

  it("invalidates a completed shared probe when pip completes in the same selection epoch", async () => {
    const request = openSessionRequest(remoteFileSource());
    const sharedProbe = deferred<{ missing: string[]; available: string[] }>();
    const { bridge, internals } = createDependencyHarness();
    vi.mocked(pythonEnvironment.probeDependencies)
      .mockReturnValueOnce(sharedProbe.promise)
      .mockResolvedValueOnce({ missing: [], available: ["polars"] });
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(missingDependencies().environment);

    const firstPreparation = internals.prepareRequest(request);
    const overlappingPreparation = internals.prepareRequest(request);
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce());
    sharedProbe.resolve({ missing: ["polars>=1.35.2,<2"], available: [] });
    await expect(firstPreparation).resolves.toMatchObject({ kind: "error", code: "missing_dependencies" });
    await expect(overlappingPreparation).resolves.toMatchObject({
      kind: "error",
      code: "missing_dependencies"
    });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    await expect(bridge.installMissingDependencies()).resolves.toBe(true);
    expect(internals.selectionEpoch).toBe(1);
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(internals.environmentSelections.size).toBe(0);

    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);

    await expect(internals.prepareRequest(request)).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(1);
  });

  it("enforces Workspace Trust before production confirmation", async () => {
    const { bridge, internals, launchDependencyInstall } = createDependencyHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    setWorkspaceTrust(false);

    await expect(bridge.installMissingDependencies()).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith("Trust this workspace before installing Python dependencies.");
    expect(warning).not.toHaveBeenCalled();
    expect(launchDependencyInstall).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toMatchObject({
      environment: missingDependencies().environment,
      requirements: missingDependencies().requirements,
      selectionEpoch: 0
    });
  });

  it("invalidates an actionable dependency target when runtime selection changes", () => {
    const { bridge, internals } = createDependencyHarness();

    bridge.clearRuntimeSelection();

    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(internals.runtimeEpoch).toBe(1);
    expect(internals.selectionEpoch).toBe(1);
  });

  it("does not advance either epoch when a repeated invalidation has no selection state left", () => {
    const { bridge, internals } = createDependencyHarness();
    bridge.clearRuntimeSelection();
    const runtimeEpoch = internals.runtimeEpoch;
    const selectionEpoch = internals.selectionEpoch;

    bridge.clearRuntimeSelection();

    expect(internals.runtimeEpoch).toBe(runtimeEpoch);
    expect(internals.selectionEpoch).toBe(selectionEpoch);
  });

  it("invalidates runtime selection on direct pythonPath configuration changes and disposes the listener", async () => {
    const bridge = new PythonBridge(testExtensionContext());
    const internals = bridge as unknown as DependencyBridgeInternals;
    const target = missingDependencies();
    internals.lastMissingDependencies = target;
    internals.environmentSelections.set(target.selection.key, target.selection);
    const configuredDependencyKey = await cacheDependencyProbe(
      internals.dependencyProbes,
      target.environment,
      target.dependencies,
      ["pandas"]
    );
    target.selection.dependencyKeys.add(configuredDependencyKey);
    const workspace = vscode.workspace as unknown as TestWorkspace;

    workspace.__fireDidChangeConfiguration("editor.fontSize");
    expect(internals.selectionEpoch).toBe(0);
    workspace.__fireDidChangeConfiguration("openWrangler.pythonPath");
    expect(internals.selectionEpoch).toBe(1);
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);

    bridge.dispose();
    workspace.__fireDidChangeConfiguration("openWrangler.pythonPath");
    expect(internals.selectionEpoch).toBe(1);
  });
});

describe("PythonBridge dependency guard recovery", () => {
  const environment: TestPythonEnvironment = {
    executable: testPythonExecutablePath("/env/bin/python"),
    executableIdentity: TEST_EXECUTABLE_IDENTITY,
    packageRoot: "/env",
    packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
    version: "3.12.4",
    source: "configuration"
  };

  beforeEach(() => {
    setWorkspaceTrust(true);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
    vi.mocked(getDependencyGuardStatus).mockClear();
    vi.mocked(validateDependencyGuard).mockClear();
  });

  afterEach(() => {
    setWorkspaceTrust(true);
    vi.restoreAllMocks();
  });

  it("retains the exact dependency records selected by the missing requirement set", async () => {
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({
      missing: ["pandas>=2.3.3,<4", "xlrd>=2.0.2,<3"],
      available: []
    });

    await expect(
      internals.prepareRequest({
        ...openSessionRequest(remoteSourceAt("/data.xls")),
        backend: "pandas"
      })
    ).resolves.toMatchObject({ kind: "error", code: "missing_dependencies" });

    expect(internals.lastMissingDependencies?.dependencies).toEqual([
      {
        importModule: "pandas",
        distribution: "pandas",
        installSpec: "pandas>=2.3.3,<4",
        minimumVersion: "2.3.3",
        maximumVersionExclusive: "4"
      },
      {
        importModule: "xlrd",
        distribution: "xlrd",
        installSpec: "xlrd>=2.0.2,<3",
        minimumVersion: "2.0.2",
        maximumVersionExclusive: "3"
      }
    ]);
  });

  it("shares only an in-flight exact status check and never caches a clean result", async () => {
    const status = deferred<Awaited<ReturnType<typeof getDependencyGuardStatus>>>();
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });
    vi.mocked(getDependencyGuardStatus).mockReturnValueOnce(status.promise);
    const request = openSessionRequest(remoteFileSource());

    const first = internals.prepareRequest(request);
    const second = internals.prepareRequest(request);
    await vi.waitFor(() => expect(getDependencyGuardStatus).toHaveBeenCalledOnce());
    expect(startDependencyGuardStatus).toHaveBeenCalledOnce();
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);
    status.resolve({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "clean",
      token: null
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: "openSession", backend: "polars" }),
      expect.objectContaining({ kind: "openSession", backend: "polars" })
    ]);
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(0));

    await expect(internals.prepareRequest(request)).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    expect(getDependencyGuardStatus).toHaveBeenCalledTimes(2);
    expect(startDependencyGuardStatus).toHaveBeenCalledTimes(2);
    expect(raw.activeDependencyGuardCommands?.size).toBe(0);
  });

  it("unrefs an active ordinary status during shutdown without killing or awaiting it", async () => {
    const controlled = controlledDependencyGuardCommand<DependencyGuardStatus>("status", environment.executable);
    vi.mocked(startDependencyGuardStatus).mockReturnValueOnce(controlled.command);
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    const preparation = internals.prepareRequest(openSessionRequest(remoteFileSource()));
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(1));

    await expect(bridge.shutdown()).resolves.toBeUndefined();
    expect(controlled.command.unref).toHaveBeenCalledOnce();
    expect(controlled.command.didClose()).toBe(false);
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);

    controlled.closeSuccessfully({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "clean",
      token: null
    });
    await expect(preparation).resolves.toMatchObject({ kind: "error", code: "runtime_selection_changed" });
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(0));

    vi.mocked(startDependencyGuardStatus).mockClear();
    await expect(raw.dependencyGuardStatusForEnvironment(environment)).rejects.toThrow("bridge disposed");
    expect(startDependencyGuardStatus).not.toHaveBeenCalled();
  });

  it("unrefs the exact status owner when close races shutdown and then removes it on completion", async () => {
    const controlled = controlledDependencyGuardCommand<DependencyGuardStatus>("status", environment.executable);
    vi.mocked(startDependencyGuardStatus).mockReturnValueOnce(controlled.command);
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    const preparation = internals.prepareRequest(openSessionRequest(remoteFileSource()));
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(1));
    controlled.closeSuccessfully({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "clean",
      token: null
    });
    expect(controlled.command.didClose()).toBe(true);

    const shutdown = bridge.shutdown();
    expect(controlled.command.unref).toHaveBeenCalledOnce();
    await expect(shutdown).resolves.toBeUndefined();
    await expect(preparation).resolves.toMatchObject({ kind: "error", code: "runtime_selection_changed" });
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(0));
  });

  it("surfaces an active dependency-guard unref failure from shutdown", async () => {
    const unrefFailure = new Error("dependency guard unref failed");
    const controlled = controlledDependencyGuardCommand<DependencyGuardStatus>(
      "status",
      environment.executable,
      vi.fn(() => {
        throw unrefFailure;
      })
    );
    vi.mocked(startDependencyGuardStatus).mockReturnValueOnce(controlled.command);
    const { bridge, internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);

    const preparation = internals.prepareRequest(openSessionRequest(remoteFileSource()));
    await vi.waitFor(() => expect(startDependencyGuardStatus).toHaveBeenCalledOnce());

    await expect(bridge.shutdown()).rejects.toBe(unrefFailure);
    expect(controlled.command.unref).toHaveBeenCalledOnce();

    controlled.closeWithFailure(new Error("status stopped after shutdown"));
    await expect(preparation).resolves.toMatchObject({ kind: "error", code: "runtime_selection_changed" });
  });

  it("retains a timed-out status owner until its authoritative late close", async () => {
    const controlled = controlledDependencyGuardCommand<DependencyGuardStatus>("status", environment.executable);
    vi.mocked(startDependencyGuardStatus).mockReturnValueOnce(controlled.command);
    const { bridge } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const status = raw.dependencyGuardStatusForEnvironment(environment);
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);

    controlled.failCompletionBeforeClose(
      new DependencyGuardCommandTimeoutError("status", environment.executable, 30_000)
    );
    await expect(status).rejects.toBeInstanceOf(DependencyGuardCommandTimeoutError);
    expect(controlled.command.didClose()).toBe(false);
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);

    controlled.releaseOwnershipAfterClose();
    await expect(controlled.command.ownershipReleased).resolves.toBeUndefined();
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(0));
  });

  it("retries and surfaces a timed-out status command's partial unref failure during shutdown", async () => {
    const detachFailure = new Error("status stdout unref failed");
    const unref = vi.fn(() => {
      throw detachFailure;
    });
    const controlled = controlledDependencyGuardCommand<DependencyGuardStatus>("status", environment.executable, unref);
    vi.mocked(startDependencyGuardStatus).mockReturnValueOnce(controlled.command);
    const { bridge } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const status = raw.dependencyGuardStatusForEnvironment(environment);

    expect(() => controlled.command.unref()).toThrow(detachFailure);
    controlled.failCompletionBeforeClose(
      new AggregateError(
        [new DependencyGuardCommandTimeoutError("status", environment.executable, 30_000), detachFailure],
        "Open Wrangler could not release its timed-out dependency guard."
      )
    );
    await expect(status).rejects.toBeInstanceOf(AggregateError);
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);

    await expect(bridge.shutdown()).rejects.toBe(detachFailure);
    expect(unref).toHaveBeenCalledTimes(2);
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);

    controlled.releaseOwnershipAfterClose();
    await expect(controlled.command.ownershipReleased).resolves.toBeUndefined();
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(0));
  });

  it("serializes status by package environment without transferring an exact token across identities", async () => {
    const status = deferred<Awaited<ReturnType<typeof getDependencyGuardStatus>>>();
    const alias: TestPythonEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/env/bin/python3"),
      executableIdentity: testExecutableIdentity("/env/bin/python3")
    };
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockImplementation(async (_context, resource) =>
      resource?.path.includes("/alias/") ? alias : environment
    );
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });
    vi.mocked(getDependencyGuardStatus).mockReturnValueOnce(status.promise);
    const ownerRequest = openSessionRequest(remoteSourceAt("/owner/data.csv"));
    const aliasRequest = openSessionRequest(remoteSourceAt("/alias/data.csv"));

    const ownerPreparation = internals.prepareRequest(ownerRequest);
    await vi.waitFor(() => expect(getDependencyGuardStatus).toHaveBeenCalledOnce());
    const aliasPreparation = internals.prepareRequest(aliasRequest);
    status.resolve({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "clean",
      token: null
    });

    await expect(ownerPreparation).resolves.toMatchObject({ kind: "openSession", backend: "polars" });
    await expect(aliasPreparation).resolves.toMatchObject({
      kind: "error",
      code: "dependency_environment_uncertain"
    });
    expect(getDependencyGuardStatus).toHaveBeenCalledOnce();

    await expect(internals.prepareRequest(aliasRequest)).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    expect(getDependencyGuardStatus).toHaveBeenCalledTimes(2);
  });

  it("lets an exact clean status clear a matching retained token", async () => {
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });
    raw.markDependencyEnvironmentUncertain(environment, TEST_DEPENDENCY_TOKEN, new Error("validation failed"));

    await expect(internals.prepareRequest(openSessionRequest(remoteFileSource()))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(0);
  });

  it("blocks a dirty journal without exposing its exact recovery token", async () => {
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(getDependencyGuardStatus).mockResolvedValue({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "dirty",
      token: TEST_DEPENDENCY_TOKEN
    });

    const response = await internals.prepareRequest(openSessionRequest(remoteFileSource()));

    expect(response).toMatchObject({ kind: "error", code: "dependency_environment_uncertain", recoverable: true });
    expect((response as ErrorResponse).detail).toContain("Revalidate Runtime Dependencies");
    expect(JSON.stringify(response)).not.toContain(TEST_DEPENDENCY_TOKEN);
    expect([...raw.dependencyEnvironmentUncertainty.values()]).toEqual([
      expect.objectContaining({ environment, token: TEST_DEPENDENCY_TOKEN })
    ]);
    expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();
  });

  it.each([
    ["busy", /currently owns this environment/],
    ["malformed_state", /journal could not be verified/],
    ["environment_changed", /environment changed/]
  ] as const)("fails closed for guard status %s", async (code, detailPattern) => {
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(getDependencyGuardStatus).mockRejectedValue(
      new DependencyGuardCommandError("status", code, environment.executable)
    );

    const response = await internals.prepareRequest(openSessionRequest(remoteFileSource()));

    expect(response).toMatchObject({ kind: "error", code: "dependency_environment_uncertain" });
    expect((response as ErrorResponse).detail).toMatch(detailPattern);
    expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();
  });

  it("does not authorize writes when the confirmed target becomes stale while READY is pending", async () => {
    const controlled = controlledDependencyInstall(testPythonExecutablePath("/env/bin/python"), true);
    const { bridge, raw, launchDependencyInstall } = createDependencyHarness();
    launchDependencyInstall.mockReturnValue(controlled.operation);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);

    const installation = bridge.installMissingDependencies();
    await vi.waitFor(() => expect(launchDependencyInstall).toHaveBeenCalledOnce());
    setWorkspaceTrust(false);
    controlled.publishReady();

    await expect(installation).resolves.toBe(false);
    expect(controlled.operation.abortBeforeWrites).toHaveBeenCalledOnce();
    expect(controlled.operation.authorizeWrites).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(1);
    controlled.closeWithFailure(new Error("aborted before writes"));
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
  });

  it("retains exact uncertainty after validation failure and rediscovers its durable marker", async () => {
    const { bridge, raw } = createDependencyHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
    vi.mocked(validateDependencyGuard).mockRejectedValue(
      new DependencyGuardCommandError("validate", "validation_failed", environment.executable)
    );

    await expect(bridge.installMissingDependencies()).rejects.toMatchObject({
      code: "validation_failed"
    });
    expect([...raw.dependencyEnvironmentUncertainty.values()]).toEqual([
      expect.objectContaining({ token: TEST_DEPENDENCY_TOKEN })
    ]);

    vi.mocked(getDependencyGuardStatus).mockResolvedValue({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "dirty",
      token: TEST_DEPENDENCY_TOKEN
    });
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    await expect(raw.prepareRequest(openSessionRequest(remoteFileSource()))).resolves.toMatchObject({
      kind: "error",
      code: "dependency_environment_uncertain"
    });
    expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();
  });

  it("bounds retained uncertainty while preserving recently refreshed identities", () => {
    const { bridge } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const environments = Array.from({ length: 130 }, (_, index): TestPythonEnvironment => {
      const executable = testPythonExecutablePath(`/env-${index}/bin/python`);
      return {
        ...environment,
        executable,
        executableIdentity: testExecutableIdentity(executable),
        packageRoot: `/env-${index}`,
        packageRootIdentity: { device: "1", inode: String(10_000 + index) }
      };
    });
    for (const candidate of environments.slice(0, 128)) {
      raw.markDependencyEnvironmentUncertain(candidate, undefined, new Error("transient"));
    }
    raw.markDependencyEnvironmentUncertain(environments[0]!, undefined, new Error("refreshed"));
    raw.markDependencyEnvironmentUncertain(environments[128]!, undefined, new Error("new"));
    raw.markDependencyEnvironmentUncertain(environments[129]!, undefined, new Error("newest"));

    const retainedExecutables = [...raw.dependencyEnvironmentUncertainty.values()].map(
      (entry) => (entry as { environment: TestPythonEnvironment }).environment.executable
    );
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(128);
    expect(retainedExecutables).toContain(environments[0]!.executable);
    expect(retainedExecutables).not.toContain(environments[1]!.executable);
    expect(retainedExecutables).not.toContain(environments[2]!.executable);
  });
});

describe("PythonBridge dependency recovery command", () => {
  const originalExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;

  beforeEach(() => {
    delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    setWorkspaceTrust(true);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
    vi.mocked(getDependencyGuardStatus).mockClear();
    vi.mocked(validateDependencyGuard).mockClear();
  });

  afterEach(() => {
    if (originalExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    else process.env.OPEN_WRANGLER_EXTENSION_TESTS = originalExtensionTests;
    setWorkspaceTrust(true);
    vi.restoreAllMocks();
  });

  it("does not run a helper or show a modal without an exact retained target", async () => {
    const { bridge } = createDependencyHarness();
    const information = vi.spyOn(vscode.window, "showInformationMessage");
    const warning = vi.spyOn(vscode.window, "showWarningMessage");

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);

    expect(information).toHaveBeenCalledWith(
      "Open Wrangler has no exact dependency recovery target. Reopen the affected source and try again."
    );
    expect(getDependencyGuardStatus).not.toHaveBeenCalled();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("deterministically revalidates the most recently confirmed current blocked source", async () => {
    const { bridge, raw, target } = createRecoveryHarness();
    const secondEnvironment: TestPythonEnvironment = {
      ...target.environment,
      executable: testPythonExecutablePath("/second/bin/python"),
      executableIdentity: testExecutableIdentity("/second/bin/python"),
      packageRoot: "/second",
      packageRootIdentity: testPackageRootIdentity("/second")
    };
    const secondSelection = testEnvironmentSelection("second", secondEnvironment, {
      resource: vscode.Uri.parse("vscode-remote://ssh-remote+test/second/data.csv", true)
    });
    const secondToken = "44444444-4444-4444-8444-444444444444";
    raw.environmentSelections.set(secondSelection.key, secondSelection);
    raw.markDependencyEnvironmentUncertain(
      secondEnvironment,
      secondToken,
      new Error("newer blocked source"),
      secondSelection
    );
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockImplementation(async (_context, resource) =>
      resource === secondSelection.resource ? secondEnvironment : target.environment
    );
    vi.mocked(getDependencyGuardStatus).mockImplementation(async (environment) => ({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "dirty",
      token: environment.executable === secondEnvironment.executable ? secondToken : TEST_DEPENDENCY_TOKEN
    }));
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(true);

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(secondEnvironment.executable),
      expect.anything(),
      "Revalidate"
    );
    expect(validateDependencyGuard).toHaveBeenCalledWith(secondEnvironment, secondToken, expect.anything());
    expect([...raw.dependencyEnvironmentUncertainty.values()]).toEqual([
      expect.objectContaining({ environment: target.environment, token: TEST_DEPENDENCY_TOKEN })
    ]);
  });

  it("checks trust before status, resolution, or confirmation", async () => {
    const { bridge } = createRecoveryHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    setWorkspaceTrust(false);

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith("Trust this workspace before revalidating Python dependencies.");
    expect(pythonEnvironment.resolvePythonEnvironment).not.toHaveBeenCalled();
    expect(getDependencyGuardStatus).not.toHaveBeenCalled();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("exposes only a decline-only test helper and preserves its exact target", async () => {
    const { bridge, raw } = createRecoveryHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage");

    await expect(bridge.declineRuntimeDependencyRevalidationForTesting()).rejects.toThrow(
      "available only to the Open Wrangler test harness"
    );
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    await expect(bridge.declineRuntimeDependencyRevalidationForTesting()).resolves.toBe(false);

    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
    expect(getDependencyGuardStatus).not.toHaveBeenCalled();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("joins concurrent calls to one status check and one modal", async () => {
    const { bridge } = createRecoveryHarness();
    const modal = deferred<"Revalidate" | undefined>();
    const warning = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockReturnValue(modal.promise as unknown as Thenable<never>);

    const first = bridge.revalidateRuntimeDependencies();
    const second = bridge.revalidateRuntimeDependencies();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    modal.resolve(undefined);

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(getDependencyGuardStatus).toHaveBeenCalledOnce();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
  });

  it("is mutually exclusive with dependency installation in either order", async () => {
    const installFirst = createRecoveryHarness();
    const installBlock = deferred<boolean>();
    installFirst.raw.dependencyInstallOperation = {
      phase: "confirming",
      promise: installBlock.promise
    };
    await expect(installFirst.bridge.revalidateRuntimeDependencies()).resolves.toBe(false);
    expect(getDependencyGuardStatus).not.toHaveBeenCalled();
    installBlock.resolve(false);

    vi.mocked(getDependencyGuardStatus).mockClear();
    const recoveryFirst = createRecoveryHarness();
    const modal = deferred<"Revalidate" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const recovery = recoveryFirst.bridge.revalidateRuntimeDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());

    await expect(recoveryFirst.bridge.installMissingDependencies()).resolves.toBe(false);
    expect(recoveryFirst.launchDependencyInstall).not.toHaveBeenCalled();
    modal.resolve(undefined);
    await expect(recovery).resolves.toBe(false);
  });

  it("uses the exact warning and clears only after exact-token validation", async () => {
    const { bridge, raw, target } = createRecoveryHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(true);

    expect(warning).toHaveBeenCalledWith(
      `Revalidate runtime dependencies in ${target.environment.executable}?`,
      {
        modal: true,
        detail:
          "Open Wrangler found an interrupted dependency change. Revalidation waits for any package writer to exit, imports and version-checks the recorded dependencies, and clears the retained recovery marker only if every check succeeds. It does not install, remove, or overwrite packages."
      },
      "Revalidate"
    );
    expect(getDependencyGuardStatus).toHaveBeenCalledTimes(2);
    expect(validateDependencyGuard).toHaveBeenCalledWith(target.environment, TEST_DEPENDENCY_TOKEN, {
      helperPath: join("/extension", "python", "openwrangler_runtime", "dependency_guard.py")
    });
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(0);
    expect(raw.dependencyMutations.size).toBe(0);
    await vi.waitFor(() => expect(raw.dependencyRecoveryOperation).toBeUndefined());
    expect(information).toHaveBeenCalledWith("Open Wrangler runtime dependencies were revalidated.");
  });

  it("quiesces the package-root runtime before the second status and validation", async () => {
    const { bridge, raw, target } = createRecoveryHarness();
    const runtime = raw.runtimeSlots.get(target.selection.key)!;
    const process = new LifecycleChildProcess();
    runtime.process = process as unknown as ChildProcessWithoutNullStreams;
    runtime.processSelection = { selection: target.selection, environment: target.environment };
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);

    const recovery = bridge.revalidateRuntimeDependencies();
    await vi.waitFor(() => expect(process.stdin.end).toHaveBeenCalledOnce());
    expect(getDependencyGuardStatus).toHaveBeenCalledOnce();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
    process.emit("exit", 0, null);

    await expect(recovery).resolves.toBe(true);
    expect(getDependencyGuardStatus).toHaveBeenCalledTimes(2);
    expect(validateDependencyGuard).toHaveBeenCalledOnce();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("rejects selection replacement while the modal is open", async () => {
    const { bridge, raw, target } = createRecoveryHarness();
    const modal = deferred<"Revalidate" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const recovery = bridge.revalidateRuntimeDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());
    raw.environmentSelections.set(
      target.selection.key,
      testEnvironmentSelection(target.selection.key, target.environment, {
        epoch: target.selection.epoch + 1
      })
    );
    modal.resolve("Revalidate");

    await expect(recovery).resolves.toBe(false);
    expect(getDependencyGuardStatus).toHaveBeenCalledOnce();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
  });

  it("rechecks trust after the modal before quiescence or another helper", async () => {
    const { bridge, raw } = createRecoveryHarness();
    const modal = deferred<"Revalidate" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const recovery = bridge.revalidateRuntimeDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());
    setWorkspaceTrust(false);
    modal.resolve("Revalidate");

    await expect(recovery).resolves.toBe(false);
    expect(getDependencyGuardStatus).toHaveBeenCalledOnce();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(0);
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
  });

  it("rejects full environment identity drift after confirmation", async () => {
    const { bridge, target } = createRecoveryHarness();
    const changed = {
      ...target.environment,
      executableIdentity: {
        ...target.environment.executableIdentity,
        ctimeNs: String(BigInt(target.environment.executableIdentity.ctimeNs) + 1n)
      }
    };
    vi.mocked(pythonEnvironment.resolvePythonEnvironment)
      .mockResolvedValueOnce(target.environment as pythonEnvironment.PythonEnvironment)
      .mockResolvedValueOnce(changed as pythonEnvironment.PythonEnvironment);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);

    expect(getDependencyGuardStatus).toHaveBeenCalledOnce();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
  });

  it("requires a new invocation and modal for a newly observed token", async () => {
    const nextToken = "22222222-2222-4222-8222-222222222222";
    const { bridge, raw } = createRecoveryHarness();
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    vi.mocked(getDependencyGuardStatus).mockResolvedValueOnce({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "dirty",
      token: nextToken
    });

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);
    expect(warning).not.toHaveBeenCalled();
    expect([...raw.dependencyEnvironmentUncertainty.values()]).toEqual([expect.objectContaining({ token: nextToken })]);

    vi.mocked(getDependencyGuardStatus).mockResolvedValue({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "dirty",
      token: nextToken
    });
    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(true);
    expect(warning).toHaveBeenCalledOnce();
    expect(validateDependencyGuard).toHaveBeenCalledWith(expect.anything(), nextToken, expect.anything());
  });

  it("retains a changed post-modal token and permits a direct confirmed retry", async () => {
    const nextToken = "33333333-3333-4333-8333-333333333333";
    const { bridge, raw } = createRecoveryHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    vi.mocked(getDependencyGuardStatus)
      .mockResolvedValueOnce({
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "status",
        state: "dirty",
        token: TEST_DEPENDENCY_TOKEN
      })
      .mockResolvedValueOnce({
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "status",
        state: "dirty",
        token: nextToken
      });

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);
    expect(validateDependencyGuard).not.toHaveBeenCalled();
    expect(raw.dependencyMutations.size).toBe(0);
    expect([...raw.dependencyEnvironmentUncertainty.values()]).toEqual([
      expect.objectContaining({ token: nextToken, selectionDetached: true })
    ]);

    vi.mocked(getDependencyGuardStatus).mockResolvedValue({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "dirty",
      token: nextToken
    });
    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(true);
    expect(validateDependencyGuard).toHaveBeenCalledWith(expect.anything(), nextToken, expect.anything());
  });

  it.each(["before confirmation", "after confirmation"] as const)(
    "clears an exact clean blocker %s but never reports validation success",
    async (phase) => {
      const { bridge, raw } = createRecoveryHarness();
      const clean = {
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "status",
        state: "clean",
        token: null
      } as const;
      if (phase === "before confirmation") {
        vi.mocked(getDependencyGuardStatus).mockResolvedValueOnce(clean);
      } else {
        vi.mocked(getDependencyGuardStatus).mockResolvedValueOnce({
          protocol: DEPENDENCY_GUARD_PROTOCOL,
          kind: "status",
          state: "dirty",
          token: TEST_DEPENDENCY_TOKEN
        });
        vi.mocked(getDependencyGuardStatus).mockResolvedValueOnce(clean);
        vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
      }

      await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);

      expect(raw.dependencyEnvironmentUncertainty.size).toBe(0);
      expect(raw.dependencyMutations.size).toBe(0);
      expect(validateDependencyGuard).not.toHaveBeenCalled();
    }
  );

  it.each([
    new DependencyGuardCommandError("status", "busy", testPythonExecutablePath("/env/bin/python")),
    new DependencyGuardCommandError("status", "malformed_state", testPythonExecutablePath("/env/bin/python")),
    new DependencyGuardCommandTimeoutError("status", testPythonExecutablePath("/env/bin/python"), 30_000)
  ])("retains the target when a status helper fails safely: $name", async (failure) => {
    const { bridge, raw } = createRecoveryHarness();
    vi.mocked(getDependencyGuardStatus).mockRejectedValueOnce(failure);
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);

    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
    expect(raw.dependencyMutations.size).toBe(0);
    expect(warning).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.mock.calls)).not.toContain(TEST_DEPENDENCY_TOKEN);
  });

  it.each([
    new DependencyGuardCommandError("status", "busy", testPythonExecutablePath("/env/bin/python")),
    new DependencyGuardCommandError("status", "malformed_state", testPythonExecutablePath("/env/bin/python")),
    new DependencyGuardCommandTimeoutError("status", testPythonExecutablePath("/env/bin/python"), 30_000)
  ])("releases the mutation barrier when the post-modal status fails: $name", async (failure) => {
    const { bridge, raw } = createRecoveryHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    vi.mocked(getDependencyGuardStatus)
      .mockResolvedValueOnce({
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "status",
        state: "dirty",
        token: TEST_DEPENDENCY_TOKEN
      })
      .mockRejectedValueOnce(failure);

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);

    expect(raw.dependencyMutations.size).toBe(0);
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
    expect(validateDependencyGuard).not.toHaveBeenCalled();
  });

  it.each([
    new DependencyGuardCommandError("validate", "busy", testPythonExecutablePath("/env/bin/python")),
    new DependencyGuardCommandError("validate", "malformed_state", testPythonExecutablePath("/env/bin/python")),
    new DependencyGuardCommandTimeoutError("validate", testPythonExecutablePath("/env/bin/python"), 30_000)
  ])("retains the exact target when validator recovery fails: $name", async (failure) => {
    const { bridge, raw } = createRecoveryHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    vi.mocked(validateDependencyGuard).mockRejectedValueOnce(failure);

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);

    expect(raw.dependencyMutations.size).toBe(0);
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
    expect([...raw.dependencyEnvironmentUncertainty.values()]).toEqual([
      expect.objectContaining({ token: TEST_DEPENDENCY_TOKEN, selectionDetached: true })
    ]);
  });

  it("retains failed validation, releases its barrier, and permits direct retry", async () => {
    const { bridge, raw } = createRecoveryHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    vi.mocked(validateDependencyGuard).mockRejectedValueOnce(
      new DependencyGuardCommandError("validate", "validation_failed", testPythonExecutablePath("/env/bin/python"))
    );

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(false);
    expect(raw.dependencyMutations.size).toBe(0);
    expect([...raw.dependencyEnvironmentUncertainty.values()]).toEqual([
      expect.objectContaining({ token: TEST_DEPENDENCY_TOKEN, selectionDetached: true })
    ]);

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(true);
    expect(validateDependencyGuard).toHaveBeenCalledTimes(2);
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(0);
  });

  it("releases recovery single-flight and its mutation barrier without waiting for an error toast", async () => {
    const { bridge, raw } = createRecoveryHarness();
    const neverSettlingToast = new Promise<never>(() => undefined);
    const warning = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    const error = vi
      .spyOn(vscode.window, "showErrorMessage")
      .mockReturnValue(neverSettlingToast as unknown as Thenable<never>);
    vi.mocked(validateDependencyGuard).mockRejectedValueOnce(
      new DependencyGuardCommandError("validate", "validation_failed", testPythonExecutablePath("/env/bin/python"))
    );

    const first = bridge.revalidateRuntimeDependencies();
    const joined = bridge.revalidateRuntimeDependencies();
    expect(joined).toBe(first);
    await expect(Promise.all([first, joined])).resolves.toEqual([false, false]);

    expect(error).toHaveBeenCalledOnce();
    expect(raw.dependencyMutations.size).toBe(0);
    expect(raw.dependencyRecoveryOperation).toBeUndefined();

    await expect(bridge.revalidateRuntimeDependencies()).resolves.toBe(true);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(validateDependencyGuard).toHaveBeenCalledTimes(2);
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(0);
  });

  it("lets shutdown win an open modal without status-after-modal, validation, or success", async () => {
    const { bridge, raw } = createRecoveryHarness();
    const modal = deferred<"Revalidate" | undefined>();
    vi.spyOn(vscode.window, "showWarningMessage").mockReturnValue(modal.promise as unknown as Thenable<never>);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    const recovery = bridge.revalidateRuntimeDependencies();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce());
    await expect(bridge.shutdown()).resolves.toBeUndefined();
    modal.resolve("Revalidate");

    await expect(recovery).resolves.toBe(false);
    expect(getDependencyGuardStatus).toHaveBeenCalledOnce();
    expect(validateDependencyGuard).not.toHaveBeenCalled();
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
    expect(information).not.toHaveBeenCalledWith("Open Wrangler runtime dependencies were revalidated.");
  });

  it("ignores a successful validation completion that arrives after shutdown", async () => {
    const validation = controlledDependencyGuardCommand<DependencyGuardValidation>(
      "validate",
      testPythonExecutablePath("/env/bin/python")
    );
    vi.mocked(startDependencyGuardValidation).mockReturnValueOnce(validation.command);
    const { bridge, raw } = createRecoveryHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    const recovery = bridge.revalidateRuntimeDependencies();
    await vi.waitFor(() => expect(startDependencyGuardValidation).toHaveBeenCalledOnce());
    expect(raw.activeDependencyGuardCommands?.size).toBe(1);
    await expect(bridge.shutdown()).resolves.toBeUndefined();
    expect(validation.command.unref).toHaveBeenCalledOnce();
    expect(validation.command.didClose()).toBe(false);
    validation.closeSuccessfully({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "validated",
      token: TEST_DEPENDENCY_TOKEN
    });

    await expect(recovery).resolves.toBe(false);
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    await vi.waitFor(() => expect(raw.activeDependencyGuardCommands?.size).toBe(0));
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
    expect(information).not.toHaveBeenCalledWith("Open Wrangler runtime dependencies were revalidated.");
  });

  it("ignores exact validation that completes after the authorized selection changes", async () => {
    const validation = deferred<Awaited<ReturnType<typeof validateDependencyGuard>>>();
    const { bridge, raw } = createRecoveryHarness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Revalidate" as never);
    vi.mocked(validateDependencyGuard).mockReturnValue(validation.promise);
    const information = vi.spyOn(vscode.window, "showInformationMessage");

    const recovery = bridge.revalidateRuntimeDependencies();
    await vi.waitFor(() => expect(validateDependencyGuard).toHaveBeenCalledOnce());
    bridge.clearRuntimeSelection();
    validation.resolve({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "validated",
      token: TEST_DEPENDENCY_TOKEN
    });

    await expect(recovery).resolves.toBe(false);
    await vi.waitFor(() => expect(raw.dependencyMutations.size).toBe(0));
    expect(raw.dependencyEnvironmentUncertainty.size).toBe(1);
    expect(information).not.toHaveBeenCalledWith("Open Wrangler runtime dependencies were revalidated.");
  });
});

describe("PythonBridge environment resource selection", () => {
  const environment = {
    executable: testPythonExecutablePath("/env/bin/python"),
    executableIdentity: TEST_EXECUTABLE_IDENTITY,
    packageRoot: "/env",
    packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
    version: "3.12.4",
    source: "pythonExtension" as const
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  it("skips DuckDB when fsspec is missing for an automatic multibyte-delimiter import", async () => {
    const source = { ...remoteFileSource(), importOptions: { delimiter: "§" } };
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies)
      .mockResolvedValueOnce({ missing: ["fsspec==2026.7.0"], available: ["duckdb", "pytz"] })
      .mockResolvedValueOnce({ missing: [], available: ["pandas"] });

    await expect(internals.prepareRequest(automaticOpenSessionRequest(source))).resolves.toMatchObject({
      kind: "openSession",
      backend: "pandas"
    });

    expect(
      vi
        .mocked(pythonEnvironment.probeDependencies)
        .mock.calls.map(([, dependencies]) => dependencies.map((dependency) => dependency.importModule))
    ).toEqual([["duckdb", "fsspec", "pytz"], ["pandas"]]);
  });

  it("probes only Pandas for an automatic multibyte-quote import", async () => {
    const source = { ...remoteFileSource(), importOptions: { quoteChar: "“" } };
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["pandas"] });

    await expect(internals.prepareRequest(automaticOpenSessionRequest(source))).resolves.toMatchObject({
      kind: "openSession",
      backend: "pandas"
    });

    expect(
      vi
        .mocked(pythonEnvironment.probeDependencies)
        .mock.calls.map(([, dependencies]) => dependencies.map((dependency) => dependency.importModule))
    ).toEqual([["pandas"]]);
  });

  it("reports only the preferred automatic Excel backend and its exact missing requirement", async () => {
    const source = remoteSourceAt("/data/workbook.xlsx");
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies)
      .mockResolvedValueOnce({ missing: ["fastexcel>=0.20.2,<1"], available: ["polars"] })
      .mockResolvedValueOnce({ missing: ["openpyxl>=3.1.5,<4"], available: ["pandas"] });

    await expect(internals.prepareRequest(automaticOpenSessionRequest(source))).resolves.toEqual({
      kind: "error",
      code: "missing_dependencies",
      message:
        "The selected Python 3.12.4 environment cannot open this source with Polars. Missing: fastexcel>=0.20.2,<1.",
      detail:
        "Install the required dependency from this error, or run Open Wrangler: Install Runtime Dependencies, then review and confirm the exact environment change.",
      recoverable: true
    });
    expect(internals.lastMissingDependencies).toMatchObject({
      requirements: ["fastexcel>=0.20.2,<1"]
    });
  });

  it.each([
    {
      backend: "polars" as const,
      importOptions: { delimiter: "§" },
      option: "delimiter",
      alternative: "DuckDB or Pandas"
    },
    {
      backend: "polars" as const,
      importOptions: { quoteChar: "“" },
      option: "quote character",
      alternative: "Pandas"
    },
    {
      backend: "duckdb" as const,
      importOptions: { quoteChar: "“" },
      option: "quote character",
      alternative: "Pandas"
    }
  ])(
    "rejects an explicit $backend backend with a multibyte $option before probing or process startup",
    async ({ backend, importOptions, option, alternative }) => {
      const source = { ...remoteFileSource(), importOptions };
      const { bridge, internals } = createEnvironmentHarness();
      const ensureProcess = vi.spyOn(internals, "ensureProcess");

      await expect(bridge.request({ ...openSessionRequest(source), backend })).resolves.toMatchObject({
        kind: "error",
        code: "unsupported_import_options",
        message: expect.stringContaining(option),
        detail: expect.stringContaining(alternative),
        recoverable: true
      });

      expect(pythonEnvironment.resolvePythonEnvironment).not.toHaveBeenCalled();
      expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();
      expect(ensureProcess).not.toHaveBeenCalled();
    }
  );

  it("passes the exact remote source URI to dependency preparation without rebuilding it as file://", async () => {
    const source = remoteFileSource();
    const { context, internals } = createEnvironmentHarness();
    const parse = vi.spyOn(vscode.Uri, "parse");
    const file = vi.spyOn(vscode.Uri, "file");
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });

    expect(parse).toHaveBeenCalledWith(source.uri, true);
    expect(file).not.toHaveBeenCalled();
    const resource = vi.mocked(pythonEnvironment.resolvePythonEnvironment).mock.calls[0]?.[1];
    expect(resource?.scheme).toBe("vscode-remote");
    expect(resource?.authority).toBe("ssh-remote+example");
    expect(resource?.toString()).toBe(source.uri);
    expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledWith(
      context,
      resource,
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
        isTrusted: expect.any(Function)
      })
    );
  });

  it("passes the exact remote source URI to process startup without rebuilding it as file://", async () => {
    const source = remoteFileSource();
    const { context, internals } = createEnvironmentHarness({ disposed: true });
    const parse = vi.spyOn(vscode.Uri, "parse");
    const file = vi.spyOn(vscode.Uri, "file");
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);

    await expect(internals.startProcess(openSessionRequest(source), 0)).rejects.toThrow("runtime start was cancelled");

    expect(parse).toHaveBeenCalledWith(source.uri, true);
    expect(file).not.toHaveBeenCalled();
    const resource = vi.mocked(pythonEnvironment.resolvePythonEnvironment).mock.calls[0]?.[1];
    expect(resource?.scheme).toBe("vscode-remote");
    expect(resource?.authority).toBe("ssh-remote+example");
    expect(resource?.toString()).toBe(source.uri);
    expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledWith(
      context,
      resource,
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
        isTrusted: expect.any(Function)
      })
    );
  });

  it("falls back to the concrete path when a persisted source URI is malformed", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    const malformed = { ...source, uri: "missing-scheme" };
    const parse = vi.spyOn(vscode.Uri, "parse");
    const file = vi.spyOn(vscode.Uri, "file");
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    await internals.prepareRequest(openSessionRequest(malformed));

    expect(parse).toHaveBeenCalledWith(malformed.uri, true);
    expect(file).toHaveBeenCalledWith(malformed.path);
    const resource = vi.mocked(pythonEnvironment.resolvePythonEnvironment).mock.calls[0]?.[1];
    expect(resource?.scheme).toBe("file");
    expect(resource?.fsPath).toBe(malformed.path);
  });

  it("shares one selection inside a workspace folder but resolves different roots independently", async () => {
    const firstFolder = workspaceFolder("vscode-remote://ssh-remote+example/first", "first", 0);
    const secondFolder = workspaceFolder("vscode-remote://ssh-remote+example/second", "second", 1);
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockImplementation((resource) =>
      resource.path.startsWith("/first/") ? firstFolder : secondFolder
    );
    const firstSource = remoteSourceAt("/first/one.csv");
    const siblingSource = remoteSourceAt("/first/two.csv");
    const secondSource = remoteSourceAt("/second/three.csv");
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    await internals.prepareRequest(openSessionRequest(firstSource));
    await internals.prepareRequest(openSessionRequest(siblingSource));
    await internals.prepareRequest(openSessionRequest(secondSource));

    expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pythonEnvironment.resolvePythonEnvironment).mock.calls[0]?.[1]?.toString()).toBe(firstSource.uri);
    expect(vi.mocked(pythonEnvironment.resolvePythonEnvironment).mock.calls[1]?.[1]?.toString()).toBe(secondSource.uri);
    expect(internals.environmentSelections.size).toBe(2);
  });

  it("isolates real process selection, startup, invalidation, and stop barriers across workspace roots", async () => {
    const firstFolder = workspaceFolder("vscode-remote://ssh-remote+example/first", "first", 0);
    const secondFolder = workspaceFolder("vscode-remote://ssh-remote+example/second", "second", 1);
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockImplementation((resource) =>
      resource.path.startsWith("/first/") ? firstFolder : secondFolder
    );
    const firstEnvironment: TestPythonEnvironment = {
      executable: testPythonExecutablePath("/envs/first/python"),
      executableIdentity: testExecutableIdentity("/envs/first/python"),
      packageRoot: "/envs/first",
      packageRootIdentity: testPackageRootIdentity("/envs/first"),
      version: "3.12.4",
      source: "pythonExtension"
    };
    const secondEnvironment: TestPythonEnvironment = {
      executable: testPythonExecutablePath("/envs/second/python"),
      executableIdentity: testExecutableIdentity("/envs/second/python"),
      packageRoot: "/envs/second",
      packageRootIdentity: testPackageRootIdentity("/envs/second"),
      version: "3.13.2",
      source: "pythonExtension"
    };
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockImplementation(async (_context, resource) =>
      resource?.path.startsWith("/first/") ? firstEnvironment : secondEnvironment
    );
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({
      missing: [],
      available: ["polars"]
    });
    const firstProcess = new LifecycleChildProcess();
    const secondProcess = new LifecycleChildProcess();
    const firstWrites: string[] = [];
    const secondWrites: string[] = [];
    firstProcess.stdin.on("data", (chunk: Buffer) => firstWrites.push(chunk.toString()));
    secondProcess.stdin.on("data", (chunk: Buffer) => secondWrites.push(chunk.toString()));
    const bridge = new PythonBridge(testExtensionContext());
    const raw = bridge as unknown as RawBridgeInternals;
    const spawnProcess = vi.fn((executable: string) =>
      executable === firstEnvironment.executable
        ? (firstProcess as unknown as ChildProcessWithoutNullStreams)
        : (secondProcess as unknown as ChildProcessWithoutNullStreams)
    );
    Object.assign(bridge as object, { spawnProcess });
    const firstRequest = {
      ...openSessionRequest(remoteSourceAt("/first/data.csv")),
      requestedSessionId: "first-live-session"
    };
    const secondRequest = {
      ...openSessionRequest(remoteSourceAt("/second/data.csv")),
      requestedSessionId: "second-live-session"
    };

    const firstOpen = bridge.request(firstRequest);
    const secondOpen = bridge.request(secondRequest);
    await vi.waitFor(() => {
      expect(firstWrites).toHaveLength(1);
      expect(secondWrites).toHaveLength(1);
    });
    const firstRuntime = raw.runtimeSlots.get(firstFolder.uri.toString(true));
    const secondRuntime = raw.runtimeSlots.get(secondFolder.uri.toString(true));
    expect(firstRuntime).toBeDefined();
    expect(secondRuntime).toBeDefined();
    expect(firstRuntime).not.toBe(secondRuntime);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    raw.runtimeTransport.handleLine(
      firstRuntime!,
      firstProcess as unknown as ChildProcessWithoutNullStreams,
      JSON.stringify({
        protocolVersion: 2,
        requestId: (JSON.parse(firstWrites[0]) as RuntimeRequestEnvelope).requestId,
        response: openedFor(firstRequest, "first-live-session")
      } satisfies RuntimeResponseEnvelope)
    );
    raw.runtimeTransport.handleLine(
      secondRuntime!,
      secondProcess as unknown as ChildProcessWithoutNullStreams,
      JSON.stringify({
        protocolVersion: 2,
        requestId: (JSON.parse(secondWrites[0]) as RuntimeRequestEnvelope).requestId,
        response: openedFor(secondRequest, "second-live-session")
      } satisfies RuntimeResponseEnvelope)
    );
    await expect(firstOpen).resolves.toMatchObject({ kind: "sessionOpened" });
    await expect(secondOpen).resolves.toMatchObject({ kind: "sessionOpened" });

    const secondClose = bridge.request({
      kind: "closeSession",
      sessionId: "second-live-session",
      revision: 0
    });
    await vi.waitFor(() => expect(secondWrites).toHaveLength(2));
    raw.handlePythonEnvironmentSelectionChange({
      id: "first-replacement",
      path: "/envs/first-replacement/python",
      resource: firstFolder
    });

    expect(firstProcess.stdin.end).toHaveBeenCalledOnce();
    expect(secondProcess.stdin.end).not.toHaveBeenCalled();
    expect(raw.sessionOwnership.confirmedOwner("first-live-session")).toBeUndefined();
    expect(raw.sessionOwnership.confirmedOwner("second-live-session")).toBe(secondRuntime);
    expect(secondRuntime!.pendingIds.size).toBe(1);
    raw.runtimeTransport.handleLine(
      secondRuntime!,
      secondProcess as unknown as ChildProcessWithoutNullStreams,
      JSON.stringify({
        protocolVersion: 2,
        requestId: (JSON.parse(secondWrites[1]) as RuntimeRequestEnvelope).requestId,
        response: { kind: "sessionClosed", sessionId: "second-live-session" }
      } satisfies RuntimeResponseEnvelope)
    );
    await expect(secondClose).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "second-live-session"
    });
    expect(secondProcess.stdin.end).toHaveBeenCalledOnce();

    const firstStop = firstRuntime!.processStop;
    const secondStop = secondRuntime!.processStop;
    firstProcess.emit("exit", 0, null);
    secondProcess.emit("exit", 0, null);
    await expect(firstStop).resolves.toBeUndefined();
    await expect(secondStop).resolves.toBeUndefined();
    await bridge.shutdown();
  });

  it("invalidates cached selection state only for a relevant Python extension event", async () => {
    const firstFolder = workspaceFolder("vscode-remote://ssh-remote+example/first", "first", 0);
    const secondFolder = workspaceFolder("vscode-remote://ssh-remote+example/second", "second", 1);
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockImplementation((resource) =>
      resource.path.startsWith("/first/") ? firstFolder : secondFolder
    );
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });
    await internals.prepareRequest(openSessionRequest(remoteSourceAt("/first/data.csv")));
    const authorizedSelection = raw.environmentSelections.get(firstFolder.uri.toString(true));
    expect(authorizedSelection?.resolvedEnvironment).toEqual(environment);
    Object.assign(bridge as object, {
      dependencyInstallOperation: {
        phase: "quiescing",
        authorizationEpoch: 0,
        authorizationSelection: authorizedSelection
      }
    });

    internals.handlePythonEnvironmentSelectionChange({
      id: "second-env",
      path: "/envs/second/python",
      resource: secondFolder
    });
    expect(internals.selectionEpoch).toBe(0);
    expect(internals.runtimeEpoch).toBe(0);
    expect(internals.environmentSelections.size).toBe(1);
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(1);
    expect(raw.dependencyAuthorizationEpoch).toBe(0);

    internals.handlePythonEnvironmentSelectionChange({
      id: "first-env",
      path: "/envs/first/python",
      resource: firstFolder
    });
    expect(internals.selectionEpoch).toBe(1);
    expect(internals.runtimeEpoch).toBe(0);
    expect(internals.environmentSelections.size).toBe(0);
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(raw.dependencyAuthorizationEpoch).toBe(1);
  });

  it("treats an event URI in the same workspace folder as affecting sibling file selections", async () => {
    const firstFolder = workspaceFolder("vscode-remote://ssh-remote+example/first", "first", 0);
    const secondFolder = workspaceFolder("vscode-remote://ssh-remote+example/second", "second", 1);
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockImplementation((resource) =>
      resource.path.startsWith("/first/") ? firstFolder : secondFolder
    );
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });
    await internals.prepareRequest(openSessionRequest(remoteSourceAt("/first/data.csv")));

    internals.handlePythonEnvironmentSelectionChange({
      id: "first-env",
      path: "/envs/first/python",
      resource: vscode.Uri.parse("vscode-remote://ssh-remote+example/first/sibling.py", true)
    });

    expect(internals.selectionEpoch).toBe(1);
    expect(internals.environmentSelections.size).toBe(0);
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
  });

  it("ignores Python extension events while an explicit Open Wrangler interpreter wins", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue({
      ...environment,
      source: "configuration"
    });
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(key: string, fallback: T): T => (key === "pythonPath" ? ("/configured/python" as T) : fallback)
    } as vscode.WorkspaceConfiguration);
    await internals.prepareRequest(openSessionRequest(source));

    internals.handlePythonEnvironmentSelectionChange({
      id: "python-extension-env",
      path: "/extension/python",
      resource: vscode.Uri.parse(source.uri!, true)
    });

    expect(internals.selectionEpoch).toBe(0);
    expect(internals.environmentSelections.size).toBe(1);
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(1);
  });

  it("clears a stale install target after successful dependency resolution without discarding the probe cache", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    internals.lastMissingDependencies = missingDependencies(
      testEnvironmentSelection(source.uri!, environment, {
        resource: vscode.Uri.parse(source.uri!, true)
      })
    );
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });

    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(1);
    await internals.prepareRequest(openSessionRequest(source));
    expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(1);
  });

  it("re-publishes a cached missing-dependency diagnostic after an earlier target is cleared", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: ["polars"], available: [] });

    await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
      kind: "error",
      code: "missing_dependencies"
    });
    internals.lastMissingDependencies = undefined;
    await internals.prepareRequest(openSessionRequest(source));

    expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce();
    expect(internals.lastMissingDependencies).toMatchObject({
      environment,
      requirements: ["polars"],
      selectionEpoch: 0
    });
    const republished = internals.lastMissingDependencies as TestMissingDependencies | undefined;
    expect(republished?.selection.key).toBe(source.uri);
  });

  it("keys dependency probes by normalized executable and exact version within one package root", async () => {
    const baseSource = remoteSourceAt("/cache-identity/base.csv");
    const executableSource = remoteSourceAt("/cache-identity/executable.csv");
    const versionSource = remoteSourceAt("/cache-identity/version.csv");
    const normalizedAliasSource = remoteSourceAt("/cache-identity/normalized-alias.csv");
    const packageRootIdentity = testPackageRootIdentity("/usr");
    const environments = new Map<string, TestPythonEnvironment>([
      [
        baseSource.uri!,
        {
          ...environment,
          executable: testPythonExecutablePath("/usr/bin/python"),
          packageRoot: "/usr",
          packageRootIdentity,
          version: "3.12.9"
        }
      ],
      [
        executableSource.uri!,
        {
          ...environment,
          executable: testPythonExecutablePath("/usr/bin/python3"),
          packageRoot: "/usr",
          packageRootIdentity,
          version: "3.12.9"
        }
      ],
      [
        versionSource.uri!,
        {
          ...environment,
          executable: testPythonExecutablePath("/usr/bin/python"),
          packageRoot: "/usr",
          packageRootIdentity,
          version: "3.14.0"
        }
      ],
      [
        normalizedAliasSource.uri!,
        {
          ...environment,
          executable: testPythonExecutablePath("/usr/bin/../bin/python"),
          packageRoot: "/usr",
          packageRootIdentity,
          version: "3.12.9"
        }
      ]
    ]);
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockImplementation(async (_context, resource) => {
      const resolved = environments.get(resource?.toString(true) ?? "");
      if (!resolved) throw new Error("unexpected dependency probe resource");
      return resolved as pythonEnvironment.PythonEnvironment;
    });
    vi.mocked(pythonEnvironment.probeDependencies)
      .mockResolvedValueOnce({ missing: ["polars"], available: [] })
      .mockResolvedValueOnce({ missing: [], available: ["polars"] })
      .mockResolvedValueOnce({ missing: [], available: ["polars"] });

    await expect(internals.prepareRequest(openSessionRequest(baseSource))).resolves.toMatchObject({
      kind: "error",
      code: "missing_dependencies"
    });
    await expect(internals.prepareRequest(openSessionRequest(executableSource))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    await expect(internals.prepareRequest(openSessionRequest(versionSource))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    await expect(internals.prepareRequest(openSessionRequest(normalizedAliasSource))).resolves.toMatchObject({
      kind: "error",
      code: "missing_dependencies"
    });

    expect(pythonEnvironment.probeDependencies).toHaveBeenCalledTimes(3);
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(3);
    const dependencyKeyFor = (source: SessionSource): string =>
      [...raw.environmentSelections.get(source.uri!)!.dependencyKeys][0]!;
    expect(dependencyKeyFor(baseSource)).not.toBe(dependencyKeyFor(executableSource));
    expect(dependencyKeyFor(baseSource)).not.toBe(dependencyKeyFor(versionSource));
    expect(dependencyKeyFor(baseSource)).toBe(dependencyKeyFor(normalizedAliasSource));
  });

  it("runs one deferred dependency probe for exact environments and descriptors across independent scopes", async () => {
    const firstSource = remoteSourceAt("/single-flight/first.csv");
    const secondSource = remoteSourceAt("/single-flight/second.csv");
    const probe = deferred<{ missing: string[]; available: string[] }>();
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockReturnValue(probe.promise);

    const first = internals.prepareRequest(openSessionRequest(firstSource));
    const second = internals.prepareRequest(openSessionRequest(secondSource));
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce());

    expect(raw.dependencyProbes.diagnostics()).toMatchObject({ inFlightCount: 1, completedCount: 0 });
    probe.resolve({ missing: [], available: ["polars"] });

    await expect(first).resolves.toMatchObject({ kind: "openSession", backend: "polars" });
    await expect(second).resolves.toMatchObject({ kind: "openSession", backend: "polars" });
    expect(raw.dependencyProbes.diagnostics()).toMatchObject({ inFlightCount: 0, completedCount: 1 });
    expect([...raw.environmentSelections.get(firstSource.uri!)!.dependencyKeys]).toEqual([
      ...raw.environmentSelections.get(secondSource.uri!)!.dependencyKeys
    ]);
  });

  it("does not let a detached old completion overwrite newer cached or install state", async () => {
    const source = remoteSourceAt("/single-flight/newer-state.csv");
    const staleProbe = deferred<{ missing: string[]; available: string[] }>();
    const currentProbe = deferred<{ missing: string[]; available: string[] }>();
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies)
      .mockReturnValueOnce(staleProbe.promise)
      .mockReturnValueOnce(currentProbe.promise);

    const stalePreparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce());
    internals.handlePythonEnvironmentSelectionChange({
      id: "same-environment-replacement",
      path: environment.executable,
      resource: vscode.Uri.parse(source.uri!, true)
    });
    const currentPreparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledTimes(2));
    currentProbe.resolve({ missing: ["polars"], available: [] });
    await expect(currentPreparation).resolves.toMatchObject({
      kind: "error",
      code: "missing_dependencies"
    });
    const currentTarget = raw.lastMissingDependencies;
    const currentSelection = raw.environmentSelections.get(source.uri!);
    const key = [...currentSelection!.dependencyKeys][0]!;
    expect(raw.dependencyProbes.completedMissing(key)).toEqual(["polars"]);

    staleProbe.resolve({ missing: [], available: ["polars"] });
    await expect(stalePreparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(raw.dependencyProbes.completedMissing(key)).toEqual(["polars"]);
    expect(raw.lastMissingDependencies).toBe(currentTarget);
    expect(raw.lastMissingDependencies?.selection).toBe(currentSelection);
  });

  it("makes every joined consumer stale when explicit invalidation lands after probe publication", async () => {
    const firstSource = remoteSourceAt("/single-flight/post-resolution-first.csv");
    const secondSource = remoteSourceAt("/single-flight/post-resolution-second.csv");
    const probe = deferred<{ missing: string[]; available: string[] }>();
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockReturnValue(probe.promise);

    const first = internals.prepareRequest(openSessionRequest(firstSource));
    const second = internals.prepareRequest(openSessionRequest(secondSource));
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce());
    const key = [...raw.environmentSelections.get(firstSource.uri!)!.dependencyKeys][0]!;
    const missing = ["polars"];
    const result = {
      available: [] as string[],
      get missing(): string[] {
        queueMicrotask(() => raw.dependencyProbes.invalidateKey(key));
        return missing;
      }
    };
    probe.resolve(result);

    await expect(first).resolves.toMatchObject({ kind: "error", code: "runtime_selection_changed" });
    await expect(second).resolves.toMatchObject({ kind: "error", code: "runtime_selection_changed" });
    expect(raw.dependencyProbes.isEmpty).toBe(true);
    expect(raw.lastMissingDependencies).toBeUndefined();
  });

  it("does not publish an old deferred probe after runtime selection is cleared", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    const probe = deferred<{ missing: string[]; available: string[] }>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockReturnValue(probe.promise);

    const preparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce());
    internals.handlePythonEnvironmentSelectionChange({
      id: "changed",
      path: "/changed/python",
      resource: vscode.Uri.parse(source.uri!, true)
    });
    probe.resolve({ missing: ["polars"], available: [] });

    await expect(preparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed",
      recoverable: true
    });
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(internals.selectionEpoch).toBe(1);
  });

  it("does not probe or publish an environment resolved after runtime selection is cleared", async () => {
    const source = remoteFileSource();
    const { internals } = createEnvironmentHarness();
    const resolution = deferred<typeof environment>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReturnValue(resolution.promise);

    const preparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledOnce());
    const selection = internals.environmentSelections.get(source.uri!);
    internals.handlePythonEnvironmentSelectionChange({
      id: "changed",
      path: "/changed/python",
      resource: vscode.Uri.parse(source.uri!, true)
    });
    expect(selection?.resolutionController.signal.reason).toBeInstanceOf(
      pythonEnvironment.PythonEnvironmentResolutionSupersededError
    );
    resolution.resolve(environment);

    await expect(preparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
  });

  it("terminally invalidates a deferred environment resolution before shutdown awaits cleanup", async () => {
    const source = remoteFileSource();
    const resolution = deferred<typeof environment>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReturnValue(resolution.promise);
    const bridge = new PythonBridge(testExtensionContext());
    const internals = bridge as unknown as RawBridgeInternals;

    const preparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledOnce());
    const selection = internals.environmentSelections.get(source.uri!);
    await bridge.shutdown();
    expect(selection?.resolutionController.signal.reason).toBeInstanceOf(
      pythonEnvironment.PythonEnvironmentResolutionDisposedError
    );
    expect(internals.environmentSelections.size).toBe(0);
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(internals.lastMissingDependencies).toBeUndefined();

    resolution.resolve(environment);
    await expect(preparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();
    expect(internals.environmentSelections.size).toBe(0);
    expect(internals.dependencyProbes.diagnostics().completedCount).toBe(0);
    expect(internals.lastMissingDependencies).toBeUndefined();
  });

  it("does not let a dependency probe republish cache or install state after shutdown", async () => {
    const source = remoteFileSource();
    const probe = deferred<{ missing: string[]; available: string[] }>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockReturnValue(probe.promise);
    const bridge = new PythonBridge(testExtensionContext());
    const internals = bridge as unknown as RawBridgeInternals;

    const preparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce());
    expect(internals.dependencyProbes.diagnostics().inFlightCount).toBe(1);
    await bridge.shutdown();
    expect(internals.dependencyProbes.diagnostics().inFlightCount).toBe(0);
    probe.resolve({ missing: ["polars"], available: [] });

    await expect(preparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(internals.environmentSelections.size).toBe(0);
    expect(internals.dependencyProbes.isEmpty).toBe(true);
    expect(internals.lastMissingDependencies).toBeUndefined();
  });

  it("bounds retained inactive external-resource scopes and scrubs exact evicted state", async () => {
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockImplementation(async (_context, resource) => {
      const packageRoot = `/envs${resource?.path ?? "/default"}`;
      return {
        ...environment,
        executable: testPythonExecutablePath(`${packageRoot}/python`),
        packageRoot,
        packageRootIdentity: testPackageRootIdentity(packageRoot)
      };
    });
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    const oldestSource = remoteSourceAt("/retention/0.csv");
    await internals.prepareRequest(openSessionRequest(oldestSource));
    const oldest = raw.runtimeSlots.get(oldestSource.uri!);
    expect(oldest).toBeDefined();
    oldest!.stderrBuffer = "scope-local diagnostic";
    oldest!.runtimeExitError = new Error("old runtime failure");
    raw.selectionEpochs.set(oldestSource.uri!, 7);

    for (let index = 1; index < 144; index += 1) {
      await internals.prepareRequest(openSessionRequest(remoteSourceAt(`/retention/${index}.csv`)));
    }

    expect(raw.runtimeSlots.size).toBe(128);
    expect(raw.environmentSelections.size).toBe(128);
    expect(raw.runtimeScopes.recency.size).toBe(128);
    expect(raw.runtimeSlots.has(oldestSource.uri!)).toBe(false);
    expect(raw.environmentSelections.has(oldestSource.uri!)).toBe(false);
    expect(raw.selectionEpochs.has(oldestSource.uri!)).toBe(false);
    expect(raw.runtimeScopes.recency.has(oldestSource.uri!)).toBe(false);
    expect(oldest!.stderrBuffer).toBe("");
    expect(oldest!.runtimeExitError).toBeUndefined();
    expect(raw.dependencyProbes.diagnostics().completedCount).toBe(128);
    expect(raw.runtimeSlots.has(remoteSourceAt("/retention/143.csv").uri!)).toBe(true);
  });

  it("never evicts the exact actionable missing-dependency scope", async () => {
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const missingSource = remoteSourceAt("/retention/missing.csv");
    const missingEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/envs/missing/python"),
      packageRoot: "/envs/missing",
      packageRootIdentity: testPackageRootIdentity("/envs/missing")
    };
    const healthyEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/envs/healthy/python"),
      packageRoot: "/envs/healthy",
      packageRootIdentity: testPackageRootIdentity("/envs/healthy")
    };
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockImplementation(async (_context, resource) =>
      resource?.toString(true) === missingSource.uri ? missingEnvironment : healthyEnvironment
    );
    vi.mocked(pythonEnvironment.probeDependencies).mockImplementation(async (executable) =>
      executable === missingEnvironment.executable
        ? { missing: ["polars"], available: [] }
        : { missing: [], available: ["polars"] }
    );

    await expect(internals.prepareRequest(openSessionRequest(missingSource))).resolves.toMatchObject({
      kind: "error",
      code: "missing_dependencies"
    });
    const exactTarget = internals.lastMissingDependencies;
    expect(exactTarget?.selection.key).toBe(missingSource.uri);

    for (let index = 0; index < 144; index += 1) {
      await internals.prepareRequest(openSessionRequest(remoteSourceAt(`/retention/healthy-${index}.csv`)));
    }

    expect(raw.runtimeSlots.size).toBe(128);
    expect(raw.environmentSelections.size).toBe(128);
    expect(raw.runtimeSlots.has(missingSource.uri!)).toBe(true);
    expect(raw.environmentSelections.get(missingSource.uri!)).toBe(exactTarget?.selection);
    expect(internals.lastMissingDependencies).toBe(exactTarget);
  });

  it("leases one exact scope through deferred environment resolution and dependency probing", async () => {
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const targetSource = remoteSourceAt("/retention/deferred.csv");
    const targetEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/envs/deferred/python"),
      packageRoot: "/envs/deferred",
      packageRootIdentity: testPackageRootIdentity("/envs/deferred")
    };
    const healthyEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/envs/healthy/python"),
      packageRoot: "/envs/healthy",
      packageRootIdentity: testPackageRootIdentity("/envs/healthy")
    };
    const resolution = deferred<TestPythonEnvironment>();
    const probe = deferred<{ missing: string[]; available: string[] }>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockImplementation((_context, resource) =>
      resource?.toString(true) === targetSource.uri ? resolution.promise : Promise.resolve(healthyEnvironment)
    );
    vi.mocked(pythonEnvironment.probeDependencies).mockImplementation((executable) =>
      executable === targetEnvironment.executable
        ? probe.promise
        : Promise.resolve({ missing: [], available: ["polars"] })
    );

    const preparation = internals.prepareRequest(openSessionRequest(targetSource));
    await vi.waitFor(() => expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledOnce());
    const targetRuntime = raw.runtimeSlots.get(targetSource.uri!);
    expect(targetRuntime?.leaseCount).toBe(1);

    for (let index = 0; index < 144; index += 1) {
      await internals.prepareRequest(openSessionRequest(remoteSourceAt(`/retention/deferred-peer-${index}.csv`)));
    }
    expect(raw.runtimeSlots.get(targetSource.uri!)).toBe(targetRuntime);
    expect(targetRuntime?.leaseCount).toBe(1);

    resolution.resolve(targetEnvironment);
    await vi.waitFor(() =>
      expect(pythonEnvironment.probeDependencies).toHaveBeenCalledWith(targetEnvironment.executable, expect.any(Array))
    );
    expect(raw.runtimeSlots.get(targetSource.uri!)).toBe(targetRuntime);
    expect(targetRuntime?.leaseCount).toBe(1);

    probe.resolve({ missing: [], available: ["polars"] });
    await expect(preparation).resolves.toMatchObject({ kind: "openSession", backend: "polars" });
    expect(targetRuntime?.leaseCount).toBe(0);

    await internals.prepareRequest(openSessionRequest(remoteSourceAt("/retention/deferred-peer-final.csv")));
    expect(raw.runtimeSlots.has(targetSource.uri!)).toBe(false);
    expect(raw.environmentSelections.has(targetSource.uri!)).toBe(false);
    expect(raw.dependencyProbes.diagnostics().completedCount).toBe(2);
  });

  it("refreshes scope recency without changing deterministic runtime-slot order", async () => {
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    for (let index = 0; index < 128; index += 1) {
      await internals.prepareRequest(openSessionRequest(remoteSourceAt(`/recency/${index}.csv`)));
    }
    const insertionOrder = [...raw.runtimeSlots.keys()];
    await internals.prepareRequest(openSessionRequest(remoteSourceAt("/recency/0.csv")));
    expect([...raw.runtimeSlots.keys()]).toEqual(insertionOrder);

    await internals.prepareRequest(openSessionRequest(remoteSourceAt("/recency/128.csv")));
    expect(raw.runtimeSlots.has(remoteSourceAt("/recency/0.csv").uri!)).toBe(true);
    expect(raw.runtimeSlots.has(remoteSourceAt("/recency/1.csv").uri!)).toBe(false);
    expect(raw.runtimeSlots.has(remoteSourceAt("/recency/128.csv").uri!)).toBe(true);
  });

  it("does not let a stale environment-resolution callback overwrite a same-key recreation", async () => {
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const source = remoteSourceAt("/recreated/resolution.csv");
    const staleEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/envs/stale/python"),
      packageRoot: "/envs/stale",
      packageRootIdentity: testPackageRootIdentity("/envs/stale")
    };
    const currentEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/envs/current/python"),
      packageRoot: "/envs/current",
      packageRootIdentity: testPackageRootIdentity("/envs/current")
    };
    const staleResolution = deferred<TestPythonEnvironment>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment)
      .mockReturnValueOnce(staleResolution.promise)
      .mockResolvedValue(currentEnvironment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["polars"] });

    const stalePreparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.resolvePythonEnvironment).toHaveBeenCalledOnce());
    internals.handlePythonEnvironmentSelectionChange({
      id: "replacement",
      path: currentEnvironment.executable,
      resource: vscode.Uri.parse(source.uri!, true)
    });
    await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    const currentSelection = raw.environmentSelections.get(source.uri!);
    expect(currentSelection?.resolvedEnvironment).toEqual(currentEnvironment);

    staleResolution.resolve(staleEnvironment);
    await expect(stalePreparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(raw.environmentSelections.get(source.uri!)).toBe(currentSelection);
    expect(currentSelection?.resolvedEnvironment).toEqual(currentEnvironment);
    expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce();
    expect(vi.mocked(pythonEnvironment.probeDependencies).mock.calls[0]?.[0]).toBe(currentEnvironment.executable);
  });

  it("does not let a stale dependency probe publish after a same-key recreation", async () => {
    const { bridge, internals } = createEnvironmentHarness();
    const raw = bridge as unknown as RawBridgeInternals;
    const source = remoteSourceAt("/recreated/probe.csv");
    const staleEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/envs/stale-probe/python"),
      packageRoot: "/envs/stale-probe",
      packageRootIdentity: testPackageRootIdentity("/envs/stale-probe")
    };
    const currentEnvironment = {
      ...environment,
      executable: testPythonExecutablePath("/envs/current-probe/python"),
      packageRoot: "/envs/current-probe",
      packageRootIdentity: testPackageRootIdentity("/envs/current-probe")
    };
    const staleProbe = deferred<{ missing: string[]; available: string[] }>();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment)
      .mockResolvedValueOnce(staleEnvironment)
      .mockResolvedValue(currentEnvironment);
    vi.mocked(pythonEnvironment.probeDependencies)
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValue({ missing: [], available: ["polars"] });

    const stalePreparation = internals.prepareRequest(openSessionRequest(source));
    await vi.waitFor(() => expect(pythonEnvironment.probeDependencies).toHaveBeenCalledOnce());
    internals.handlePythonEnvironmentSelectionChange({
      id: "replacement",
      path: currentEnvironment.executable,
      resource: vscode.Uri.parse(source.uri!, true)
    });
    await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
      kind: "openSession",
      backend: "polars"
    });
    const currentSelection = raw.environmentSelections.get(source.uri!);

    staleProbe.resolve({ missing: ["polars"], available: [] });
    await expect(stalePreparation).resolves.toMatchObject({
      kind: "error",
      code: "runtime_selection_changed"
    });
    expect(raw.environmentSelections.get(source.uri!)).toBe(currentSelection);
    expect(currentSelection?.resolvedEnvironment).toEqual(currentEnvironment);
    expect(internals.lastMissingDependencies).toBeUndefined();
    expect(raw.dependencyProbes.diagnostics().completedCount).toBe(1);
    expect([...currentSelection!.dependencyKeys]).toEqual(raw.dependencyProbes.diagnostics().completedKeys);
  });
});

class ManualCancellation implements CancellationTokenLike {
  isCancellationRequested = false;
  private listener: (() => void) | undefined;
  readonly dispose = vi.fn();

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listener = listener;
    return { dispose: this.dispose };
  }

  cancel(): void {
    if (this.isCancellationRequested) return;
    this.isCancellationRequested = true;
    this.listener?.();
  }
}

interface TestEnvironmentSelection {
  readonly key: string;
  readonly epoch: number;
  readonly resource: vscode.Uri | undefined;
  readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
  readonly promise: Promise<TestPythonEnvironment>;
  readonly resolutionController: AbortController;
  readonly dependencyKeys: Set<string>;
  resolvedEnvironment?: TestPythonEnvironment;
}

interface TestProcessSelection {
  readonly selection: TestEnvironmentSelection;
  readonly environment: TestPythonEnvironment;
}

interface TestRuntimeSlot {
  readonly key: string;
  readonly pendingIds: Set<string>;
  readonly provisionalSessionIds: Set<string>;
  readonly sessionIds: Set<string>;
  readonly stoppingProcesses: Map<
    ChildProcessWithoutNullStreams,
    { packageEnvironmentKey: string | undefined; shutdown: Promise<void>; exit: Promise<void> }
  >;
  leaseCount: number;
  process: ChildProcessWithoutNullStreams | undefined;
  processStart: Promise<ChildProcessWithoutNullStreams> | undefined;
  processSelection: TestProcessSelection | undefined;
  processStartSelection: TestProcessSelection | undefined;
  processStop: Promise<void> | undefined;
  runtimeExitError: Error | undefined;
  stderrBuffer: string;
  runtimeEpoch: number;
}

interface RawBridgeInternals {
  disposed: boolean;
  selectionEpoch: number;
  dependencyAuthorizationEpoch: number;
  selectionEpochs: Map<string, number>;
  runtimeScopes: PythonRuntimeScopeRegistry<TestRuntimeSlot, TestEnvironmentSelection>;
  runtimeSlots: Map<string, TestRuntimeSlot>;
  sessionOwnership: PythonSessionOwnership<TestRuntimeSlot>;
  environmentSelections: Map<string, TestEnvironmentSelection>;
  dependencyProbes: PythonDependencyProbeRegistry;
  dependencyGuardStatusFlights: Map<string, unknown>;
  activeDependencyGuardCommands:
    Set<OwnedDependencyGuardCommand<DependencyGuardStatus | DependencyGuardValidation>> | undefined;
  dependencyEnvironmentUncertainty: Map<string, unknown>;
  dependencyMutations: Map<string, unknown>;
  dependencyInstallOperation:
    | {
        phase: string;
        promise?: Promise<boolean>;
        process?: OwnedDependencyInstall;
        uncertainty?: unknown;
      }
    | undefined;
  dependencyRecoveryOperation:
    | {
        phase: string;
        promise?: Promise<boolean>;
        target?: unknown;
        mutation?: { phase: string };
      }
    | undefined;
  lastMissingDependencies: TestMissingDependencies | undefined;
  runtimeTransport: PythonRuntimeTransport<TestRuntimeSlot>;
  output: { appendLine(message: string): void };
  prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse>;
  prepareRequestForDispatch(request: OpenWranglerRequest): Promise<{
    request: OpenWranglerRequest | ErrorResponse;
    processSelection?: TestProcessSelection;
  }>;
  processSelectionFor(request: OpenWranglerRequest): Promise<TestProcessSelection>;
  markDependencyEnvironmentUncertain(
    environment: TestPythonEnvironment,
    token: string | undefined,
    reason: unknown,
    selection?: TestEnvironmentSelection
  ): void;
  dependencyGuardStatusForEnvironment(environment: TestPythonEnvironment): Promise<DependencyGuardStatus>;
  runtimeSlot(key: string): TestRuntimeSlot;
  retainRuntime(runtime: TestRuntimeSlot): () => void;
  ensureProcess(runtime: TestRuntimeSlot, selection: TestProcessSelection): Promise<ChildProcessWithoutNullStreams>;
  startProcess(
    runtime: TestRuntimeSlot,
    epoch: number,
    selection: TestProcessSelection
  ): Promise<ChildProcessWithoutNullStreams>;
  trackProcessStop(
    runtime: TestRuntimeSlot,
    process: ChildProcessWithoutNullStreams,
    gracefulTimeoutMs?: number,
    packageEnvironmentKey?: string
  ): void;
  handlePythonEnvironmentSelectionChange(event: pythonEnvironment.PythonEnvironmentSelectionChangeEvent): void;
  runtimeUnavailableError(runtime: TestRuntimeSlot, error?: unknown): Error;
  restartRuntime(runtime: TestRuntimeSlot, reason: string): void;
  stopRuntimeIfIdle(runtime: TestRuntimeSlot): void;
  trimInactiveScopes(): void;
}

function createDependencyProbeRegistry(raw: RawBridgeInternals): PythonDependencyProbeRegistry {
  return new PythonDependencyProbeRegistry(
    (packageEnvironmentKey) => raw.disposed || raw.dependencyMutations.has(packageEnvironmentKey),
    (executable, dependencies) => pythonEnvironment.probeDependencies(executable, dependencies)
  );
}

function createSessionOwnership(raw: RawBridgeInternals): PythonSessionOwnership<TestRuntimeSlot> {
  return new PythonSessionOwnership((runtime, reason) => raw.restartRuntime(runtime, reason));
}

function createRuntimeScopeRegistry(
  raw: RawBridgeInternals,
  options: {
    runtimeSlots?: Map<string, TestRuntimeSlot>;
    environmentSelections?: Map<string, TestEnvironmentSelection>;
    selectionEpochs?: Map<string, number>;
    scopeRecency?: Map<string, number>;
    initialUseClock?: number;
  } = {}
): PythonRuntimeScopeRegistry<TestRuntimeSlot, TestEnvironmentSelection> {
  return new PythonRuntimeScopeRegistry({
    createRuntime: testRuntimeSlot,
    slots: options.runtimeSlots,
    environmentSelections: options.environmentSelections ?? new Map(),
    selectionEpochs: options.selectionEpochs ?? new Map(),
    recency: options.scopeRecency,
    initialUseClock: options.initialUseClock,
    activeMissingSelection: () => raw.lastMissingDependencies?.selection,
    abortSelection: (selection) => selection.resolutionController.abort(),
    hasExternalOwnership: (runtime) =>
      raw.runtimeTransport.hasOwnership(runtime) || raw.sessionOwnership.hasClaimsFor(runtime)
  });
}

function createRuntimeTransport(raw: RawBridgeInternals): PythonRuntimeTransport<TestRuntimeSlot> {
  return new PythonRuntimeTransport({
    sessionOwnership: raw.sessionOwnership,
    restartRuntime: (runtime, reason) => raw.restartRuntime(runtime, reason),
    stopRuntimeIfIdle: (runtime) => raw.stopRuntimeIfIdle(runtime),
    runtimeUnavailableError: (runtime, error) => raw.runtimeUnavailableError(runtime, error),
    reportDiagnostic: (message) => raw.output.appendLine(message)
  });
}

function attachRuntimeTransport(bridge: PythonBridge): void {
  const raw = bridge as unknown as RawBridgeInternals;
  Object.assign(bridge as object, { runtimeTransport: createRuntimeTransport(raw) });
}

async function cacheDependencyProbe(
  registry: PythonDependencyProbeRegistry,
  environment: TestPythonEnvironment,
  dependencies: readonly PythonDependency[],
  missing: readonly string[]
): Promise<string> {
  vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValueOnce({ missing: [...missing], available: [] });
  const probe = registry.probe(environment, dependencies);
  await probe.result;
  return probe.key;
}

interface LifecycleBridgeInternals {
  process: ChildProcessWithoutNullStreams | undefined;
  processStop: Promise<void> | undefined;
  disposed: boolean;
  runtimeEpoch: number;
  readonly runtime: TestRuntimeSlot;
  readonly selection: TestEnvironmentSelection;
  spawnProcess: ReturnType<typeof vi.fn>;
  ensureProcess(request: OpenWranglerRequest): Promise<ChildProcessWithoutNullStreams>;
  trackProcessStop(
    proc: ChildProcessWithoutNullStreams,
    gracefulTimeoutMs?: number,
    packageEnvironmentKey?: string
  ): void;
}

class LifecycleChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
  readonly unref = vi.fn();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    vi.spyOn(this.stdin, "end");
  }
}

function createLifecycleHarness(): {
  bridge: PythonBridge;
  internals: LifecycleBridgeInternals;
  process: LifecycleChildProcess;
  configurationSubscription: { dispose: ReturnType<typeof vi.fn> };
  output: { appendLine: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
} {
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const process = new LifecycleChildProcess();
  const configurationSubscription = { dispose: vi.fn() };
  const output = { appendLine: vi.fn(), dispose: vi.fn() };
  const environment = {
    executable: testPythonExecutablePath("/env/bin/python"),
    executableIdentity: TEST_EXECUTABLE_IDENTITY,
    packageRoot: "/env",
    packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
    version: "3.12.4",
    source: "configuration" as const
  };
  const selection = testEnvironmentSelection("<workspace-default>", environment);
  const runtime = testRuntimeSlot(selection.key, process as unknown as ChildProcessWithoutNullStreams, {
    environment,
    selection
  });
  const raw = bridge as unknown as RawBridgeInternals;
  const spawnProcess = vi.fn();
  const runtimeSlots = new Map([[runtime.key, runtime]]);
  const selectionEpochs = new Map([[selection.key, 0]]);
  const environmentSelections = new Map([[selection.key, selection]]);
  const runtimeScopes = createRuntimeScopeRegistry(raw, {
    runtimeSlots,
    selectionEpochs,
    environmentSelections,
    scopeRecency: new Map([[selection.key, 1]]),
    initialUseClock: 1
  });
  vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
  Object.assign(bridge as object, {
    context: testExtensionContext(),
    shutdownPromise: undefined,
    runtimeScopes,
    sessionOwnership: createSessionOwnership(raw),
    selectionEpoch: 0,
    dependencyAuthorizationEpoch: 0,
    selectionEpochs,
    generation: 0,
    disposed: false,
    environmentSelections,
    dependencyProbes: createDependencyProbeRegistry(raw),
    dependencyGuardStatusFlights: new Map<string, unknown>(),
    dependencyEnvironmentUncertainty: new Map<string, unknown>(),
    launchDependencyGuardStatus: startDependencyGuardStatus,
    launchDependencyGuardValidation: startDependencyGuardValidation,
    dependencyMutations: new Map(),
    lastMissingDependencies: undefined,
    spawnProcess,
    configurationSubscription,
    environmentApiBroker: { dispose: vi.fn() },
    output
  });
  attachRuntimeTransport(bridge);
  const internals: LifecycleBridgeInternals = {
    get process() {
      return runtime.process;
    },
    set process(value) {
      runtime.process = value;
    },
    get processStop() {
      return runtime.processStop;
    },
    set processStop(value) {
      runtime.processStop = value;
    },
    get disposed() {
      return raw.disposed;
    },
    set disposed(value) {
      raw.disposed = value;
    },
    get runtimeEpoch() {
      return runtime.runtimeEpoch;
    },
    set runtimeEpoch(value) {
      runtime.runtimeEpoch = value;
    },
    runtime,
    selection,
    spawnProcess,
    ensureProcess: async (request) => {
      const resource =
        request.kind === "openSession" && request.source.uri ? vscode.Uri.parse(request.source.uri, true) : undefined;
      const nextEnvironment = await pythonEnvironment.resolvePythonEnvironment(
        testExtensionContext(),
        resource,
        undefined
      );
      return raw.ensureProcess(runtime, { selection, environment: nextEnvironment });
    },
    trackProcessStop: (child, gracefulTimeoutMs, packageEnvironmentKey) =>
      raw.trackProcessStop(runtime, child, gracefulTimeoutMs, packageEnvironmentKey)
  };
  return {
    bridge,
    internals,
    process,
    configurationSubscription,
    output
  };
}

interface EnvironmentBridgeInternals {
  dependencyProbes: PythonDependencyProbeRegistry;
  environmentSelections: Map<string, TestEnvironmentSelection>;
  lastMissingDependencies: TestMissingDependencies | undefined;
  runtimeEpoch: number;
  selectionEpoch: number;
  clearRuntimeSelection(): void;
  ensureProcess(request: OpenWranglerRequest): Promise<ChildProcessWithoutNullStreams>;
  handlePythonEnvironmentSelectionChange(event: pythonEnvironment.PythonEnvironmentSelectionChangeEvent): void;
  prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse>;
  startProcess(request: OpenWranglerRequest, epoch: number): Promise<ChildProcessWithoutNullStreams>;
}

interface DependencyBridgeInternals {
  dependencyProbes: PythonDependencyProbeRegistry;
  environmentSelections: Map<string, TestEnvironmentSelection>;
  lastMissingDependencies: TestMissingDependencies | undefined;
  runtimeEpoch: number;
  selectionEpoch: number;
  prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse>;
}

interface TestPythonEnvironment {
  executable: string;
  executableIdentity: {
    device: string;
    inode: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
  };
  packageRoot: string;
  packageRootIdentity: { device: string; inode: string };
  version: string;
  source: "configuration" | "pythonExtension" | "system";
}

interface TestMissingDependencies {
  environment: TestPythonEnvironment;
  dependencies: readonly PythonDependency[];
  requirements: readonly string[];
  selection: TestEnvironmentSelection;
  selectionEpoch: number;
}

interface TestWorkspace {
  __fireDidChangeConfiguration(section: string): void;
}

interface TestProgressWindow {
  withProgress<T>(options: unknown, task: () => Promise<T>): Promise<T>;
}

function createEnvironmentHarness(options: { disposed?: boolean } = {}): {
  bridge: PythonBridge;
  context: vscode.ExtensionContext;
  internals: EnvironmentBridgeInternals;
} {
  const context = testExtensionContext();
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const raw = bridge as unknown as RawBridgeInternals;
  const runtimeSlots = new Map<string, TestRuntimeSlot>();
  const selectionEpochs = new Map<string, number>();
  const environmentSelections = new Map<string, TestEnvironmentSelection>();
  const runtimeScopes = createRuntimeScopeRegistry(raw, {
    runtimeSlots,
    selectionEpochs,
    environmentSelections
  });
  Object.assign(bridge as object, {
    context,
    runtimeScopes,
    sessionOwnership: createSessionOwnership(raw),
    selectionEpoch: 0,
    dependencyAuthorizationEpoch: 0,
    selectionEpochs,
    disposed: options.disposed ?? false,
    environmentSelections,
    dependencyProbes: createDependencyProbeRegistry(raw),
    dependencyGuardStatusFlights: new Map<string, unknown>(),
    dependencyEnvironmentUncertainty: new Map<string, unknown>(),
    launchDependencyGuardStatus: startDependencyGuardStatus,
    launchDependencyGuardValidation: startDependencyGuardValidation,
    dependencyMutations: new Map(),
    lastMissingDependencies: undefined,
    generation: 0,
    spawnProcess: vi.fn(),
    configurationSubscription: { dispose: vi.fn() },
    output: { appendLine: vi.fn(), dispose: vi.fn() }
  });
  attachRuntimeTransport(bridge);
  const internals: EnvironmentBridgeInternals = {
    get dependencyProbes() {
      return raw.dependencyProbes;
    },
    get environmentSelections() {
      return raw.environmentSelections;
    },
    get lastMissingDependencies() {
      return raw.lastMissingDependencies;
    },
    set lastMissingDependencies(value) {
      raw.lastMissingDependencies = value;
    },
    get runtimeEpoch() {
      return Math.max(0, ...[...runtimeSlots.values()].map((runtime) => runtime.runtimeEpoch));
    },
    get selectionEpoch() {
      return raw.selectionEpoch;
    },
    set selectionEpoch(value) {
      raw.selectionEpoch = value;
    },
    clearRuntimeSelection: () => bridge.clearRuntimeSelection(),
    ensureProcess: async (request) => {
      const desired = await raw.processSelectionFor(request);
      return raw.ensureProcess(raw.runtimeSlot(desired.selection.key), desired);
    },
    handlePythonEnvironmentSelectionChange: (event) => raw.handlePythonEnvironmentSelectionChange(event),
    prepareRequest: (request) => raw.prepareRequest(request),
    startProcess: async (request, epoch) => {
      const desired = await raw.processSelectionFor(request);
      return raw.startProcess(raw.runtimeSlot(desired.selection.key), epoch, desired);
    }
  };
  return { bridge, context, internals };
}

function createDependencyHarness(execute: () => Promise<unknown> = async () => undefined): {
  bridge: PythonBridge;
  raw: RawBridgeInternals;
  internals: DependencyBridgeInternals;
  launchDependencyInstall: ReturnType<typeof vi.fn>;
} {
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const raw = bridge as unknown as RawBridgeInternals;
  const launchDependencyInstall = vi.fn(() => fakeOwnedDependencyInstall(execute));
  const target = missingDependencies();
  vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(
    target.environment as pythonEnvironment.PythonEnvironment
  );
  const runtime = testRuntimeSlot(target.selection.key);
  const runtimeSlots = new Map([[runtime.key, runtime]]);
  const selectionEpochs = new Map([[target.selection.key, 0]]);
  const environmentSelections = new Map([[target.selection.key, target.selection]]);
  const runtimeScopes = createRuntimeScopeRegistry(raw, {
    runtimeSlots,
    selectionEpochs,
    environmentSelections,
    scopeRecency: new Map([[target.selection.key, 1]]),
    initialUseClock: 1
  });
  Object.assign(bridge as object, {
    context: testExtensionContext(),
    runtimeScopes,
    sessionOwnership: createSessionOwnership(raw),
    selectionEpoch: 0,
    dependencyAuthorizationEpoch: 0,
    selectionEpochs,
    disposed: false,
    environmentSelections,
    dependencyProbes: createDependencyProbeRegistry(raw),
    dependencyGuardStatusFlights: new Map<string, unknown>(),
    dependencyEnvironmentUncertainty: new Map<string, unknown>(),
    launchDependencyGuardStatus: startDependencyGuardStatus,
    launchDependencyGuardValidation: startDependencyGuardValidation,
    lastMissingDependencies: target,
    dependencyInstallOperation: undefined,
    dependencyMutations: new Map(),
    launchDependencyInstall,
    waitForDependencyInstallExit,
    spawnProcess: vi.fn(),
    configurationSubscription: { dispose: vi.fn() },
    environmentApiBroker: { dispose: vi.fn() },
    output: { appendLine: vi.fn(), dispose: vi.fn() }
  });
  attachRuntimeTransport(bridge);
  const internals: DependencyBridgeInternals = {
    get dependencyProbes() {
      return raw.dependencyProbes;
    },
    get environmentSelections() {
      return raw.environmentSelections;
    },
    get lastMissingDependencies() {
      return raw.lastMissingDependencies;
    },
    set lastMissingDependencies(value) {
      raw.lastMissingDependencies = value;
    },
    get runtimeEpoch() {
      return runtime.runtimeEpoch;
    },
    get selectionEpoch() {
      return raw.selectionEpoch;
    },
    prepareRequest: (request) => raw.prepareRequest(request)
  };
  return { bridge, raw, internals, launchDependencyInstall };
}

function createRecoveryHarness(): ReturnType<typeof createDependencyHarness> & {
  target: TestMissingDependencies;
} {
  const harness = createDependencyHarness();
  const target = harness.raw.lastMissingDependencies!;
  harness.raw.markDependencyEnvironmentUncertain(
    target.environment,
    TEST_DEPENDENCY_TOKEN,
    new Error("interrupted dependency change"),
    target.selection
  );
  vi.mocked(getDependencyGuardStatus).mockResolvedValue({
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "status",
    state: "dirty",
    token: TEST_DEPENDENCY_TOKEN
  });
  return { ...harness, target };
}

function ownedDependencyGuardCommand<Result>(
  mode: "status" | "validate",
  executable: string,
  completion: Promise<Result>,
  unref = vi.fn()
): OwnedDependencyGuardCommand<Result> {
  let closed = false;
  const markClosed = (): void => {
    closed = true;
  };
  const ownershipReleased = completion.then(markClosed, markClosed);
  return {
    child: { unref } as unknown as ChildProcess,
    mode,
    executable,
    completion,
    ownershipReleased,
    didSpawn: () => true,
    didClose: () => closed,
    unref
  };
}

function controlledDependencyGuardCommand<Result>(
  mode: "status" | "validate",
  executable: string,
  unref = vi.fn()
): {
  command: OwnedDependencyGuardCommand<Result>;
  closeSuccessfully(result: Result): void;
  closeWithFailure(error: Error): void;
  failCompletionBeforeClose(error: Error): void;
  releaseOwnershipAfterClose(): void;
} {
  let resolve!: (result: Result) => void;
  let reject!: (error: Error) => void;
  let resolveOwnershipReleased!: () => void;
  let closed = false;
  const completion = new Promise<Result>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  const ownershipReleased = new Promise<void>((innerResolve) => {
    resolveOwnershipReleased = innerResolve;
  });
  void completion.catch(() => undefined);
  const releaseOwnershipAfterClose = (): void => {
    if (closed) return;
    closed = true;
    resolveOwnershipReleased();
  };
  return {
    command: {
      child: { unref } as unknown as ChildProcess,
      mode,
      executable,
      completion,
      ownershipReleased,
      didSpawn: () => true,
      didClose: () => closed,
      unref
    },
    closeSuccessfully: (result) => {
      releaseOwnershipAfterClose();
      resolve(result);
    },
    closeWithFailure: (error) => {
      releaseOwnershipAfterClose();
      reject(error);
    },
    failCompletionBeforeClose: reject,
    releaseOwnershipAfterClose
  };
}

function fakeOwnedDependencyInstall(execute: () => Promise<unknown>): OwnedDependencyInstall {
  const completion = Promise.resolve()
    .then(execute)
    .then(() => undefined);
  void completion.catch(() => undefined);
  let authorized = false;
  return {
    child: { unref: vi.fn() } as unknown as ChildProcess,
    executable: testPythonExecutablePath("/env/bin/python"),
    requirements: [...TEST_DEPENDENCY_REQUIREMENTS],
    token: TEST_DEPENDENCY_TOKEN,
    ready: Promise.resolve({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "ready",
      token: TEST_DEPENDENCY_TOKEN
    }),
    exit: completion.then(
      () => undefined,
      () => undefined
    ),
    completion,
    authorizeWrites: vi.fn(() => {
      authorized = true;
    }),
    abortBeforeWrites: vi.fn(),
    didSpawn: () => true,
    didAuthorize: () => authorized,
    unref: vi.fn()
  };
}

function controlledDependencyInstall(
  executable = testPythonExecutablePath("/env/bin/python"),
  deferReady = false
): {
  operation: OwnedDependencyInstall;
  child: LifecycleChildProcess;
  publishReady(): void;
  closeSuccessfully(): void;
  closeWithFailure(error: Error): void;
} {
  const child = new LifecycleChildProcess();
  const ready = deferred<{
    protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
    kind: "ready";
    token: string;
  }>();
  const exit = deferred<void>();
  const completion = deferred<void>();
  void completion.promise.catch(() => undefined);
  const unref = vi.fn(() => child.unref());
  let authorized = false;
  const authorizeWrites = vi.fn(() => {
    authorized = true;
  });
  const publishReady = (): void =>
    ready.resolve({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "ready",
      token: TEST_DEPENDENCY_TOKEN
    });
  if (!deferReady) publishReady();
  return {
    operation: {
      child: child as unknown as ChildProcess,
      executable,
      requirements: [...TEST_DEPENDENCY_REQUIREMENTS],
      token: TEST_DEPENDENCY_TOKEN,
      ready: ready.promise,
      exit: exit.promise,
      completion: completion.promise,
      authorizeWrites,
      abortBeforeWrites: vi.fn(),
      didSpawn: () => true,
      didAuthorize: () => authorized,
      unref
    },
    child,
    publishReady,
    closeSuccessfully: () => {
      exit.resolve(undefined);
      completion.resolve(undefined);
    },
    closeWithFailure: (error) => {
      exit.resolve(undefined);
      completion.reject(error);
    }
  };
}

function missingDependencies(
  selection = testEnvironmentSelection("<workspace-default>", {
    executable: testPythonExecutablePath("/env/bin/python"),
    executableIdentity: TEST_EXECUTABLE_IDENTITY,
    packageRoot: "/env",
    packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
    version: "3.12.4",
    source: "configuration"
  })
): TestMissingDependencies {
  return {
    environment: selection.resolvedEnvironment!,
    dependencies: TEST_DEPENDENCIES.map((dependency) => ({ ...dependency })),
    requirements: [...TEST_DEPENDENCY_REQUIREMENTS],
    selection,
    selectionEpoch: selection.epoch
  };
}

function setWorkspaceTrust(value: boolean): void {
  Object.defineProperty(vscode.workspace, "isTrusted", { configurable: true, value, writable: true });
}

function testEnvironmentSelection(
  key: string,
  environment: TestPythonEnvironment,
  options: {
    epoch?: number;
    resource?: vscode.Uri;
    workspaceFolder?: vscode.WorkspaceFolder;
  } = {}
): TestEnvironmentSelection {
  return {
    key,
    epoch: options.epoch ?? 0,
    resource: options.resource,
    workspaceFolder: options.workspaceFolder,
    promise: Promise.resolve(environment),
    resolutionController: new AbortController(),
    dependencyKeys: new Set(),
    resolvedEnvironment: environment
  };
}

function testRuntimeSlot(
  key: string,
  process?: ChildProcessWithoutNullStreams,
  processSelection?: TestProcessSelection
): TestRuntimeSlot {
  return {
    key,
    pendingIds: new Set(),
    provisionalSessionIds: new Set(),
    sessionIds: new Set(),
    stoppingProcesses: new Map(),
    leaseCount: 0,
    process,
    processStart: undefined,
    processSelection,
    processStartSelection: undefined,
    processStop: undefined,
    runtimeExitError: undefined,
    stderrBuffer: "",
    runtimeEpoch: 0
  };
}

function remoteFileSource(): SessionSource {
  return {
    kind: "file",
    label: "data.csv",
    path: "/workspace/data.csv",
    uri: "vscode-remote://ssh-remote+example/workspace/data.csv"
  };
}

function remoteSourceAt(path: string): SessionSource {
  return {
    kind: "file",
    label: path.slice(path.lastIndexOf("/") + 1),
    path,
    uri: `vscode-remote://ssh-remote+example${path}`
  };
}

function workspaceFolder(uri: string, name: string, index: number): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.parse(uri, true),
    name,
    index
  };
}

function openSessionRequest(source: SessionSource): Extract<OpenWranglerRequest, { kind: "openSession" }> {
  return {
    kind: "openSession",
    source,
    backend: "polars",
    mode: "editing",
    pageSize: 100,
    columnOffset: 0,
    columnLimit: 16
  };
}

function automaticOpenSessionRequest(source: SessionSource): Extract<OpenWranglerRequest, { kind: "openSession" }> {
  return {
    kind: "openSession",
    source,
    mode: "editing",
    pageSize: 100,
    columnOffset: 0,
    columnLimit: 16
  };
}

function openedFor(
  request: Extract<OpenWranglerRequest, { kind: "openSession" }>,
  sessionId: string
): SessionOpenedResponse {
  const metadata: SessionMetadata = {
    protocolVersion: 2,
    sessionId,
    revision: 0,
    backend: request.backend ?? "polars",
    mode: request.mode ?? "editing",
    source: request.source,
    capabilities: {
      editable: true,
      lazy: true,
      cancel: true,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: false
    },
    shape: { rows: 0, columns: 1 },
    filteredShape: { rows: 0, columns: 1 },
    filterModel: { filters: [], sort: [] },
    steps: [],
    schema: [
      {
        id: "c:0",
        name: "value",
        position: 0,
        rawType: "String",
        type: "string",
        nullable: true
      }
    ]
  };
  return {
    kind: "sessionOpened",
    metadata,
    page: {
      offset: 0,
      limit: request.pageSize,
      totalRows: 0,
      columnIds: ["c:0"],
      rows: []
    },
    summaries: []
  };
}

function createMultiScopeHarness(): {
  bridge: PythonBridge;
  runtimes: { first: TestRuntimeSlot; second: TestRuntimeSlot };
  processes: {
    first: ChildProcessWithoutNullStreams;
    second: ChildProcessWithoutNullStreams;
  };
  sessionOwnership: PythonSessionOwnership<TestRuntimeSlot>;
  restartRuntime: ReturnType<typeof vi.fn>;
  stopRuntime: ReturnType<typeof vi.fn>;
  writes(scope: "first" | "second"): RuntimeRequestEnvelope[];
  waitForWrites(scope: "first" | "second", count: number): Promise<void>;
  respond(scope: "first" | "second", requestId: string, response: OpenWranglerResponse): void;
} {
  const environment: TestPythonEnvironment = {
    executable: testPythonExecutablePath("/shared/bin/python"),
    executableIdentity: testExecutableIdentity("/shared/bin/python"),
    packageRoot: "/shared",
    packageRootIdentity: testPackageRootIdentity("/shared"),
    version: "3.12.4",
    source: "pythonExtension"
  };
  const firstSelection = testEnvironmentSelection("first", environment);
  const secondSelection = testEnvironmentSelection("second", environment);
  const writesByScope = {
    first: [] as string[],
    second: [] as string[]
  };
  const processFor = (scope: "first" | "second"): ChildProcessWithoutNullStreams =>
    ({
      killed: false,
      stdin: {
        destroyed: false,
        writable: true,
        write: vi.fn((value: string, callback?: (error?: Error | null) => void) => {
          writesByScope[scope].push(value);
          callback?.();
          return true;
        })
      },
      kill: vi.fn()
    }) as unknown as ChildProcessWithoutNullStreams;
  const processes = {
    first: processFor("first"),
    second: processFor("second")
  };
  const runtimes = {
    first: testRuntimeSlot("first", processes.first, {
      selection: firstSelection,
      environment
    }),
    second: testRuntimeSlot("second", processes.second, {
      selection: secondSelection,
      environment
    })
  };
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const raw = bridge as unknown as RawBridgeInternals;
  const sessionOwnership = createSessionOwnership(raw);
  const restartRuntime = vi.fn((runtime: TestRuntimeSlot, _reason: string) => {
    sessionOwnership.releaseRuntime(runtime);
    runtime.process = undefined;
  });
  const stopRuntime = vi.fn((runtime: TestRuntimeSlot, _reason: string) => {
    sessionOwnership.releaseRuntime(runtime);
    runtime.process = undefined;
  });
  const runtimeSlots = new Map([
    [runtimes.first.key, runtimes.first],
    [runtimes.second.key, runtimes.second]
  ]);
  const selectionEpochs = new Map([
    [firstSelection.key, 0],
    [secondSelection.key, 0]
  ]);
  const environmentSelections = new Map([
    [firstSelection.key, firstSelection],
    [secondSelection.key, secondSelection]
  ]);
  const runtimeScopes = createRuntimeScopeRegistry(raw, {
    runtimeSlots,
    selectionEpochs,
    environmentSelections,
    scopeRecency: new Map([
      [firstSelection.key, 1],
      [secondSelection.key, 2]
    ]),
    initialUseClock: 2
  });
  Object.assign(bridge as object, {
    runtimeScopes,
    sessionOwnership,
    selectionEpoch: 0,
    selectionEpochs,
    disposed: false,
    environmentSelections,
    dependencyProbes: createDependencyProbeRegistry(raw),
    dependencyGuardStatusFlights: new Map<string, unknown>(),
    dependencyEnvironmentUncertainty: new Map<string, unknown>(),
    launchDependencyGuardStatus: startDependencyGuardStatus,
    launchDependencyGuardValidation: startDependencyGuardValidation,
    dependencyMutations: new Map(),
    lastMissingDependencies: undefined,
    output: { appendLine: vi.fn() },
    prepareRequestForDispatch: vi.fn(async (request: OpenWranglerRequest) => {
      const scope = request.kind === "openSession" && request.source.path?.startsWith("/second/") ? "second" : "first";
      const selection = scope === "first" ? firstSelection : secondSelection;
      return {
        request,
        processSelection: { selection, environment }
      };
    }),
    ensureProcess: vi.fn(async (runtime: TestRuntimeSlot) => runtime.process!),
    restartRuntime,
    stopRuntime,
    stopRuntimeIfIdle: vi.fn((runtime: TestRuntimeSlot) => {
      if (runtime.sessionIds.size === 0 && runtime.pendingIds.size === 0 && runtime.process) {
        stopRuntime(runtime, "Open Wrangler runtime stopped after its last session closed.");
      }
    })
  });
  attachRuntimeTransport(bridge);
  const writes = (scope: "first" | "second"): RuntimeRequestEnvelope[] =>
    writesByScope[scope].map((line) => JSON.parse(line) as RuntimeRequestEnvelope);
  return {
    bridge,
    runtimes,
    processes,
    sessionOwnership,
    restartRuntime,
    stopRuntime,
    writes,
    waitForWrites: async (scope, count) => {
      await vi.waitFor(() => expect(writesByScope[scope]).toHaveLength(count));
    },
    respond: (scope, requestId, response) => {
      const envelope: RuntimeResponseEnvelope = { protocolVersion: 2, requestId, response };
      raw.runtimeTransport.handleLine(runtimes[scope], processes[scope], JSON.stringify(envelope));
    }
  };
}

function createHarness(
  prepareRequest: (request: OpenWranglerRequest) => Promise<OpenWranglerRequest | ErrorResponse> = async (request) =>
    request
): {
  bridge: PythonBridge;
  ensureProcess: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  writes(): RuntimeRequestEnvelope[];
  waitForWrites(count: number): Promise<void>;
  respond(requestId: string, response: OpenWranglerResponse): void;
  advanceSelectionEpoch(): void;
} {
  const rawWrites: string[] = [];
  const stdin = {
    destroyed: false,
    writable: true,
    write: vi.fn((value: string, callback?: (error?: Error | null) => void) => {
      rawWrites.push(value);
      callback?.();
      return true;
    })
  };
  const process = {
    killed: false,
    stdin,
    kill: vi.fn()
  } as unknown as ChildProcessWithoutNullStreams;
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const environment: TestPythonEnvironment = {
    executable: testPythonExecutablePath("/env/bin/python"),
    executableIdentity: TEST_EXECUTABLE_IDENTITY,
    packageRoot: "/env",
    packageRootIdentity: TEST_PACKAGE_ROOT_IDENTITY,
    version: "3.12.4",
    source: "configuration"
  };
  const selection = testEnvironmentSelection("<workspace-default>", environment);
  const processSelection = { selection, environment };
  const runtime = testRuntimeSlot(selection.key, process, processSelection);
  const ensureProcess = vi.fn(async () => process);
  const restart = vi.fn();
  const internals = bridge as unknown as RawBridgeInternals;
  const runtimeSlots = new Map([[runtime.key, runtime]]);
  const selectionEpochs = new Map([[selection.key, 0]]);
  const environmentSelections = new Map([[selection.key, selection]]);
  const runtimeScopes = createRuntimeScopeRegistry(internals, {
    runtimeSlots,
    selectionEpochs,
    environmentSelections,
    scopeRecency: new Map([[selection.key, 1]]),
    initialUseClock: 1
  });
  Object.assign(bridge as object, {
    runtimeScopes,
    sessionOwnership: createSessionOwnership(internals),
    selectionEpoch: 0,
    selectionEpochs,
    disposed: false,
    environmentSelections,
    dependencyProbes: createDependencyProbeRegistry(internals),
    dependencyGuardStatusFlights: new Map<string, unknown>(),
    dependencyEnvironmentUncertainty: new Map<string, unknown>(),
    launchDependencyGuardStatus: startDependencyGuardStatus,
    launchDependencyGuardValidation: startDependencyGuardValidation,
    dependencyMutations: new Map(),
    lastMissingDependencies: undefined,
    output: { appendLine: vi.fn() },
    prepareRequestForDispatch: vi.fn(async (request: OpenWranglerRequest) => {
      const prepared = await prepareRequest(request);
      return prepared.kind === "error" ? { request: prepared } : { request: prepared, processSelection };
    }),
    ensureProcess,
    restartRuntime: restart,
    stopRuntimeIfIdle: vi.fn()
  });
  attachRuntimeTransport(bridge);

  const writes = (): RuntimeRequestEnvelope[] => rawWrites.map((line) => JSON.parse(line) as RuntimeRequestEnvelope);
  return {
    bridge,
    ensureProcess,
    restart,
    writes,
    waitForWrites: async (count) => {
      await vi.waitFor(() => expect(rawWrites).toHaveLength(count));
    },
    respond: (requestId, response) => {
      const envelope: RuntimeResponseEnvelope = { protocolVersion: 2, requestId, response };
      internals.runtimeTransport.handleLine(runtime, process, JSON.stringify(envelope));
    },
    advanceSelectionEpoch: () => {
      internals.selectionEpoch += 1;
      internals.selectionEpochs.set(selection.key, selection.epoch + 1);
      internals.environmentSelections.delete(selection.key);
    }
  };
}

function addInactiveScopePressure(raw: RawBridgeInternals, count: number, prefix: string): void {
  for (let index = 0; index < count; index += 1) {
    raw.runtimeSlot(`${prefix}-${index}`);
  }
  raw.trimInactiveScopes();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
