import * as path from "node:path";
import * as vscode from "vscode";
import type { CancellationTokenLike } from "../dataBridge";

const SCRIPT_ENVIRONMENT_KEY = "OPEN_WRANGLER_R_DEPENDENCY_SCRIPT";
const STARTUP_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 30_000;
const SCRIPT_BOOTSTRAP =
  `base::sys.source(base::Sys.getenv("${SCRIPT_ENVIRONMENT_KEY}"), ` +
  "envir = base::globalenv(), keep.source = FALSE)";

export interface RDependencyProcessOptions {
  readonly rscriptPath: string;
  readonly scriptPath: string;
  /** Its scheme and authority must identify the host that owns Rscript. */
  readonly cwd: vscode.Uri;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly mode: "probe" | "install";
  readonly cancellation?: CancellationTokenLike;
  readonly startupTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
}

export interface RDependencyProcess {
  /** Cancellation or a deadline can reject before VS Code closes the terminal. */
  readonly completion: Promise<void>;
  /** Retain private files and writer ownership until this exact terminal closes. */
  readonly settlement: Promise<void>;
}

/** Uses VS Code's process lifetime without shell commands or task-triggered editor saves. */
export function startRDependencyProcess(options: RDependencyProcessOptions): RDependencyProcess {
  validatePath(options.rscriptPath, "Rscript", true);
  validatePath(options.scriptPath, "dependency script", false);
  validatePath(options.cwd.fsPath, "working directory", true);
  if (
    (options.cwd.scheme !== "file" && options.cwd.scheme !== "vscode-remote") ||
    (options.cwd.scheme === "vscode-remote" && !options.cwd.authority)
  ) {
    throw new Error("The R dependency process requires a captured local or remote host directory.");
  }
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  validateTimeout(startupTimeoutMs);
  validateTimeout(probeTimeoutMs);
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before checking or installing R packages.");

  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  let resolveSettlement!: () => void;
  const settlement = new Promise<void>((resolve) => {
    resolveSettlement = resolve;
  });
  const result = { completion, settlement };
  let terminal: vscode.Terminal | undefined;
  let closed = false;
  let completed = false;
  let stopRequested = false;
  let failure: Error | undefined;
  let startupTimer: NodeJS.Timeout | undefined;
  let probeTimer: NodeJS.Timeout | undefined;
  let cancellationSubscription: { dispose(): void } | undefined;

  const clearTimers = (): void => {
    if (startupTimer) clearTimeout(startupTimer);
    if (probeTimer) clearTimeout(probeTimer);
    startupTimer = undefined;
    probeTimer = undefined;
  };
  const complete = (): void => {
    if (completed) return;
    completed = true;
    if (failure) rejectCompletion(failure);
    else resolveCompletion();
  };
  const fail = (error: Error): void => {
    if (closed) return;
    failure ??= error;
    clearTimers();
    // Once authorized, an installation belongs to its visible terminal. Closing
    // a panel only detaches its waiter; only a read-only probe is stopped here.
    if (terminal && options.mode === "probe" && !stopRequested) {
      stopRequested = true;
      try {
        terminal.dispose();
      } catch (stopError) {
        failure = new AggregateError([failure, stopError], "Open Wrangler could not stop its R dependency probe.");
      }
    }
    complete();
  };

  if (options.cancellation?.isCancellationRequested) {
    failure = new Error("The R dependency operation was cancelled before it started.");
    complete();
    resolveSettlement();
    return result;
  }

  const closeSubscription = vscode.window.onDidCloseTerminal((candidate) => {
    if (!terminal || candidate !== terminal || closed) return;
    closed = true;
    clearTimers();
    closeSubscription.dispose();
    cancellationSubscription?.dispose();
    cancellationSubscription = undefined;
    const status = candidate.exitStatus;
    if (!failure && (status?.reason !== vscode.TerminalExitReason.Process || status.code !== 0)) {
      failure = new Error(
        status?.reason === vscode.TerminalExitReason.Process && status.code !== undefined
          ? `The R dependency ${options.mode} process exited with code ${status.code}.`
          : `The R dependency ${options.mode} terminal closed without a confirmed successful process exit.`
      );
    }
    complete();
    resolveSettlement();
  });

  try {
    terminal = vscode.window.createTerminal({
      name: options.mode === "probe" ? "Open Wrangler: check R packages" : "Open Wrangler: install R packages",
      shellPath: options.rscriptPath,
      shellArgs: ["--vanilla", "-e", SCRIPT_BOOTSTRAP],
      cwd: options.cwd,
      env: { ...options.environment, [SCRIPT_ENVIRONMENT_KEY]: options.scriptPath },
      strictEnv: true,
      hideFromUser: options.mode === "probe",
      isTransient: true
    });
  } catch (error) {
    closeSubscription.dispose();
    failure = error instanceof Error ? error : new Error(String(error));
    complete();
    resolveSettlement();
    return result;
  }

  startupTimer = setTimeout(
    () =>
      fail(
        new Error("VS Code did not confirm that the R dependency process started. Check its terminal before retrying.")
      ),
    startupTimeoutMs
  );
  startupTimer.unref();
  if (options.mode === "probe") {
    probeTimer = setTimeout(() => fail(new Error("The R dependency probe exceeded its time limit.")), probeTimeoutMs);
    probeTimer.unref();
  }
  cancellationSubscription = options.cancellation?.onCancellationRequested(() =>
    fail(new Error("The R dependency operation was cancelled."))
  );
  if (options.cancellation?.isCancellationRequested) fail(new Error("The R dependency operation was cancelled."));

  void Promise.resolve(terminal.processId).then(
    (pid) => {
      if (closed || failure) return;
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = undefined;
      if (!Number.isSafeInteger(pid) || !pid || pid <= 0) {
        fail(new Error("VS Code did not report a process identity for the R dependency terminal."));
      }
    },
    () => fail(new Error("VS Code could not confirm the R dependency process identity."))
  );
  if (options.mode === "install") {
    try {
      terminal.show(true);
    } catch (error) {
      fail(new Error("VS Code could not show the R package installation terminal.", { cause: error }));
    }
  }
  return result;
}

function validatePath(value: string, label: string, rejectVariables: boolean): void {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`The R dependency ${label} path must be absolute and contain no NUL bytes.`);
  }
  if (rejectVariables && value.includes("${")) {
    throw new Error(`The R dependency ${label} path contains unsupported VS Code variable syntax.`);
  }
}

function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("The R dependency process timeout must be positive.");
}
