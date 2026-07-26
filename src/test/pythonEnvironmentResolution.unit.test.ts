import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SYSTEM_PYTHON_CANDIDATES,
  PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS,
  PythonEnvironmentApiBroker,
  PythonEnvironmentApiBrokerDisposedError,
  PythonEnvironmentResolutionCancelledError,
  PythonEnvironmentResolutionSupersededError,
  PythonEnvironmentResolutionTimeoutError,
  PythonEnvironmentResolutionWorkspaceTrustError,
  resolvePythonEnvironment,
  type PythonEnvironmentProcessExecutor,
  type PythonEnvironmentResolutionClock
} from "../extension/pythonEnvironment";

describe("bounded Python environment resolution", () => {
  beforeEach(() => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(_key: string, fallback: T): T => fallback
    } as vscode.WorkspaceConfiguration);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies one aggregate deadline to Python-extension activation and ignores its late completion", async () => {
    const clock = new VirtualClock();
    const activation = deferred<unknown>();
    const executeProcess = vi.fn<PythonEnvironmentProcessExecutor>();
    const activate = vi.fn(() => activation.promise);
    mockExtensionLookup({ activate } as unknown as vscode.Extension<unknown>);
    const broker = new PythonEnvironmentApiBroker();

    const resolution = resolvePythonEnvironment(context(), undefined, broker, {
      clock,
      executeProcess
    });
    await flushMicrotasks();
    expect(activate).toHaveBeenCalledOnce();

    await clock.advance(PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS);
    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentResolutionTimeoutError);

    activation.resolve(pythonApi("/late/python"));
    await flushMicrotasks();
    expect(executeProcess).not.toHaveBeenCalled();
    broker.dispose();
  });

  it("bounds selected-environment resolution under the same activation budget", async () => {
    const clock = new VirtualClock();
    const selected = deferred<{ executable: { uri: vscode.Uri } }>();
    mockExtensionLookup({
      activate: vi.fn(async () => pythonApi("/selected/python", () => selected.promise))
    } as unknown as vscode.Extension<unknown>);
    const broker = new PythonEnvironmentApiBroker();

    const resolution = resolvePythonEnvironment(context(), undefined, broker, { clock });
    await flushMicrotasks();
    await clock.advance(PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS);

    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentResolutionTimeoutError);
    selected.resolve({ executable: { uri: vscode.Uri.file("/selected/python") } });
    broker.dispose();
  });

  it("stops after a Windows launcher consumes the aggregate deadline", async () => {
    mockExtensionLookup();
    const clock = new VirtualClock();
    const launcher = deferred<{ stdout: string; stderr: string }>();
    const executeProcess = vi.fn<PythonEnvironmentProcessExecutor>(() => launcher.promise);

    const resolution = resolvePythonEnvironment(context(), undefined, undefined, {
      clock,
      environment: { Path: "C:\\Tools" },
      executeProcess,
      isExecutable: (candidate) => candidate.toLocaleLowerCase("en-US") === "c:\\tools\\py.exe",
      platform: "win32"
    });
    await flushMicrotasks();
    expect(executeProcess).toHaveBeenCalledOnce();

    await clock.advance(PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS);
    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentResolutionTimeoutError);
    launcher.resolve({
      stdout: " -3.14-64 C:\\Python314\\python.exe",
      stderr: ""
    });
    await flushMicrotasks();
    expect(executeProcess).toHaveBeenCalledOnce();
  });

  it("ranks, deduplicates, and caps Windows candidates before executable checks or probes", async () => {
    mockExtensionLookup();
    const clock = new VirtualClock();
    const listing = [
      " -3.12t C:\\Python12t\\python.exe",
      " -3.14t C:\\Python14t\\python.exe",
      " -3.14 C:\\Python14B\\python.exe",
      " -3.14 C:\\Python14A\\python.exe",
      " -3.14 C:\\PYTHON14A\\PYTHON.EXE",
      ...Array.from({ length: 20 }, (_, index) => ` -3.13 C:\\Python13-${String(index).padStart(2, "0")}\\python.exe`)
    ].join("\r\n");
    const checked: string[] = [];
    const probed: string[] = [];
    const executeProcess: PythonEnvironmentProcessExecutor = async (executable, arguments_) => {
      if (arguments_[0] === "-0p") return { stdout: listing, stderr: "" };
      probed.push(executable);
      throw new Error("candidate failed");
    };

    await expect(
      resolvePythonEnvironment(context(), undefined, undefined, {
        clock,
        environment: { Path: "C:\\Tools" },
        executeProcess,
        isExecutable: (candidate) => {
          checked.push(candidate);
          return true;
        },
        platform: "win32"
      })
    ).rejects.toThrow("No compatible Python");

    expect(probed).toHaveLength(MAX_SYSTEM_PYTHON_CANDIDATES);
    expect(probed.slice(0, 3)).toEqual([
      "C:\\Python14A\\python.exe",
      "C:\\Python14B\\python.exe",
      "C:\\Python14t\\python.exe"
    ]);
    expect(probed).not.toContain("C:\\PYTHON14A\\PYTHON.EXE");
    expect(new Set(checked.filter((candidate) => !candidate.toLocaleLowerCase("en-US").endsWith("\\py.exe")))).toEqual(
      new Set(probed)
    );
    expect(new Set(probed)).toHaveLength(MAX_SYSTEM_PYTHON_CANDIDATES);
  });

  it("reduces every command ceiling to the remaining shared budget", async () => {
    mockExtensionLookup();
    const clock = new VirtualClock();
    const listing = Array.from({ length: 4 }, (_, index) => ` -3.14 C:\\Python${index}\\python.exe`).join("\r\n");
    const observedTimeouts: number[] = [];
    let command = 0;
    const executeProcess: PythonEnvironmentProcessExecutor = (_executable, arguments_, options) => {
      observedTimeouts.push(options.timeout);
      command += 1;
      if (arguments_[0] === "-0p") {
        return settleAfter(clock, 9_000, { stdout: listing, stderr: "" });
      }
      return rejectAfter(clock, command === 2 ? 10_000 : command === 3 ? 10_000 : 1_000);
    };
    const resolution = resolvePythonEnvironment(context(), undefined, undefined, {
      clock,
      environment: { Path: "C:\\Tools" },
      executeProcess,
      isExecutable: () => true,
      platform: "win32"
    });

    await clock.advance(9_000);
    await clock.advance(10_000);
    await clock.advance(10_000);
    await clock.advance(1_000);

    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentResolutionTimeoutError);
    expect(observedTimeouts.slice(0, 3)).toEqual([10_000, 10_000, 10_000]);
    expect(observedTimeouts[3]).toBeGreaterThan(0);
    expect(observedTimeouts[3]).toBeLessThanOrEqual(1_000);
  });

  it("allows exactly one wrapper re-probe inside the aggregate budget", async () => {
    setConfiguredPython("/wrapper/python");
    const executeProcess = vi
      .fn<PythonEnvironmentProcessExecutor>()
      .mockResolvedValueOnce({ stdout: probePayload("/env/bin/python"), stderr: "" })
      .mockResolvedValueOnce({ stdout: probePayload("/env/bin/python"), stderr: "" });

    const environment = await resolvePythonEnvironment(context(), undefined, undefined, {
      executeProcess,
      isExecutable: () => true,
      pathExists: () => true,
      platform: "linux"
    });

    expect(environment.executable).toBe("/env/bin/python");
    expect(executeProcess).toHaveBeenCalledTimes(2);
    expect(executeProcess.mock.calls[0]?.[0]).toBe("/wrapper/python");
    expect(executeProcess.mock.calls[1]?.[0]).toBe("/env/bin/python");
  });

  it("cancels a pending attempt without launching fallback candidates", async () => {
    const activation = deferred<unknown>();
    mockExtensionLookup({
      activate: vi.fn(() => activation.promise)
    } as unknown as vscode.Extension<unknown>);
    const controller = new AbortController();
    const executeProcess = vi.fn<PythonEnvironmentProcessExecutor>();
    const resolution = resolvePythonEnvironment(context(), undefined, undefined, {
      executeProcess,
      signal: controller.signal
    });

    controller.abort(new PythonEnvironmentResolutionCancelledError());
    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentResolutionCancelledError);
    activation.resolve(pythonApi("/late/python"));
    await flushMicrotasks();
    expect(executeProcess).not.toHaveBeenCalled();
  });

  it("settles immediately when the shared API broker is disposed", async () => {
    const activation = deferred<unknown>();
    mockExtensionLookup({
      activate: vi.fn(() => activation.promise)
    } as unknown as vscode.Extension<unknown>);
    const broker = new PythonEnvironmentApiBroker();
    const resolution = resolvePythonEnvironment(context(), undefined, broker);

    broker.dispose();
    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentApiBrokerDisposedError);
  });

  it.each([
    {
      name: "Workspace Trust loss",
      error: PythonEnvironmentResolutionWorkspaceTrustError,
      mutate: (state: { trusted: boolean; current: boolean }) => {
        state.trusted = false;
      }
    },
    {
      name: "selection supersession",
      error: PythonEnvironmentResolutionSupersededError,
      mutate: (state: { trusted: boolean; current: boolean }) => {
        state.current = false;
      }
    }
  ])("treats $name as terminal while activation is pending", async ({ error, mutate }) => {
    const clock = new VirtualClock();
    const activation = deferred<unknown>();
    const state = { trusted: true, current: true };
    mockExtensionLookup({
      activate: vi.fn(() => activation.promise)
    } as unknown as vscode.Extension<unknown>);
    const resolution = resolvePythonEnvironment(context(), undefined, undefined, {
      clock,
      isCurrent: () => state.current,
      isTrusted: () => state.trusted
    });

    mutate(state);
    await clock.advance(25);
    await expect(resolution).rejects.toBeInstanceOf(error);
  });

  it("lets the deadline win when a process result arrives at the exact boundary", async () => {
    setConfiguredPython("/env/bin/python");
    const clock = new VirtualClock();
    const executeProcess: PythonEnvironmentProcessExecutor = () =>
      settleAfter(clock, PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS, {
        stdout: probePayload("/env/bin/python"),
        stderr: ""
      });
    const resolution = resolvePythonEnvironment(context(), undefined, undefined, {
      clock,
      executeProcess,
      isExecutable: () => true,
      pathExists: () => true,
      platform: "linux"
    });

    await clock.advance(PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS);
    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentResolutionTimeoutError);
  });
});

class VirtualClock implements PythonEnvironmentResolutionClock {
  private current = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { callback: () => void; due: number; sequence: number }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = ++this.sequence;
    this.timers.set(id, {
      callback,
      due: this.current + Math.max(0, delayMs),
      sequence: id
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }

  async advance(milliseconds: number): Promise<void> {
    const target = this.current + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[1].sequence - right[1].sequence)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = timer.due;
      timer.callback();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

function context(): vscode.ExtensionContext {
  return { extensionPath: "/extension" } as vscode.ExtensionContext;
}

function mockExtensionLookup(extension?: vscode.Extension<unknown>): void {
  vi.spyOn(vscode.extensions, "getExtension").mockReturnValue(extension);
}

function pythonApi(
  selectedPath: string,
  resolveEnvironment: () => Promise<{ executable: { uri: vscode.Uri } } | undefined> = async () => ({
    executable: { uri: vscode.Uri.file(selectedPath) }
  })
): unknown {
  return {
    environments: {
      getActiveEnvironmentPath: vi.fn(() => ({ id: "selected", path: selectedPath })),
      resolveEnvironment: vi.fn(resolveEnvironment),
      onDidChangeActiveEnvironmentPath: vi.fn(() => ({ dispose: vi.fn() }))
    }
  };
}

function setConfiguredPython(executable: string): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: <T>(key: string, fallback: T): T => (key === "pythonPath" ? (executable as T) : fallback)
  } as vscode.WorkspaceConfiguration);
}

function probePayload(executable: string): string {
  return JSON.stringify({
    executable,
    executableIdentity: {
      device: "1",
      inode: "2",
      size: "16384",
      mtimeNs: "1700000000000000000",
      ctimeNs: "1700000000000000001"
    },
    version: [3, 12, 4],
    packageRoot: executable.startsWith("C:\\") ? "C:\\Environment" : "/env",
    packageRootIdentity: {
      device: "1",
      inode: "2"
    }
  });
}

function settleAfter<T>(clock: VirtualClock, delayMs: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    clock.setTimeout(() => resolve(value), delayMs);
  });
}

function rejectAfter(clock: VirtualClock, delayMs: number): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    clock.setTimeout(() => reject(new Error("candidate failed")), delayMs);
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
