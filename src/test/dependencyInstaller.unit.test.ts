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
  it("spawns isolated pip with owned controls and a deny-by-default inherited pip environment", async () => {
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
        PIP_DRY_RUN: "1",
        pip_No_Deps: "1",
        PiP_Constraint: "/private/constraints.txt",
        PIP_INDEX_URL: "https://example.invalid/simple"
      },
      spawnProcess
    });
    requirements.push("unexpected");

    const [spawnedExecutable, spawnedArgs, spawnOptions] = spawnProcess.mock.calls[0] ?? [];
    const privateCwd = spawnOptions?.cwd;
    expect(spawnedExecutable).toBe("/env/bin/python");
    expect(spawnedArgs).toEqual(["-I", "-m", "pip", "install", "--no-input", "--no-user", "pandas>=2", "xlrd>=2.0.1"]);
    expect(spawnOptions).toEqual({
      cwd: privateCwd,
      env: {
        PATH: "/usr/bin",
        PIP_CONFIG_FILE: process.platform === "win32" ? "nul" : devNull,
        PIP_INDEX_URL: "https://example.invalid/simple",
        PIP_NO_INPUT: "1",
        PIP_USER: "0"
      },
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    expect(typeof privateCwd).toBe("string");
    expect(privateCwd).not.toBe("/extension");
    expect(existsSync(privateCwd as string)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(privateCwd as string).mode & 0o077).toBe(0);
    }
    expect(operation.requirements).toEqual(["pandas>=2", "xlrd>=2.0.1"]);
    expect(operation.didSpawn()).toBe(false);

    child.emit("spawn");
    child.emit("close", 0, null);

    expect(operation.didSpawn()).toBe(true);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(privateCwd as string)).toBe(false);
  });

  it.each(["python", "/env/bin/python"])(
    "uses a private short-lived cwd for %s instead of importing from the requested directory",
    async (executable) => {
      const userHome = mkdtempSync(join(tmpdir(), "openwrangler-home-"));
      writeFileSync(join(userHome, "pip.py"), "raise RuntimeError('must not import')\n", "utf8");
      const child = new DependencyChildProcess();
      const spawnProcess = vi.fn(
        (_executable: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcess
      );

      try {
        const operation = startDependencyInstall(executable, ["pandas"], {
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
    }
  );

  it("canonicalizes allowed pip settings and replaces inherited owned controls", async () => {
    const child = new DependencyChildProcess();
    const spawnProcess = vi.fn(
      (_executable: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcess
    );
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      environment: {
        pip_index_url: "https://lower.invalid/simple",
        PIP_INDEX_URL: "https://canonical.invalid/simple",
        Pip_Proxy: "https://proxy.invalid",
        pIp_CaChE_dIr: "/private/cache",
        pip_config_file: "/private/pip.conf",
        Pip_No_Input: "0",
        pIp_UsEr: "1"
      },
      spawnProcess
    });

    expect(spawnProcess.mock.calls[0]?.[2].env).toEqual({
      PIP_CACHE_DIR: "/private/cache",
      PIP_CONFIG_FILE: process.platform === "win32" ? "nul" : devNull,
      PIP_INDEX_URL: "https://canonical.invalid/simple",
      PIP_NO_INPUT: "1",
      PIP_PROXY: "https://proxy.invalid",
      PIP_USER: "0"
    });

    child.emit("spawn");
    child.emit("close", 0, null);
    await expect(operation.completion).resolves.toBeUndefined();
  });

  it("treats a pre-spawn error as proof that no package-writing process exists", async () => {
    const child = new DependencyChildProcess();
    let privateCwd: string | undefined;
    const operation = startDependencyInstall("/missing/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: (_executable, _args, options) => {
        privateCwd = options.cwd as string;
        return child as unknown as ChildProcess;
      }
    });

    child.emit("error", new Error("ENOENT"));

    expect(operation.didSpawn()).toBe(false);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toThrow(
      "could not start dependency installation with /missing/python: ENOENT"
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(privateCwd).toBeDefined();
    expect(existsSync(privateCwd as string)).toBe(false);
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
    let privateCwd: string | undefined;
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: (_executable, _args, options) => {
        privateCwd = options.cwd as string;
        return child as unknown as ChildProcess;
      }
    });
    let exited = false;
    void operation.exit.then(() => {
      exited = true;
    });

    child.emit("spawn");
    child.emit("error", new Error("late child error"));
    await Promise.resolve();

    expect(exited).toBe(false);
    expect(existsSync(privateCwd as string)).toBe(true);
    child.emit("close", 1, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toThrow(
      "dependency installation with /env/bin/python failed: late child error"
    );
    expect(existsSync(privateCwd as string)).toBe(false);
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
    let privateCwd: string | undefined;
    expect(() =>
      startDependencyInstall("/env/bin/python", ["pandas"], {
        cwd: "/extension",
        spawnProcess: (_executable, _args, options) => {
          privateCwd = options.cwd as string;
          throw new Error("invalid spawn options");
        }
      })
    ).toThrow("invalid spawn options");
    expect(privateCwd).toBeDefined();
    expect(existsSync(privateCwd as string)).toBe(false);
  });

  it("times out by unreferencing the exact child and never signalling it", async () => {
    vi.useFakeTimers();
    const child = new DependencyChildProcess();
    let privateCwd: string | undefined;
    const operation = startDependencyInstall("/env/bin/python", ["pandas"], {
      cwd: "/extension",
      spawnProcess: (_executable, _args, options) => {
        privateCwd = options.cwd as string;
        return child as unknown as ChildProcess;
      }
    });
    child.emit("spawn");

    const waiting = waitForDependencyInstallExit(operation, 5_000);
    const rejected = expect(waiting).rejects.toBeInstanceOf(DependencyInstallExitUnconfirmedError);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;

    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(privateCwd as string)).toBe(true);

    child.emit("close", 0, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).resolves.toBeUndefined();
    expect(existsSync(privateCwd as string)).toBe(false);
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
