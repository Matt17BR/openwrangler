import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type {
  ActiveEnvironmentPathChangeEvent,
  EnvironmentPath,
  PythonExtension,
  Resource
} from "@vscode/python-extension";
import { getSetting } from "./configuration";
import { resolvePythonExecutable } from "./pythonPath";
import { isSupportedPythonVersion, type PythonDependency } from "./pythonEnvironmentModel";

export { automaticBackends, isSupportedPythonVersion, requiredDependencies } from "./pythonEnvironmentModel";

const execFileAsync = promisify(execFile);

export type PythonEnvironmentResource = Resource;
export type PythonEnvironmentSelectionChangeEvent = ActiveEnvironmentPathChangeEvent;

type PythonEnvironmentsApi = Pick<
  PythonExtension["environments"],
  "getActiveEnvironmentPath" | "resolveEnvironment" | "onDidChangeActiveEnvironmentPath"
>;

export class PythonEnvironmentApiBrokerDisposedError extends Error {
  readonly code = "python_environment_api_broker_disposed";

  constructor() {
    super("Python environment resolution was cancelled because its API broker was disposed.");
    this.name = "PythonEnvironmentApiBrokerDisposedError";
  }
}

export class PythonEnvironmentApiBroker implements vscode.Disposable {
  private api: PythonEnvironmentsApi | undefined;
  private activation: Promise<PythonEnvironmentsApi | undefined> | undefined;
  private selectionSubscription: vscode.Disposable | undefined;
  private disposed = false;

  constructor(
    private readonly onDidChangeSelection: (event: PythonEnvironmentSelectionChangeEvent) => unknown = () => undefined
  ) {}

  async resolveSelectedExecutable(resource?: PythonEnvironmentResource): Promise<string | undefined> {
    this.throwIfDisposed();
    const api = await this.acquireApi();
    this.throwIfDisposed();
    if (!api) return undefined;

    try {
      const selected: unknown = api.getActiveEnvironmentPath(resource);
      if (!isEnvironmentPath(selected)) return undefined;
      const resolved = await api.resolveEnvironment(selected);
      this.throwIfDisposed();
      const executable = resolved?.executable?.uri?.fsPath;
      return typeof executable === "string" && executable.trim() ? executable : selected.path;
    } catch (error) {
      if (error instanceof PythonEnvironmentApiBrokerDisposedError) throw error;
      this.throwIfDisposed();
      return undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
  version: string;
  packageRoot: string;
  source: "configuration" | "pythonExtension" | "system";
}

export interface DependencyProbe {
  missing: string[];
  available: string[];
}

export async function resolvePythonEnvironment(
  context: vscode.ExtensionContext,
  resource?: vscode.Uri,
  apiBroker?: PythonEnvironmentApiBroker
): Promise<PythonEnvironment> {
  const configured = getSetting("pythonPath", "", resource).trim();
  if (configured) {
    const executable = resolvePythonExecutable(
      configured,
      vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
      context.extensionPath,
      existsSync
    );
    return probeEnvironment(executable, "configuration");
  }

  const broker = apiBroker ?? new PythonEnvironmentApiBroker();
  const ownsBroker = apiBroker === undefined;
  try {
    const executable = await broker.resolveSelectedExecutable(resource);
    if (executable) {
      try {
        return await probeEnvironment(executable, "pythonExtension");
      } catch {
        // Fall through to system interpreters. Diagnostics are surfaced if every candidate fails.
      }
    }
  } finally {
    if (ownsBroker) broker.dispose();
  }

  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await probeEnvironment(candidate, "system");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`No compatible Python 3.10-3.14 interpreter was found. ${failures.join(" ")}`);
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
  const { stdout } = await execFileAsync(executable, ["-c", program], { timeout: 10_000 });
  const result = JSON.parse(stdout.trim()) as Record<string, { found: boolean; version?: string }>;
  const supported = (dependency: PythonDependency): boolean => {
    const observed = result[dependency.importModule];
    if (!observed?.found) return false;
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

async function probeEnvironment(executable: string, source: PythonEnvironment["source"]): Promise<PythonEnvironment> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      executable,
      ["-c", "import json,sys; print(json.dumps({'version':list(sys.version_info[:3]),'packageRoot':sys.prefix}))"],
      { timeout: 10_000 }
    );
    stdout = result.stdout.trim();
  } catch (error) {
    throw new Error(`${executable} could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { version, packageRoot } = decodePythonEnvironmentProbeOutput(stdout);
  const [major, minor, patch] = version;
  if (!isSupportedPythonVersion(major, minor)) {
    throw new Error(`${executable} is Python ${major}.${minor}.${patch}; Open Wrangler requires Python 3.10-3.14.`);
  }
  return { executable, version: `${major}.${minor}.${patch}`, packageRoot, source };
}

export function decodePythonEnvironmentProbeOutput(stdout: string): {
  version: [number, number, number];
  packageRoot: string;
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
  if (keys.length !== 2 || keys[0] !== "packageRoot" || keys[1] !== "version") {
    throw new Error("Python environment probe returned an invalid payload.");
  }
  const version = candidate.version;
  if (
    !Array.isArray(version) ||
    version.length !== 3 ||
    !version.every((part) => Number.isSafeInteger(part) && (part as number) >= 0)
  ) {
    throw new Error("Python environment probe returned an invalid version.");
  }
  if (typeof candidate.packageRoot !== "string" || candidate.packageRoot.trim().length === 0) {
    throw new Error("Python environment probe returned an invalid package root.");
  }
  return {
    version: [version[0] as number, version[1] as number, version[2] as number],
    packageRoot: candidate.packageRoot
  };
}
