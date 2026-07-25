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
  "getActiveEnvironmentPath" | "resolveEnvironment"
> & {
  readonly onDidChangeActiveEnvironmentPath?: PythonExtension["environments"]["onDidChangeActiveEnvironmentPath"];
};

export class PythonEnvironmentApiBroker implements vscode.Disposable {
  private api: PythonEnvironmentsApi | undefined;
  private activation: Promise<PythonEnvironmentsApi | undefined> | undefined;
  private selectionSubscription: vscode.Disposable | undefined;
  private disposed = false;

  constructor(
    private readonly onDidChangeSelection: (event: PythonEnvironmentSelectionChangeEvent) => unknown = () => undefined
  ) {}

  async resolveSelectedExecutable(resource?: PythonEnvironmentResource): Promise<string | undefined> {
    const api = await this.acquireApi();
    if (!api || this.disposed) return undefined;

    try {
      const selected: unknown = api.getActiveEnvironmentPath(resource);
      if (!isEnvironmentPath(selected)) return undefined;
      const resolved = await api.resolveEnvironment(selected);
      if (this.disposed) return undefined;
      const executable = resolved?.executable?.uri?.fsPath;
      return typeof executable === "string" && executable.trim() ? executable : selected.path;
    } catch {
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
    if (this.disposed) return Promise.resolve(undefined);
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
    const extension = vscode.extensions.getExtension<unknown>("ms-python.python");
    if (!extension) return undefined;

    let activated: unknown;
    try {
      const candidate = extension as vscode.Extension<unknown>;
      activated = candidate.isActive ? candidate.exports : await candidate.activate();
    } catch {
      return undefined;
    }
    if (this.disposed || !isPythonEnvironmentsApi(activated)) return undefined;

    const event = activated.environments.onDidChangeActiveEnvironmentPath;
    if (typeof event === "function") {
      let subscription: vscode.Disposable;
      try {
        subscription = event((selectionEvent) => {
          if (!this.disposed) this.onDidChangeSelection(selectionEvent);
        });
      } catch {
        return undefined;
      }
      if (!isDisposable(subscription)) return undefined;
      if (this.disposed) {
        subscription.dispose();
        return undefined;
      }
      this.selectionSubscription = subscription;
    }
    return activated.environments;
  }
}

export interface PythonEnvironment {
  executable: string;
  version: string;
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
    (candidate.onDidChangeActiveEnvironmentPath === undefined ||
      typeof candidate.onDidChangeActiveEnvironmentPath === "function")
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
      ["-c", "import json,sys; print(json.dumps(list(sys.version_info[:3])))"],
      { timeout: 10_000 }
    );
    stdout = result.stdout.trim();
  } catch (error) {
    throw new Error(`${executable} could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [major, minor, patch] = JSON.parse(stdout) as [number, number, number];
  if (!isSupportedPythonVersion(major, minor)) {
    throw new Error(`${executable} is Python ${major}.${minor}.${patch}; Open Wrangler requires Python 3.10-3.14.`);
  }
  return { executable, version: `${major}.${minor}.${patch}`, source };
}
