import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { startRDependencyProcess, type RDependencyProcessOptions } from "../extension/r/rDependencyProcess";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function terminalHarness() {
  const pid = deferred<number | undefined>();
  const close = new vscode.EventEmitter<vscode.Terminal>();
  const terminal = {
    processId: pid.promise,
    exitStatus: undefined as vscode.TerminalExitStatus | undefined,
    dispose: vi.fn(),
    show: vi.fn()
  };
  const value = terminal as unknown as vscode.Terminal;
  const create = vi.spyOn(vscode.window, "createTerminal").mockReturnValue(value);
  const unsubscribe = vi.fn();
  vi.spyOn(vscode.window, "onDidCloseTerminal").mockImplementation((listener) => {
    const subscription = close.event(listener);
    return {
      dispose() {
        unsubscribe();
        subscription.dispose();
      }
    };
  });
  return {
    pid,
    terminal,
    value,
    create,
    unsubscribe,
    close,
    finish(code: number | undefined, reason = vscode.TerminalExitReason.Process) {
      terminal.exitStatus = { code, reason };
      close.fire(value);
    }
  };
}

const options = (mode: RDependencyProcessOptions["mode"] = "probe"): RDependencyProcessOptions => ({
  rscriptPath: resolve("/selected/Rscript"),
  scriptPath: resolve("/private/${literal}/install.R"),
  cwd: vscode.Uri.file(resolve("/selected")),
  environment: { PATH: "/captured/bin", R_LIBS_USER: "/private/${literal}/R", OPTIONAL: undefined },
  mode,
  startupTimeoutMs: 10,
  probeTimeoutMs: 40
});

describe("native R dependency terminal ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["probe", "install"] as const)(
    "pins the %s process and accepts only its natural completion",
    async (mode) => {
      const harness = terminalHarness();
      const selected = options(mode);
      const operation = startRDependencyProcess(selected);
      const settled = vi.fn();
      void operation.settlement.then(settled);
      const supplied = harness.create.mock.calls[0]![0] as vscode.TerminalOptions;
      expect(supplied).toMatchObject({
        shellPath: selected.rscriptPath,
        cwd: selected.cwd,
        strictEnv: true,
        isTransient: true,
        hideFromUser: mode === "probe",
        env: {
          PATH: "/captured/bin",
          R_LIBS_USER: "/private/${literal}/R",
          OPEN_WRANGLER_R_DEPENDENCY_SCRIPT: selected.scriptPath
        }
      });
      expect(supplied.shellArgs).toEqual([
        "--vanilla",
        "-e",
        'base::sys.source(base::Sys.getenv("OPEN_WRANGLER_R_DEPENDENCY_SCRIPT"), envir = base::globalenv(), keep.source = FALSE)'
      ]);
      expect(harness.terminal.show).toHaveBeenCalledTimes(mode === "install" ? 1 : 0);
      harness.pid.resolve(42);
      harness.close.fire({ exitStatus: { code: 0, reason: vscode.TerminalExitReason.Process } } as vscode.Terminal);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      harness.finish(0);
      await expect(operation.completion).resolves.toBeUndefined();
      await operation.settlement;
      expect(harness.unsubscribe).toHaveBeenCalledOnce();
      expect(harness.terminal.dispose).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(["probe", "install"] as const)("keeps %s cancellation separate from terminal settlement", async (mode) => {
    const harness = terminalHarness();
    const cancellation = new vscode.CancellationTokenSource();
    const operation = startRDependencyProcess({ ...options(mode), cancellation: cancellation.token });
    const settled = vi.fn();
    void operation.settlement.then(settled);
    cancellation.cancel();
    await expect(operation.completion).rejects.toThrow("cancelled");
    expect(harness.terminal.dispose).toHaveBeenCalledTimes(mode === "probe" ? 1 : 0);
    expect(settled).not.toHaveBeenCalled();
    harness.pid.resolve(42);
    harness.finish(0);
    await operation.settlement;
    await expect(operation.completion).rejects.toThrow("cancelled");
    cancellation.dispose();
  });

  it("does not acquire a terminal for a cancelled or untrusted request", async () => {
    const harness = terminalHarness();
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    const operation = startRDependencyProcess({ ...options(), cancellation: cancellation.token });
    await expect(operation.completion).rejects.toThrow("before it started");
    await operation.settlement;
    const trusted = vscode.workspace.isTrusted;
    try {
      Object.assign(vscode.workspace, { isTrusted: false });
      expect(() => startRDependencyProcess(options())).toThrow("Trust this workspace");
    } finally {
      Object.assign(vscode.workspace, { isTrusted: trusted });
      cancellation.dispose();
    }
    expect(harness.create).not.toHaveBeenCalled();
  });

  it.each(["probe", "install"] as const)("retains an unconfirmed %s launch until terminal closure", async (mode) => {
    const harness = terminalHarness();
    const operation = startRDependencyProcess(options(mode));
    const settled = vi.fn();
    void operation.settlement.then(settled);
    await vi.advanceTimersByTimeAsync(10);
    await expect(operation.completion).rejects.toThrow("did not confirm");
    expect(harness.terminal.dispose).toHaveBeenCalledTimes(mode === "probe" ? 1 : 0);
    expect(settled).not.toHaveBeenCalled();
    harness.pid.resolve(42);
    harness.finish(0);
    await operation.settlement;
    await expect(operation.completion).rejects.toThrow("did not confirm");
  });

  it("bounds a started probe, while an installation has no completion deadline", async () => {
    const probe = terminalHarness();
    const operation = startRDependencyProcess(options());
    probe.pid.resolve(42);
    await vi.advanceTimersByTimeAsync(40);
    await expect(operation.completion).rejects.toThrow("exceeded its time limit");
    expect(probe.terminal.dispose).toHaveBeenCalledOnce();
    probe.finish(undefined, vscode.TerminalExitReason.Extension);
    await operation.settlement;

    const install = terminalHarness();
    const installation = startRDependencyProcess(options("install"));
    install.pid.resolve(43);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(install.terminal.dispose).not.toHaveBeenCalled();
    install.finish(0);
    await expect(installation.completion).resolves.toBeUndefined();
  });

  it.each([
    [undefined, vscode.TerminalExitReason.Process],
    [9, vscode.TerminalExitReason.Process],
    [0, vscode.TerminalExitReason.User],
    [0, vscode.TerminalExitReason.Shutdown]
  ])("refuses an unsuccessful exit (%s, %s), including before PID readiness", async (code, reason) => {
    const harness = terminalHarness();
    const operation = startRDependencyProcess(options("install"));
    harness.finish(code, reason);
    await expect(operation.completion).rejects.toThrow(/exited with code|without a confirmed successful/u);
    await operation.settlement;
    harness.pid.resolve(undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.terminal.dispose).not.toHaveBeenCalled();
  });

  it("retains closure observation when the PID request rejects", async () => {
    const harness = terminalHarness();
    const operation = startRDependencyProcess(options());
    harness.pid.reject(new Error("unavailable"));
    await expect(operation.completion).rejects.toThrow("process identity");
    expect(harness.terminal.dispose).toHaveBeenCalledOnce();
    harness.finish(undefined, vscode.TerminalExitReason.Extension);
    await operation.settlement;
  });

  it("settles launch failure without retaining a nonexistent terminal", async () => {
    const harness = terminalHarness();
    harness.create.mockImplementation(() => {
      throw new Error("cannot create terminal");
    });
    const operation = startRDependencyProcess(options());
    await expect(operation.completion).rejects.toThrow("cannot create terminal");
    await operation.settlement;
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the captured remote host and rejects paths VS Code could reinterpret", async () => {
    const harness = terminalHarness();
    for (const changed of [
      { rscriptPath: resolve("/selected/${env:OTHER}/Rscript") },
      { cwd: vscode.Uri.file(resolve("/selected/${workspaceFolder}")) },
      { scriptPath: "relative.R" }
    ])
      expect(() => startRDependencyProcess({ ...options(), ...changed })).toThrow(/variable syntax|absolute/u);
    expect(harness.create).not.toHaveBeenCalled();
    const cwd = vscode.Uri.parse("vscode-remote://ssh-remote+owned/selected");
    const operation = startRDependencyProcess({ ...options(), cwd });
    expect((harness.create.mock.calls[0]![0] as vscode.TerminalOptions).cwd).toBe(cwd);
    harness.finish(0);
    await operation.completion;
  });
});
