import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmdirSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  BoundedDependencyGuardFrameReader,
  DEPENDENCY_GUARD_MAX_FRAME_BYTES,
  DependencyGuardProtocolError,
  type DependencyGuardMode
} from "./dependencyGuardFrameReader";
import type { PythonEnvironment } from "./pythonEnvironment";
import type { PythonDependency } from "./pythonEnvironmentModel";
import { isFullyQualifiedPythonPath } from "./pythonPath";
import { buildPythonProcessEnvironment } from "./pythonProcessEnvironment";

export const DEPENDENCY_GUARD_PROTOCOL = "openwrangler-dependency-guard-v1";
export {
  DEPENDENCY_GUARD_MAX_FRAME_BYTES,
  DependencyGuardProtocolError,
  type DependencyGuardMode
} from "./dependencyGuardFrameReader";
export const DEPENDENCY_GUARD_COMMAND_TIMEOUT_MS = 30_000;
export const DEPENDENCY_INSTALL_READY_TIMEOUT_MS = 30_000;
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const DEPENDENCY_INSTALL_SHUTDOWN_WAIT_MS = 5_000;

export type DependencyGuardErrorCode =
  | "invalid_request"
  | "busy"
  | "malformed_state"
  | "validation_failed"
  | "pip_failed"
  | "stale_or_missing_marker"
  | "environment_changed"
  | "internal_error";

const DEPENDENCY_GUARD_EXIT_CODES: Readonly<Record<DependencyGuardErrorCode, number>> = {
  invalid_request: 10,
  busy: 11,
  malformed_state: 12,
  validation_failed: 13,
  pip_failed: 14,
  stale_or_missing_marker: 15,
  environment_changed: 16,
  internal_error: 17
};

const DEPENDENCY_GUARD_CODES_BY_EXIT = new Map<number, DependencyGuardErrorCode>(
  Object.entries(DEPENDENCY_GUARD_EXIT_CODES).map(([code, exitCode]) => [exitCode, code as DependencyGuardErrorCode])
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DependencyInstallSpawner = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface DependencyGuardReady {
  readonly protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
  readonly kind: "ready";
  readonly token: string;
}

export type DependencyGuardStatus =
  | {
      readonly protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
      readonly kind: "status";
      readonly state: "clean";
      readonly token: null;
    }
  | {
      readonly protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
      readonly kind: "status";
      readonly state: "dirty";
      readonly token: string;
    };

export interface DependencyGuardValidation {
  readonly protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
  readonly kind: "validated";
  readonly token: string;
}

export interface OwnedDependencyInstall {
  readonly child: ChildProcess;
  readonly executable: string;
  readonly requirements: readonly string[];
  readonly token: string;
  readonly ready: Promise<DependencyGuardReady>;
  readonly exit: Promise<void>;
  readonly completion: Promise<void>;
  authorizeWrites(): void;
  abortBeforeWrites(): void;
  didSpawn(): boolean;
  didAuthorize(): boolean;
  unref(): void;
}

export interface OwnedDependencyGuardCommand<Result> {
  readonly child: ChildProcess;
  readonly mode: "status" | "validate";
  readonly executable: string;
  readonly completion: Promise<Result>;
  readonly ownershipReleased: Promise<void>;
  didSpawn(): boolean;
  didClose(): boolean;
  unref(): void;
}

export interface DependencyGuardClientOptions {
  readonly helperPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: DependencyInstallSpawner;
  readonly timeoutMs?: number;
}

export interface StartDependencyInstallOptions extends Omit<DependencyGuardClientOptions, "timeoutMs"> {
  readonly readyTimeoutMs?: number;
}

export class DependencyGuardCommandError extends Error {
  readonly exitCode: number;

  constructor(
    readonly mode: DependencyGuardMode,
    readonly code: DependencyGuardErrorCode,
    readonly executable: string
  ) {
    const exitCode = DEPENDENCY_GUARD_EXIT_CODES[code];
    super(`Open Wrangler dependency guard ${mode} with ${executable} failed with ${code} (exit code ${exitCode}).`);
    this.name = "DependencyGuardCommandError";
    this.exitCode = exitCode;
  }
}

export class DependencyInstallAbortedError extends Error {
  constructor(readonly executable: string) {
    super(`Open Wrangler aborted dependency installation with ${executable} before package writes were authorized.`);
    this.name = "DependencyInstallAbortedError";
  }
}

export class DependencyInstallReadyTimeoutError extends Error {
  constructor(
    readonly executable: string,
    readonly timeoutMs: number
  ) {
    super(
      `Open Wrangler dependency guard with ${executable} did not publish READY within ${timeoutMs} ms. ` +
        "Package writes were not authorized."
    );
    this.name = "DependencyInstallReadyTimeoutError";
  }
}

export class DependencyGuardCommandTimeoutError extends Error {
  constructor(
    readonly mode: Exclude<DependencyGuardMode, "install">,
    readonly executable: string,
    readonly timeoutMs: number
  ) {
    super(
      `Open Wrangler could not confirm that dependency guard ${mode} with ${executable} exited within ${timeoutMs} ms.`
    );
    this.name = "DependencyGuardCommandTimeoutError";
  }
}

export class DependencyInstallExitUnconfirmedError extends Error {
  constructor(
    readonly executable: string,
    readonly timeoutMs: number
  ) {
    super(
      `Open Wrangler could not confirm that dependency installation with ${executable} exited within ${timeoutMs} ms. ` +
        "The process was left running to avoid corrupting package writes."
    );
    this.name = "DependencyInstallExitUnconfirmedError";
  }
}

export function startDependencyInstall(
  environment: PythonEnvironment,
  dependencies: readonly PythonDependency[],
  options: StartDependencyInstallOptions
): OwnedDependencyInstall {
  validateGuardTarget(environment, options.helperPath);
  if (dependencies.length === 0) {
    throw new Error("Python dependency installation requires at least one dependency.");
  }
  const readyTimeoutMs = options.readyTimeoutMs ?? DEPENDENCY_INSTALL_READY_TIMEOUT_MS;
  validateTimeout(readyTimeoutMs, "Dependency guard READY timeout");

  const token = randomUUID();
  const requirements = dependencies.map((dependency) => dependency.installSpec);
  const request = {
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "install",
    token,
    environment: dependencyGuardEnvironmentWire(environment),
    dependencies: dependencies.map(dependencyGuardDependencyWire)
  } as const;
  const requestFrame = encodeDependencyGuardFrame(request);
  const goFrame = encodeDependencyGuardFrame({
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "go",
    token
  });
  const processEnvironment = dependencyGuardProcessEnvironment(options.environment ?? process.env);
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const workingDirectory = dependencyGuardWorkingDirectory();

  let child: ChildProcess;
  try {
    child = spawnProcess(environment.executable, ["-I", options.helperPath, "install"], {
      cwd: workingDirectory.cwd,
      env: processEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true
    });
  } catch (error) {
    throwWithSynchronousCleanup(
      error,
      workingDirectory.cleanup(),
      "Open Wrangler could not start dependency installation or clean its private working directory."
    );
  }

  return ownDependencyInstall(
    child,
    environment.executable,
    requirements,
    token,
    requestFrame,
    goFrame,
    workingDirectory,
    readyTimeoutMs
  );
}

export function getDependencyGuardStatus(
  environment: PythonEnvironment,
  options: DependencyGuardClientOptions
): Promise<DependencyGuardStatus> {
  return startDependencyGuardStatus(environment, options).completion;
}

export function startDependencyGuardStatus(
  environment: PythonEnvironment,
  options: DependencyGuardClientOptions
): OwnedDependencyGuardCommand<DependencyGuardStatus> {
  validateGuardTarget(environment, options.helperPath);
  const requestFrame = encodeDependencyGuardFrame({
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "status",
    environment: dependencyGuardEnvironmentWire(environment)
  });
  return startDependencyGuardCommand(
    "status",
    environment.executable,
    options,
    requestFrame,
    decodeDependencyGuardStatus
  );
}

export function validateDependencyGuard(
  environment: PythonEnvironment,
  expectedToken: string,
  options: DependencyGuardClientOptions
): Promise<DependencyGuardValidation> {
  return startDependencyGuardValidation(environment, expectedToken, options).completion;
}

export function startDependencyGuardValidation(
  environment: PythonEnvironment,
  expectedToken: string,
  options: DependencyGuardClientOptions
): OwnedDependencyGuardCommand<DependencyGuardValidation> {
  validateGuardTarget(environment, options.helperPath);
  if (!isCanonicalUuid(expectedToken)) {
    throw new Error("Dependency validation requires a canonical lowercase UUID.");
  }
  const requestFrame = encodeDependencyGuardFrame({
    protocol: DEPENDENCY_GUARD_PROTOCOL,
    kind: "validate",
    environment: dependencyGuardEnvironmentWire(environment),
    expectedToken
  });
  return startDependencyGuardCommand("validate", environment.executable, options, requestFrame, (frame) =>
    decodeDependencyGuardValidation(frame, expectedToken)
  );
}

export async function waitForDependencyInstallExit(
  operation: OwnedDependencyInstall,
  timeoutMs: number
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        const uncertainty = new DependencyInstallExitUnconfirmedError(operation.executable, timeoutMs);
        try {
          operation.unref();
          reject(uncertainty);
        } catch (error) {
          reject(
            new AggregateError(
              [uncertainty, error],
              "Open Wrangler could not release its unconfirmed dependency-install process."
            )
          );
        }
      },
      Math.max(0, timeoutMs)
    );
    timer.unref();
  });
  try {
    await Promise.race([operation.exit, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ownDependencyInstall(
  child: ChildProcess,
  executable: string,
  requirements: readonly string[],
  token: string,
  requestFrame: Buffer,
  goFrame: Buffer,
  workingDirectory: DependencyGuardWorkingDirectory,
  readyTimeoutMs: number
): OwnedDependencyInstall {
  let spawned = false;
  let authorized = false;
  let aborted = false;
  let requestWritten = false;
  let inputEnded = false;
  let closed = false;
  let unreferenced = false;
  let exitSettled = false;
  let readySettled = false;
  let completionSettled = false;
  let readyReceived = false;
  let processError: Error | undefined;
  let protocolError: Error | undefined;
  let helperError: DependencyGuardCommandError | undefined;
  let readyTimeoutError: Error | undefined;
  let output: BoundedDependencyGuardFrameReader | undefined;
  let resolveExit!: () => void;
  let resolveReady!: (ready: DependencyGuardReady) => void;
  let rejectReady!: (error: Error) => void;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const ready = new Promise<DependencyGuardReady>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void ready.catch(() => undefined);
  void completion.catch(() => undefined);

  const settleExit = (): void => {
    if (exitSettled) return;
    exitSettled = true;
    resolveExit();
  };
  const settleReady = (result: DependencyGuardReady | Error): void => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    if (result instanceof Error) rejectReady(result);
    else resolveReady(result);
  };
  const settleCompletion = (error?: Error): void => {
    if (completionSettled) return;
    completionSettled = true;
    if (error) rejectCompletion(error);
    else resolveCompletion();
  };
  const closeInputWithoutGo = (): void => {
    if (authorized || inputEnded) return;
    if (!spawned || !requestWritten) return;
    inputEnded = true;
    try {
      guardStdio?.stdin.end();
    } catch (error) {
      processError ??= asError(error);
    }
  };
  const recordProtocolError = (error: Error): void => {
    output?.dispose();
    protocolError ??= error;
    settleReady(error);
    closeInputWithoutGo();
  };
  const recordProcessError = (error: Error): void => {
    output?.dispose();
    processError ??= error;
    settleReady(error);
    closeInputWithoutGo();
  };
  const recordHelperError = (error: DependencyGuardCommandError): void => {
    helperError ??= error;
    settleReady(error);
    closeInputWithoutGo();
  };

  const guardStdio = dependencyGuardStdio(child);
  const readyTimer = setTimeout(() => {
    output?.dispose();
    let failure: Error = new DependencyInstallReadyTimeoutError(executable, readyTimeoutMs);
    readyTimeoutError = failure;
    closeInputWithoutGo();
    if (!closed && !unreferenced) {
      unreferenced = true;
      try {
        unrefDependencyGuardProcess(child, guardStdio);
      } catch (error) {
        failure = new AggregateError(
          [failure, error],
          "Open Wrangler could not release its dependency-install helper after the READY timeout."
        );
        readyTimeoutError = failure;
      }
    }
    settleReady(failure);
  }, readyTimeoutMs);
  readyTimer.unref();

  if (!guardStdio) {
    recordProtocolError(
      new DependencyGuardProtocolError("install", "the helper process did not expose the required stdin/stdout pipes")
    );
  } else {
    const reader = new BoundedDependencyGuardFrameReader(
      "install",
      (frame) => {
        if (!spawned) {
          recordProtocolError(
            new DependencyGuardProtocolError(
              "install",
              "the helper emitted output before spawn ownership was confirmed"
            )
          );
          return;
        }
        if (frame.kind === "error") {
          recordHelperError(decodeDependencyGuardError(frame, "install", executable));
          return;
        }
        const decoded = decodeDependencyGuardReady(frame, token);
        readyReceived = true;
        if (!aborted) settleReady(decoded);
      },
      recordProtocolError
    );
    output = reader;
    guardStdio.stdout.on("data", (chunk: unknown) => reader.accept(chunk));
    guardStdio.stdout.once("end", () => reader.end());
    guardStdio.stdout.on("error", (error: Error) => {
      recordProcessError(new Error(`Open Wrangler could not read dependency guard output: ${error.message}`));
    });
    guardStdio.stdin.on("error", (error: Error) => {
      recordProcessError(new Error(`Open Wrangler could not write dependency guard input: ${error.message}`));
    });
  }

  child.once("spawn", () => {
    spawned = true;
    if (!guardStdio || requestWritten) return;
    requestWritten = true;
    try {
      if (aborted || protocolError || processError || readyTimeoutError) {
        inputEnded = true;
        guardStdio.stdin.end(requestFrame);
      } else {
        guardStdio.stdin.write(requestFrame);
      }
    } catch (error) {
      recordProcessError(
        new Error(`Open Wrangler could not send the dependency guard install request: ${asError(error).message}`)
      );
    }
  });
  child.once("error", (error: Error) => {
    output?.dispose();
    recordProcessError(error);
    if (spawned) return;
    settleExit();
    const failure = new Error(
      `Open Wrangler could not start dependency installation with ${executable}: ${error.message}`
    );
    settleCompletion(combineCleanupFailure(failure, workingDirectory.cleanup()));
  });
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    output?.dispose();
    closed = true;
    settleExit();
    if (!readySettled) {
      settleReady(
        new DependencyGuardProtocolError("install", "the helper closed before publishing an exact READY frame")
      );
    }
    const cleanupError = workingDirectory.cleanup();
    const failure = dependencyInstallCloseFailure({
      executable,
      spawned,
      authorized,
      aborted,
      readyReceived,
      processError,
      protocolError,
      helperError,
      readyTimeoutError,
      code,
      signal
    });
    settleCompletion(combineCleanupFailure(failure, cleanupError));
  });

  const operation: OwnedDependencyInstall = {
    child,
    executable,
    requirements: [...requirements],
    token,
    ready,
    exit,
    completion,
    authorizeWrites: () => {
      if (closed) throw new Error("Dependency installation already closed.");
      if (aborted) throw new Error("Dependency installation was already aborted before package writes.");
      if (authorized) throw new Error("Dependency installation writes were already authorized.");
      if (!readyReceived || !readySettled) {
        throw new Error("Dependency installation writes cannot be authorized before an exact READY frame.");
      }
      if (protocolError || processError || helperError || readyTimeoutError) {
        throw new Error("Dependency installation writes cannot be authorized after a guard failure.");
      }
      if (!guardStdio || inputEnded) {
        throw new Error("Dependency installation input is no longer available for authorization.");
      }
      authorized = true;
      inputEnded = true;
      try {
        guardStdio.stdin.end(goFrame);
      } catch (error) {
        const failure = new Error(
          `Open Wrangler could not send the dependency guard GO frame: ${asError(error).message}`
        );
        recordProcessError(failure);
        throw failure;
      }
    },
    abortBeforeWrites: () => {
      if (authorized) throw new Error("Dependency installation writes were already authorized.");
      if (closed) throw new Error("Dependency installation already closed.");
      if (aborted) return;
      aborted = true;
      settleReady(new DependencyInstallAbortedError(executable));
      closeInputWithoutGo();
    },
    didSpawn: () => spawned,
    didAuthorize: () => authorized,
    unref: () => {
      if (unreferenced) return;
      unreferenced = true;
      unrefDependencyGuardProcess(child, guardStdio);
    }
  };

  return operation;
}

interface DependencyInstallCloseState {
  readonly executable: string;
  readonly spawned: boolean;
  readonly authorized: boolean;
  readonly aborted: boolean;
  readonly readyReceived: boolean;
  readonly processError?: Error;
  readonly protocolError?: Error;
  readonly helperError?: DependencyGuardCommandError;
  readonly readyTimeoutError?: Error;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function dependencyInstallCloseFailure(state: DependencyInstallCloseState): Error | undefined {
  if (state.processError) {
    return new Error(
      `Open Wrangler dependency installation with ${state.executable} failed: ${state.processError.message}`
    );
  }
  if (!state.spawned) {
    return new Error(
      `Open Wrangler dependency installation with ${state.executable} closed before spawn ownership was confirmed.`
    );
  }
  if (state.readyTimeoutError) return state.readyTimeoutError;
  if (state.protocolError) return state.protocolError;
  if (state.helperError) {
    if (state.code !== state.helperError.exitCode || state.signal) {
      return new DependencyGuardProtocolError(
        "install",
        `error frame ${state.helperError.code} did not match ${dependencyGuardCloseDetail(state.code, state.signal)}`
      );
    }
    return state.helperError;
  }
  if (state.aborted && !state.authorized) {
    if (state.readyReceived && state.code === DEPENDENCY_GUARD_EXIT_CODES.invalid_request && !state.signal) {
      return undefined;
    }
    return new DependencyGuardProtocolError(
      "install",
      `aborted helper did not close after READY with exit code ${DEPENDENCY_GUARD_EXIT_CODES.invalid_request}`
    );
  }
  if (!state.readyReceived) {
    return new DependencyGuardProtocolError("install", "the helper did not publish an exact READY frame");
  }
  if (!state.authorized) {
    return new DependencyGuardProtocolError("install", "the helper closed without an explicit GO authorization");
  }
  if (state.code === 0 && !state.signal) return undefined;
  const guardCode = state.code === null ? undefined : DEPENDENCY_GUARD_CODES_BY_EXIT.get(state.code);
  if (guardCode && !state.signal) return new DependencyGuardCommandError("install", guardCode, state.executable);
  return new Error(
    `Open Wrangler dependency installation with ${state.executable} ended with ${dependencyGuardCloseDetail(
      state.code,
      state.signal
    )}.`
  );
}

function startDependencyGuardCommand<Result>(
  mode: "status" | "validate",
  executable: string,
  options: DependencyGuardClientOptions,
  requestFrame: Buffer,
  decodeSuccess: (frame: Record<string, unknown>) => Result
): OwnedDependencyGuardCommand<Result> {
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_GUARD_COMMAND_TIMEOUT_MS;
  validateTimeout(timeoutMs, "Dependency guard timeout");
  const processEnvironment = dependencyGuardProcessEnvironment(options.environment ?? process.env);
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const workingDirectory = dependencyGuardWorkingDirectory();
  let child: ChildProcess;
  try {
    child = spawnProcess(executable, ["-I", options.helperPath, mode], {
      cwd: workingDirectory.cwd,
      env: processEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true
    });
  } catch (error) {
    throwWithSynchronousCleanup(
      error,
      workingDirectory.cleanup(),
      `Open Wrangler could not start dependency guard ${mode} or clean its private working directory.`
    );
  }

  let spawned = false;
  let closed = false;
  let unreferenced = false;
  let processError: Error | undefined;
  let protocolError: Error | undefined;
  let helperError: DependencyGuardCommandError | undefined;
  let result: Result | undefined;
  let resultReceived = false;
  let output: BoundedDependencyGuardFrameReader | undefined;
  let completionSettled = false;
  let ownershipSettled = false;
  let resolveCompletion!: (value: Result) => void;
  let rejectCompletion!: (error: Error) => void;
  let resolveOwnershipReleased!: () => void;

  const completion = new Promise<Result>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const ownershipReleased = new Promise<void>((resolve) => {
    resolveOwnershipReleased = resolve;
  });
  void completion.catch(() => undefined);
  const settleOwnership = (): void => {
    if (ownershipSettled) return;
    ownershipSettled = true;
    resolveOwnershipReleased();
  };
  const settleCompletion = (value: Result | Error): void => {
    if (completionSettled) return;
    completionSettled = true;
    if (value instanceof Error) rejectCompletion(value);
    else resolveCompletion(value);
  };
  const recordProtocolError = (error: Error): void => {
    output?.dispose();
    protocolError ??= error;
  };
  const recordProcessError = (error: Error): void => {
    output?.dispose();
    processError ??= error;
  };

  const guardStdio = dependencyGuardStdio(child);
  if (!guardStdio) {
    recordProtocolError(
      new DependencyGuardProtocolError(mode, "the helper process did not expose the required stdin/stdout pipes")
    );
  } else {
    const reader = new BoundedDependencyGuardFrameReader(
      mode,
      (frame) => {
        if (!spawned) {
          recordProtocolError(
            new DependencyGuardProtocolError(mode, "the helper emitted output before spawn ownership was confirmed")
          );
          return;
        }
        if (frame.kind === "error") {
          helperError ??= decodeDependencyGuardError(frame, mode, executable);
          return;
        }
        result = decodeSuccess(frame);
        resultReceived = true;
      },
      recordProtocolError
    );
    output = reader;
    guardStdio.stdout.on("data", (chunk: unknown) => reader.accept(chunk));
    guardStdio.stdout.once("end", () => reader.end());
    guardStdio.stdout.on("error", (error: Error) => {
      recordProcessError(new Error(`Open Wrangler could not read dependency guard output: ${error.message}`));
    });
    guardStdio.stdin.on("error", (error: Error) => {
      recordProcessError(new Error(`Open Wrangler could not write dependency guard input: ${error.message}`));
    });
  }

  child.once("spawn", () => {
    spawned = true;
    if (!guardStdio) return;
    try {
      guardStdio.stdin.end(requestFrame);
    } catch (error) {
      recordProcessError(
        new Error(`Open Wrangler could not send the dependency guard ${mode} request: ${asError(error).message}`)
      );
    }
  });
  child.once("error", (error: Error) => {
    output?.dispose();
    recordProcessError(error);
    if (spawned) return;
    const failure = new Error(
      `Open Wrangler could not start dependency guard ${mode} with ${executable}: ${error.message}`
    );
    const combined = combineCleanupFailure(failure, workingDirectory.cleanup()) ?? failure;
    settleOwnership();
    settleCompletion(combined);
  });
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    output?.dispose();
    closed = true;
    const cleanupError = workingDirectory.cleanup();
    const failure = dependencyGuardCommandCloseFailure({
      mode,
      executable,
      spawned,
      processError,
      protocolError,
      helperError,
      resultReceived,
      code,
      signal
    });
    const combined = combineCleanupFailure(failure, cleanupError);
    settleOwnership();
    if (combined) {
      settleCompletion(combined);
      return;
    }
    if (!resultReceived) {
      settleCompletion(new DependencyGuardProtocolError(mode, "the helper closed without a result frame"));
      return;
    }
    settleCompletion(result as Result);
  });

  const unrefCommand = (): void => {
    if (unreferenced) return;
    unrefDependencyGuardProcess(child, guardStdio);
    unreferenced = true;
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      output?.dispose();
      const uncertainty = new DependencyGuardCommandTimeoutError(mode, executable, timeoutMs);
      try {
        if (!closed) unrefCommand();
        reject(uncertainty);
      } catch (error) {
        reject(
          new AggregateError(
            [uncertainty, error],
            `Open Wrangler could not release its unconfirmed dependency guard ${mode} process.`
          )
        );
      }
    }, timeoutMs);
    timer.unref();
  });
  const ownedCompletion = Promise.race([completion, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return {
    child,
    mode,
    executable,
    completion: ownedCompletion,
    ownershipReleased,
    didSpawn: () => spawned,
    didClose: () => closed,
    unref: unrefCommand
  };
}

interface DependencyGuardCommandCloseState {
  readonly mode: "status" | "validate";
  readonly executable: string;
  readonly spawned: boolean;
  readonly processError?: Error;
  readonly protocolError?: Error;
  readonly helperError?: DependencyGuardCommandError;
  readonly resultReceived: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function dependencyGuardCommandCloseFailure(state: DependencyGuardCommandCloseState): Error | undefined {
  if (state.processError) {
    return new Error(
      `Open Wrangler dependency guard ${state.mode} with ${state.executable} failed: ${state.processError.message}`
    );
  }
  if (!state.spawned) {
    return new Error(
      `Open Wrangler dependency guard ${state.mode} with ${state.executable} closed before spawn ownership was confirmed.`
    );
  }
  if (state.protocolError) return state.protocolError;
  if (state.helperError) {
    if (state.code !== state.helperError.exitCode || state.signal || state.resultReceived) {
      return new DependencyGuardProtocolError(
        state.mode,
        `error frame ${state.helperError.code} did not match ${dependencyGuardCloseDetail(state.code, state.signal)}`
      );
    }
    return state.helperError;
  }
  if (!state.resultReceived) {
    return new DependencyGuardProtocolError(state.mode, "the helper did not publish an exact result frame");
  }
  if (state.code === 0 && !state.signal) return undefined;
  return new DependencyGuardProtocolError(
    state.mode,
    `result frame did not match ${dependencyGuardCloseDetail(state.code, state.signal)}`
  );
}

function decodeDependencyGuardReady(frame: Record<string, unknown>, token: string): DependencyGuardReady {
  requireExactFrameKeys(frame, ["protocol", "kind", "token"], "install");
  if (
    frame.protocol !== DEPENDENCY_GUARD_PROTOCOL ||
    frame.kind !== "ready" ||
    frame.token !== token ||
    !isCanonicalUuid(frame.token)
  ) {
    throw new DependencyGuardProtocolError("install", "the helper published an invalid or mis-correlated READY frame");
  }
  return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "ready", token };
}

function decodeDependencyGuardStatus(frame: Record<string, unknown>): DependencyGuardStatus {
  requireExactFrameKeys(frame, ["protocol", "kind", "state", "token"], "status");
  if (frame.protocol !== DEPENDENCY_GUARD_PROTOCOL || frame.kind !== "status") {
    throw new DependencyGuardProtocolError("status", "the helper published an invalid status frame");
  }
  if (frame.state === "clean" && frame.token === null) {
    return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "status", state: "clean", token: null };
  }
  if (frame.state === "dirty" && typeof frame.token === "string" && isCanonicalUuid(frame.token)) {
    return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "status", state: "dirty", token: frame.token };
  }
  throw new DependencyGuardProtocolError("status", "the helper published an inconsistent status state/token pair");
}

function decodeDependencyGuardValidation(
  frame: Record<string, unknown>,
  expectedToken: string
): DependencyGuardValidation {
  requireExactFrameKeys(frame, ["protocol", "kind", "token"], "validate");
  if (
    frame.protocol !== DEPENDENCY_GUARD_PROTOCOL ||
    frame.kind !== "validated" ||
    typeof frame.token !== "string" ||
    !isCanonicalUuid(frame.token) ||
    frame.token !== expectedToken
  ) {
    throw new DependencyGuardProtocolError(
      "validate",
      "the helper published an invalid or mis-correlated validation frame"
    );
  }
  return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "validated", token: frame.token };
}

function decodeDependencyGuardError(
  frame: Record<string, unknown>,
  mode: DependencyGuardMode,
  executable: string
): DependencyGuardCommandError {
  requireExactFrameKeys(frame, ["protocol", "kind", "code"], mode);
  if (
    frame.protocol !== DEPENDENCY_GUARD_PROTOCOL ||
    frame.kind !== "error" ||
    typeof frame.code !== "string" ||
    !isDependencyGuardErrorCode(frame.code)
  ) {
    throw new DependencyGuardProtocolError(mode, "the helper published an invalid error frame");
  }
  return new DependencyGuardCommandError(mode, frame.code, executable);
}

function requireExactFrameKeys(
  frame: Record<string, unknown>,
  expected: readonly string[],
  mode: DependencyGuardMode
): void {
  const actual = Object.keys(frame);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(frame, key))) {
    throw new DependencyGuardProtocolError(mode, "the helper frame had an unexpected shape");
  }
}

function dependencyGuardEnvironmentWire(environment: PythonEnvironment): {
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
  pythonVersion: string;
} {
  return {
    executable: environment.executable,
    executableIdentity: {
      device: environment.executableIdentity.device,
      inode: environment.executableIdentity.inode,
      size: environment.executableIdentity.size,
      mtimeNs: environment.executableIdentity.mtimeNs,
      ctimeNs: environment.executableIdentity.ctimeNs
    },
    packageRoot: environment.packageRoot,
    packageRootIdentity: {
      device: environment.packageRootIdentity.device,
      inode: environment.packageRootIdentity.inode
    },
    pythonVersion: environment.version
  };
}

function dependencyGuardDependencyWire(dependency: PythonDependency): {
  importModule: string;
  distribution: string;
  installSpec: string;
  exactVersion: string | null;
  minimumVersion: string | null;
  maximumVersionExclusive: string | null;
} {
  return {
    importModule: dependency.importModule,
    distribution: dependency.distribution,
    installSpec: dependency.installSpec,
    exactVersion: dependency.exactVersion ?? null,
    minimumVersion: dependency.minimumVersion ?? null,
    maximumVersionExclusive: dependency.maximumVersionExclusive ?? null
  };
}

function validateGuardTarget(environment: PythonEnvironment, helperPath: string): void {
  if (!isFullyQualifiedPythonPath(environment.executable)) {
    throw new Error("Python dependency guard requires an absolute executable path.");
  }
  if (!isFullyQualifiedPythonPath(environment.packageRoot)) {
    throw new Error("Python dependency guard requires an absolute package-root path.");
  }
  if (!isFullyQualifiedPythonPath(helperPath)) {
    throw new Error("Python dependency guard requires an absolute helper path.");
  }
}

function validateTimeout(timeoutMs: number, label: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
}

function encodeDependencyGuardFrame(payload: unknown): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  if (encoded.length > DEPENDENCY_GUARD_MAX_FRAME_BYTES) {
    throw new Error(
      `Dependency guard request exceeds ${DEPENDENCY_GUARD_MAX_FRAME_BYTES} bytes including its LF terminator.`
    );
  }
  return encoded;
}

function dependencyGuardStdio(child: ChildProcess): (ChildProcess & { stdin: Writable; stdout: Readable }) | undefined {
  if (!child.stdin || !child.stdout) return undefined;
  return child as ChildProcess & { stdin: Writable; stdout: Readable };
}

interface UnrefableDependencyGuardPipe {
  readonly destroyed: boolean;
  unref(): void;
}

function unrefDependencyGuardProcess(
  child: ChildProcess,
  stdio: (ChildProcess & { stdin: Writable; stdout: Readable }) | undefined
): void {
  const failures: unknown[] = [];
  for (const [name, stream] of [
    ["stdin", stdio?.stdin],
    ["stdout", stdio?.stdout]
  ] as const) {
    if (!stream || stream.destroyed) continue;
    if (!isUnrefableDependencyGuardPipe(stream)) {
      failures.push(new Error(`Open Wrangler could not unreference dependency guard ${name}.`));
      continue;
    }
    try {
      stream.unref();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    child.unref();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Open Wrangler could not unreference every dependency guard process handle.");
  }
}

function isUnrefableDependencyGuardPipe(value: object): value is UnrefableDependencyGuardPipe {
  return "unref" in value && typeof value.unref === "function";
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isDependencyGuardErrorCode(value: string): value is DependencyGuardErrorCode {
  return Object.hasOwn(DEPENDENCY_GUARD_EXIT_CODES, value);
}

function dependencyGuardCloseDetail(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
}

function dependencyGuardProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = buildPythonProcessEnvironment(source);
  const allowedPipKeys = new Set([
    "PIP_CACHE_DIR",
    "PIP_CERT",
    "PIP_CLIENT_CERT",
    "PIP_DISABLE_PIP_VERSION_CHECK",
    "PIP_EXTRA_INDEX_URL",
    "PIP_INDEX_URL",
    "PIP_NO_CACHE_DIR",
    "PIP_PROXY",
    "PIP_RETRIES",
    "PIP_TIMEOUT",
    "PIP_TRUSTED_HOST"
  ]);
  const allowedPipValues = new Map<string, string>();
  const removedPythonKeys = new Set(["PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE"]);
  for (const key of Object.keys(environment)) {
    const normalized = key.toLocaleUpperCase("en-US");
    if (normalized.startsWith("PIP_")) {
      const value = environment[key];
      if (
        allowedPipKeys.has(normalized) &&
        value !== undefined &&
        (key === normalized || !allowedPipValues.has(normalized))
      ) {
        allowedPipValues.set(normalized, value);
      }
      delete environment[key];
      continue;
    }
    if (removedPythonKeys.has(normalized)) delete environment[key];
  }
  for (const [key, value] of allowedPipValues) environment[key] = value;
  environment.PIP_CONFIG_FILE = process.platform === "win32" ? "nul" : devNull;
  environment.PIP_NO_INPUT = "1";
  environment.PIP_USER = "0";
  return environment;
}

interface DependencyGuardWorkingDirectory {
  readonly cwd: string;
  cleanup(): Error | undefined;
}

function dependencyGuardWorkingDirectory(): DependencyGuardWorkingDirectory {
  const cwd = mkdtempSync(join(tmpdir(), "openwrangler-pip-"));
  try {
    chmodSync(cwd, 0o700);
  } catch (error) {
    try {
      rmdirSync(cwd);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Open Wrangler could not secure or clean its private dependency-install working directory."
      );
    }
    throw error;
  }
  let cleaned = false;
  return {
    cwd,
    cleanup: () => {
      if (cleaned) return undefined;
      cleaned = true;
      try {
        rmdirSync(cwd);
        return undefined;
      } catch (error) {
        return asError(error);
      }
    }
  };
}

function combineCleanupFailure(failure: Error | undefined, cleanupError: Error | undefined): Error | undefined {
  if (failure && cleanupError) {
    return new AggregateError(
      [failure, cleanupError],
      "Open Wrangler dependency guard and private working-directory cleanup both failed."
    );
  }
  return failure ?? cleanupError;
}

function throwWithSynchronousCleanup(error: unknown, cleanupError: Error | undefined, message: string): never {
  if (cleanupError) throw new AggregateError([error, cleanupError], message);
  throw error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
