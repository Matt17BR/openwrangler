import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getSetting } from "./configuration";
import { resolvePythonExecutable } from "./pythonPath";
import { isSupportedPythonVersion, type PythonDependency } from "./pythonEnvironmentModel";

export { automaticBackends, isSupportedPythonVersion, requiredDependencies } from "./pythonEnvironmentModel";

const execFileAsync = promisify(execFile);

interface PythonExtensionApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path?: string } | undefined;
    resolveEnvironment?(environment: { path?: string } | string): Promise<{
      executable?: { uri?: vscode.Uri };
      version?: { major?: number; minor?: number; micro?: number };
    } | null>;
  };
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
  resource?: vscode.Uri
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

  const pythonExtension = vscode.extensions.getExtension<PythonExtensionApi>("ms-python.python");
  if (pythonExtension) {
    try {
      const api = await pythonExtension.activate();
      const selected = api.environments?.getActiveEnvironmentPath(resource);
      const resolved =
        selected && api.environments?.resolveEnvironment
          ? await api.environments.resolveEnvironment(selected)
          : undefined;
      const executable = resolved?.executable?.uri?.fsPath ?? selected?.path;
      if (executable) return await probeEnvironment(executable, "pythonExtension");
    } catch {
      // Fall through to system interpreters. Diagnostics are surfaced if every candidate fails.
    }
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
