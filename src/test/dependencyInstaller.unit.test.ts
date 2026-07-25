import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
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
    const spawnProcess = vi.fn(
      (_executable: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcess
    );
    const requirements = ["pandas>=2", "xlrd>=2.0.1"];

    const operation = startDependencyInstall("/env/bin/python", requirements, {
      cwd: "/extension",
      environment: {
        PATH: "/usr/bin",
        PYTHONPATH: "/private/runtime",
        PythonHome: "/private/home",
        pythonUserBase: "/private/user-base",
        PIP_TARGET: "/private/target",
        Pip_Prefix: "/private/prefix",
        pip_user: "1",
        PIP_ROOT: "/private/root",
        Pip_Python: "/other/python",
        pip_config_file: "/private/pip.conf",
        PIP_REQUIREMENT: "/private/extra-requirements.txt",
        PIP_EDITABLE: "/private/editable",
        PIP_SRC: "/private/src",
        PIP_BUILD_TRACKER: "/private/tracker",
        PIP_LOG: "/private/pip.log",
        PIP_REPORT: "/private/report.json",
        pip_no_input: "0",
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
          PIP_CONFIG_FILE: process.platform === "win32" ? "nul" : devNull,
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

  it("uses a private short-lived cwd for a PATH-resolved interpreter instead of importing from home", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "openwrangler-home-"));
    writeFileSync(join(userHome, "pip.py"), "raise RuntimeError('must not import')\n", "utf8");
    const child = new DependencyChildProcess();
    const spawnProcess = vi.fn(
      (_executable: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcess
    );

    try {
      const operation = startDependencyInstall("python", ["pandas"], {
        cwd: userHome,
        environment: { PATH: "/usr/bin" },
        spawnProcess
      });
      const spawnOptions = spawnProcess.mock.calls[0]?.[2];
      const privateCwd = spawnOptions?.cwd;

      expect(typeof privateCwd).toBe("string");
      expect(privateCwd).not.toBe(userHome);
      expect(existsSync(privateCwd as string)).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(privateCwd as string).mode & 0o077).toBe(0);
      }

      child.emit("spawn");
      child.emit("close", 0, null);
      await expect(operation.completion).resolves.toBeUndefined();
      expect(existsSync(privateCwd as string)).toBe(false);
    } finally {
      rmSync(userHome, { force: true, recursive: true });
    }
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
