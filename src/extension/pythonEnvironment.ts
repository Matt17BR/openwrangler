import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import * as path from "node:path";
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

  let candidates: Array<{ executable: string; arguments: readonly string[] }>;
  try {
    candidates =
      process.platform === "win32"
        ? (await discoverWindowsSystemPythonExecutables()).map((executable) => ({
            executable,
            arguments: []
          }))
        : [
            { executable: "python3", arguments: [] },
            { executable: "python", arguments: [] }
          ];
  } catch (error) {
    throw new Error(
      `No compatible Python 3.10-3.14 interpreter was found. Windows Python discovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await probeEnvironment(candidate.executable, "system", candidate.arguments);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
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
      timeout: number;
      windowsHide: true;
    }
  ) => Promise<{ stdout: string; stderr: string }>;
}

export async function discoverWindowsSystemPythonExecutables(
  options: WindowsPythonDiscoveryOptions = {}
): Promise<string[]> {
  const environment = buildPythonProcessEnvironment(options.environment);
  const executableCheck = options.isExecutable ?? isExecutableFile;
  const launcher = resolvePythonCommandPath("py", environment, executableCheck, "win32");
  if (!launcher) return [];
  const executeLauncher =
    options.executeLauncher ??
    (async (executable, arguments_, launchOptions) => {
      const result = await execFileAsync(executable, [...arguments_], launchOptions);
      return { stdout: result.stdout, stderr: result.stderr };
    });
  let stdout: string;
  let stderr: string;
  try {
    const result = await executeLauncher(launcher, ["-0p"], {
      env: {
        ...environment,
        PYLAUNCHER_NO_SEARCH_PATH: "1",
        PYTHON_MANAGER_AUTOMATIC_INSTALL: "0"
      },
      maxBuffer: 256 * 1024,
      shell: false,
      timeout: 10_000,
      windowsHide: true
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    throw new Error(
      `the Python launcher could not list installed runtimes: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parseWindowsPythonLauncherOutput(`${stdout}\n${stderr}`).filter(executableCheck);
}

export function parseWindowsPythonLauncherOutput(output: string): string[] {
  const candidates: Array<{ executable: string; minor: number }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^\s*-(?:V:)?(?:(?:PythonCore)[\\/])?3\.(10|11|12|13|14)t?(?:-[A-Za-z0-9]+)?(?:\s+\*)?\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    let executable = match[2]?.trim() ?? "";
    if (executable.endsWith("*")) executable = executable.slice(0, -1).trimEnd();
    if (executable.startsWith('"') || executable.endsWith('"')) {
      const quoted = /^"([^"]+)"$/.exec(executable);
      if (!quoted) continue;
      executable = quoted[1] ?? "";
    }
    if (!isFullyQualifiedWindowsExecutable(executable)) continue;
    candidates.push({
      executable: path.win32.normalize(executable),
      minor: Number.parseInt(match[1] ?? "", 10)
    });
  }
  candidates.sort((left, right) => right.minor - left.minor);
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

async function probeEnvironment(
  executable: string,
  source: PythonEnvironment["source"],
  launcherArguments: readonly string[] = []
): Promise<PythonEnvironment> {
  const processEnvironment = buildPythonProcessEnvironment();
  const resolvedExecutable = resolvePythonCommandPath(
    executable,
    processEnvironment,
    isExecutableFile,
    process.platform
  );
  if (!resolvedExecutable) {
    throw new Error(`${executable} could not be resolved to an absolute executable.`);
  }
  const initial = await executeEnvironmentProbe(resolvedExecutable, processEnvironment, launcherArguments);
  const reportedExecutable = path.normalize(initial.executable);
  const result = sameExecutablePath(resolvedExecutable, reportedExecutable)
    ? initial
    : await executeEnvironmentProbe(reportedExecutable, processEnvironment);
  if (!sameExecutablePath(result.executable, reportedExecutable)) {
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
    const result = await execFileAsync(executable, [...launcherArguments, "-I", "-c", program], {
      env: processEnvironment,
      shell: false,
      timeout: 10_000,
      windowsHide: true
    });
    stdout = result.stdout.trim();
  } catch (error) {
    throw new Error(`${executable} could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  return decodePythonEnvironmentProbeOutput(stdout);
}

export function decodePythonEnvironmentProbeOutput(stdout: string): {
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
    !isFullyQualifiedPythonPath(candidate.executable) ||
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
    !isFullyQualifiedPythonPath(candidate.packageRoot) ||
    candidate.packageRoot.includes("\0")
  ) {
    throw new Error("Python environment probe returned an invalid package root.");
  }
  const packageRootIdentity = decodePythonPackageRootIdentity(candidate.packageRootIdentity);
  return {
    executable: path.normalize(candidate.executable),
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

function sameExecutablePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function isFullyQualifiedWindowsExecutable(candidate: string): boolean {
  return (
    isFullyQualifiedPythonPath(candidate, "win32") &&
    path.win32.extname(candidate).toLocaleLowerCase("en-US") === ".exe" &&
    !candidate.includes("\0")
  );
}
