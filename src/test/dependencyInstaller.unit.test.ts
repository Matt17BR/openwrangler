import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DependencyInstallExitUnconfirmedError,
  startDependencyInstall,
  waitForDependencyInstallExit
} from "../extension/dependencyInstaller";

class DependencyChildProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly unref = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("owned dependency installation", () => {
  it("spawns exact pip argv without a shell, output pipes, or inherited Python path overrides", async () => {
    const child = new DependencyChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const requirements = ["pandas>=2", "xlrd>=2.0.1"];

    const operation = startDependencyInstall("/env/bin/python", requirements, {
      cwd: "/extension",
      environment: {
        PATH: "/usr/bin",
        PYTHONPATH: "/private/runtime",
        PythonHome: "/private/home",
        PIP_INDEX_URL: "https://example.invalid/simple"
      },
      spawnProcess
    });
    requirements.push("unexpected");

    expect(spawnProcess).toHaveBeenCalledWith(
      "/env/bin/python",
      ["-m", "pip", "install", "--no-input", "pandas>=2", "xlrd>=2.0.1"],
      {
        cwd: "/extension",
        env: {
          PATH: "/usr/bin",
          PIP_INDEX_URL: "https://example.invalid/simple",
          PIP_NO_INPUT: "1"
        },
        shell: false,
        stdio: "ignore",
        windowsHide: true
      }
    );
    expect(operation.requirements).toEqual(["pandas>=2", "xlrd>=2.0.1"]);
    expect(operation.didSpawn()).toBe(false);

    child.emit("spawn");
    child.emit("close", 0, null);

    expect(operation.didSpawn()).toBe(true);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("treats a pre-spawn error as proof that no package-writing process exists", async () => {
    const child = new DependencyChildProcess();
    const operation = startDependencyInstall("/missing/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: () => child as unknown as ChildProcess
    });

    child.emit("error", new Error("ENOENT"));

    expect(operation.didSpawn()).toBe(false);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toThrow(
      "could not start dependency installation with /missing/python: ENOENT"
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("fails closed when close arrives without either spawn or pre-spawn error proof", async () => {
    const child = new DependencyChildProcess();
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: () => child as unknown as ChildProcess
    });

    child.emit("close", 0, null);

    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toThrow("closed before spawn ownership was confirmed");
    expect(operation.didSpawn()).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not let a post-spawn error impersonate exact process close", async () => {
    const child = new DependencyChildProcess();
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: () => child as unknown as ChildProcess
    });
    let exited = false;
    void operation.exit.then(() => {
      exited = true;
    });

    child.emit("spawn");
    child.emit("error", new Error("late child error"));
    await Promise.resolve();

    expect(exited).toBe(false);
    child.emit("close", 1, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toThrow(
      "dependency installation with /env/bin/python failed: late child error"
    );
  });

  it("ignores exit until Node confirms that every child-process stdio handle closed", async () => {
    const child = new DependencyChildProcess();
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: () => child as unknown as ChildProcess
    });
    let exited = false;
    void operation.exit.then(() => {
      exited = true;
    });

    child.emit("spawn");
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(exited).toBe(false);

    child.emit("close", 0, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).resolves.toBeUndefined();
  });

  it.each([
    { code: 7, signal: null, detail: "exit code 7" },
    { code: null, signal: "SIGTERM", detail: "signal SIGTERM" },
    { code: null, signal: null, detail: "exit code unknown" }
  ])("reports unsuccessful close as $detail", async ({ code, signal, detail }) => {
    const child = new DependencyChildProcess();
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: () => child as unknown as ChildProcess
    });
    child.emit("spawn");
    child.emit("close", code, signal);

    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toThrow(
      `dependency installation with /env/bin/python ended with ${detail}`
    );
  });

  it("propagates a synchronous spawn failure without claiming process ownership", () => {
    expect(() =>
      startDependencyInstall("/env/bin/python", ["pandas"], {
        cwd: "/extension",
        spawnProcess: () => {
          throw new Error("invalid spawn options");
        }
      })
    ).toThrow("invalid spawn options");
  });

  it("times out by unreferencing the exact child and never signalling it", async () => {
    vi.useFakeTimers();
    const child = new DependencyChildProcess();
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: () => child as unknown as ChildProcess
    });
    child.emit("spawn");

    const waiting = waitForDependencyInstallExit(operation, 5_000);
    const rejected = expect(waiting).rejects.toBeInstanceOf(DependencyInstallExitUnconfirmedError);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;

    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close", 0, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).resolves.toBeUndefined();
  });

  it("cancels its timeout when exact close arrives first", async () => {
    vi.useFakeTimers();
    const child = new DependencyChildProcess();
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: () => child as unknown as ChildProcess
    });
    child.emit("spawn");

    const waiting = waitForDependencyInstallExit(operation, 5_000);
    child.emit("close", 0, null);
    await expect(waiting).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(child.unref).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("retains both timeout and unref failures without attempting termination", async () => {
    vi.useFakeTimers();
    const child = new DependencyChildProcess();
    child.unref.mockImplementation(() => {
      throw new Error("unref failed");
    });
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: () => child as unknown as ChildProcess
    });
    child.emit("spawn");

    const waiting = waitForDependencyInstallExit(operation, 1);
    const rejected = expect(waiting).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some((item) => item instanceof DependencyInstallExitUnconfirmedError) &&
        error.errors.some((item) => item instanceof Error && item.message === "unref failed")
    );
    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    expect(child.kill).not.toHaveBeenCalled();
  });
});
