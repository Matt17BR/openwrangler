import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

export const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const DEPENDENCY_INSTALL_SHUTDOWN_WAIT_MS = 5_000;

export type DependencyInstallSpawner = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface OwnedDependencyInstall {
  readonly child: ChildProcess;
  readonly executable: string;
  readonly requirements: readonly string[];
  readonly exit: Promise<void>;
  readonly completion: Promise<void>;
  didSpawn(): boolean;
  unref(): void;
}

export interface StartDependencyInstallOptions {
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: DependencyInstallSpawner;
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
  executable: string,
  requirements: readonly string[],
  options: StartDependencyInstallOptions
): OwnedDependencyInstall {
  const environment = dependencyInstallEnvironment(options.environment ?? process.env);
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const workingDirectory = dependencyInstallWorkingDirectory();
  let child: ChildProcess;
  try {
    child = spawnProcess(executable, ["-I", "-m", "pip", "install", "--no-input", "--no-user", ...requirements], {
      cwd: workingDirectory.cwd,
      env: environment,
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
  } catch (error) {
    const cleanupError = workingDirectory.cleanup();
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Open Wrangler could not start dependency installation or clean its private working directory."
      );
    }
    throw error;
  }

  let spawned = false;
  let unreferenced = false;
  let exitSettled = false;
  let completionSettled = false;
  let processError: Error | undefined;
  let resolveExit!: () => void;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A timed-out caller deliberately stops awaiting semantic completion while
  // the exact close listener continues to own the child.
  void completion.catch(() => undefined);

  const settleExit = (): void => {
    if (exitSettled) return;
    exitSettled = true;
    resolveExit();
  };
  const settleCompletion = (error?: Error): void => {
    if (completionSettled) return;
    completionSettled = true;
    if (error) rejectCompletion(error);
    else resolveCompletion();
  };
  const settleCompletionWithCleanup = (error: Error | undefined, cleanupError: Error | undefined): void => {
    if (error && cleanupError) {
      settleCompletion(
        new AggregateError(
          [error, cleanupError],
          "Open Wrangler dependency installation and private working-directory cleanup both failed."
        )
      );
      return;
    }
    settleCompletion(error ?? cleanupError);
  };

  child.once("spawn", () => {
    spawned = true;
  });
  child.once("error", (error) => {
    processError = error;
    if (spawned) return;
    // Node's pre-spawn error proves that no package-writing process exists.
    settleExit();
    settleCompletionWithCleanup(
      new Error(`Open Wrangler could not start dependency installation with ${executable}: ${error.message}`),
      workingDirectory.cleanup()
    );
  });
  child.once("close", (code, signal) => {
    settleExit();
    const cleanupError = workingDirectory.cleanup();
    if (processError) {
      settleCompletionWithCleanup(
        new Error(`Open Wrangler dependency installation with ${executable} failed: ${processError.message}`),
        cleanupError
      );
      return;
    }
    if (!spawned) {
      settleCompletionWithCleanup(
        new Error(
          `Open Wrangler dependency installation with ${executable} closed before spawn ownership was confirmed.`
        ),
        cleanupError
      );
      return;
    }
    if (code === 0) {
      settleCompletionWithCleanup(undefined, cleanupError);
      return;
    }
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    settleCompletionWithCleanup(
      new Error(`Open Wrangler dependency installation with ${executable} ended with ${detail}.`),
      cleanupError
    );
  });

  return {
    child,
    executable,
    requirements: [...requirements],
    exit,
    completion,
    didSpawn: () => spawned,
    unref: () => {
      if (unreferenced) return;
      unreferenced = true;
      child.unref();
    }
  };
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

function dependencyInstallEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
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
  // pip compares this string with Python's os.devnull to disable every config
  // layer. Node spells the Windows device differently, so use Python's value.
  environment.PIP_CONFIG_FILE = process.platform === "win32" ? "nul" : devNull;
  environment.PIP_NO_INPUT = "1";
  environment.PIP_USER = "0";
  return environment;
}

interface DependencyInstallWorkingDirectory {
  readonly cwd: string;
  cleanup(): Error | undefined;
}

function dependencyInstallWorkingDirectory(): DependencyInstallWorkingDirectory {
  const cwd = mkdtempSync(join(tmpdir(), "openwrangler-pip-"));
  try {
    chmodSync(cwd, 0o700);
  } catch (error) {
    try {
      rmSync(cwd, { force: false, recursive: true });
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
        rmSync(cwd, { force: false, recursive: true });
        return undefined;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    }
  };
}
