import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

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
  const child = spawnProcess(executable, ["-m", "pip", "install", "--no-input", ...requirements], {
    cwd: options.cwd,
    env: environment,
    shell: false,
    stdio: "ignore",
    windowsHide: true
  });

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

  child.once("spawn", () => {
    spawned = true;
  });
  child.once("error", (error) => {
    processError = error;
    if (spawned) return;
    // Node's pre-spawn error proves that no package-writing process exists.
    settleExit();
    settleCompletion(
      new Error(`Open Wrangler could not start dependency installation with ${executable}: ${error.message}`)
    );
  });
  child.once("close", (code, signal) => {
    settleExit();
    if (processError) {
      settleCompletion(
        new Error(`Open Wrangler dependency installation with ${executable} failed: ${processError.message}`)
      );
      return;
    }
    if (!spawned) {
      settleCompletion(
        new Error(
          `Open Wrangler dependency installation with ${executable} closed before spawn ownership was confirmed.`
        )
      );
      return;
    }
    if (code === 0) {
      settleCompletion();
      return;
    }
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    settleCompletion(new Error(`Open Wrangler dependency installation with ${executable} ended with ${detail}.`));
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
  const environment: NodeJS.ProcessEnv = { ...source, PIP_NO_INPUT: "1" };
  for (const key of Object.keys(environment)) {
    const normalized = key.toLocaleUpperCase("en-US");
    if (normalized === "PYTHONPATH" || normalized === "PYTHONHOME") delete environment[key];
  }
  return environment;
}
