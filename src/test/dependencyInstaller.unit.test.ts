import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPENDENCY_GUARD_MAX_FRAME_BYTES,
  DEPENDENCY_GUARD_PROTOCOL,
  DependencyGuardCommandTimeoutError,
  DependencyGuardProtocolError,
  DependencyInstallAbortedError,
  DependencyInstallExitUnconfirmedError,
  DependencyInstallReadyTimeoutError,
  getDependencyGuardStatus,
  startDependencyGuardStatus,
  startDependencyGuardValidation,
  startDependencyInstall,
  validateDependencyGuard,
  waitForDependencyInstallExit,
  type DependencyGuardClientOptions,
  type OwnedDependencyInstall
} from "../extension/dependencyInstaller";
import type { PythonEnvironment } from "../extension/pythonEnvironment";
import type { PythonDependency } from "../extension/pythonEnvironmentModel";

const OWNED_PYTHON_PROCESS_ENVIRONMENT = {
  PYTHON_MANAGER_AUTOMATIC_INSTALL: "0",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONNOUSERSITE: "1",
  PYTHONSAFEPATH: "1",
  PYTHONUNBUFFERED: "1",
  PYTHONUTF8: "1"
};
const TEST_PYTHON_EXECUTABLE = testPath("/env/bin/python");
const TEST_PACKAGE_ROOT = testPath("/env");
const TEST_HELPER_PATH = testPath("/extension/python/openwrangler_runtime/dependency_guard.py");
const TEST_TOKEN = "11111111-2222-4333-8444-555555555555";
const TEST_ENVIRONMENT: PythonEnvironment = {
  executable: TEST_PYTHON_EXECUTABLE,
  executableIdentity: {
    device: "2049",
    inode: "998877",
    size: "18200",
    mtimeNs: "1711111111000000000",
    ctimeNs: "1711111112000000000"
  },
  version: "3.12.4",
  packageRoot: TEST_PACKAGE_ROOT,
  packageRootIdentity: { device: "2049", inode: "887766" },
  source: "configuration"
};
const TEST_DEPENDENCIES: readonly PythonDependency[] = [
  {
    importModule: "pandas",
    distribution: "pandas",
    installSpec: "pandas>=2.2,<3",
    minimumVersion: "2.2",
    maximumVersionExclusive: "3"
  },
  {
    importModule: "xlrd",
    distribution: "xlrd",
    installSpec: "xlrd>=2.0.1",
    minimumVersion: "2.0.1"
  }
];

class DependencyChildProcess extends EventEmitter {
  readonly stdin = Object.assign(new PassThrough(), { unref: vi.fn() });
  readonly stdout = Object.assign(new PassThrough(), { unref: vi.fn() });
  readonly kill = vi.fn(() => true);
  readonly unref = vi.fn();
  private readonly inputChunks: Buffer[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.inputChunks.push(Buffer.from(chunk)));
  }

  inputBytes(): Buffer {
    return Buffer.concat(this.inputChunks);
  }

  inputFrames(): Array<Record<string, unknown>> {
    return this.inputBytes()
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("owned dependency installation", () => {
  it("arms the exact environment, waits for READY, and sends GO only after explicit authorization", async () => {
    const child = new DependencyChildProcess();
    const spawnProcess = vi.fn(
      (_executable: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcess
    );
    const dependencies = TEST_DEPENDENCIES.map((dependency) => ({ ...dependency }));
    const operation = startDependencyInstall(TEST_ENVIRONMENT, dependencies, {
      helperPath: TEST_HELPER_PATH,
      environment: hostileProcessEnvironment(),
      spawnProcess
    });
    dependencies[0]!.installSpec = "changed-after-start";

    const [executable, args, options] = spawnProcess.mock.calls[0] ?? [];
    const privateCwd = options?.cwd as string;
    expect(executable).toBe(TEST_PYTHON_EXECUTABLE);
    expect(args).toEqual(["-I", TEST_HELPER_PATH, "install"]);
    expect(options).toEqual({
      cwd: privateCwd,
      env: {
        PATH: "/usr/bin",
        ...OWNED_PYTHON_PROCESS_ENVIRONMENT,
        PIP_CONFIG_FILE: process.platform === "win32" ? "nul" : devNull,
        PIP_INDEX_URL: "https://example.invalid/simple",
        PIP_NO_INPUT: "1",
        PIP_USER: "0"
      },
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true
    });
    expect(existsSync(privateCwd)).toBe(true);
    if (process.platform !== "win32") expect(statSync(privateCwd).mode & 0o077).toBe(0);
    expect(operation.requirements).toEqual(["pandas>=2.2,<3", "xlrd>=2.0.1"]);
    expect(operation.didSpawn()).toBe(false);
    expect(operation.didAuthorize()).toBe(false);

    child.emit("spawn");
    expect(operation.didSpawn()).toBe(true);
    expect(child.inputFrames()).toEqual([
      {
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "install",
        token: operation.token,
        environment: {
          executable: TEST_PYTHON_EXECUTABLE,
          executableIdentity: {
            device: "2049",
            inode: "998877",
            size: "18200",
            mtimeNs: "1711111111000000000",
            ctimeNs: "1711111112000000000"
          },
          packageRoot: TEST_PACKAGE_ROOT,
          packageRootIdentity: { device: "2049", inode: "887766" },
          pythonVersion: "3.12.4"
        },
        dependencies: [
          {
            importModule: "pandas",
            distribution: "pandas",
            installSpec: "pandas>=2.2,<3",
            exactVersion: null,
            minimumVersion: "2.2",
            maximumVersionExclusive: "3"
          },
          {
            importModule: "xlrd",
            distribution: "xlrd",
            installSpec: "xlrd>=2.0.1",
            exactVersion: null,
            minimumVersion: "2.0.1",
            maximumVersionExclusive: null
          }
        ]
      }
    ]);

    const readyBytes = frameBytes(readyFrame(operation));
    child.stdout.write(readyBytes.subarray(0, 17));
    child.stdout.write(readyBytes.subarray(17));
    await expect(operation.ready).resolves.toEqual(readyFrame(operation));
    expect(child.inputFrames()).toHaveLength(1);

    operation.authorizeWrites();
    expect(operation.didAuthorize()).toBe(true);
    expect(child.inputFrames()).toEqual([
      expect.objectContaining({ kind: "install", token: operation.token }),
      { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "go", token: operation.token }
    ]);

    let exited = false;
    void operation.exit.then(() => {
      exited = true;
    });
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(exited).toBe(false);
    expect(existsSync(privateCwd)).toBe(true);

    child.emit("close", 0, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(privateCwd)).toBe(false);
  });

  it("aborts before READY by closing stdin without ever sending GO or signalling the helper", async () => {
    const { child, operation } = startInstall();
    operation.abortBeforeWrites();
    operation.abortBeforeWrites();
    await expect(operation.ready).rejects.toBeInstanceOf(DependencyInstallAbortedError);
    expect(() => operation.authorizeWrites()).toThrow("already aborted");

    child.emit("spawn");
    expect(child.inputFrames()).toEqual([expect.objectContaining({ kind: "install", token: operation.token })]);
    expect(operation.didAuthorize()).toBe(false);

    emitFrame(child, readyFrame(operation));
    child.emit("close", 10, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).resolves.toBeUndefined();
    expect(child.inputFrames()).toHaveLength(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("refuses authorization before READY and fails closed if an un-aborted helper closes without GO", async () => {
    const { child, operation } = startInstall();
    child.emit("spawn");
    expect(() => operation.authorizeWrites()).toThrow("before an exact READY frame");

    emitFrame(child, readyFrame(operation));
    await operation.ready;
    child.emit("close", 10, null);

    await expect(operation.completion).rejects.toThrow("closed without an explicit GO authorization");
    expect(operation.didAuthorize()).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "mis-correlated token",
      output: (operation: OwnedDependencyInstall) =>
        frameBytes({ ...readyFrame(operation), token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" })
    },
    {
      name: "unexpected key",
      output: (operation: OwnedDependencyInstall) => frameBytes({ ...readyFrame(operation), extra: true })
    },
    {
      name: "CRLF",
      output: (operation: OwnedDependencyInstall) => Buffer.from(`${JSON.stringify(readyFrame(operation))}\r\n`, "utf8")
    },
    {
      name: "invalid UTF-8",
      output: (_operation: OwnedDependencyInstall) => Buffer.from([0xc3, 0x28, 0x0a])
    },
    {
      name: "duplicate keys",
      output: (operation: OwnedDependencyInstall) =>
        Buffer.from(
          `{"protocol":"${DEPENDENCY_GUARD_PROTOCOL}","kind":"ready","kind":"ready","token":"${operation.token}"}\n`,
          "utf8"
        )
    },
    {
      name: "two frames",
      output: (operation: OwnedDependencyInstall) =>
        Buffer.concat([frameBytes(readyFrame(operation)), frameBytes(readyFrame(operation))])
    },
    {
      name: "overlong unterminated frame",
      output: (_operation: OwnedDependencyInstall) => Buffer.alloc(DEPENDENCY_GUARD_MAX_FRAME_BYTES, 0x61)
    }
  ])("rejects a $name helper response without authorizing writes", async ({ output }) => {
    const { child, operation } = startInstall();
    child.emit("spawn");
    child.stdout.write(output(operation));
    child.emit("close", 10, null);

    await expect(operation.ready).rejects.toBeInstanceOf(DependencyGuardProtocolError);
    await expect(operation.completion).rejects.toBeInstanceOf(DependencyGuardProtocolError);
    expect(operation.didAuthorize()).toBe(false);
    expect(child.inputFrames()).toHaveLength(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects unsupported stream chunks without invoking attacker-controlled coercion", async () => {
    const { child, operation } = startInstall();
    child.emit("spawn");
    const unsupported = {
      toString: vi.fn(() => {
        throw new Error("must not execute");
      })
    };

    expect(() => child.stdout.emit("data", unsupported)).not.toThrow();
    child.emit("close", 10, null);
    await expect(operation.ready).rejects.toBeInstanceOf(DependencyGuardProtocolError);
    await expect(operation.completion).rejects.toBeInstanceOf(DependencyGuardProtocolError);
    expect(unsupported.toString).not.toHaveBeenCalled();
  });

  it("invalidates an already received READY frame if the helper emits any later byte", async () => {
    const { child, operation } = startInstall();
    child.emit("spawn");
    emitFrame(child, readyFrame(operation));
    await expect(operation.ready).resolves.toEqual(readyFrame(operation));

    child.stdout.write(Buffer.from("x", "utf8"));
    expect(() => operation.authorizeWrites()).toThrow("after a guard failure");
    child.emit("close", 10, null);
    await expect(operation.completion).rejects.toBeInstanceOf(DependencyGuardProtocolError);
    expect(operation.didAuthorize()).toBe(false);
  });

  it("rejects helper output that arrives before spawn ownership is confirmed", async () => {
    const { child, operation } = startInstall();
    emitFrame(child, readyFrame(operation));
    child.emit("spawn");
    child.emit("close", 10, null);

    await expect(operation.ready).rejects.toThrow("before spawn ownership was confirmed");
    await expect(operation.completion).rejects.toBeInstanceOf(DependencyGuardProtocolError);
    expect(operation.didAuthorize()).toBe(false);
  });

  it("correlates a structured pre-READY helper error with its stable exit code", async () => {
    const { child, operation } = startInstall();
    child.emit("spawn");
    emitFrame(child, errorFrame("busy"));
    const readyFailure = expect(operation.ready).rejects.toMatchObject({ code: "busy", exitCode: 11 });
    child.emit("close", 11, null);

    await readyFailure;
    await expect(operation.completion).rejects.toMatchObject({
      name: "DependencyGuardCommandError",
      mode: "install",
      code: "busy",
      exitCode: 11
    });
  });

  it("rejects an error frame whose stable exit code does not match exact close", async () => {
    const { child, operation } = startInstall();
    child.emit("spawn");
    emitFrame(child, errorFrame("busy"));
    child.emit("close", 12, null);

    await expect(operation.completion).rejects.toBeInstanceOf(DependencyGuardProtocolError);
  });

  it("maps a post-GO pip failure from exact close without expecting a second protocol frame", async () => {
    const { child, operation } = startInstall();
    await readyAndAuthorize(child, operation);
    child.emit("close", 14, null);

    await expect(operation.completion).rejects.toMatchObject({
      name: "DependencyGuardCommandError",
      mode: "install",
      code: "pip_failed",
      exitCode: 14
    });
    expect(operation.didAuthorize()).toBe(true);
  });

  it("treats a pre-spawn error as proof that no package-writing process exists", async () => {
    const child = new DependencyChildProcess();
    let privateCwd: string | undefined;
    const missingEnvironment = { ...TEST_ENVIRONMENT, executable: testPath("/missing/python") };
    const operation = startDependencyInstall(missingEnvironment, TEST_DEPENDENCIES, {
      helperPath: TEST_HELPER_PATH,
      spawnProcess: (_executable, _args, options) => {
        privateCwd = options.cwd as string;
        return child as unknown as ChildProcess;
      }
    });

    child.emit("error", new Error("ENOENT"));

    await expect(operation.ready).rejects.toThrow("ENOENT");
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toThrow(
      `could not start dependency installation with ${missingEnvironment.executable}: ENOENT`
    );
    expect(operation.didSpawn()).toBe(false);
    expect(existsSync(privateCwd!)).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("waits for exact close after a post-spawn process error", async () => {
    const { child, operation, privateCwd } = startInstall();
    let exited = false;
    void operation.exit.then(() => {
      exited = true;
    });
    child.emit("spawn");
    child.emit("error", new Error("late child error"));
    await Promise.resolve();

    expect(exited).toBe(false);
    expect(existsSync(privateCwd)).toBe(true);
    child.emit("close", 17, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toThrow("late child error");
    expect(existsSync(privateCwd)).toBe(false);
  });

  it("fails cleanup without recursively deleting an entry planted in the private cwd", async () => {
    const { child, operation, privateCwd } = startInstall();
    const planted = `${privateCwd}/foreign-entry`;
    try {
      writeFileSync(planted, "preserve me", "utf8");
      await readyAndAuthorize(child, operation);
      child.emit("close", 0, null);

      await expect(operation.exit).resolves.toBeUndefined();
      await expect(operation.completion).rejects.toThrow();
      expect(existsSync(planted)).toBe(true);
    } finally {
      rmSync(privateCwd, { recursive: true, force: true });
    }
  });

  it("times out by unreferencing the exact child and never signalling it", async () => {
    vi.useFakeTimers();
    const { child, operation, privateCwd } = startInstall();
    await readyAndAuthorize(child, operation);

    const waiting = waitForDependencyInstallExit(operation, 5_000);
    const rejected = expect(waiting).rejects.toBeInstanceOf(DependencyInstallExitUnconfirmedError);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;

    expect(child.unref).toHaveBeenCalledOnce();
    expectPipeDetached(child.stdin);
    expect(child.stdout.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(privateCwd)).toBe(true);

    child.emit("close", 0, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).resolves.toBeUndefined();
    expect(existsSync(privateCwd)).toBe(false);
  });

  it("bounds the post-request READY phase, closes stdin without GO, and retains exact-close cleanup", async () => {
    vi.useFakeTimers();
    const { child, operation, privateCwd } = startInstall({ readyTimeoutMs: 25 });
    child.emit("spawn");

    const readyFailure = expect(operation.ready).rejects.toBeInstanceOf(DependencyInstallReadyTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await readyFailure;

    expect(operation.didAuthorize()).toBe(false);
    expect(child.inputFrames()).toEqual([expect.objectContaining({ kind: "install", token: operation.token })]);
    expect(child.stdin.writableEnded).toBe(true);
    expectPipeDetached(child.stdin);
    expect(child.stdout.unref).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(privateCwd)).toBe(true);

    emitFrame(child, readyFrame(operation));
    child.emit("close", 10, null);
    await expect(operation.exit).resolves.toBeUndefined();
    await expect(operation.completion).rejects.toBeInstanceOf(DependencyInstallReadyTimeoutError);
    expect(child.inputFrames()).toHaveLength(1);
    expect(existsSync(privateCwd)).toBe(false);
  });

  it("also bounds pre-spawn READY uncertainty and aggregates pipe/child unref failures", async () => {
    vi.useFakeTimers();
    const { child, operation, privateCwd } = startInstall({ readyTimeoutMs: 5 });
    child.stdout.unref.mockImplementation(() => {
      throw new Error("stdout unref failed");
    });
    child.unref.mockImplementation(() => {
      throw new Error("child unref failed");
    });

    const readyFailure = expect(operation.ready).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        collectErrors(error).some((item) => item instanceof DependencyInstallReadyTimeoutError) &&
        collectErrors(error).some((item) => item instanceof Error && item.message === "stdout unref failed") &&
        collectErrors(error).some((item) => item instanceof Error && item.message === "child unref failed")
    );
    await vi.advanceTimersByTimeAsync(5);
    await readyFailure;

    expect(operation.didSpawn()).toBe(false);
    expect(child.stdin.unref).toHaveBeenCalledOnce();
    expect(child.stdout.unref).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(privateCwd)).toBe(true);

    child.emit("spawn");
    expect(child.stdin.writableEnded).toBe(true);
    emitFrame(child, readyFrame(operation));
    child.emit("close", 10, null);
    await operation.exit;
    await expect(operation.completion).rejects.toBeInstanceOf(AggregateError);
    expect(existsSync(privateCwd)).toBe(false);
  });

  it("cancels the READY deadline after a valid correlated frame", async () => {
    vi.useFakeTimers();
    const { child, operation } = startInstall({ readyTimeoutMs: 25 });
    child.emit("spawn");
    emitFrame(child, readyFrame(operation));
    await operation.ready;

    await vi.advanceTimersByTimeAsync(25);
    expect(child.unref).not.toHaveBeenCalled();
    expect(child.stdin.unref).not.toHaveBeenCalled();
    expect(child.stdout.unref).not.toHaveBeenCalled();

    operation.authorizeWrites();
    child.emit("close", 0, null);
    await expect(operation.completion).resolves.toBeUndefined();
  });

  it("retains both timeout and unref failures without attempting termination", async () => {
    vi.useFakeTimers();
    const { child, operation } = startInstall();
    child.unref.mockImplementation(() => {
      throw new Error("unref failed");
    });
    child.emit("spawn");

    const waiting = waitForDependencyInstallExit(operation, 1);
    const rejected = expect(waiting).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        collectErrors(error).some((item) => item instanceof DependencyInstallExitUnconfirmedError) &&
        collectErrors(error).some((item) => item instanceof Error && item.message === "unref failed")
    );
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(child.kill).not.toHaveBeenCalled();

    operation.abortBeforeWrites();
    emitFrame(child, readyFrame(operation));
    child.emit("close", 10, null);
    await operation.exit;
  });

  it("rejects invalid targets, empty dependency sets, and oversized requests before spawn", () => {
    const spawnProcess = vi.fn();
    const options = { helperPath: TEST_HELPER_PATH, spawnProcess };

    expect(() =>
      startDependencyInstall({ ...TEST_ENVIRONMENT, executable: "python" }, TEST_DEPENDENCIES, options)
    ).toThrow("absolute executable path");
    expect(() =>
      startDependencyInstall({ ...TEST_ENVIRONMENT, packageRoot: "relative/env" }, TEST_DEPENDENCIES, options)
    ).toThrow("absolute package-root path");
    expect(() =>
      startDependencyInstall(TEST_ENVIRONMENT, TEST_DEPENDENCIES, { ...options, helperPath: "helper.py" })
    ).toThrow("absolute helper path");
    expect(() => startDependencyInstall(TEST_ENVIRONMENT, [], options)).toThrow("at least one dependency");
    expect(() =>
      startDependencyInstall(TEST_ENVIRONMENT, TEST_DEPENDENCIES, { ...options, readyTimeoutMs: Number.NaN })
    ).toThrow("READY timeout must be a finite non-negative number");
    expect(() =>
      startDependencyInstall(
        TEST_ENVIRONMENT,
        [{ ...TEST_DEPENDENCIES[0]!, installSpec: "x".repeat(DEPENDENCY_GUARD_MAX_FRAME_BYTES) }],
        options
      )
    ).toThrow("request exceeds");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("propagates synchronous spawn failure after cleaning the private cwd", () => {
    let privateCwd: string | undefined;
    expect(() =>
      startDependencyInstall(TEST_ENVIRONMENT, TEST_DEPENDENCIES, {
        helperPath: TEST_HELPER_PATH,
        spawnProcess: (_executable, _args, options) => {
          privateCwd = options.cwd as string;
          throw new Error("invalid spawn options");
        }
      })
    ).toThrow("invalid spawn options");
    expect(privateCwd).toBeDefined();
    expect(existsSync(privateCwd!)).toBe(false);
  });
});

describe("dependency guard status and validation", () => {
  it.each([
    {
      mode: "status",
      start: (options: DependencyGuardClientOptions) => startDependencyGuardStatus(TEST_ENVIRONMENT, options),
      result: {
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "status",
        state: "clean",
        token: null
      }
    },
    {
      mode: "validate",
      start: (options: DependencyGuardClientOptions) =>
        startDependencyGuardValidation(TEST_ENVIRONMENT, TEST_TOKEN, options),
      result: {
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "validated",
        token: TEST_TOKEN
      }
    }
  ])("exposes an idempotently detachable owned $mode command through exact close", async ({ start, result }) => {
    const child = new DependencyChildProcess();
    let privateCwd: string | undefined;
    const command = start({
      helperPath: TEST_HELPER_PATH,
      spawnProcess: (_executable, _args, options) => {
        privateCwd = options.cwd as string;
        return child as unknown as ChildProcess;
      }
    });
    expect(command.child).toBe(child);
    expect(command.didSpawn()).toBe(false);
    expect(command.didClose()).toBe(false);
    expect(existsSync(privateCwd!)).toBe(true);
    let ownershipReleased = false;
    void command.ownershipReleased.then(() => {
      ownershipReleased = true;
    });

    child.emit("spawn");
    expect(command.didSpawn()).toBe(true);
    command.unref();
    command.unref();
    expect(child.unref).toHaveBeenCalledOnce();
    expectPipeDetached(child.stdin);
    expect(child.stdout.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(ownershipReleased).toBe(false);

    emitFrame(child, result);
    child.emit("close", 0, null);
    await expect(command.completion).resolves.toEqual(result);
    await expect(command.ownershipReleased).resolves.toBeUndefined();
    expect(ownershipReleased).toBe(true);
    expect(command.didClose()).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(privateCwd!)).toBe(false);
  });

  it("parses an exact clean status only after exact close and sends the selected environment", async () => {
    const child = new DependencyChildProcess();
    let privateCwd: string | undefined;
    const spawnProcess = vi.fn((_executable: string, _args: string[], options: SpawnOptions) => {
      privateCwd = options.cwd as string;
      return child as unknown as ChildProcess;
    });
    const status = getDependencyGuardStatus(TEST_ENVIRONMENT, {
      helperPath: TEST_HELPER_PATH,
      spawnProcess
    });

    expect(spawnProcess.mock.calls[0]?.slice(0, 2)).toEqual([
      TEST_PYTHON_EXECUTABLE,
      ["-I", TEST_HELPER_PATH, "status"]
    ]);
    child.emit("spawn");
    expect(child.inputFrames()).toEqual([
      {
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "status",
        environment: expectedWireEnvironment()
      }
    ]);

    emitFrame(child, {
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "clean",
      token: null
    });
    let settled = false;
    void status.then(() => {
      settled = true;
    });
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(existsSync(privateCwd!)).toBe(true);

    child.emit("close", 0, null);
    await expect(status).resolves.toEqual({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "clean",
      token: null
    });
    expect(existsSync(privateCwd!)).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("round-trips a dirty status token", async () => {
    const child = new DependencyChildProcess();
    const status = getDependencyGuardStatus(TEST_ENVIRONMENT, guardOptions(child));
    child.emit("spawn");
    emitFrame(child, {
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "dirty",
      token: TEST_TOKEN
    });
    child.emit("close", 0, null);

    await expect(status).resolves.toMatchObject({ state: "dirty", token: TEST_TOKEN });
  });

  it("binds validation to the mandatory expected token", async () => {
    const child = new DependencyChildProcess();
    const validation = validateDependencyGuard(TEST_ENVIRONMENT, TEST_TOKEN, guardOptions(child));
    child.emit("spawn");
    expect(child.inputFrames()).toEqual([
      {
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "validate",
        environment: expectedWireEnvironment(),
        expectedToken: TEST_TOKEN
      }
    ]);
    emitFrame(child, {
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "validated",
      token: TEST_TOKEN
    });
    child.emit("close", 0, null);

    await expect(validation).resolves.toEqual({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "validated",
      token: TEST_TOKEN
    });
  });

  it("rejects a missing, malformed, or differently correlated validation token before or after spawn", async () => {
    const spawnProcess = vi.fn();
    expect(() =>
      validateDependencyGuard(TEST_ENVIRONMENT, null as unknown as string, {
        helperPath: TEST_HELPER_PATH,
        spawnProcess
      })
    ).toThrow("canonical lowercase UUID");
    expect(() =>
      validateDependencyGuard(TEST_ENVIRONMENT, "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", {
        helperPath: TEST_HELPER_PATH,
        spawnProcess
      })
    ).toThrow("canonical lowercase UUID");
    expect(spawnProcess).not.toHaveBeenCalled();

    const child = new DependencyChildProcess();
    const validation = validateDependencyGuard(TEST_ENVIRONMENT, TEST_TOKEN, guardOptions(child));
    child.emit("spawn");
    emitFrame(child, {
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "validated",
      token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    });
    child.emit("close", 0, null);
    await expect(validation).rejects.toBeInstanceOf(DependencyGuardProtocolError);
  });

  it("requires status state and token to agree", async () => {
    const child = new DependencyChildProcess();
    const status = getDependencyGuardStatus(TEST_ENVIRONMENT, guardOptions(child));
    child.emit("spawn");
    emitFrame(child, {
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "clean",
      token: TEST_TOKEN
    });
    child.emit("close", 0, null);

    await expect(status).rejects.toBeInstanceOf(DependencyGuardProtocolError);
  });

  it("maps a structured helper error only when its stable exit code matches", async () => {
    const child = new DependencyChildProcess();
    const status = getDependencyGuardStatus(TEST_ENVIRONMENT, guardOptions(child));
    child.emit("spawn");
    emitFrame(child, errorFrame("malformed_state"));
    child.emit("close", 12, null);

    await expect(status).rejects.toMatchObject({
      name: "DependencyGuardCommandError",
      mode: "status",
      code: "malformed_state",
      exitCode: 12
    });
  });

  it("rejects an error/result frame whose exact close status disagrees", async () => {
    const errorChild = new DependencyChildProcess();
    const errored = getDependencyGuardStatus(TEST_ENVIRONMENT, guardOptions(errorChild));
    errorChild.emit("spawn");
    emitFrame(errorChild, errorFrame("busy"));
    errorChild.emit("close", 12, null);
    await expect(errored).rejects.toBeInstanceOf(DependencyGuardProtocolError);

    const resultChild = new DependencyChildProcess();
    const result = getDependencyGuardStatus(TEST_ENVIRONMENT, guardOptions(resultChild));
    resultChild.emit("spawn");
    emitFrame(resultChild, {
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      state: "clean",
      token: null
    });
    resultChild.emit("close", 11, null);
    await expect(result).rejects.toBeInstanceOf(DependencyGuardProtocolError);
  });

  it.each([
    {
      name: "extra frame",
      output: Buffer.concat([
        frameBytes({
          protocol: DEPENDENCY_GUARD_PROTOCOL,
          kind: "status",
          state: "clean",
          token: null
        }),
        Buffer.from("{}\n", "utf8")
      ])
    },
    {
      name: "overlong frame",
      output: Buffer.alloc(DEPENDENCY_GUARD_MAX_FRAME_BYTES, 0x61)
    },
    {
      name: "unknown error",
      output: frameBytes({
        protocol: DEPENDENCY_GUARD_PROTOCOL,
        kind: "error",
        code: "not_a_guard_error"
      })
    }
  ])("rejects $name output", async ({ output }) => {
    const child = new DependencyChildProcess();
    const status = getDependencyGuardStatus(TEST_ENVIRONMENT, guardOptions(child));
    child.emit("spawn");
    child.stdout.write(output);
    child.emit("close", 17, null);
    await expect(status).rejects.toBeInstanceOf(DependencyGuardProtocolError);
  });

  it("waits for close after a post-spawn error but resolves a proven pre-spawn error immediately", async () => {
    const lateChild = new DependencyChildProcess();
    const late = startDependencyGuardStatus(TEST_ENVIRONMENT, guardOptions(lateChild));
    lateChild.emit("spawn");
    lateChild.emit("error", new Error("late error"));
    let lateSettled = false;
    let lateOwnershipReleased = false;
    void late.completion.catch(() => {
      lateSettled = true;
    });
    void late.ownershipReleased.then(() => {
      lateOwnershipReleased = true;
    });
    await Promise.resolve();
    expect(lateSettled).toBe(false);
    expect(lateOwnershipReleased).toBe(false);
    lateChild.emit("close", 17, null);
    await expect(late.completion).rejects.toThrow("late error");
    await expect(late.ownershipReleased).resolves.toBeUndefined();
    expect(lateOwnershipReleased).toBe(true);

    const earlyChild = new DependencyChildProcess();
    let privateCwd: string | undefined;
    const early = startDependencyGuardStatus(TEST_ENVIRONMENT, {
      helperPath: TEST_HELPER_PATH,
      spawnProcess: (_executable, _args, options) => {
        privateCwd = options.cwd as string;
        return earlyChild as unknown as ChildProcess;
      }
    });
    earlyChild.emit("error", new Error("ENOENT"));
    await expect(early.completion).rejects.toThrow("ENOENT");
    await expect(early.ownershipReleased).resolves.toBeUndefined();
    expect(existsSync(privateCwd!)).toBe(false);
  });

  it("times out by unreferencing without signalling and retains cwd ownership until late close", async () => {
    vi.useFakeTimers();
    const child = new DependencyChildProcess();
    let privateCwd: string | undefined;
    const command = startDependencyGuardStatus(TEST_ENVIRONMENT, {
      helperPath: TEST_HELPER_PATH,
      timeoutMs: 25,
      spawnProcess: (_executable, _args, options) => {
        privateCwd = options.cwd as string;
        return child as unknown as ChildProcess;
      }
    });
    child.emit("spawn");
    let ownershipReleased = false;
    void command.ownershipReleased.then(() => {
      ownershipReleased = true;
    });

    const rejected = expect(command.completion).rejects.toBeInstanceOf(DependencyGuardCommandTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(child.unref).toHaveBeenCalledOnce();
    expectPipeDetached(child.stdin);
    expect(child.stdout.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(privateCwd!)).toBe(true);
    expect(ownershipReleased).toBe(false);

    child.emit("close", 17, null);
    await expect(command.ownershipReleased).resolves.toBeUndefined();
    expect(ownershipReleased).toBe(true);
    expect(existsSync(privateCwd!)).toBe(false);
  });

  it("does not detach an owned command twice when its timeout follows an explicit unref", async () => {
    vi.useFakeTimers();
    const child = new DependencyChildProcess();
    const command = startDependencyGuardStatus(TEST_ENVIRONMENT, {
      helperPath: TEST_HELPER_PATH,
      timeoutMs: 25,
      spawnProcess: () => child as unknown as ChildProcess
    });
    child.emit("spawn");
    command.unref();

    const rejected = expect(command.completion).rejects.toBeInstanceOf(DependencyGuardCommandTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(child.unref).toHaveBeenCalledOnce();
    expectPipeDetached(child.stdin);
    expect(child.stdout.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close", 17, null);
  });

  it("retries a partial timeout detach and marks ownership unreferenced only after every handle succeeds", async () => {
    vi.useFakeTimers();
    const child = new DependencyChildProcess();
    const detachFailure = new Error("stdout unref failed");
    child.stdout.unref.mockImplementationOnce(() => {
      throw detachFailure;
    });
    const command = startDependencyGuardStatus(TEST_ENVIRONMENT, {
      helperPath: TEST_HELPER_PATH,
      timeoutMs: 25,
      spawnProcess: () => child as unknown as ChildProcess
    });
    child.emit("spawn");

    const timedOut = command.completion.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(collectErrors(await timedOut)).toContain(detachFailure);
    expect(child.stdout.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();

    expect(() => command.unref()).not.toThrow();
    expect(child.stdout.unref).toHaveBeenCalledTimes(2);
    command.unref();
    expect(child.stdout.unref).toHaveBeenCalledTimes(2);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close", 17, null);
    await expect(command.ownershipReleased).resolves.toBeUndefined();
  });

  it("validates timeout and request bounds before spawning a one-shot helper", () => {
    const spawnProcess = vi.fn();
    expect(() =>
      getDependencyGuardStatus(TEST_ENVIRONMENT, {
        helperPath: TEST_HELPER_PATH,
        timeoutMs: Number.NaN,
        spawnProcess
      })
    ).toThrow("finite non-negative");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

function startInstall(options: { readonly readyTimeoutMs?: number } = {}): {
  child: DependencyChildProcess;
  operation: OwnedDependencyInstall;
  privateCwd: string;
} {
  const child = new DependencyChildProcess();
  let privateCwd: string | undefined;
  const operation = startDependencyInstall(TEST_ENVIRONMENT, TEST_DEPENDENCIES, {
    helperPath: TEST_HELPER_PATH,
    ...options,
    spawnProcess: (_executable, _args, options) => {
      privateCwd = options.cwd as string;
      return child as unknown as ChildProcess;
    }
  });
  return { child, operation, privateCwd: privateCwd! };
}

function collectErrors(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return [error, ...error.errors.flatMap(collectErrors)];
}

function expectPipeDetached(pipe: DependencyChildProcess["stdin"]): void {
  expect(pipe.destroyed || pipe.unref.mock.calls.length === 1).toBe(true);
}

function guardOptions(child: DependencyChildProcess): DependencyGuardClientOptions {
  return {
    helperPath: TEST_HELPER_PATH,
    spawnProcess: () => child as unknown as ChildProcess
  };
}

async function readyAndAuthorize(child: DependencyChildProcess, operation: OwnedDependencyInstall): Promise<void> {
  child.emit("spawn");
  emitFrame(child, readyFrame(operation));
  await operation.ready;
  operation.authorizeWrites();
}

function readyFrame(operation: OwnedDependencyInstall): {
  protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
  kind: "ready";
  token: string;
} {
  return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "ready", token: operation.token };
}

function errorFrame(code: string): {
  protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
  kind: "error";
  code: string;
} {
  return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "error", code };
}

function emitFrame(child: DependencyChildProcess, payload: unknown): void {
  child.stdout.write(frameBytes(payload));
}

function frameBytes(payload: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

function expectedWireEnvironment(): Record<string, unknown> {
  return {
    executable: TEST_PYTHON_EXECUTABLE,
    executableIdentity: {
      device: "2049",
      inode: "998877",
      size: "18200",
      mtimeNs: "1711111111000000000",
      ctimeNs: "1711111112000000000"
    },
    packageRoot: TEST_PACKAGE_ROOT,
    packageRootIdentity: { device: "2049", inode: "887766" },
    pythonVersion: "3.12.4"
  };
}

function hostileProcessEnvironment(): NodeJS.ProcessEnv {
  return {
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
  };
}

function testPath(posixPath: string): string {
  return process.platform === "win32" ? win32.join("C:\\", ...posixPath.split("/").filter(Boolean)) : posixPath;
}
