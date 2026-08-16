import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type {
  ActiveEnvironmentPathChangeEvent,
  EnvironmentPath,
  PythonExtension,
  Resource
} from "@vscode/python-extension";
import { getSetting } from "./configuration";
import { isFullyQualifiedPythonPath, resolvePythonCommandPath, resolvePythonExecutable } from "./pythonPath";
import { isSupportedPythonVersion, type PythonDependency } from "./pythonEnvironmentModel";
import { buildPythonProcessEnvironment } from "./pythonProcessEnvironment";

export { automaticBackends, isSupportedPythonVersion, requiredDependencies } from "./pythonEnvironmentModel";

const execFileAsync = promisify(execFile);
export const PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS = 30_000;
export const PYTHON_ENVIRONMENT_COMMAND_TIMEOUT_MS = 10_000;
export const MAX_SYSTEM_PYTHON_CANDIDATES = 16;
const RESOLUTION_GUARD_POLL_INTERVAL_MS = 25;

export type PythonEnvironmentResource = Resource;
export type PythonEnvironmentSelectionChangeEvent = ActiveEnvironmentPathChangeEvent;

type PythonEnvironmentsApi = Pick<
  PythonExtension["environments"],
  "getActiveEnvironmentPath" | "resolveEnvironment" | "onDidChangeActiveEnvironmentPath"
>;

export abstract class PythonEnvironmentResolutionTerminalError extends Error {
  abstract readonly code: string;
}

export class PythonEnvironmentResolutionTimeoutError extends PythonEnvironmentResolutionTerminalError {
  readonly code = "python_environment_resolution_timeout";

  constructor() {
    super(
      `Python environment resolution exceeded its ${PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS} ms aggregate deadline.`
    );
    this.name = "PythonEnvironmentResolutionTimeoutError";
  }
}

export class PythonEnvironmentResolutionCancelledError extends PythonEnvironmentResolutionTerminalError {
  readonly code = "python_environment_resolution_cancelled";

  constructor() {
    super("Python environment resolution was cancelled before an interpreter was selected.");
    this.name = "PythonEnvironmentResolutionCancelledError";
  }
}

export class PythonEnvironmentResolutionSupersededError extends PythonEnvironmentResolutionTerminalError {
  readonly code = "python_environment_resolution_superseded";

  constructor() {
    super("Python environment resolution was superseded by a newer runtime selection.");
    this.name = "PythonEnvironmentResolutionSupersededError";
  }
}

export class PythonEnvironmentResolutionWorkspaceTrustError extends PythonEnvironmentResolutionTerminalError {
  readonly code = "python_environment_resolution_workspace_untrusted";

  constructor() {
    super("Python environment resolution stopped because the workspace is no longer trusted.");
    this.name = "PythonEnvironmentResolutionWorkspaceTrustError";
  }
}

export class PythonEnvironmentResolutionDisposedError extends PythonEnvironmentResolutionTerminalError {
  readonly code = "python_environment_resolution_disposed";

  constructor() {
    super("Python environment resolution stopped because its runtime bridge was disposed.");
    this.name = "PythonEnvironmentResolutionDisposedError";
  }
}

export class PythonEnvironmentApiBrokerDisposedError extends PythonEnvironmentResolutionTerminalError {
  readonly code = "python_environment_api_broker_disposed";

  constructor() {
    super("Python environment resolution was cancelled because its API broker was disposed.");
    this.name = "PythonEnvironmentApiBrokerDisposedError";
  }
}

export function isPythonEnvironmentResolutionTerminalError(
  error: unknown
): error is PythonEnvironmentResolutionTerminalError {
  return error instanceof PythonEnvironmentResolutionTerminalError;
}

export interface PythonEnvironmentResolutionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface PythonEnvironmentProcessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type PythonEnvironmentProcessExecutor = (
  executable: string,
  arguments_: readonly string[],
  options: PythonEnvironmentProcessOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface PythonEnvironmentResolutionControl {
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
  readonly isTrusted?: () => boolean;
  readonly clock?: PythonEnvironmentResolutionClock;
  readonly executeProcess?: PythonEnvironmentProcessExecutor;
  readonly environment?: NodeJS.ProcessEnv;
  readonly isExecutable?: (candidate: string) => boolean;
  readonly pathExists?: (candidate: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

const defaultResolutionClock: PythonEnvironmentResolutionClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle)
};

const defaultProcessExecutor: PythonEnvironmentProcessExecutor = async (executable, arguments_, options) => {
  const result = await execFileAsync(executable, [...arguments_], options);
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
};

export class PythonEnvironmentResolutionAttempt {
  private readonly deadline: number;
  private readonly clock: PythonEnvironmentResolutionClock;

  constructor(private readonly control: PythonEnvironmentResolutionControl) {
    this.clock = control.clock ?? defaultResolutionClock;
    this.deadline = this.clock.now() + PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS;
    this.assertActive();
  }

  get signal(): AbortSignal {
    return this.control.signal ?? neverAbortedSignal;
  }

  get processExecutor(): PythonEnvironmentProcessExecutor {
    return this.control.executeProcess ?? defaultProcessExecutor;
  }

  get environment(): NodeJS.ProcessEnv | undefined {
    return this.control.environment;
  }

  get executableCheck(): (candidate: string) => boolean {
    return this.control.isExecutable ?? isExecutableFile;
  }

  get pathExists(): (candidate: string) => boolean {
    return this.control.pathExists ?? existsSync;
  }

  get platform(): NodeJS.Platform {
    return this.control.platform ?? process.platform;
  }

  commandTimeout(): number {
    this.assertActive();
    return Math.max(1, Math.min(PYTHON_ENVIRONMENT_COMMAND_TIMEOUT_MS, Math.ceil(this.deadline - this.clock.now())));
  }

  assertActive(): void {
    if (this.signal.aborted) throw terminalAbortReason(this.signal, new PythonEnvironmentResolutionCancelledError());
    if (this.control.isTrusted?.() === false) {
      throw new PythonEnvironmentResolutionWorkspaceTrustError();
    }
    if (this.control.isCurrent?.() === false) {
      throw new PythonEnvironmentResolutionSupersededError();
    }
    if (this.clock.now() >= this.deadline) throw new PythonEnvironmentResolutionTimeoutError();
  }

  wait<T>(work: PromiseLike<T>, additionalSignal?: AbortSignal): Promise<T> {
    const workPromise = Promise.resolve(work);
    try {
      this.assertActive();
      if (additionalSignal?.aborted) {
        throw terminalAbortReason(additionalSignal, new PythonEnvironmentApiBrokerDisposedError());
      }
    } catch (error) {
      void workPromise.catch(() => undefined);
      throw error;
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) this.clock.clearTimeout(timer);
        this.signal.removeEventListener("abort", onControlAbort);
        additionalSignal?.removeEventListener("abort", onAdditionalAbort);
      };
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const rejectTerminal = (fallback: PythonEnvironmentResolutionTerminalError, signal?: AbortSignal): void => {
        settle(() => reject(signal ? terminalAbortReason(signal, fallback) : fallback));
      };
      const onControlAbort = (): void => rejectTerminal(new PythonEnvironmentResolutionCancelledError(), this.signal);
      const onAdditionalAbort = (): void =>
        rejectTerminal(new PythonEnvironmentApiBrokerDisposedError(), additionalSignal);
      const poll = (): void => {
        if (settled) return;
        try {
          this.assertActive();
          if (additionalSignal?.aborted) {
            rejectTerminal(new PythonEnvironmentApiBrokerDisposedError(), additionalSignal);
            return;
          }
          const remaining = Math.max(1, Math.ceil(this.deadline - this.clock.now()));
          timer = this.clock.setTimeout(poll, Math.min(RESOLUTION_GUARD_POLL_INTERVAL_MS, remaining));
        } catch (error) {
          settle(() => reject(error));
        }
      };

      this.signal.addEventListener("abort", onControlAbort, { once: true });
      additionalSignal?.addEventListener("abort", onAdditionalAbort, { once: true });
      poll();
      void workPromise.then(
        (value) => {
          try {
            this.assertActive();
            if (additionalSignal?.aborted) {
              rejectTerminal(new PythonEnvironmentApiBrokerDisposedError(), additionalSignal);
              return;
            }
            settle(() => resolve(value));
          } catch (error) {
            settle(() => reject(error));
          }
        },
        (error: unknown) => {
          try {
            this.assertActive();
            if (additionalSignal?.aborted) {
              rejectTerminal(new PythonEnvironmentApiBrokerDisposedError(), additionalSignal);
              return;
            }
            settle(() => reject(error));
          } catch (terminalError) {
            settle(() => reject(terminalError));
          }
        }
      );
    });
  }
}

const neverAbortedSignal = new AbortController().signal;

function terminalAbortReason(
  signal: AbortSignal,
  fallback: PythonEnvironmentResolutionTerminalError
): PythonEnvironmentResolutionTerminalError {
  return isPythonEnvironmentResolutionTerminalError(signal.reason) ? signal.reason : fallback;
}

export class PythonEnvironmentApiBroker implements vscode.Disposable {
  private api: PythonEnvironmentsApi | undefined;
  private activation: Promise<PythonEnvironmentsApi | undefined> | undefined;
  private selectionSubscription: vscode.Disposable | undefined;
  private readonly disposalController = new AbortController();
  private disposed = false;

  constructor(
    private readonly onDidChangeSelection: (event: PythonEnvironmentSelectionChangeEvent) => unknown = () => undefined
  ) {}

  async resolveSelectedExecutable(
    resource?: PythonEnvironmentResource,
    attempt: PythonEnvironmentResolutionAttempt = new PythonEnvironmentResolutionAttempt({})
  ): Promise<string | undefined> {
    this.throwIfDisposed();
    attempt.assertActive();
    const api = await attempt.wait(this.acquireApi(), this.disposalController.signal);
    this.throwIfDisposed();
    if (!api) return undefined;

    try {
      attempt.assertActive();
      const selected: unknown = api.getActiveEnvironmentPath(resource);
      if (!isEnvironmentPath(selected)) return undefined;
      attempt.assertActive();
      const resolved = await attempt.wait(api.resolveEnvironment(selected), this.disposalController.signal);
      this.throwIfDisposed();
      const executable = resolved?.executable?.uri?.fsPath;
      return typeof executable === "string" && executable.trim() ? executable : selected.path;
    } catch (error) {
      if (isPythonEnvironmentResolutionTerminalError(error)) throw error;
      this.throwIfDisposed();
      return undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalController.abort(new PythonEnvironmentApiBrokerDisposedError());
    const subscription = this.selectionSubscription;
    this.selectionSubscription = undefined;
    subscription?.dispose();
  }

  private acquireApi(): Promise<PythonEnvironmentsApi | undefined> {
    this.throwIfDisposed();
    if (this.api) return Promise.resolve(this.api);
    if (this.activation) return this.activation;

    const attempt = this.activateApi();
    this.activation = attempt;
    void attempt.then(
      (api) => {
        if (this.activation === attempt) this.activation = undefined;
        if (api && !this.disposed) this.api = api;
      },
      () => {
        if (this.activation === attempt) this.activation = undefined;
      }
    );
    return attempt;
  }

  private async activateApi(): Promise<PythonEnvironmentsApi | undefined> {
    this.throwIfDisposed();
    const extension = vscode.extensions.getExtension<unknown>("ms-python.python");
    if (!extension) return undefined;

    let activated: unknown;
    try {
      const candidate = extension as vscode.Extension<unknown>;
      activated = candidate.isActive ? candidate.exports : await candidate.activate();
    } catch (error) {
      if (error instanceof PythonEnvironmentApiBrokerDisposedError) throw error;
      this.throwIfDisposed();
      return undefined;
    }
    this.throwIfDisposed();
    if (!isPythonEnvironmentsApi(activated)) return undefined;

    const event = activated.environments.onDidChangeActiveEnvironmentPath;
    let subscription: vscode.Disposable;
    try {
      subscription = event((selectionEvent) => {
        if (!this.disposed) this.onDidChangeSelection(selectionEvent);
      });
    } catch {
      this.throwIfDisposed();
      return undefined;
    }
    if (!isDisposable(subscription)) return undefined;
    if (this.disposed) {
      subscription.dispose();
      this.throwIfDisposed();
    }
    this.selectionSubscription = subscription;
    return activated.environments;
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new PythonEnvironmentApiBrokerDisposedError();
  }
}

export interface PythonEnvironment {
  executable: string;
  executableIdentity: PythonExecutableIdentity;
  version: string;
  packageRoot: string;
  packageRootIdentity: PythonPackageRootIdentity;
  source: "configuration" | "pythonExtension" | "system";
}

export interface PythonExecutableIdentity {
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface PythonPackageRootIdentity {
  device: string;
  inode: string;
}

export interface DependencyProbe {
  missing: string[];
  available: string[];
}

export async function resolvePythonEnvironment(
  context: vscode.ExtensionContext,
  resource?: vscode.Uri,
  apiBroker?: PythonEnvironmentApiBroker,
  control: PythonEnvironmentResolutionControl = {}
): Promise<PythonEnvironment> {
  const attempt = new PythonEnvironmentResolutionAttempt(control);
  const configured = getSetting("pythonPath", "", resource).trim();
  if (configured) {
    attempt.assertActive();
    const executable = resolvePythonExecutable(
      configured,
      vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
      context.extensionPath,
      attempt.pathExists
    );
    return probeEnvironment(executable, "configuration", attempt);
  }

  const broker = apiBroker ?? new PythonEnvironmentApiBroker();
  const ownsBroker = apiBroker === undefined;
  try {
    const executable = await broker.resolveSelectedExecutable(resource, attempt);
    if (executable) {
      try {
        return await probeEnvironment(executable, "pythonExtension", attempt);
      } catch (error) {
        if (isPythonEnvironmentResolutionTerminalError(error)) throw error;
        // Fall through to system interpreters. Diagnostics are surfaced if every candidate fails.
      }
    }
  } finally {
    if (ownsBroker) broker.dispose();
  }

  let candidates: Array<{ executable: string; arguments: readonly string[] }>;
  try {
    attempt.assertActive();
    candidates =
      attempt.platform === "win32"
        ? (await discoverWindowsSystemPythonExecutablesWithinAttempt(attempt)).map((executable) => ({
            executable,
            arguments: []
          }))
        : [
            { executable: "python3", arguments: [] },
            { executable: "python", arguments: [] }
          ];
  } catch (error) {
    if (isPythonEnvironmentResolutionTerminalError(error)) throw error;
    throw new Error(
      `No compatible Python 3.10-3.14 interpreter was found. Windows Python discovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const failures: string[] = [];
  for (const candidate of candidates) {
    attempt.assertActive();
    try {
      return await probeEnvironment(candidate.executable, "system", attempt, candidate.arguments);
    } catch (error) {
      if (isPythonEnvironmentResolutionTerminalError(error)) throw error;
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  attempt.assertActive();
  throw new Error(`No compatible Python 3.10-3.14 interpreter was found. ${failures.join(" ")}`);
}

export interface WindowsPythonDiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly isExecutable?: (candidate: string) => boolean;
  readonly executeLauncher?: (
    executable: string,
    arguments_: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      maxBuffer: number;
      shell: false;
      signal: AbortSignal;
      timeout: number;
      windowsHide: true;
    }
  ) => Promise<{ stdout: string; stderr: string }>;
}

export async function discoverWindowsSystemPythonExecutables(
  options: WindowsPythonDiscoveryOptions = {}
): Promise<string[]> {
  const attempt = new PythonEnvironmentResolutionAttempt({
    environment: options.environment,
    isExecutable: options.isExecutable,
    executeProcess: options.executeLauncher
  });
  return discoverWindowsSystemPythonExecutablesWithinAttempt(attempt);
}

async function discoverWindowsSystemPythonExecutablesWithinAttempt(
  attempt: PythonEnvironmentResolutionAttempt
): Promise<string[]> {
  attempt.assertActive();
  const environment = buildPythonProcessEnvironment(attempt.environment);
  const executableCheck = attempt.executableCheck;
  const launcher = resolvePythonCommandPath("py", environment, executableCheck, "win32");
  if (!launcher) return [];
  let stdout: string;
  let stderr: string;
  try {
    const result = await attempt.wait(
      attempt.processExecutor(launcher, ["-0p"], {
        env: {
          ...environment,
          PYLAUNCHER_NO_SEARCH_PATH: "1",
          PYTHON_MANAGER_AUTOMATIC_INSTALL: "0"
        },
        maxBuffer: 256 * 1024,
        shell: false,
        signal: attempt.signal,
        timeout: attempt.commandTimeout(),
        windowsHide: true
      })
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    if (isPythonEnvironmentResolutionTerminalError(error)) throw error;
    throw new Error(
      `the Python launcher could not list installed runtimes: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  attempt.assertActive();
  return parseWindowsPythonLauncherOutput(`${stdout}\n${stderr}`)
    .slice(0, MAX_SYSTEM_PYTHON_CANDIDATES)
    .filter((candidate) => {
      attempt.assertActive();
      return executableCheck(candidate);
    });
}

export function parseWindowsPythonLauncherOutput(output: string): string[] {
  const candidates: Array<{ executable: string; minor: number; freeThreaded: boolean }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^\s*-(?:V:)?(?:(?:PythonCore)[\\/])?3\.(10|11|12|13|14)(t?)(?:-[A-Za-z0-9]+)?(?:\s+\*)?\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    let executable = match[3]?.trim() ?? "";
    if (executable.endsWith("*")) executable = executable.slice(0, -1).trimEnd();
    if (executable.startsWith('"') || executable.endsWith('"')) {
      const quoted = /^"([^"]+)"$/.exec(executable);
      if (!quoted) continue;
      executable = quoted[1] ?? "";
    }
    if (!isFullyQualifiedWindowsExecutable(executable)) continue;
    candidates.push({
      executable: path.win32.normalize(executable),
      minor: Number.parseInt(match[1] ?? "", 10),
      freeThreaded: (match[2] ?? "").toLocaleLowerCase("en-US") === "t"
    });
  }
  candidates.sort(
    (left, right) =>
      right.minor - left.minor ||
      Number(left.freeThreaded) - Number(right.freeThreaded) ||
      compareWindowsPaths(left.executable, right.executable)
  );
  const seen = new Set<string>();
  return candidates
    .map(({ executable }) => executable)
    .filter((executable) => {
      const key = executable.toLocaleLowerCase("en-US");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isEnvironmentPath(value: unknown): value is EnvironmentPath {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; path?: unknown };
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.path === "string" &&
    candidate.path.trim().length > 0
  );
}

function isPythonEnvironmentsApi(value: unknown): value is { environments: PythonEnvironmentsApi } {
  if (!value || typeof value !== "object") return false;
  const environments = (value as { environments?: unknown }).environments;
  if (!environments || typeof environments !== "object") return false;
  const candidate = environments as {
    getActiveEnvironmentPath?: unknown;
    resolveEnvironment?: unknown;
    onDidChangeActiveEnvironmentPath?: unknown;
  };
  return (
    typeof candidate.getActiveEnvironmentPath === "function" &&
    typeof candidate.resolveEnvironment === "function" &&
    typeof candidate.onDidChangeActiveEnvironmentPath === "function"
  );
}

function isDisposable(value: unknown): value is vscode.Disposable {
  return Boolean(value && typeof value === "object" && typeof (value as { dispose?: unknown }).dispose === "function");
}

export async function probeDependencies(
  executable: string,
  dependencies: readonly PythonDependency[]
): Promise<DependencyProbe> {
  if (dependencies.length === 0) return { missing: [], available: [] };
  if (!isFullyQualifiedPythonPath(executable)) {
    throw new Error("Python dependency probing requires an absolute executable path.");
  }
  const program = [
    "import importlib.metadata,importlib.util,json",
    `deps=${JSON.stringify(dependencies)}`,
    "out={}",
    "for d in deps:",
    " found=importlib.util.find_spec(d['importModule']) is not None",
    " try: version=importlib.metadata.version(d['distribution']) if found else None",
    " except importlib.metadata.PackageNotFoundError: version=None",
    " out[d['importModule']]={'found':found,'version':version}",
    "print(json.dumps(out))"
  ].join("\n");
  const { stdout } = await execFileAsync(executable, ["-I", "-c", program], {
    env: buildPythonProcessEnvironment(),
    shell: false,
    timeout: 10_000,
    windowsHide: true
  });
  const result = JSON.parse(stdout.trim()) as Record<string, { found: boolean; version?: string }>;
  return classifyDependencyProbe(dependencies, result);
}

export function classifyDependencyProbe(
  dependencies: readonly PythonDependency[],
  result: Readonly<Record<string, { found: boolean; version?: string }>>
): DependencyProbe {
  const supported = (dependency: PythonDependency): boolean => {
    const observed = result[dependency.importModule];
    if (!observed?.found) return false;
    if (dependency.exactVersion && observed.version !== dependency.exactVersion) return false;
    if (dependency.minimumVersion && compareVersions(observed.version, dependency.minimumVersion) < 0) return false;
    if (
      dependency.maximumVersionExclusive &&
      compareVersions(observed.version, dependency.maximumVersionExclusive) >= 0
    ) {
      return false;
    }
    return true;
  };
  return {
    missing: dependencies.filter((dependency) => !supported(dependency)).map((dependency) => dependency.installSpec),
    available: dependencies.filter(supported).map((dependency) => dependency.importModule)
  };
}

function compareVersions(observed: string | undefined, expected: string): number {
  if (!observed) return -1;
  const parts = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(observed);
  const right = parts(expected);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function probeEnvironment(
  executable: string,
  source: PythonEnvironment["source"],
  attempt: PythonEnvironmentResolutionAttempt,
  launcherArguments: readonly string[] = []
): Promise<PythonEnvironment> {
  attempt.assertActive();
  const processEnvironment = buildPythonProcessEnvironment(attempt.environment);
  const resolvedExecutable = resolvePythonCommandPath(
    executable,
    processEnvironment,
    attempt.executableCheck,
    attempt.platform
  );
  if (!resolvedExecutable) {
    throw new Error(`${executable} could not be resolved to an absolute executable.`);
  }
  const initial = await executeEnvironmentProbe(resolvedExecutable, processEnvironment, attempt, launcherArguments);
  const reportedExecutable = platformPath(attempt.platform).normalize(initial.executable);
  const result = sameExecutablePath(resolvedExecutable, reportedExecutable, attempt.platform)
    ? initial
    : await executeEnvironmentProbe(reportedExecutable, processEnvironment, attempt);
  if (!sameExecutablePath(result.executable, reportedExecutable, attempt.platform)) {
    throw new Error(`${executable} did not resolve to a stable Python executable.`);
  }
  const { version, executableIdentity, packageRoot, packageRootIdentity } = result;
  const [major, minor, patch] = version;
  if (!isSupportedPythonVersion(major, minor)) {
    throw new Error(
      `${reportedExecutable} is Python ${major}.${minor}.${patch}; Open Wrangler requires Python 3.10-3.14.`
    );
  }
  return {
    executable: reportedExecutable,
    executableIdentity,
    version: `${major}.${minor}.${patch}`,
    packageRoot,
    packageRootIdentity,
    source
  };
}

async function executeEnvironmentProbe(
  executable: string,
  processEnvironment: NodeJS.ProcessEnv,
  attempt: PythonEnvironmentResolutionAttempt,
  launcherArguments: readonly string[] = []
): Promise<ReturnType<typeof decodePythonEnvironmentProbeOutput>> {
  let stdout: string;
  try {
    const program = [
      "import json,os,stat,sys",
      "executable=os.path.abspath(sys.executable)",
      "executable_stat=os.stat(executable)",
      "if not stat.S_ISREG(executable_stat.st_mode): raise RuntimeError('Python executable is not a regular file')",
      "package_root=os.path.realpath(os.path.abspath(sys.prefix))",
      "package_root_stat=os.stat(package_root)",
      "print(json.dumps({",
      " 'executable':executable,",
      " 'executableIdentity':{",
      "  'device':str(executable_stat.st_dev),",
      "  'inode':str(executable_stat.st_ino),",
      "  'size':str(executable_stat.st_size),",
      "  'mtimeNs':str(executable_stat.st_mtime_ns),",
      "  'ctimeNs':str(executable_stat.st_ctime_ns),",
      " },",
      " 'version':list(sys.version_info[:3]),",
      " 'packageRoot':package_root,",
      " 'packageRootIdentity':{",
      "  'device':str(package_root_stat.st_dev),",
      "  'inode':str(package_root_stat.st_ino),",
      " },",
      "},separators=(',',':')))"
    ].join("\n");
    const result = await attempt.wait(
      attempt.processExecutor(executable, [...launcherArguments, "-I", "-c", program], {
        env: processEnvironment,
        maxBuffer: 1024 * 1024,
        shell: false,
        signal: attempt.signal,
        timeout: attempt.commandTimeout(),
        windowsHide: true
      })
    );
    stdout = result.stdout.trim();
  } catch (error) {
    if (isPythonEnvironmentResolutionTerminalError(error)) throw error;
    throw new Error(`${executable} could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  attempt.assertActive();
  return decodePythonEnvironmentProbeOutput(stdout, attempt.platform);
}

export function decodePythonEnvironmentProbeOutput(
  stdout: string,
  platform: NodeJS.Platform = process.platform
): {
  executable: string;
  executableIdentity: PythonExecutableIdentity;
  version: [number, number, number];
  packageRoot: string;
  packageRootIdentity: PythonPackageRootIdentity;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    throw new Error("Python environment probe did not return valid JSON.");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Python environment probe returned an invalid payload.");
  }
  const candidate = decoded as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== "executable" ||
    keys[1] !== "executableIdentity" ||
    keys[2] !== "packageRoot" ||
    keys[3] !== "packageRootIdentity" ||
    keys[4] !== "version"
  ) {
    throw new Error("Python environment probe returned an invalid payload.");
  }
  if (
    typeof candidate.executable !== "string" ||
    !isFullyQualifiedPythonPath(candidate.executable, platform) ||
    candidate.executable.includes("\0")
  ) {
    throw new Error("Python environment probe returned an invalid executable.");
  }
  const executableIdentity = decodePythonExecutableIdentity(candidate.executableIdentity);
  const version = candidate.version;
  if (
    !Array.isArray(version) ||
    version.length !== 3 ||
    !version.every((part) => Number.isSafeInteger(part) && (part as number) >= 0)
  ) {
    throw new Error("Python environment probe returned an invalid version.");
  }
  if (
    typeof candidate.packageRoot !== "string" ||
    candidate.packageRoot.trim().length === 0 ||
    !isFullyQualifiedPythonPath(candidate.packageRoot, platform) ||
    candidate.packageRoot.includes("\0")
  ) {
    throw new Error("Python environment probe returned an invalid package root.");
  }
  const packageRootIdentity = decodePythonPackageRootIdentity(candidate.packageRootIdentity);
  return {
    executable: platformPath(platform).normalize(candidate.executable),
    executableIdentity,
    version: [version[0] as number, version[1] as number, version[2] as number],
    packageRoot: candidate.packageRoot,
    packageRootIdentity
  };
}

function decodePythonExecutableIdentity(value: unknown): PythonExecutableIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Python environment probe returned an invalid executable identity.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== "ctimeNs" ||
    keys[1] !== "device" ||
    keys[2] !== "inode" ||
    keys[3] !== "mtimeNs" ||
    keys[4] !== "size"
  ) {
    throw new Error("Python environment probe returned an invalid executable identity.");
  }
  if (
    !isCanonicalDeviceInteger(candidate.device) ||
    !isCanonicalInodeInteger(candidate.inode) ||
    !isCanonicalUnsigned128Integer(candidate.size) ||
    !isCanonicalSigned128Integer(candidate.mtimeNs) ||
    !isCanonicalSigned128Integer(candidate.ctimeNs)
  ) {
    throw new Error("Python environment probe returned an invalid executable identity.");
  }
  if (
    (candidate.device === "0" && candidate.inode === "0") ||
    candidate.size === "0" ||
    (candidate.mtimeNs === "0" && candidate.ctimeNs === "0")
  ) {
    throw new Error("Python environment probe returned an invalid executable identity.");
  }
  return {
    device: candidate.device,
    inode: candidate.inode,
    size: candidate.size,
    mtimeNs: candidate.mtimeNs,
    ctimeNs: candidate.ctimeNs
  };
}

function decodePythonPackageRootIdentity(value: unknown): PythonPackageRootIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Python environment probe returned an invalid package root identity.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== 2 || keys[0] !== "device" || keys[1] !== "inode") {
    throw new Error("Python environment probe returned an invalid package root identity.");
  }
  if (!isCanonicalDeviceInteger(candidate.device) || !isCanonicalInodeInteger(candidate.inode)) {
    throw new Error("Python environment probe returned an invalid package root identity.");
  }
  if (candidate.device === "0" && candidate.inode === "0") {
    throw new Error("Python environment probe returned an invalid package root identity.");
  }
  return {
    device: candidate.device,
    inode: candidate.inode
  };
}

function isCanonicalDeviceInteger(value: unknown): value is string {
  return (
    typeof value === "string" && /^(?:0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

function isCanonicalInodeInteger(value: unknown): value is string {
  return isCanonicalUnsigned128Integer(value);
}

function isCanonicalUnsigned128Integer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d{0,38})$/.test(value) &&
    BigInt(value) <= 340_282_366_920_938_463_463_374_607_431_768_211_455n
  );
}

function isCanonicalSigned128Integer(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|-?[1-9]\d{0,38})$/.test(value)) return false;
  const decoded = BigInt(value);
  return (
    decoded >= -170_141_183_460_469_231_731_687_303_715_884_105_728n &&
    decoded <= 170_141_183_460_469_231_731_687_303_715_884_105_727n
  );
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sameExecutablePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const pathApi = platformPath(platform);
  const normalizedLeft = pathApi.normalize(left);
  const normalizedRight = pathApi.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function compareWindowsPaths(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase("en-US");
  const normalizedRight = right.toLocaleLowerCase("en-US");
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function isFullyQualifiedWindowsExecutable(candidate: string): boolean {
  return (
    isFullyQualifiedPythonPath(candidate, "win32") &&
    path.win32.extname(candidate).toLocaleLowerCase("en-US") === ".exe" &&
    !candidate.includes("\0")
  );
}
