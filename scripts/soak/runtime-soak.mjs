import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
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
  assertFailureReceiptForEmission,
  writeFailureReceipt
} from "./soak-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RESPONSE_MAX_BYTES = 1024 * 1024;
const STDERR_COUNT_LIMIT = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const PROGRESS_INTERVAL = 100;
const SOURCE_FILE_LIMIT = 512;
const SOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
const PORTABLE_OWNER_TEST = "scripts/soak/runtime-soak.test.mjs";
const EXECUTED_WORKTREE_PATHS = Object.freeze([
  "scripts/soak/runtime-soak.mjs",
  "scripts/soak/soak-contract.mjs",
  "scripts/packaged-python-preflight.mjs",
  "scripts/editor-acceptance-evidence.mjs",
  "scripts/strict-json.mjs",
  "src/shared/strictJson.cjs",
  "package.json",
  "package-lock.json"
]);
const RUNTIME_SOURCE_ROOT = "python/openwrangler_runtime";
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

export class BoundedLfFramer {
  constructor(stream, maximumBytes = RESPONSE_MAX_BYTES) {
    this.maximumBytes = maximumBytes;
    this.buffer = Buffer.alloc(0);
    this.invalid = false;
    this.closed = false;
    this.queue = [];
    this.waiter = undefined;
    this.maximumBufferedBytes = 0;
    stream.on("data", (chunk) => this.accept(chunk));
    stream.once("end", () => this.finish());
    stream.once("error", () => this.invalidate());
  }

  accept(chunk) {
    if (this.invalid || this.closed) return;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      this.reject();
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      const nextLength = this.buffer.length + segment.length;
      if (nextLength > this.maximumBytes) {
        this.reject();
        return;
      } else if (segment.length > 0) {
        this.buffer =
          this.buffer.length === 0 ? Buffer.from(segment) : Buffer.concat([this.buffer, segment], nextLength);
        this.maximumBufferedBytes = Math.max(this.maximumBufferedBytes, this.buffer.length);
      }
      if (newline === -1) return;
      let line = this.buffer;
      this.buffer = Buffer.alloc(0);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      try {
        this.publish({ kind: "line", value: new TextDecoder("utf-8", { fatal: true }).decode(line) });
      } catch {
        this.reject();
        return;
      }
      offset = end + 1;
    }
  }

  finish() {
    if (this.closed) return;
    if (this.buffer.length > 0 && !this.invalid) this.reject();
    this.buffer = Buffer.alloc(0);
    this.closed = true;
    this.publish({ kind: "end" });
  }

  invalidate() {
    if (this.closed) return;
    this.reject();
  }

  reject() {
    this.buffer = Buffer.alloc(0);
    if (!this.invalid) this.publish({ kind: "invalid" });
    this.invalid = true;
  }

  publish(value) {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(value);
      return;
    }
    if (this.queue.length >= 4) {
      this.queue = [{ kind: "invalid" }];
      return;
    }
    this.queue.push(value);
  }

  next() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve({ kind: "end" });
    if (this.waiter) return Promise.resolve({ kind: "invalid" });
    return new Promise((resolveFrame) => {
      this.waiter = resolveFrame;
    });
  }

  bufferedBytesForTesting() {
    return Object.freeze({ current: this.buffer.length, maximum: this.maximumBufferedBytes });
  }
}

export class RuntimeServer {
  constructor(
    executable,
    workingRoot,
    runtimePythonRoot,
    signal,
    { spawnProcess = spawn, stopTimeoutMs = STOP_TIMEOUT_MS } = {}
  ) {
    this.signal = signal;
    this.requestNumber = 0;
    this.stderrBytes = 0;
    this.stopTimeoutMs = stopTimeoutMs;
    this.killAttempted = false;
    this.process = spawnProcess(executable, ["-I", "-B", "-X", "utf8", "-c", SERVER_SOURCE, runtimePythonRoot], {
      cwd: workingRoot,
      env: runtimeEnvironment(workingRoot),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.lines = new BoundedLfFramer(this.process.stdout);
    this.process.stdin.on("error", () => {
      // A correlated request observes the owned runtime exit; never surface an unbounded stream error.
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderrBytes = Math.min(STDERR_COUNT_LIMIT, this.stderrBytes + chunk.length);
    });
    this.spawnState = Number.isSafeInteger(this.process.pid) && this.process.pid > 0 ? "spawned" : "pending";
    this.terminationObserved = false;
    this.termination = new Promise((resolveTermination) => {
      const settle = (value) => {
        if (this.terminationObserved) return;
        this.terminationObserved = true;
        resolveTermination(Object.freeze(value));
      };
      this.process.once("spawn", () => {
        if (this.spawnState === "pending") this.spawnState = "spawned";
      });
      this.process.on("error", () => {
        if (this.spawnState === "pending") {
          this.spawnState = "failed";
          settle({ kind: "pre_spawn_error", code: null, signal: null });
        }
      });
      this.process.once("exit", (code, exitSignal) => settle({ kind: "exit", code, signal: exitSignal }));
      this.process.once("close", (code, closeSignal) => settle({ kind: "close", code, signal: closeSignal }));
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
    if (this.terminationObserved || this.process.exitCode !== null || this.process.signalCode !== null) {
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
    if (result.kind === "end") throw new SoakRunError("runtime_exit", phase);
    if (result.kind !== "line" || typeof result.value !== "string") {
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

  requestKill() {
    if (this.terminationObserved || this.killAttempted) return false;
    this.killAttempted = true;
    try {
      return this.process.kill("SIGKILL") === true;
    } catch {
      return false;
    }
  }

  async crash(phase, remaining) {
    if (!this.requestKill()) throw new SoakRunError("scenario_failed", phase);
    const timeoutMs = Math.min(this.stopTimeoutMs, requestDeadline(remaining()));
    await waitWithBound(this.termination, timeoutMs, "runtime_exit", phase, this.signal);
  }

  async stop(phase, remaining = () => this.stopTimeoutMs) {
    if (!this.terminationObserved && this.process.exitCode === null && this.process.signalCode === null) {
      this.process.stdin.end();
    }
    let termination;
    try {
      termination = await waitWithBound(
        this.termination,
        Math.min(this.stopTimeoutMs, requestDeadline(remaining())),
        "cleanup_failed",
        phase,
        undefined
      );
    } catch {
      this.requestKill();
      try {
        termination = await waitWithBound(
          this.termination,
          Math.min(this.stopTimeoutMs, requestDeadline(remaining())),
          "cleanup_failed",
          phase,
          undefined
        );
      } catch {
        return Object.freeze({ settled: false, clean: false });
      }
    }
    return Object.freeze({
      settled: true,
      clean:
        (termination.kind === "exit" || termination.kind === "close") &&
        termination.code === 0 &&
        termination.signal === null
    });
  }

  async forceStop() {
    this.requestKill();
    try {
      await waitWithBound(this.termination, this.stopTimeoutMs, "cleanup_failed", "cleanup", undefined);
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
  constructor({ executable, workingRoot, runtimePythonRoot, sourcePath, seed, signal }) {
    this.executable = executable;
    this.workingRoot = workingRoot;
    this.runtimePythonRoot = runtimePythonRoot;
    this.sourcePath = sourcePath;
    this.seed = seed;
    this.signal = signal;
    this.server = undefined;
    this.runtimeVersion = "unknown";
  }

  async initialize(remainingMs) {
    this.server = new RuntimeServer(this.executable, this.workingRoot, this.runtimePythonRoot, this.signal);
    const response = await this.server.request({ kind: "initialize" }, "initialize", requestDeadline(remainingMs));
    expectKind(response, "initialized", "initialize");
    if (typeof response.runtimeVersion !== "string") throw new SoakRunError("protocol_invalid", "initialize");
    this.runtimeVersion = response.runtimeVersion;
  }

  async runScenario(scenario, iteration, remaining) {
    if (!this.server) throw new SoakRunError("runtime_start_failed", scenario);
    const timeout = () => requestDeadline(remaining());
    if (scenario === "open_page_close") {
      const { sessionId, revision } = await this.openSession(iteration, scenario, remaining);
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
        timeout()
      );
      expectKind(page, "page", scenario);
      const closed = await this.server.request({ kind: "closeSession", sessionId, revision }, scenario, timeout());
      expectKind(closed, "sessionClosed", scenario);
      return;
    }
    if (scenario === "invalid_protocol") {
      const response = await this.server.request({ kind: "initialize" }, scenario, timeout(), 1);
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
        timeout()
      );
      expectErrorCode(response, "unknown_session", scenario);
      return;
    }
    if (scenario === "crash_restart") {
      const { sessionId } = await this.openSession(iteration, scenario, remaining);
      await this.server.crash(scenario, remaining);
      this.server = new RuntimeServer(this.executable, this.workingRoot, this.runtimePythonRoot, this.signal);
      const initialized = await this.server.request({ kind: "initialize" }, scenario, timeout());
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
        timeout()
      );
      expectErrorCode(response, "unknown_session", scenario);
      return;
    }
    throw new SoakRunError("scenario_failed", "prepare");
  }

  async openSession(iteration, phase, remaining) {
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
      requestDeadline(remaining())
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

  async close(remaining = () => STOP_TIMEOUT_MS) {
    if (!this.server) return;
    const current = this.server;
    const exit = await current.stop("cleanup", remaining);
    if (!exit.settled) throw new SoakRunError("cleanup_failed", "cleanup");
    if (this.server === current) this.server = undefined;
    if (!exit.clean) throw new SoakRunError("runtime_exit", "cleanup");
  }

  async forceClose() {
    if (!this.server) return true;
    const current = this.server;
    const settled = await current.forceStop();
    if (settled && this.server === current) this.server = undefined;
    return settled;
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
  onProgress = () => undefined,
  beforeReceipt = async () => undefined,
  onCleanupUncertain = () => undefined
}) {
  const selector = createScenarioSelector(options.seed);
  const counts = new Map(SOAK_SCENARIOS.map((scenario) => [scenario, 0]));
  const startedEpochMs = clock.epochMs();
  const startedMonotonicMs = clock.monotonicMs();
  const deadlineMs = startedMonotonicMs + options.wallSeconds * 1_000;
  let completedIterations = 0;
  let phase = "initialize";
  let failure;
  let retentionAllowed = true;
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
      await adapter.runScenario(scenario, completedIterations + 1, remaining);
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
    await adapter.close(remaining);
    if (clock.monotonicMs() > deadlineMs) throw new SoakRunError("deadline_exceeded", phase);
  } catch (error) {
    const classified = error instanceof SoakRunError ? error : new SoakRunError("scenario_failed", phase);
    failure = { code: classified.code, phase: classified.phase, iteration: initialized ? completedIterations + 1 : 0 };
    const cleanupConfirmed = await adapter.forceClose();
    retentionAllowed = cleanupConfirmed;
    if (!cleanupConfirmed) {
      failure = { code: "cleanup_failed", phase: "cleanup", iteration: completedIterations };
      onCleanupUncertain();
      return Object.freeze({ receipt: undefined, failure, retentionAllowed: false });
    }
  }

  const endedEpochMs = clock.epochMs();
  const elapsedMs = Math.max(0, Math.floor(clock.monotonicMs() - startedMonotonicMs));
  await beforeReceipt();
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
  return Object.freeze({ receipt, failure, retentionAllowed });
}

function gitOutput(root, args, { encoding = "utf8", maxBuffer = 2 * 1024 * 1024 } = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    timeout: 15_000,
    maxBuffer,
    windowsHide: true
  });
}

function trackedSourceEntries(root) {
  const raw = gitOutput(
    root,
    [
      "ls-tree",
      "-r",
      "-z",
      "HEAD",
      "--",
      RUNTIME_SOURCE_ROOT,
      "scripts/soak",
      ...EXECUTED_WORKTREE_PATHS.filter((path) => !path.startsWith("scripts/soak/"))
    ],
    { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }
  );
  const entries = [];
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^100644 blob ([a-f0-9]{40})\t([^\0]+)$/u.exec(record);
    if (!match || match[2].startsWith("/") || match[2].split("/").includes("..")) {
      throw new SoakContractError("The source inventory contains an unsupported entry.");
    }
    entries.push(Object.freeze({ objectId: match[1], path: match[2] }));
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (entries.length < 1 || entries.length > SOURCE_FILE_LIMIT) {
    throw new SoakContractError("The source inventory exceeds its file bound.");
  }
  for (const required of EXECUTED_WORKTREE_PATHS) {
    if (!entries.some((entry) => entry.path === required)) {
      throw new SoakContractError("The source inventory is missing a required executable input.");
    }
  }
  return Object.freeze(entries);
}

function gitBlob(root, objectId) {
  return gitOutput(root, ["cat-file", "blob", objectId], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024
  });
}

function relativeModuleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+[^;]*?\s+from\s+(["'])([^"'\r\n]+)\1\s*;?/gu,
    /(?:^|\n)\s*import\s+(["'])([^"'\r\n]+)\1\s*;?/gu,
    /\b(?:import|require)\s*\(\s*(["'])([^"'\r\n]+)\1\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[2].startsWith(".")) specifiers.add(match[2]);
    }
  }
  return [...specifiers].sort((left, right) => left.localeCompare(right, "en"));
}

function assertLocalImportClosure(entries, expectedBytes) {
  const trackedPaths = new Set(entries.map((entry) => entry.path));
  for (const entry of entries) {
    if (!/\.(?:cjs|js|mjs)$/u.test(entry.path)) continue;
    const source = expectedBytes.get(entry.path)?.bytes.toString("utf8");
    if (source === undefined) throw new SoakContractError("The source inventory is incomplete.");
    for (const specifier of relativeModuleSpecifiers(source)) {
      if (specifier.includes("\\") || specifier.includes("?") || specifier.includes("#")) {
        throw new SoakContractError("A local executable import is not canonical.");
      }
      const importedPath = posix.normalize(posix.join(posix.dirname(entry.path), specifier));
      if (
        importedPath.startsWith("../") ||
        importedPath.startsWith("/") ||
        importedPath === "." ||
        !trackedPaths.has(importedPath)
      ) {
        throw new SoakContractError("A local executable import is outside the exact source inventory.");
      }
    }
  }
}

function assertPortableOwnerRegistration(manifestBytes) {
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new SoakContractError("The package manifest is not valid JSON.");
  }
  const command = manifest?.scripts?.["test:scripts:portable"];
  if (
    typeof command !== "string" ||
    command.split(/\s+/u).filter((token) => token === PORTABLE_OWNER_TEST).length !== 1
  ) {
    throw new SoakContractError("The soak owner test is not registered exactly once in the portable inventory.");
  }
}

async function walkRegularFiles(root, relativeRoot) {
  const files = [];
  const visit = async (relativeDirectory) => {
    const absoluteDirectory = resolve(root, relativeDirectory);
    if (relative(root, absoluteDirectory).split(sep).includes("..")) {
      throw new SoakContractError("The source inventory escaped its root.");
    }
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const relativePath = join(relativeDirectory, child.name).split(sep).join("/");
      if (child.isSymbolicLink()) throw new SoakContractError("The source inventory contains a symbolic link.");
      if (child.isDirectory()) {
        await visit(relativePath);
      } else if (child.isFile()) {
        files.push(relativePath);
        if (files.length > SOURCE_FILE_LIMIT) throw new SoakContractError("The source inventory is too large.");
      } else {
        throw new SoakContractError("The source inventory contains a non-regular entry.");
      }
    }
  };
  await visit(relativeRoot);
  return files;
}

function assertTrackedSourceClean(root) {
  const output = gitOutput(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=no",
    "--",
    RUNTIME_SOURCE_ROOT,
    "scripts/soak",
    ...EXECUTED_WORKTREE_PATHS.filter((path) => !path.startsWith("scripts/soak/"))
  ]);
  if (output.length !== 0) throw new SoakContractError("The executed source differs from the recorded commit.");
}

export async function createSourceAttestation(root, privateRoot) {
  const sourceCommit = gitOutput(root, ["rev-parse", "HEAD"]).trim();
  const sourceTree = gitOutput(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const entries = trackedSourceEntries(root);
  assertTrackedSourceClean(root);
  const trackedPaths = new Set(entries.map((entry) => entry.path));
  for (const sourceRoot of [RUNTIME_SOURCE_ROOT, "scripts/soak"]) {
    const actualPaths = await walkRegularFiles(root, sourceRoot);
    if (actualPaths.some((path) => !trackedPaths.has(path))) {
      throw new SoakContractError("The source roots contain an untracked executable input.");
    }
  }

  const materializedRoot = join(privateRoot, "recorded-source");
  const runtimePythonRoot = join(materializedRoot, "python");
  await mkdir(runtimePythonRoot, { recursive: true, mode: 0o700 });
  let totalBytes = 0;
  const inventory = [];
  const expectedBytes = new Map();
  for (const entry of entries) {
    const bytes = gitBlob(root, entry.objectId);
    totalBytes += bytes.length;
    if (totalBytes > SOURCE_TOTAL_BYTES) throw new SoakContractError("The source inventory exceeds its byte bound.");
    const digest = sha256Hex(bytes);
    inventory.push(Object.freeze({ path: entry.path, byteLength: bytes.length, sha256: digest }));
    expectedBytes.set(entry.path, Object.freeze({ bytes, byteLength: bytes.length, sha256: digest }));
    if (entry.path.startsWith(`${RUNTIME_SOURCE_ROOT}/`) || entry.path === `${RUNTIME_SOURCE_ROOT}/__init__.py`) {
      const destination = join(materializedRoot, ...entry.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
  }
  assertLocalImportClosure(entries, expectedBytes);
  const executedInventorySha256 = sha256Hex(JSON.stringify(inventory));
  const manifest = expectedBytes.get("package.json");
  const lock = expectedBytes.get("package-lock.json");
  if (!manifest || !lock) throw new SoakContractError("The source inventory is missing package metadata.");
  assertPortableOwnerRegistration(manifest.bytes);

  const revalidate = async () => {
    if (
      gitOutput(root, ["rev-parse", "HEAD"]).trim() !== sourceCommit ||
      gitOutput(root, ["rev-parse", "HEAD^{tree}"]).trim() !== sourceTree
    ) {
      throw new SoakContractError("The recorded source identity changed during the soak.");
    }
    assertTrackedSourceClean(root);
    for (const sourceRoot of [RUNTIME_SOURCE_ROOT, "scripts/soak"]) {
      const actualPaths = await walkRegularFiles(root, sourceRoot);
      if (actualPaths.some((path) => !trackedPaths.has(path))) {
        throw new SoakContractError("The source roots gained an untracked executable input.");
      }
    }
    for (const entry of entries.filter((candidate) => !candidate.path.startsWith(`${RUNTIME_SOURCE_ROOT}/`))) {
      const bytes = await readFile(join(root, ...entry.path.split("/")));
      const expected = expectedBytes.get(entry.path);
      if (bytes.length !== expected.byteLength || sha256Hex(bytes) !== expected.sha256) {
        throw new SoakContractError("An executed source file changed during the soak.");
      }
    }
    const materializedPaths = await walkRegularFiles(materializedRoot, RUNTIME_SOURCE_ROOT);
    const runtimeEntries = entries.filter((entry) => entry.path.startsWith(`${RUNTIME_SOURCE_ROOT}/`));
    if (
      materializedPaths.length !== runtimeEntries.length ||
      materializedPaths.some((path, index) => path !== runtimeEntries[index].path)
    ) {
      throw new SoakContractError("The materialized runtime inventory changed during the soak.");
    }
    for (const entry of runtimeEntries) {
      const bytes = await readFile(join(materializedRoot, ...entry.path.split("/")));
      const expected = expectedBytes.get(entry.path);
      if (bytes.length !== expected.byteLength || sha256Hex(bytes) !== expected.sha256) {
        throw new SoakContractError("A materialized runtime file changed during the soak.");
      }
    }
  };
  await revalidate();
  return Object.freeze({
    subject: Object.freeze({
      kind: "source_tree",
      sourceCommit,
      sourceTree,
      executedInventorySha256,
      packageManifestSha256: manifest.sha256,
      dependencyLockSha256: lock.sha256
    }),
    runtimePythonRoot,
    revalidate
  });
}

function probeVersions(executable, runtimePythonRoot, workingRoot) {
  const output = execFileSync(executable, ["-I", "-B", "-X", "utf8", "-c", VERSION_PROBE_SOURCE, runtimePythonRoot], {
    cwd: workingRoot,
    env: runtimeEnvironment(workingRoot),
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
  const path = await mkdtemp(join(tmpdir(), prefix));
  const status = await lstat(path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (process.platform !== "win32" && (status.uid !== process.getuid() || (status.mode & 0o077) !== 0))
  ) {
    throw new SoakContractError("The soak workspace is not privately owned.");
  }
  return Object.freeze({ path, dev: status.dev, ino: status.ino });
}

async function removePrivateRoot(receipt) {
  const status = await lstat(receipt.path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.dev !== receipt.dev ||
    status.ino !== receipt.ino ||
    (process.platform !== "win32" && (status.uid !== process.getuid() || (status.mode & 0o077) !== 0))
  ) {
    throw new SoakContractError("The soak workspace ownership changed before cleanup.");
  }
  await rm(receipt.path, { recursive: true, force: false });
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
  let workingRootReceipt;
  try {
    workingRootReceipt = await verifiedPrivateRoot("openwrangler-soak-work-");
    const workingRoot = workingRootReceipt.path;
    const sourcePath = join(workingRoot, "soak.csv");
    await writeFile(sourcePath, "city,value,flag\nBerlin,12,true\nParis,7,false\nRome,,true\nMadrid,9,false\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const attestation = await createSourceAttestation(repositoryRoot, workingRoot);
    const executable = resolveAndPreflightAcceptancePython({
      profile: "repository-command",
      repositoryRoot,
      environment: process.env,
      platform: process.platform
    });
    const tools = probeVersions(executable, attestation.runtimePythonRoot, workingRoot);
    const identifiers = createRunIdentifiers();
    const adapter = new PythonRuntimeSoakAdapter({
      executable,
      workingRoot,
      runtimePythonRoot: attestation.runtimePythonRoot,
      sourcePath,
      seed: options.seed,
      signal: signalController.signal
    });
    const result = await executeRuntimeSoak({
      options,
      subject: attestation.subject,
      tools,
      identifiers,
      adapter,
      signal: signalController.signal,
      beforeReceipt: attestation.revalidate,
      onCleanupUncertain: () => {
        workingRootReceipt = undefined;
      },
      onProgress: (progress) =>
        stderr(
          `OW_SOAK_PROGRESS seed=${progress.seed} completed=${progress.completedIterations} elapsedMs=${progress.elapsedMs} branches=${progress.branches.map((entry) => `${entry.scenario}:${entry.count}`).join(",")}`
        )
    });
    if (!result.retentionAllowed) {
      // The exact child may still own this private root. Leave it untouched and publish no path.
      workingRootReceipt = undefined;
      stderr(
        `OW_SOAK_FAILED code=${result.failure.code} phase=${result.failure.phase} seed=${options.seed} receipt=none`
      );
      return 1;
    }
    await removePrivateRoot(workingRootReceipt);
    workingRootReceipt = undefined;
    if (!result.failure) {
      stdout(result.receipt.json.trim());
      return 0;
    }
    const retained = await writeFailureReceipt(result.receipt, tmpdir());
    await assertFailureReceiptForEmission(retained);
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
    if (workingRootReceipt) {
      try {
        await removePrivateRoot(workingRootReceipt);
      } catch {
        // Ownership uncertainty deliberately suppresses diagnostics and further traversal.
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRuntimeSoakCli(process.argv.slice(2));
}
