import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveAndPreflightAcceptancePython } from "../packaged-python-preflight.mjs";
import {
  createRunIdentifiers,
  createScenarioSelector,
  createSoakReceipt,
  maximumCompletedIterations,
  parseSoakArguments,
  sha256Hex,
  soakUsage,
  SOAK_PRNG,
  SOAK_SCENARIOS,
  SOAK_SCENARIO_SET_SHA256,
  SoakContractError,
  SoakRunError,
  writeFailureReceipt
} from "./soak-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pythonRoot = resolve(repositoryRoot, "python");
const RESPONSE_MAX_BYTES = 1024 * 1024;
const STDERR_COUNT_LIMIT = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const PROGRESS_INTERVAL = 100;
const SERVER_SOURCE = [
  "import runpy",
  "import sys",
  "sys.path.insert(0, sys.argv[1])",
  "runpy.run_module('openwrangler_runtime.server', run_name='__main__')"
].join(";");
const VERSION_PROBE_SOURCE = [
  "import json",
  "import sys",
  "sys.path.insert(0, sys.argv[1])",
  "import pandas",
  "from openwrangler_runtime.version import __version__",
  "print(json.dumps({'pythonVersion': '.'.join(map(str, sys.version_info[:3])), 'runtimeVersion': __version__, 'backendVersion': pandas.__version__}))"
].join(";");

function platformIdentifier(value) {
  if (value === "linux") return "linux";
  if (value === "darwin") return "macos";
  if (value === "win32") return "windows";
  return "other";
}

function canonicalUuid(seed, iteration, suffix) {
  const digest = createHash("sha256").update(`${seed}:${iteration}:${suffix}`).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}

function requestDeadline(remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new SoakRunError("deadline_exceeded", "prepare");
  }
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Math.floor(remainingMs)));
}

function waitWithBound(promise, timeoutMs, code, phase, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const timer = setTimeout(
      () => finish(rejectPromise, new SoakRunError(code, phase)),
      Math.max(1, Math.floor(timeoutMs))
    );
    const abort = () => finish(rejectPromise, new SoakRunError("interrupted", phase));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(resolvePromise, value),
      () => finish(rejectPromise, new SoakRunError(code, phase))
    );
  });
}

class RuntimeServer {
  constructor(executable, workingRoot, signal) {
    this.signal = signal;
    this.requestNumber = 0;
    this.stderrBytes = 0;
    this.process = spawn(executable, ["-I", "-X", "utf8", "-c", SERVER_SOURCE, pythonRoot], {
      cwd: workingRoot,
      env: runtimeEnvironment(workingRoot),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    this.process.stdin.on("error", () => {
      // A correlated request observes the owned runtime exit; never surface an unbounded stream error.
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderrBytes = Math.min(STDERR_COUNT_LIMIT, this.stderrBytes + chunk.length);
    });
    this.exit = new Promise((resolveExit) => {
      this.process.once("error", () => resolveExit({ code: null, signal: "spawn_error" }));
      this.process.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
    });
  }

  async request(request, phase, timeoutMs, protocolVersion = 2) {
    this.requestNumber += 1;
    const requestId = `soak-${this.requestNumber}`;
    return this.requestEnvelope(
      { protocolVersion, requestId, priority: "interactive", request },
      requestId,
      phase,
      timeoutMs
    );
  }

  async requestEnvelope(envelope, requestId, phase, timeoutMs) {
    if (this.signal?.aborted) throw new SoakRunError("interrupted", phase);
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      throw new SoakRunError("runtime_exit", phase);
    }
    const frame = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(frame, "utf8") > 64 * 1024) throw new SoakRunError("protocol_invalid", phase);
    try {
      this.process.stdin.write(frame);
    } catch {
      throw new SoakRunError("runtime_exit", phase);
    }
    const result = await waitWithBound(this.lines.next(), timeoutMs, "protocol_timeout", phase, this.signal);
    if (result.done || typeof result.value !== "string") throw new SoakRunError("runtime_exit", phase);
    if (Buffer.byteLength(result.value, "utf8") > RESPONSE_MAX_BYTES) {
      throw new SoakRunError("protocol_invalid", phase);
    }
    let envelopeResponse;
    try {
      envelopeResponse = JSON.parse(result.value);
    } catch {
      throw new SoakRunError("protocol_invalid", phase);
    }
    if (
      typeof envelopeResponse !== "object" ||
      envelopeResponse === null ||
      Array.isArray(envelopeResponse) ||
      envelopeResponse.protocolVersion !== 2 ||
      envelopeResponse.requestId !== requestId ||
      typeof envelopeResponse.response !== "object" ||
      envelopeResponse.response === null ||
      Array.isArray(envelopeResponse.response) ||
      typeof envelopeResponse.response.kind !== "string"
    ) {
      throw new SoakRunError("protocol_invalid", phase);
    }
    return envelopeResponse.response;
  }

  async crash(phase) {
    if (!this.process.kill("SIGKILL")) throw new SoakRunError("scenario_failed", phase);
    await waitWithBound(this.exit, STOP_TIMEOUT_MS, "runtime_exit", phase, this.signal);
  }

  async stop(phase, requireZero = true) {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.stdin.end();
    let exit;
    try {
      exit = await waitWithBound(this.exit, STOP_TIMEOUT_MS, "cleanup_failed", phase, undefined);
    } catch (error) {
      this.process.kill("SIGKILL");
      throw error;
    }
    if (requireZero && (exit.code !== 0 || exit.signal !== null)) {
      throw new SoakRunError("runtime_exit", phase);
    }
  }

  async forceStop() {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL");
    try {
      await waitWithBound(this.exit, STOP_TIMEOUT_MS, "cleanup_failed", "cleanup", undefined);
      return true;
    } catch {
      return false;
    }
  }
}

function runtimeEnvironment(workingRoot) {
  const environment = {
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    TMP: workingRoot,
    TEMP: workingRoot,
    TMPDIR: workingRoot
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

function expectKind(response, kind, phase) {
  if (response.kind !== kind) throw new SoakRunError("scenario_failed", phase);
  return response;
}

function expectErrorCode(response, code, phase) {
  if (response.kind !== "error" || response.code !== code) {
    throw new SoakRunError("scenario_failed", phase);
  }
}

export class PythonRuntimeSoakAdapter {
  constructor({ executable, workingRoot, sourcePath, seed, signal }) {
    this.executable = executable;
    this.workingRoot = workingRoot;
    this.sourcePath = sourcePath;
    this.seed = seed;
    this.signal = signal;
    this.server = undefined;
    this.runtimeVersion = "unknown";
  }

  async initialize(remainingMs) {
    this.server = new RuntimeServer(this.executable, this.workingRoot, this.signal);
    const response = await this.server.request({ kind: "initialize" }, "initialize", requestDeadline(remainingMs));
    expectKind(response, "initialized", "initialize");
    if (typeof response.runtimeVersion !== "string") throw new SoakRunError("protocol_invalid", "initialize");
    this.runtimeVersion = response.runtimeVersion;
  }

  async runScenario(scenario, iteration, remainingMs) {
    if (!this.server) throw new SoakRunError("runtime_start_failed", scenario);
    const timeoutMs = requestDeadline(remainingMs);
    if (scenario === "open_page_close") {
      const { sessionId, revision } = await this.openSession(iteration, scenario, timeoutMs);
      const page = await this.server.request(
        {
          kind: "getPage",
          sessionId,
          revision,
          viewRequestId: `view-${iteration}`,
          offset: 0,
          limit: 4,
          columnOffset: 0,
          columnLimit: 8,
          filterModel: { logic: "and", filters: [], sort: [] }
        },
        scenario,
        timeoutMs
      );
      expectKind(page, "page", scenario);
      const closed = await this.server.request({ kind: "closeSession", sessionId, revision }, scenario, timeoutMs);
      expectKind(closed, "sessionClosed", scenario);
      return;
    }
    if (scenario === "invalid_protocol") {
      const response = await this.server.request({ kind: "initialize" }, scenario, timeoutMs, 1);
      expectErrorCode(response, "invalid_request", scenario);
      return;
    }
    if (scenario === "unknown_session") {
      const response = await this.server.request(
        {
          kind: "getPage",
          sessionId: canonicalUuid(this.seed, iteration, "missing"),
          revision: 0,
          viewRequestId: `missing-${iteration}`,
          offset: 0,
          limit: 4,
          columnOffset: 0,
          columnLimit: 8,
          filterModel: { logic: "and", filters: [], sort: [] }
        },
        scenario,
        timeoutMs
      );
      expectErrorCode(response, "unknown_session", scenario);
      return;
    }
    if (scenario === "crash_restart") {
      const { sessionId } = await this.openSession(iteration, scenario, timeoutMs);
      await this.server.crash(scenario);
      this.server = new RuntimeServer(this.executable, this.workingRoot, this.signal);
      const initialized = await this.server.request({ kind: "initialize" }, scenario, timeoutMs);
      expectKind(initialized, "initialized", scenario);
      if (initialized.runtimeVersion !== this.runtimeVersion) throw new SoakRunError("scenario_failed", scenario);
      const response = await this.server.request(
        {
          kind: "getPage",
          sessionId,
          revision: 0,
          viewRequestId: `lost-${iteration}`,
          offset: 0,
          limit: 4,
          columnOffset: 0,
          columnLimit: 8,
          filterModel: { logic: "and", filters: [], sort: [] }
        },
        scenario,
        timeoutMs
      );
      expectErrorCode(response, "unknown_session", scenario);
      return;
    }
    throw new SoakRunError("scenario_failed", "prepare");
  }

  async openSession(iteration, phase, timeoutMs) {
    if (!this.server) throw new SoakRunError("runtime_start_failed", phase);
    const sessionId = canonicalUuid(this.seed, iteration, phase);
    const response = await this.server.request(
      {
        kind: "openSession",
        source: { kind: "file", label: "soak.csv", path: this.sourcePath },
        requestedSessionId: sessionId,
        backend: "pandas",
        mode: "editing",
        pageSize: 4,
        columnOffset: 0,
        columnLimit: 8
      },
      phase,
      timeoutMs
    );
    expectKind(response, "sessionOpened", phase);
    if (
      typeof response.metadata !== "object" ||
      response.metadata === null ||
      response.metadata.sessionId !== sessionId ||
      response.metadata.backend !== "pandas" ||
      !Number.isSafeInteger(response.metadata.revision)
    ) {
      throw new SoakRunError("protocol_invalid", phase);
    }
    return { sessionId, revision: response.metadata.revision };
  }

  async close() {
    if (!this.server) return;
    const current = this.server;
    this.server = undefined;
    await current.stop("cleanup");
  }

  async forceClose() {
    if (!this.server) return true;
    const current = this.server;
    this.server = undefined;
    return current.forceStop();
  }
}

function canonicalCounters(counts) {
  return SOAK_SCENARIOS.map((scenario) => ({ scenario, count: counts.get(scenario) ?? 0 }));
}

export async function executeRuntimeSoak({
  options,
  subject,
  tools,
  identifiers,
  adapter,
  signal,
  clock = {
    epochMs: () => Date.now(),
    monotonicMs: () => performance.now()
  },
  onProgress = () => undefined
}) {
  const selector = createScenarioSelector(options.seed);
  const counts = new Map(SOAK_SCENARIOS.map((scenario) => [scenario, 0]));
  const startedEpochMs = clock.epochMs();
  const startedMonotonicMs = clock.monotonicMs();
  const deadlineMs = startedMonotonicMs + options.wallSeconds * 1_000;
  let completedIterations = 0;
  let phase = "initialize";
  let failure;
  let initialized = false;
  const remaining = () => deadlineMs - clock.monotonicMs();

  try {
    await adapter.initialize(remaining());
    initialized = true;
    while (
      completedIterations < options.iterations ||
      clock.monotonicMs() - startedMonotonicMs < options.durationSeconds * 1_000
    ) {
      if (signal?.aborted) throw new SoakRunError("interrupted", phase);
      if (remaining() <= 0) throw new SoakRunError("deadline_exceeded", phase);
      if (completedIterations >= maximumCompletedIterations()) {
        throw new SoakRunError("iteration_limit", phase);
      }
      const scenario = selector.next();
      phase = scenario;
      await adapter.runScenario(scenario, completedIterations + 1, remaining());
      counts.set(scenario, counts.get(scenario) + 1);
      completedIterations += 1;
      if (completedIterations % PROGRESS_INTERVAL === 0) {
        onProgress({
          seed: options.seed,
          completedIterations,
          elapsedMs: Math.floor(clock.monotonicMs() - startedMonotonicMs),
          branches: canonicalCounters(counts)
        });
      }
    }
    phase = "cleanup";
    await adapter.close();
    if (clock.monotonicMs() > deadlineMs) throw new SoakRunError("deadline_exceeded", phase);
  } catch (error) {
    const classified = error instanceof SoakRunError ? error : new SoakRunError("scenario_failed", phase);
    failure = { code: classified.code, phase: classified.phase, iteration: initialized ? completedIterations + 1 : 0 };
    const cleanupConfirmed = await adapter.forceClose();
    if (!cleanupConfirmed && failure.code === "scenario_failed") {
      failure = { code: "cleanup_failed", phase: "cleanup", iteration: completedIterations };
    }
  }

  const endedEpochMs = clock.epochMs();
  const elapsedMs = Math.max(0, Math.floor(clock.monotonicMs() - startedMonotonicMs));
  const receipt = createSoakReceipt({
    outcome: failure ? "failure" : "success",
    subject,
    tools: { ...tools, runtimeVersion: adapter.runtimeVersion ?? "unknown" },
    run: {
      runId: identifiers.runId,
      jobId: identifiers.jobId,
      prng: SOAK_PRNG,
      seed: options.seed,
      scenarioSetSha256: SOAK_SCENARIO_SET_SHA256,
      requestedIterations: options.iterations,
      requestedDurationSeconds: options.durationSeconds,
      wallSeconds: options.wallSeconds,
      completedIterations,
      startedAt: new Date(startedEpochMs).toISOString(),
      endedAt: new Date(endedEpochMs).toISOString(),
      elapsedMs,
      branches: canonicalCounters(counts)
    },
    ...(failure ? { failure } : {})
  });
  return Object.freeze({ receipt, failure });
}

async function sourceSubject(root) {
  const git = (argument) =>
    execFileSync("git", ["-C", root, "rev-parse", argument], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4_096,
      windowsHide: true
    }).trim();
  const [manifest, lock] = await Promise.all([
    readFile(join(root, "package.json")),
    readFile(join(root, "package-lock.json"))
  ]);
  return Object.freeze({
    kind: "source_tree",
    sourceCommit: git("HEAD"),
    sourceTree: git("HEAD^{tree}"),
    packageManifestSha256: sha256Hex(manifest),
    dependencyLockSha256: sha256Hex(lock)
  });
}

function probeVersions(executable) {
  const output = execFileSync(executable, ["-I", "-X", "utf8", "-c", VERSION_PROBE_SOURCE, pythonRoot], {
    cwd: repositoryRoot,
    env: runtimeEnvironment(tmpdir()),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024,
    windowsHide: true
  });
  const parsed = JSON.parse(output);
  return Object.freeze({
    platform: platformIdentifier(process.platform),
    nodeVersion: process.versions.node,
    pythonVersion: parsed.pythonVersion,
    runtimeVersion: parsed.runtimeVersion,
    backend: "pandas",
    backendVersion: parsed.backendVersion
  });
}

async function verifiedPrivateRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const status = await lstat(root);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (process.platform !== "win32" && status.uid !== process.getuid())
  ) {
    throw new SoakContractError("The soak workspace is not privately owned.");
  }
  return root;
}

async function removePrivateRoot(root) {
  const status = await lstat(root);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (process.platform !== "win32" && status.uid !== process.getuid())
  ) {
    throw new SoakContractError("The soak workspace ownership changed before cleanup.");
  }
  await rm(root, { recursive: true, force: false });
}

export async function runRuntimeSoakCli(args, dependencies = {}) {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(`${value}\n`));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(`${value}\n`));
  let options;
  try {
    options = parseSoakArguments(args);
  } catch {
    stderr(soakUsage());
    return 2;
  }
  if (options.help) {
    stdout(soakUsage());
    return 0;
  }

  const signalController = new AbortController();
  const interrupt = () => signalController.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let workingRoot;
  try {
    workingRoot = await verifiedPrivateRoot("openwrangler-soak-work-");
    const sourcePath = join(workingRoot, "soak.csv");
    await writeFile(sourcePath, "city,value,flag\nBerlin,12,true\nParis,7,false\nRome,,true\nMadrid,9,false\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const subject = await sourceSubject(repositoryRoot);
    const executable = resolveAndPreflightAcceptancePython({
      profile: "repository-command",
      repositoryRoot,
      environment: process.env,
      platform: process.platform
    });
    const tools = probeVersions(executable);
    const identifiers = createRunIdentifiers();
    const adapter = new PythonRuntimeSoakAdapter({
      executable,
      workingRoot,
      sourcePath,
      seed: options.seed,
      signal: signalController.signal
    });
    const result = await executeRuntimeSoak({
      options,
      subject,
      tools,
      identifiers,
      adapter,
      signal: signalController.signal,
      onProgress: (progress) =>
        stderr(
          `OW_SOAK_PROGRESS seed=${progress.seed} completed=${progress.completedIterations} elapsedMs=${progress.elapsedMs} branches=${progress.branches.map((entry) => `${entry.scenario}:${entry.count}`).join(",")}`
        )
    });
    await removePrivateRoot(workingRoot);
    workingRoot = undefined;
    if (!result.failure) {
      stdout(result.receipt.json.trim());
      return 0;
    }
    const retained = await writeFailureReceipt(result.receipt, tmpdir());
    stderr(
      `OW_SOAK_FAILED code=${result.failure.code} phase=${result.failure.phase} seed=${options.seed} receipt=${retained.path}`
    );
    return 1;
  } catch {
    stderr("OW_SOAK_PREPARE_FAILED");
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (workingRoot) {
      try {
        await removePrivateRoot(workingRoot);
      } catch {
        // Ownership uncertainty deliberately suppresses diagnostics and further traversal.
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRuntimeSoakCli(process.argv.slice(2));
}
