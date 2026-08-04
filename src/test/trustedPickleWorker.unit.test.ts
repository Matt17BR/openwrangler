import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shutdown = vi.hoisted(() => ({ stop: vi.fn<(process: ChildProcessWithoutNullStreams) => Promise<void>>() }));

vi.mock("../extension/processShutdown", () => ({ stopChildProcessGracefully: shutdown.stop }));

import {
  runTrustedPickleWorker,
  TrustedPickleConversionCancelledError,
  TrustedPickleConversionTimeoutError,
  TrustedPickleProcessTreeUnconfirmedError,
  TrustedPickleWorkerLifecycle,
  trustedPickleWorkerEnvironment
} from "../extension/files/trustedPickleWorker";

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid = 4321) {
    super();
    this.pid = pid;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

const sourceFingerprint = Object.freeze({ dev: 11n, ino: 22n, size: 33n, mtimeNs: 44n, ctimeNs: 55n });

function options(child: FakeChildProcess, overrides: Record<string, unknown> = {}) {
  return {
    executable: "/venv/bin/python",
    helperPath: "/extension/python/openwrangler_runtime/trusted_pickle_to_parquet.py",
    sourcePath: "/workspace/orders.pkl",
    destinationPath: "/workspace/.openwrangler-temp.parquet",
    sourceFingerprint,
    platform: "win32" as const,
    spawnProcess: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
    createWorkingDirectory: () => ({ path: "/private/cwd", cleanup: () => undefined }),
    ...overrides
  };
}

describe("trusted pickle worker", () => {
  beforeEach(() => {
    shutdown.stop.mockReset();
    shutdown.stop.mockImplementation(async (process) => {
      (process as unknown as FakeChildProcess).finish(null, "SIGKILL");
    });
  });

  it("uses the selected interpreter, fingerprinted helper contract, and private cwd", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const cleanup = vi.fn(() => undefined);
    const conversion = runTrustedPickleWorker(
      options(child, {
        spawnProcess: spawnProcess as unknown as typeof spawn,
        createWorkingDirectory: () => ({ path: "/private/cwd", cleanup })
      })
    );
    queueMicrotask(() => child.finish(0));

    await expect(conversion).resolves.toBeUndefined();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/venv/bin/python",
      [
        "-I",
        "-B",
        "-S",
        "/extension/python/openwrangler_runtime/trusted_pickle_to_parquet.py",
        "/workspace/orders.pkl",
        "/workspace/.openwrangler-temp.parquet",
        "11",
        "22",
        "33",
        "44",
        "55"
      ],
      expect.objectContaining({
        cwd: "/private/cwd",
        detached: false,
        shell: false,
        windowsHide: true
      })
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(shutdown.stop).not.toHaveBeenCalled();
  });

  it("stops and cleans the worker when cancellation arrives", async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const cleanup = vi.fn(() => undefined);
    const conversion = runTrustedPickleWorker(
      options(child, {
        signal: controller.signal,
        createWorkingDirectory: () => ({ path: "/private/cwd", cleanup })
      })
    );

    controller.abort();

    await expect(conversion).rejects.toBeInstanceOf(TrustedPickleConversionCancelledError);
    expect(shutdown.stop).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("bounds and discards worker output without reflecting it in the error", async () => {
    const child = new FakeChildProcess();
    const secret = "sensitive-row-value";
    const conversion = runTrustedPickleWorker(options(child, { outputLimitBytes: 4 }));

    child.stderr.write(secret);
    const error = await conversion.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("fixed diagnostic output limit");
    expect((error as Error).message).not.toContain(secret);
    expect(shutdown.stop).toHaveBeenCalledOnce();
  });

  it("stops and cleans the worker at its deadline", async () => {
    const child = new FakeChildProcess();
    const cleanup = vi.fn(() => undefined);
    const conversion = runTrustedPickleWorker(
      options(child, {
        timeoutMs: 1,
        createWorkingDirectory: () => ({ path: "/private/cwd", cleanup })
      })
    );

    await expect(conversion).rejects.toBeInstanceOf(TrustedPickleConversionTimeoutError);
    expect(shutdown.stop).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    [3, "This pickle does not contain a Pandas DataFrame."],
    [4, "Open Wrangler could not convert this pickle to Parquet."]
  ])("reports a fixed non-data-bearing error for helper exit %i", async (exitCode, message) => {
    const child = new FakeChildProcess();
    const conversion = runTrustedPickleWorker(options(child));
    child.stderr.write("do not expose this row");
    queueMicrotask(() => child.finish(exitCode));

    await expect(conversion).rejects.toThrow(message);
  });

  it("settles a spawn error even when close never arrives", async () => {
    const child = new FakeChildProcess(0);
    const cleanup = vi.fn(() => undefined);
    const conversion = runTrustedPickleWorker(
      options(child, { createWorkingDirectory: () => ({ path: "/private/cwd", cleanup }) })
    );
    queueMicrotask(() => child.emit("error", new Error("private spawn detail")));

    await expect(conversion).rejects.toThrow("could not start the trusted pickle converter");
    expect(shutdown.stop).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("does not remove the private cwd when tree shutdown cannot be confirmed", async () => {
    const child = new FakeChildProcess();
    const cleanup = vi.fn(() => undefined);
    shutdown.stop.mockRejectedValueOnce(new Error("tree still running"));
    const controller = new AbortController();
    const conversion = runTrustedPickleWorker(
      options(child, {
        signal: controller.signal,
        createWorkingDirectory: () => ({ path: "/private/cwd", cleanup })
      })
    );
    controller.abort();

    await expect(conversion).rejects.toBeInstanceOf(TrustedPickleProcessTreeUnconfirmedError);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("terminates surviving POSIX descendants before cleaning after a successful main process", async () => {
    const child = new FakeChildProcess();
    let groupExists = true;
    const killProcess = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      expect(pid).toBe(-child.pid!);
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        groupExists = false;
        return true;
      }
      if (groupExists) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }) as unknown as typeof process.kill;
    const cleanup = vi.fn(() => undefined);
    const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const conversion = runTrustedPickleWorker(
      options(child, {
        platform: "linux",
        killProcess,
        spawnProcess: spawnProcess as unknown as typeof spawn,
        createWorkingDirectory: () => ({ path: "/private/cwd", cleanup })
      })
    );
    queueMicrotask(() => child.finish(0));

    await expect(conversion).resolves.toBeUndefined();
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["44", "55"]),
      expect.objectContaining({ detached: true })
    );
    expect(killProcess).toHaveBeenCalledWith(-child.pid!, "SIGTERM");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("passes only basic platform variables to the unpickling worker", () => {
    const environment = trustedPickleWorkerEnvironment(
      "/private/cwd",
      {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_TOKEN: "secret",
        OVSX_PAT: "secret",
        HTTPS_PROXY: "https://secret@example.test",
        SSH_AUTH_SOCK: "/private/agent.sock",
        PYTHONPATH: "/private/injection"
      },
      "linux"
    );

    expect(environment).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/private/cwd",
      TMPDIR: "/private/cwd",
      TEMP: "/private/cwd",
      TMP: "/private/cwd"
    });
  });

  it("recursively removes its default private cwd after confirmed shutdown", async () => {
    const child = new FakeChildProcess();
    let privateCwd: string | undefined;
    const spawnProcess = vi.fn((_executable, _arguments, spawnOptions) => {
      privateCwd = String(spawnOptions?.cwd);
      writeFileSync(`${privateCwd}/worker-junk`, "discard me", { mode: 0o600 });
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const conversion = runTrustedPickleWorker(
      options(child, {
        spawnProcess: spawnProcess as unknown as typeof spawn,
        createWorkingDirectory: undefined
      })
    );
    queueMicrotask(() => child.finish(0));

    await expect(conversion).resolves.toBeUndefined();
    expect(privateCwd).toMatch(/openwrangler-pickle-/u);
    expect(existsSync(privateCwd!)).toBe(false);
  });

  it("aborts and waits for active workers before lifecycle shutdown completes", async () => {
    const child = new FakeChildProcess();
    const lifecycle = new TrustedPickleWorkerLifecycle();
    const worker = lifecycle.run(options(child));

    const shutdownPromise = lifecycle.shutdown();

    await expect(worker).rejects.toBeInstanceOf(TrustedPickleConversionCancelledError);
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(shutdown.stop).toHaveBeenCalledOnce();
    await expect(lifecycle.run(options(new FakeChildProcess()))).rejects.toBeInstanceOf(
      TrustedPickleConversionCancelledError
    );
  });
});
