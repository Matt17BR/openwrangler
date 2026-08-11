import { constants as fsConstants, watch, type BigIntStats, type FSWatcher } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RDataframeFlavor } from "./rFrameContract";
import type { RProcessVariableDescriptor, RProcessVariableDiscovery } from "./rProcessTransport";

const REQUEST_MAX_BYTES = 64 * 1_024;
const WORKSPACE_MAX_BYTES = 4 * 1_024 * 1_024;
const LOCK_MAX_BYTES = 256;
const MAX_VARIABLES = 256;
const MAX_NAME_BYTES = 1_024;
const DEFAULT_DEBOUNCE_MS = 40;
const DEFAULT_RETRY_MS = 20;
const DEFAULT_ATTACH_TIMEOUT_MS = 60_000;
const MIN_ATTACH_POLL_MS = 100;
const READ_ATTEMPTS = 5;
const READ_FLAGS =
  fsConstants.O_RDONLY |
  (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0) |
  (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);

export interface RVscodeWorkspaceWatcher extends vscode.Disposable {
  readonly terminal: vscode.Terminal;
  readonly onDidChangeVariables: vscode.Event<RProcessVariableDiscovery>;
  readonly onDidInvalidate: vscode.Event<void>;
  readInitial(): Promise<RProcessVariableDiscovery>;
  verifyCurrent(): Promise<void>;
}

export interface RVscodeWorkspaceWatcherFactory {
  create(context: vscode.ExtensionContext, terminal: vscode.Terminal): RVscodeWorkspaceWatcher | undefined;
}

export interface RVscodeWorkspaceWatcherOptions {
  readonly extensionPath?: string;
  readonly debounceMs?: number;
  readonly retryMs?: number;
  readonly attachTimeoutMs?: number;
}

interface WatcherProvenance {
  readonly watcherRoot: string;
}

interface VscodeRWorkspaceApi {
  readonly workspace: {
    readonly data?: unknown;
    readonly onDidChangeTreeData: vscode.Event<unknown>;
  };
}

interface AttachRecord {
  readonly pid: number;
  readonly tempdir: string;
}

interface SessionFiles {
  readonly tempdir: string;
  readonly sessionRoot: string;
  readonly workspacePath: string;
  readonly lockPath: string;
  readonly watcherRootIdentity: BigIntStats;
  readonly tempdirIdentity: BigIntStats;
  readonly sessionRootIdentity: BigIntStats;
}

export const defaultRVscodeWorkspaceWatcherFactory: RVscodeWorkspaceWatcherFactory = Object.freeze({
  create: (_context: vscode.ExtensionContext, terminal: vscode.Terminal) => createRVscodeWorkspaceWatcher(terminal)
});

export function createRVscodeWorkspaceWatcher(
  terminal: vscode.Terminal,
  options: RVscodeWorkspaceWatcherOptions = {}
): RVscodeWorkspaceWatcher | undefined {
  const rExtension = vscode.extensions.getExtension("REditorSupport.r");
  const extensionPath = options.extensionPath ?? rExtension?.extensionPath;
  if (!extensionPath) return undefined;
  const provenance = terminalProvenance(terminal, extensionPath);
  if (!provenance) return undefined;
  const matchingExtension =
    rExtension && path.resolve(rExtension.extensionPath) === path.resolve(extensionPath) ? rExtension : undefined;
  return new VscodeWorkspaceWatcher(terminal, provenance, options, matchingExtension);
}

class VscodeWorkspaceWatcher implements RVscodeWorkspaceWatcher {
  private readonly changeEmitter = new vscode.EventEmitter<RProcessVariableDiscovery>();
  private readonly invalidationEmitter = new vscode.EventEmitter<void>();
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private readonly attachTimeoutMs: number;
  private expectedProcessId: number | undefined;
  private workspaceApi: VscodeRWorkspaceApi | undefined;
  private workspaceApiSubscription: vscode.Disposable | undefined;
  private session: SessionFiles | undefined;
  private directoryWatcher: FSWatcher | undefined;
  private readTimer: NodeJS.Timeout | undefined;
  private attachWait: Readonly<{ timer: NodeJS.Timeout; resolve: () => void }> | undefined;
  private initialRead: Promise<RProcessVariableDiscovery> | undefined;
  private readTail: Promise<void> = Promise.resolve();
  private lastSignature: string | undefined;
  private invalidated = false;
  private disposed = false;

  readonly onDidChangeVariables = this.changeEmitter.event;
  readonly onDidInvalidate = this.invalidationEmitter.event;

  constructor(
    readonly terminal: vscode.Terminal,
    private readonly provenance: WatcherProvenance,
    options: RVscodeWorkspaceWatcherOptions,
    private readonly rExtension: vscode.Extension<unknown> | undefined
  ) {
    this.debounceMs = boundedDelay(options.debounceMs, DEFAULT_DEBOUNCE_MS);
    this.retryMs = boundedDelay(options.retryMs, DEFAULT_RETRY_MS);
    this.attachTimeoutMs = boundedDuration(options.attachTimeoutMs, DEFAULT_ATTACH_TIMEOUT_MS);
  }

  readInitial(): Promise<RProcessVariableDiscovery> {
    this.assertUsable();
    if (this.session || this.workspaceApi) return this.readConsistentWorkspace();
    this.initialRead ??= this.initialize();
    return this.initialRead;
  }

  private async initialize(): Promise<RProcessVariableDiscovery> {
    const expectedProcessId = await terminalProcessId(this.terminal);
    this.expectedProcessId = expectedProcessId;
    const deadline = Date.now() + this.attachTimeoutMs;
    let lastError: unknown;
    while (true) {
      this.assertUsable();
      await this.assertProcess(expectedProcessId);
      const workspaceApi = currentWorkspaceApi(this.rExtension, expectedProcessId);
      if (workspaceApi && workspaceApiHasData(workspaceApi)) {
        this.workspaceApi = workspaceApi;
        this.workspaceApiSubscription = workspaceApi.workspace.onDidChangeTreeData(() => this.scheduleRead());
        try {
          const discovery = await this.readConsistentWorkspace();
          this.lastSignature = discoverySignature(discovery);
          return discovery;
        } catch (error) {
          this.releaseWorkspaceApi();
          if (!(error instanceof WorkspaceMetadataNotReadyError)) {
            this.dispose();
            throw error;
          }
          lastError = error;
        }
      }
      let session: SessionFiles | undefined;
      try {
        session = await this.attachCurrentSession(expectedProcessId);
      } catch (error) {
        lastError = error;
        this.assertUsable();
        await this.assertProcess(expectedProcessId);
        if (error instanceof OverwrittenAttachRecordError || error instanceof ForeignAttachRecordError) {
          this.dispose();
          throw error;
        }
      }
      if (session) {
        this.assertUsable();
        this.session = session;
        this.directoryWatcher = watch(session.sessionRoot, { persistent: false }, (_event, filename) => {
          const changed = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
          if (changed === null || changed === "workspace.lock" || changed === "workspace.json") this.scheduleRead();
        });
        this.directoryWatcher.on("error", () => this.invalidate());
        try {
          const discovery = await this.readConsistentWorkspace();
          this.lastSignature = discoverySignature(discovery);
          return discovery;
        } catch (error) {
          this.dispose();
          throw error;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.dispose();
        throw lastError instanceof Error
          ? lastError
          : new Error("Open Wrangler could not attach to the vscode-R session.");
      }
      await this.waitForAttachRetry(Math.min(Math.max(this.retryMs, MIN_ATTACH_POLL_MS), remaining));
    }
  }

  async verifyCurrent(): Promise<void> {
    this.assertUsable();
    const expectedProcessId = this.expectedProcessId;
    const workspaceApi = this.workspaceApi;
    if (!expectedProcessId) throw new Error("The vscode-R workspace watcher is not attached.");
    await this.assertProcess(expectedProcessId);
    if (workspaceApi) {
      const current = currentWorkspaceApi(this.rExtension, expectedProcessId);
      if (!current || current.workspace !== workspaceApi.workspace) {
        throw new Error("The vscode-R workspace session changed.");
      }
      await this.assertProcess(expectedProcessId);
      return;
    }
    const session = this.session;
    if (!session) throw new Error("The vscode-R workspace watcher is not attached.");
    await assertDirectoryIdentity(this.provenance.watcherRoot, session.watcherRootIdentity, "vscode-R watcher root");
    await assertDirectoryIdentity(session.tempdir, session.tempdirIdentity, "vscode-R session temp directory");
    await assertDirectoryIdentity(session.sessionRoot, session.sessionRootIdentity, "vscode-R session directory");
    await this.assertProcess(expectedProcessId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = undefined;
    this.cancelAttachWait();
    this.directoryWatcher?.close();
    this.directoryWatcher = undefined;
    this.releaseWorkspaceApi();
    this.changeEmitter.dispose();
    this.invalidationEmitter.dispose();
  }

  private scheduleRead(): void {
    if (this.disposed || this.invalidated) return;
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.readTimer = undefined;
      const read = this.readTail.then(async () => {
        try {
          const discovery = await this.readConsistentWorkspace();
          const signature = discoverySignature(discovery);
          if (signature === this.lastSignature || this.disposed || this.invalidated) return;
          this.lastSignature = signature;
          this.changeEmitter.fire(discovery);
        } catch {
          this.invalidate();
        }
      });
      this.readTail = read.catch(() => undefined);
    }, this.debounceMs);
    this.readTimer.unref();
  }

  private async readConsistentWorkspace(): Promise<RProcessVariableDiscovery> {
    const expectedProcessId = this.expectedProcessId;
    const workspaceApi = this.workspaceApi;
    if (expectedProcessId && workspaceApi) {
      await this.verifyCurrent();
      const workspace = workspaceApi.workspace.data;
      if (workspace === undefined) throw new WorkspaceMetadataNotReadyError();
      const discovery = decodeWorkspaceValue(workspace);
      if (workspaceApi.workspace.data !== workspace) {
        throw new Error("The vscode-R workspace changed while Open Wrangler was reading it.");
      }
      await this.verifyCurrent();
      return discovery;
    }
    const session = this.session;
    if (!expectedProcessId || !session) throw new Error("The vscode-R workspace watcher is not attached.");
    let lastError: unknown;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      try {
        await this.verifyCurrent();
        const lockBefore = await readBoundedFile(session.lockPath, LOCK_MAX_BYTES);
        const workspace = await readBoundedFile(session.workspacePath, WORKSPACE_MAX_BYTES);
        const lockAfter = await readBoundedFile(session.lockPath, LOCK_MAX_BYTES);
        if (!lockBefore || !workspace || lockBefore !== lockAfter) {
          throw new Error("The vscode-R workspace changed while Open Wrangler was reading it.");
        }
        const discovery = decodeWorkspace(workspace);
        await this.verifyCurrent();
        return discovery;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < READ_ATTEMPTS) await delay(this.retryMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Open Wrangler could not read the vscode-R workspace.");
  }

  private async readAttach(expectedProcessId: number): Promise<AttachRecord> {
    const payload = await readBoundedFile(path.join(this.provenance.watcherRoot, "request.log"), REQUEST_MAX_BYTES);
    if (!payload) throw new Error("The selected terminal does not expose a current vscode-R session record.");
    return decodeAttachRecord(payload, expectedProcessId);
  }

  private async attachCurrentSession(expectedProcessId: number): Promise<SessionFiles> {
    this.assertUsable();
    await assertCanonicalDirectory(this.provenance.watcherRoot, "vscode-R watcher root");
    validateDirectory(await lstat(this.provenance.watcherRoot, { bigint: true }), "vscode-R watcher root");
    const attach = await this.readAttach(expectedProcessId);
    await this.assertProcess(expectedProcessId);
    const session = await validateSessionFiles(this.provenance.watcherRoot, attach.tempdir);
    await this.assertAttach(expectedProcessId, session.tempdir);
    return session;
  }

  private async assertAttach(expectedProcessId: number, expectedTempdir: string): Promise<void> {
    const attach = await this.readAttach(expectedProcessId);
    if (attach.tempdir !== expectedTempdir) throw new Error("The vscode-R session path changed.");
  }

  private async assertProcess(expectedProcessId: number): Promise<void> {
    if (!vscode.window.terminals.includes(this.terminal)) throw new Error("The selected R terminal closed.");
    if ((await terminalProcessId(this.terminal)) !== expectedProcessId) {
      throw new Error("The selected R terminal process changed.");
    }
  }

  private invalidate(): void {
    if (this.invalidated || this.disposed) return;
    this.invalidated = true;
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = undefined;
    this.cancelAttachWait();
    this.directoryWatcher?.close();
    this.directoryWatcher = undefined;
    this.releaseWorkspaceApi();
    this.invalidationEmitter.fire();
  }

  private releaseWorkspaceApi(): void {
    this.workspaceApiSubscription?.dispose();
    this.workspaceApiSubscription = undefined;
    this.workspaceApi = undefined;
  }

  private assertUsable(): void {
    if (this.disposed || this.invalidated) throw new Error("The vscode-R workspace watcher is no longer current.");
  }

  private waitForAttachRetry(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.attachWait?.timer === timer) this.attachWait = undefined;
        resolve();
      }, milliseconds);
      timer.unref();
      this.attachWait = { timer, resolve };
    });
  }

  private cancelAttachWait(): void {
    const wait = this.attachWait;
    if (!wait) return;
    this.attachWait = undefined;
    clearTimeout(wait.timer);
    wait.resolve();
  }
}

function terminalProvenance(terminal: vscode.Terminal, extensionPath: string): WatcherProvenance | undefined {
  if (terminal.name !== "R" && terminal.name !== "R Interactive") return undefined;
  const creation = terminal.creationOptions as vscode.TerminalOptions;
  const env = creation && "env" in creation ? creation.env : undefined;
  if (!env || typeof env !== "object") return undefined;
  const watcherRoot = env.VSCODE_WATCHER_DIR;
  const initPath = env.VSCODE_INIT_R;
  const profilePath = env.R_PROFILE_USER;
  if (!isAbsolutePath(watcherRoot) || !isAbsolutePath(initPath) || !isAbsolutePath(profilePath)) return undefined;
  const normalizedExtension = path.resolve(extensionPath);
  if (path.resolve(initPath) !== path.join(normalizedExtension, "R", "session", "init.R")) return undefined;
  if (path.resolve(profilePath) !== path.join(normalizedExtension, "R", "session", "profile.R")) return undefined;
  return Object.freeze({ watcherRoot: path.resolve(watcherRoot) });
}

async function validateSessionFiles(watcherRoot: string, tempdir: string): Promise<SessionFiles> {
  const sessionRoot = path.join(tempdir, "vscode-R");
  await Promise.all([
    assertCanonicalDirectory(watcherRoot, "vscode-R watcher root"),
    assertCanonicalDirectory(tempdir, "vscode-R session temp directory"),
    assertCanonicalDirectory(sessionRoot, "vscode-R session directory")
  ]);
  return Object.freeze({
    tempdir,
    sessionRoot,
    workspacePath: path.join(sessionRoot, "workspace.json"),
    lockPath: path.join(sessionRoot, "workspace.lock"),
    watcherRootIdentity: validateDirectory(await lstat(watcherRoot, { bigint: true }), "vscode-R watcher root"),
    tempdirIdentity: validateDirectory(await lstat(tempdir, { bigint: true }), "vscode-R session temp directory"),
    sessionRootIdentity: validateDirectory(await lstat(sessionRoot, { bigint: true }), "vscode-R session directory")
  });
}

async function assertCanonicalDirectory(filePath: string, label: string): Promise<void> {
  if ((await realpath(filePath)) !== path.resolve(filePath)) throw new Error(`The ${label} contains a symbolic link.`);
}

async function assertDirectoryIdentity(filePath: string, expected: BigIntStats, label: string): Promise<void> {
  const current = validateDirectory(await lstat(filePath, { bigint: true }), label);
  if (expected.dev !== current.dev || expected.ino !== current.ino) throw new Error(`The ${label} changed.`);
}

async function readBoundedFile(filePath: string, maximumBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, READ_FLAGS);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const opened = validateFile(await handle.stat({ bigint: true }), BigInt(maximumBytes));
    const namedBefore = validateFile(await lstat(filePath, { bigint: true }), BigInt(maximumBytes));
    if (!sameIdentity(opened, namedBefore)) throw new Error("A vscode-R watcher file changed before it was read.");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) throw new Error("A vscode-R watcher file was truncated.");
      offset += bytesRead;
    }
    const completed = validateFile(await handle.stat({ bigint: true }), BigInt(maximumBytes));
    const namedAfter = validateFile(await lstat(filePath, { bigint: true }), BigInt(maximumBytes));
    if (!sameIdentity(opened, completed) || !sameIdentity(opened, namedAfter)) {
      throw new Error("A vscode-R watcher file changed while it was read.");
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

function decodeAttachRecord(payload: string, expectedProcessId: number): AttachRecord {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("The vscode-R session record is malformed.");
  }
  if (!isRecord(value)) throw new Error("The vscode-R session record is malformed.");
  if (value.command !== "attach") {
    if (value.pid === expectedProcessId) {
      throw new OverwrittenAttachRecordError();
    }
    throw new ForeignAttachRecordError();
  }
  if (!Number.isSafeInteger(value.pid)) throw new Error("The vscode-R session record is malformed.");
  if (value.pid !== expectedProcessId) throw new ForeignAttachRecordError();
  if (!isAbsolutePath(value.tempdir) || Buffer.byteLength(value.tempdir, "utf8") > 4_096) {
    throw new Error("The selected terminal does not match the current vscode-R session record.");
  }
  return Object.freeze({ pid: value.pid, tempdir: path.resolve(value.tempdir) });
}

function decodeWorkspace(payload: string): RProcessVariableDiscovery {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("The vscode-R workspace metadata is malformed.");
  }
  return decodeWorkspaceValue(value);
}

function decodeWorkspaceValue(value: unknown): RProcessVariableDiscovery {
  if (!isRecord(value)) {
    throw new Error("The vscode-R workspace metadata is malformed.");
  }
  if (value.globalenv === null) {
    throw new Error("vscode-R workspace watching is unavailable for this session.");
  }
  if (!isRecord(value.globalenv)) throw new Error("The vscode-R workspace metadata is malformed.");
  const candidates = Object.entries(value.globalenv);
  const variables: RProcessVariableDescriptor[] = [];
  let truncated = false;
  for (const [name, metadata] of candidates) {
    const flavor = dataframeFlavor(metadata);
    if (!flavor) continue;
    if (!isBoundedName(name)) throw new Error("The vscode-R workspace contains an invalid dataframe name.");
    if (variables.length >= MAX_VARIABLES) {
      truncated = true;
      break;
    }
    variables.push(Object.freeze({ name, backend: "r", dataframeFlavor: flavor }));
  }
  return Object.freeze({ variables: Object.freeze(variables), truncated });
}

function currentWorkspaceApi(
  extension: vscode.Extension<unknown> | undefined,
  expectedProcessId: number
): VscodeRWorkspaceApi | undefined {
  try {
    const moduleExports = activeVscodeRModuleExports(extension);
    if (!isRecord(moduleExports)) return undefined;
    const workspace = moduleExports.rWorkspace;
    const status = moduleExports.sessionStatusBarItem;
    if (!isRecord(workspace) || typeof workspace.onDidChangeTreeData !== "function" || !isRecord(status)) {
      return undefined;
    }
    const tooltip = status.tooltip;
    const tooltipText =
      typeof tooltip === "string"
        ? tooltip
        : isRecord(tooltip) && typeof tooltip.value === "string"
          ? tooltip.value
          : undefined;
    const processMatch = tooltipText ? /(?:^|\n)Process ID:\s*(\d+)(?:\n|$)/u.exec(tooltipText) : undefined;
    if (!processMatch || Number(processMatch[1]) !== expectedProcessId) return undefined;
    return Object.freeze({
      workspace: workspace as unknown as VscodeRWorkspaceApi["workspace"]
    });
  } catch {
    return undefined;
  }
}

function workspaceApiHasData(workspaceApi: VscodeRWorkspaceApi): boolean {
  try {
    return workspaceApi.workspace.data !== undefined;
  } catch {
    return false;
  }
}

function activeVscodeRModuleExports(extension: vscode.Extension<unknown> | undefined): unknown {
  if (!extension?.isActive || !isRecord(extension.packageJSON)) return undefined;
  const main = extension.packageJSON.main;
  if (typeof main !== "string" || main.length === 0 || main.length > 1_024 || main.includes("\0")) return undefined;
  const extensionRoot = path.resolve(extension.extensionPath);
  const candidate = path.resolve(extensionRoot, main);
  if (!isContainedPath(extensionRoot, candidate)) return undefined;
  try {
    const extensionRequire = createRequire(path.join(extensionRoot, "package.json"));
    const resolved = extensionRequire.resolve(candidate);
    if (!isContainedPath(extensionRoot, resolved)) return undefined;
    return extensionRequire.cache[resolved]?.exports;
  } catch {
    return undefined;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

class WorkspaceMetadataNotReadyError extends Error {
  constructor() {
    super("The vscode-R workspace metadata is not ready.");
  }
}

class OverwrittenAttachRecordError extends Error {
  constructor() {
    super("vscode-R no longer exposes the attach record for this active session.");
  }
}

class ForeignAttachRecordError extends Error {
  constructor() {
    super("The selected terminal does not match the current vscode-R session record.");
  }
}

function dataframeFlavor(metadata: unknown): RDataframeFlavor | undefined {
  if (!isRecord(metadata) || !Array.isArray(metadata.class) || !Array.isArray(metadata.dim)) return undefined;
  if (
    metadata.class.some((item) => typeof item !== "string" || Buffer.byteLength(item, "utf8") > 256) ||
    metadata.dim.length !== 2 ||
    metadata.dim.some((item) => !Number.isSafeInteger(item) || item < 0)
  ) {
    return undefined;
  }
  const classes = new Set(metadata.class);
  if (classes.has("data.table")) return "r.data.table";
  if (classes.has("tbl_df") || classes.has("tbl")) return "r.tibble";
  if (classes.has("data.frame")) return "r.data.frame";
  return undefined;
}

function validateDirectory(stats: BigIntStats, label: string): BigIntStats {
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.nlink < 1n || !isCurrentUser(stats)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return stats;
}

function validateFile(stats: BigIntStats, maximumBytes: bigint): BigIntStats {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    stats.size < 1n ||
    stats.size > maximumBytes ||
    !isCurrentUser(stats)
  ) {
    throw new Error("A vscode-R watcher file is invalid.");
  }
  return stats;
}

function isCurrentUser(stats: BigIntStats): boolean {
  const getuid = process.getuid;
  return typeof getuid !== "function" || stats.uid === BigInt(getuid.call(process));
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function discoverySignature(discovery: RProcessVariableDiscovery): string {
  return JSON.stringify(discovery);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && path.isAbsolute(value);
}

function isBoundedName(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_NAME_BYTES;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function terminalProcessId(terminal: vscode.Terminal): Promise<number> {
  const processId = await terminal.processId;
  if (!Number.isSafeInteger(processId) || (processId ?? 0) < 1) {
    throw new Error("Open Wrangler could not verify the selected R terminal process.");
  }
  return processId!;
}

function boundedDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) throw new TypeError("Invalid watcher delay.");
  return value;
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new TypeError("Invalid watcher timeout.");
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
