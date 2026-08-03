import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const LINUX_STUDY_SUPERVISOR_PROTOCOL = "openwrangler-linux-study-supervisor-v1";
export const LINUX_STUDY_SUPERVISOR_ERROR_PREFIX = "OPEN_WRANGLER_LINUX_SUPERVISOR_ERROR:";
export const LINUX_STUDY_SUPERVISOR_MAXIMUM_RECEIPT_BYTES = 32 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER_TEXT = /^[1-9]\d*$/u;
const NON_NEGATIVE_INTEGER_TEXT = /^(?:0|[1-9]\d*)$/u;
const NUMERIC_PYTHON_312 = /^3\.12\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAXIMUM_ENVIRONMENT_ENTRIES = 512;
const MAXIMUM_ENVIRONMENT_BYTES = 1024 * 1024;
const MAXIMUM_ARGUMENTS = 256;
const MAXIMUM_ARGUMENT_BYTES = 256 * 1024;
const MAXIMUM_STDERR_BYTES = 4 * 1024;
const MAXIMUM_SOURCE_BYTES = 1024 * 1024;
const MAXIMUM_PYTHON_BYTES = 256 * 1024 * 1024;
const MAXIMUM_RETAINED_IDENTITIES = 256;

export const LINUX_STUDY_SUPERVISOR_INVOCATION_POLICY = Object.freeze({
  argvGrammar: Object.freeze([
    "--protocol",
    "--nonce",
    "--receipt-fd",
    "--payload-environment-sha256",
    "--",
    "payload-argv"
  ]),
  ownership: Object.freeze({
    census: "full-numeric-proc-stat-ppid",
    historyIdentity: "pid-start-time-ticks",
    pidReuse: "latch-invalid-clean-replacement",
    subreaper: true
  }),
  payloadLaunch: Object.freeze({ closeFds: true, spawnCount: 1, startNewSession: true }),
  protocol: LINUX_STUDY_SUPERVISOR_PROTOCOL,
  python: Object.freeze({ implementation: "CPython", major: 3, minor: 12 }),
  signaling: Object.freeze({
    api: "libc-pidfd-symbols",
    identity: "pid-start-time-ticks",
    pidfdRequired: true
  }),
  subreaper: Object.freeze({ get: 37, set: 36, verifiedValue: 1 }),
  version: 1
});

export class LinuxStudySupervisorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "LinuxStudySupervisorError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new LinuxStudySupervisorError(code, message, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail("malformed-receipt", `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("malformed-receipt", `${label} has missing or unknown fields.`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalLinuxStudySupervisorJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digestLinuxStudySupervisorValue(value) {
  return createHash("sha256").update(canonicalLinuxStudySupervisorJson(value), "utf8").digest("hex");
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("malformed-receipt", `${label} is not a lowercase SHA-256 digest.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("malformed-receipt", `${label} must be a positive integer.`);
  }
}

function assertIdentityText(value, label) {
  if (typeof value !== "string" || !NON_NEGATIVE_INTEGER_TEXT.test(value)) {
    fail("malformed-receipt", `${label} is not a process start-time identity.`);
  }
}

function sameFileMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function filesystemIdentity(metadata) {
  return Object.freeze({
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    sizeBytes: Number(metadata.size),
    mtimeNs: metadata.mtimeNs.toString()
  });
}

function captureRegularFile(path, maximumBytes, label) {
  let descriptor;
  let operationError;
  let result;
  try {
    const named = lstatSync(path, { bigint: true });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      named.size <= 0n ||
      named.size > BigInt(maximumBytes)
    ) {
      fail("invalid-input", `${label} must be one bounded, singly linked regular file.`);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFileMetadata(named, opened)) {
      fail("input-changed", `${label} changed while it opened.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    if (!sameFileMetadata(opened, after) || !sameFileMetadata(after, entry) || bytes.length !== Number(opened.size)) {
      fail("input-changed", `${label} changed while it was read.`);
    }
    result = Object.freeze({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      filesystemIdentity: filesystemIdentity(after)
    });
  } catch (error) {
    operationError =
      error instanceof LinuxStudySupervisorError
        ? error
        : new LinuxStudySupervisorError("input-read", `${label} could not be read safely.`, { cause: error });
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined || closeError !== undefined) {
    if (operationError !== undefined && closeError === undefined) throw operationError;
    throw new AggregateError(
      [operationError, closeError].filter(Boolean),
      `${label} validation did not finish cleanly.`
    );
  }
  return result;
}

function captureDefaultSupervisorInputs(supervisorPath, pythonExecutable) {
  let canonicalPython;
  try {
    canonicalPython = realpathSync(pythonExecutable);
  } catch (error) {
    fail("invalid-input", "The Linux study supervisor Python executable could not be resolved.", { cause: error });
  }
  return Object.freeze({
    supervisorSource: captureRegularFile(supervisorPath, MAXIMUM_SOURCE_BYTES, "Linux study supervisor source"),
    pythonExecutable: captureRegularFile(
      canonicalPython,
      MAXIMUM_PYTHON_BYTES,
      "Linux study supervisor Python executable"
    )
  });
}

export function createLinuxStudySupervisorEnvironmentReceipt(environment) {
  if (!isRecord(environment)) fail("invalid-invocation", "Linux study supervisor environment must be an object.");
  const entries = [];
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (!ENVIRONMENT_NAME.test(key) || typeof value !== "string" || value.includes("\0")) {
      fail("invalid-invocation", "Linux study supervisor environment contains an invalid entry.");
    }
    entries.push([key, value]);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    entries.length > MAXIMUM_ENVIRONMENT_ENTRIES ||
    Buffer.byteLength(canonicalLinuxStudySupervisorJson(entries), "utf8") > MAXIMUM_ENVIRONMENT_BYTES
  ) {
    fail("invalid-invocation", "Linux study supervisor environment exceeds its fixed bound.");
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function validatePayloadArgv(payloadArgv) {
  if (
    !Array.isArray(payloadArgv) ||
    payloadArgv.length < 1 ||
    payloadArgv.length > MAXIMUM_ARGUMENTS ||
    payloadArgv.some((argument) => typeof argument !== "string" || argument.includes("\0")) ||
    payloadArgv.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0) > MAXIMUM_ARGUMENT_BYTES
  ) {
    fail("invalid-invocation", "Linux study supervisor payload arguments are missing, malformed, or too large.");
  }
  return Object.freeze([...payloadArgv]);
}

export function buildLinuxStudySupervisorInvocation({ nonce, environment, payloadArgv }) {
  if (typeof nonce !== "string" || !SHA256.test(nonce)) {
    fail("invalid-invocation", "Linux study supervisor nonce must be one lowercase SHA-256 value.");
  }
  const normalizedArgv = validatePayloadArgv(payloadArgv);
  const environmentReceipt = createLinuxStudySupervisorEnvironmentReceipt(environment);
  const payloadArgvSha256 = digestLinuxStudySupervisorValue(normalizedArgv);
  const payloadEnvironmentSha256 = digestLinuxStudySupervisorValue(environmentReceipt);
  const invocationPolicySha256 = digestLinuxStudySupervisorValue(LINUX_STUDY_SUPERVISOR_INVOCATION_POLICY);
  const invocationSha256 = digestLinuxStudySupervisorValue({
    nonce,
    payloadArgvSha256,
    payloadEnvironmentSha256,
    policySha256: invocationPolicySha256,
    protocol: LINUX_STUDY_SUPERVISOR_PROTOCOL,
    receiptFd: 3
  });
  return Object.freeze({
    nonce,
    environmentReceipt,
    payloadArgv: normalizedArgv,
    payloadArgvSha256,
    payloadEnvironmentSha256,
    invocationPolicySha256,
    invocationSha256,
    supervisorArguments: Object.freeze([
      "--protocol",
      LINUX_STUDY_SUPERVISOR_PROTOCOL,
      "--nonce",
      nonce,
      "--receipt-fd",
      "3",
      "--payload-environment-sha256",
      payloadEnvironmentSha256,
      "--",
      ...normalizedArgv
    ])
  });
}

function parseProcStat(text, pid) {
  if (typeof text !== "string" || text.length > 16 * 1024) {
    fail("process-identity", `Process identity for PID ${pid} is missing or too large.`);
  }
  const closingParenthesis = text.lastIndexOf(")");
  if (!text.startsWith(`${pid} (`) || closingParenthesis <= 0) {
    fail("process-identity", `Process identity for PID ${pid} is malformed.`);
  }
  const fields = text
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) fail("process-identity", `Process identity for PID ${pid} is incomplete.`);
  const [state, parentPidText, processGroupIdText, sessionIdText] = fields;
  const startTimeTicks = fields[19];
  if (
    !/^\S$/u.test(state ?? "") ||
    !NON_NEGATIVE_INTEGER_TEXT.test(parentPidText ?? "") ||
    !NON_NEGATIVE_INTEGER_TEXT.test(processGroupIdText ?? "") ||
    !NON_NEGATIVE_INTEGER_TEXT.test(sessionIdText ?? "") ||
    !NON_NEGATIVE_INTEGER_TEXT.test(startTimeTicks ?? "")
  ) {
    fail("process-identity", `Process identity for PID ${pid} is malformed.`);
  }
  return Object.freeze({
    pid,
    state,
    parentPid: Number(parentPidText),
    processGroupId: Number(processGroupIdText),
    sessionId: Number(sessionIdText),
    startTimeTicks
  });
}

function readDefaultProcessIdentity(pid) {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    if (error instanceof LinuxStudySupervisorError) throw error;
    fail("process-identity", `Process identity for PID ${pid} could not be read.`, { cause: error });
  }
}

function validateFilesystemIdentity(value, label) {
  exactKeys(value, ["device", "inode", "sizeBytes", "mtimeNs"], label);
  if (
    !NON_NEGATIVE_INTEGER_TEXT.test(value.device) ||
    !NON_NEGATIVE_INTEGER_TEXT.test(value.inode) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    !NON_NEGATIVE_INTEGER_TEXT.test(value.mtimeNs)
  ) {
    fail("malformed-receipt", `${label} is malformed.`);
  }
}

function validateFileProvenance(value, label) {
  exactKeys(value, ["sha256", "filesystemIdentity"], label);
  assertSha256(value.sha256, `${label} SHA-256`);
  validateFilesystemIdentity(value.filesystemIdentity, `${label} filesystem identity`);
}

function sameJson(left, right) {
  return canonicalLinuxStudySupervisorJson(left) === canonicalLinuxStudySupervisorJson(right);
}

function validateLaunchReceipt(receipt, expected, readProcessIdentity) {
  exactKeys(
    receipt,
    [
      "protocol",
      "kind",
      "nonce",
      "supervisor",
      "editorRoot",
      "supervisorSource",
      "pythonExecutable",
      "invocationPolicySha256",
      "invocationSha256",
      "payloadArgvSha256",
      "payloadEnvironmentSha256"
    ],
    "Linux study supervisor launch receipt"
  );
  if (
    receipt.protocol !== LINUX_STUDY_SUPERVISOR_PROTOCOL ||
    receipt.kind !== "launch" ||
    receipt.nonce !== expected.invocation.nonce
  ) {
    fail("receipt-correlation", "Linux study supervisor launch receipt is stale or mis-correlated.");
  }
  exactKeys(
    receipt.supervisor,
    ["pid", "startTimeTicks", "subreaperVerified", "pidfdVerified"],
    "Linux study supervisor identity"
  );
  assertPositiveInteger(receipt.supervisor.pid, "Linux study supervisor PID");
  assertIdentityText(receipt.supervisor.startTimeTicks, "Linux study supervisor start time");
  if (
    receipt.supervisor.pid !== expected.childPid ||
    receipt.supervisor.subreaperVerified !== true ||
    receipt.supervisor.pidfdVerified !== true
  ) {
    fail("ownership-ambiguity", "Linux study supervisor launch identity does not match its spawned process.");
  }
  exactKeys(
    receipt.editorRoot,
    ["pid", "startTimeTicks", "processGroupId", "sessionId"],
    "Linux study editor-root identity"
  );
  assertPositiveInteger(receipt.editorRoot.pid, "Linux study editor-root PID");
  assertIdentityText(receipt.editorRoot.startTimeTicks, "Linux study editor-root start time");
  if (
    receipt.editorRoot.pid === receipt.supervisor.pid ||
    receipt.editorRoot.processGroupId !== receipt.editorRoot.pid ||
    receipt.editorRoot.sessionId !== receipt.editorRoot.pid
  ) {
    fail("ownership-ambiguity", "Linux study editor root does not own its launch-time process group and session.");
  }
  validateFileProvenance(receipt.supervisorSource, "Linux study supervisor source");
  exactKeys(
    receipt.pythonExecutable,
    ["implementation", "version", "sha256", "filesystemIdentity"],
    "Linux study supervisor Python executable"
  );
  if (
    receipt.pythonExecutable.implementation !== "CPython" ||
    typeof receipt.pythonExecutable.version !== "string" ||
    !NUMERIC_PYTHON_312.test(receipt.pythonExecutable.version)
  ) {
    fail("malformed-receipt", "Linux study supervisor did not run under the required CPython 3.12 executable.");
  }
  assertSha256(receipt.pythonExecutable.sha256, "Linux study supervisor Python SHA-256");
  validateFilesystemIdentity(
    receipt.pythonExecutable.filesystemIdentity,
    "Linux study supervisor Python filesystem identity"
  );
  for (const [field, value] of Object.entries({
    invocationPolicySha256: expected.invocation.invocationPolicySha256,
    invocationSha256: expected.invocation.invocationSha256,
    payloadArgvSha256: expected.invocation.payloadArgvSha256,
    payloadEnvironmentSha256: expected.invocation.payloadEnvironmentSha256
  })) {
    assertSha256(receipt[field], `Linux study supervisor ${field}`);
    if (receipt[field] !== value) {
      fail("receipt-correlation", `Linux study supervisor ${field} does not match the sealed invocation.`);
    }
  }
  if (
    !sameJson(receipt.supervisorSource, expected.inputs.supervisorSource) ||
    receipt.pythonExecutable.sha256 !== expected.inputs.pythonExecutable.sha256 ||
    !sameJson(receipt.pythonExecutable.filesystemIdentity, expected.inputs.pythonExecutable.filesystemIdentity)
  ) {
    fail("input-changed", "Linux study supervisor source or Python executable changed before launch.");
  }

  const observedSupervisor = readProcessIdentity(receipt.supervisor.pid);
  const observedEditor = readProcessIdentity(receipt.editorRoot.pid);
  if (
    observedSupervisor?.startTimeTicks !== receipt.supervisor.startTimeTicks ||
    observedEditor?.startTimeTicks !== receipt.editorRoot.startTimeTicks ||
    observedEditor.parentPid !== receipt.supervisor.pid ||
    observedEditor.processGroupId !== receipt.editorRoot.pid ||
    observedEditor.sessionId !== receipt.editorRoot.pid
  ) {
    fail("ownership-ambiguity", "Linux study supervisor process identities changed before sampling could start.");
  }
  return Object.freeze(receipt);
}

function validateTerminalReceipt(receipt, launchReceipt) {
  exactKeys(
    receipt,
    [
      "protocol",
      "kind",
      "nonce",
      "supervisor",
      "editorRoot",
      "retainedOwnedIdentities",
      "identityReuseEvents",
      "emptyCensusProof",
      "supervisorExitCode"
    ],
    "Linux study supervisor terminal receipt"
  );
  if (
    receipt.protocol !== LINUX_STUDY_SUPERVISOR_PROTOCOL ||
    receipt.kind !== "terminal-cleanup" ||
    receipt.nonce !== launchReceipt.nonce
  ) {
    fail("receipt-correlation", "Linux study supervisor terminal receipt is stale or mis-correlated.");
  }
  exactKeys(receipt.supervisor, ["pid", "startTimeTicks"], "Linux study cleanup supervisor identity");
  exactKeys(receipt.editorRoot, ["pid", "startTimeTicks"], "Linux study cleanup editor-root identity");
  if (
    receipt.supervisor.pid !== launchReceipt.supervisor.pid ||
    receipt.supervisor.startTimeTicks !== launchReceipt.supervisor.startTimeTicks ||
    receipt.editorRoot.pid !== launchReceipt.editorRoot.pid ||
    receipt.editorRoot.startTimeTicks !== launchReceipt.editorRoot.startTimeTicks
  ) {
    fail("ownership-ambiguity", "Linux study supervisor terminal receipt changed a launch-time process identity.");
  }
  if (
    !Array.isArray(receipt.retainedOwnedIdentities) ||
    receipt.retainedOwnedIdentities.length < 1 ||
    receipt.retainedOwnedIdentities.length > MAXIMUM_RETAINED_IDENTITIES
  ) {
    fail("malformed-receipt", "Linux study supervisor retained-process list is missing or exceeds its bound.");
  }
  const retained = new Set();
  const retainedStartTimes = new Map();
  let includesEditorRoot = false;
  for (const identity of receipt.retainedOwnedIdentities) {
    exactKeys(identity, ["pid", "startTimeTicks", "disposition"], "Linux study retained process identity");
    assertPositiveInteger(identity.pid, "Linux study retained PID");
    assertIdentityText(identity.startTimeTicks, "Linux study retained process start time");
    if (identity.disposition !== "exited" && identity.disposition !== "terminated") {
      fail("malformed-receipt", "Linux study retained process disposition is invalid.");
    }
    const key = `${identity.pid}:${identity.startTimeTicks}`;
    if (retained.has(key)) fail("ownership-ambiguity", "Linux study terminal receipt repeats a process identity.");
    const retainedStartTime = retainedStartTimes.get(identity.pid);
    if (retainedStartTime !== undefined && retainedStartTime !== identity.startTimeTicks) {
      fail("pid-reuse", "Linux study terminal receipt contains more than one identity for the same PID.");
    }
    retained.add(key);
    retainedStartTimes.set(identity.pid, identity.startTimeTicks);
    includesEditorRoot ||= key === `${receipt.editorRoot.pid}:${receipt.editorRoot.startTimeTicks}`;
  }
  if (!includesEditorRoot) {
    fail("ownership-ambiguity", "Linux study terminal receipt omits the editor root.");
  }
  if (!Array.isArray(receipt.identityReuseEvents) || receipt.identityReuseEvents.length > MAXIMUM_RETAINED_IDENTITIES) {
    fail("malformed-receipt", "Linux study PID-reuse list is malformed or exceeds its bound.");
  }
  for (const event of receipt.identityReuseEvents) {
    exactKeys(event, ["pid", "previousStartTimeTicks", "replacementStartTimeTicks"], "Linux study PID-reuse event");
    assertPositiveInteger(event.pid, "Linux study reused PID");
    assertIdentityText(event.previousStartTimeTicks, "Linux study previous PID start time");
    assertIdentityText(event.replacementStartTimeTicks, "Linux study replacement PID start time");
  }
  if (receipt.identityReuseEvents.length !== 0) {
    fail("pid-reuse", "Linux study process ownership became ambiguous after a PID was reused.");
  }
  exactKeys(receipt.emptyCensusProof, ["requiredConsecutiveChecks", "checks"], "Linux study empty census proof");
  if (
    receipt.emptyCensusProof.requiredConsecutiveChecks !== 3 ||
    !Array.isArray(receipt.emptyCensusProof.checks) ||
    receipt.emptyCensusProof.checks.length !== 3
  ) {
    fail("cleanup-proof", "Linux study supervisor did not report three empty ownership censuses.");
  }
  let previous = -1n;
  for (const check of receipt.emptyCensusProof.checks) {
    exactKeys(check, ["monotonicNanoseconds", "ownedProcessCount"], "Linux study empty census check");
    if (
      typeof check.monotonicNanoseconds !== "string" ||
      !POSITIVE_INTEGER_TEXT.test(check.monotonicNanoseconds) ||
      check.ownedProcessCount !== 0 ||
      BigInt(check.monotonicNanoseconds) <= previous
    ) {
      fail("cleanup-proof", "Linux study empty ownership censuses are malformed or out of order.");
    }
    previous = BigInt(check.monotonicNanoseconds);
  }
  if (
    !Number.isSafeInteger(receipt.supervisorExitCode) ||
    receipt.supervisorExitCode < 0 ||
    receipt.supervisorExitCode > 255
  ) {
    fail("malformed-receipt", "Linux study supervisor exit code is invalid.");
  }
  return Object.freeze(receipt);
}

export function createBoundedLinuxStudySupervisorFrameReader(
  stream,
  { maximumBytes = LINUX_STUDY_SUPERVISOR_MAXIMUM_RECEIPT_BYTES } = {}
) {
  if (
    !stream ||
    typeof stream.on !== "function" ||
    typeof stream.once !== "function" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > LINUX_STUDY_SUPERVISOR_MAXIMUM_RECEIPT_BYTES
  ) {
    fail("invalid-stream", "Linux study supervisor receipt reader requires one bounded readable stream.");
  }
  stream.setEncoding?.("utf8");
  let buffered = "";
  let ended = false;
  let failure;
  let frameCount = 0;
  const queued = [];
  const waiters = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectDone = rejectPromise;
  });
  void done.catch(() => {});
  const reject = (error) => {
    if (failure !== undefined) return;
    failure =
      error instanceof LinuxStudySupervisorError
        ? error
        : new LinuxStudySupervisorError("receipt-stream", "Linux study supervisor receipt stream failed.", {
            cause: error
          });
    rejectDone(failure);
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
  };
  const publish = (frame) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else queued.push(frame);
  };
  stream.on("data", (chunk) => {
    if (failure !== undefined) return;
    try {
      if (typeof chunk !== "string") fail("receipt-stream", "Linux study supervisor emitted non-text receipt data.");
      buffered += chunk;
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const frame = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(frame, "utf8") > maximumBytes) {
          fail("receipt-limit", "Linux study supervisor receipt exceeded its byte limit.");
        }
        frameCount += 1;
        if (frameCount > 2) fail("extra-receipt", "Linux study supervisor emitted an extra receipt frame.");
        let parsed;
        try {
          parsed = JSON.parse(frame);
        } catch (error) {
          fail("malformed-receipt", "Linux study supervisor emitted invalid JSON.", { cause: error });
        }
        if (canonicalLinuxStudySupervisorJson(parsed) !== frame) {
          fail("malformed-receipt", "Linux study supervisor receipt is not in canonical JSON form.");
        }
        publish(parsed);
      }
      if (Buffer.byteLength(buffered, "utf8") > maximumBytes) {
        fail("receipt-limit", "Linux study supervisor receipt exceeded its byte limit.");
      }
    } catch (error) {
      reject(error);
    }
  });
  stream.once("error", reject);
  stream.once("close", () => {
    if (!ended) {
      reject(
        new LinuxStudySupervisorError(
          "missing-receipt",
          "Linux study supervisor receipt stream closed before its complete frame pair."
        )
      );
    }
  });
  stream.once("end", () => {
    ended = true;
    if (failure !== undefined) return;
    try {
      if (buffered !== "") fail("malformed-receipt", "Linux study supervisor ended with an incomplete receipt frame.");
      if (frameCount !== 2)
        fail("missing-receipt", "Linux study supervisor did not emit launch and terminal receipts.");
      resolveDone();
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new LinuxStudySupervisorError("missing-receipt", "Linux study supervisor receipt stream ended."));
      }
    } catch (error) {
      reject(error);
    }
  });
  return Object.freeze({
    done,
    nextFrame() {
      if (failure !== undefined) return Promise.reject(failure);
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (ended) {
        return Promise.reject(
          new LinuxStudySupervisorError("missing-receipt", "Linux study supervisor receipt stream ended.")
        );
      }
      return new Promise((resolvePromise, rejectPromise) => {
        waiters.push({ resolve: resolvePromise, reject: rejectPromise });
      });
    }
  });
}

function observeChildClose(child) {
  return new Promise((resolvePromise) => {
    let firstError;
    child.on("error", (error) => {
      firstError ??= error;
    });
    child.once("close", (code, signal) => resolvePromise({ code, signal, error: firstError }));
  });
}

function captureBoundedStderr(stream) {
  let bytes = 0;
  const chunks = [];
  let failure;
  stream?.on("data", (chunk) => {
    if (failure !== undefined) return;
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAXIMUM_STDERR_BYTES) {
      failure = new LinuxStudySupervisorError("stderr-limit", "Linux study supervisor stderr exceeded its byte limit.");
      return;
    }
    chunks.push(value);
  });
  return Object.freeze({
    error() {
      return failure;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    }
  });
}

function assertSpawnOptions(options) {
  if (
    !isRecord(options) ||
    !isRecord(options.env) ||
    !Array.isArray(options.stdio) ||
    options.stdio.length !== 3 ||
    options.stdio[0] !== "ignore" ||
    options.stdio[1] !== "pipe" ||
    options.stdio[2] !== "pipe"
  ) {
    fail("invalid-invocation", "Linux study supervisor adapter received unsupported editor spawn options.");
  }
}

export function createLinuxStudySupervisorSpawnAdapter(
  {
    pythonExecutable,
    supervisorPath = resolve(import.meta.dirname, "linux-study-supervisor.py"),
    nonce = randomBytes(32).toString("hex")
  },
  {
    platform = process.platform,
    spawnProcess = spawn,
    captureInputs = captureDefaultSupervisorInputs,
    readProcessIdentity = readDefaultProcessIdentity
  } = {}
) {
  if (platform !== "linux") fail("unsupported-platform", "Linux study supervisor adapter requires Linux.");
  if (
    typeof pythonExecutable !== "string" ||
    !isAbsolute(pythonExecutable) ||
    /[\0\r\n]/u.test(pythonExecutable) ||
    typeof supervisorPath !== "string" ||
    !isAbsolute(supervisorPath) ||
    /[\0\r\n]/u.test(supervisorPath) ||
    typeof spawnProcess !== "function" ||
    typeof captureInputs !== "function" ||
    typeof readProcessIdentity !== "function"
  ) {
    fail("invalid-invocation", "Linux study supervisor adapter requires absolute inputs and callable dependencies.");
  }
  if (!SHA256.test(nonce)) fail("invalid-invocation", "Linux study supervisor adapter nonce is invalid.");
  const inputs = captureInputs(supervisorPath, pythonExecutable);
  let started = false;
  let launchPromise;
  let completionPromise;
  let spawnedChild;

  const spawnAdapter = (payloadExecutable, payloadArguments, options) => {
    if (started) fail("duplicate-launch", "Linux study supervisor adapter may launch only one editor tree.");
    started = true;
    if (typeof payloadExecutable !== "string" || payloadExecutable.length === 0 || !Array.isArray(payloadArguments)) {
      fail("invalid-invocation", "Linux study supervisor adapter received malformed editor arguments.");
    }
    assertSpawnOptions(options);
    const invocation = buildLinuxStudySupervisorInvocation({
      nonce,
      environment: options.env,
      payloadArgv: [payloadExecutable, ...payloadArguments]
    });
    const child = spawnProcess(pythonExecutable, [supervisorPath, ...invocation.supervisorArguments], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      detached: options.detached === true,
      env: options.env,
      windowsHide: options.windowsHide === true,
      stdio: ["ignore", "pipe", "pipe", "pipe"]
    });
    spawnedChild = child;
    if (
      !child ||
      !Number.isSafeInteger(child.pid) ||
      child.pid < 1 ||
      !Array.isArray(child.stdio) ||
      !child.stdio[3] ||
      typeof child.stdio[3].on !== "function"
    ) {
      try {
        child?.kill?.("SIGKILL");
      } catch {
        // The launch is already classified as unowned below.
      }
      fail("spawn-failure", "Linux study supervisor did not expose its correlated receipt pipe.");
    }
    const stderr = captureBoundedStderr(child.stderr);
    const close = observeChildClose(child);
    const reader = createBoundedLinuxStudySupervisorFrameReader(child.stdio[3]);
    launchPromise = reader
      .nextFrame()
      .then((receipt) =>
        validateLaunchReceipt(receipt, { childPid: child.pid, inputs, invocation }, readProcessIdentity)
      );
    completionPromise = (async () => {
      const launchReceipt = await launchPromise;
      const terminalReceipt = validateTerminalReceipt(await reader.nextFrame(), launchReceipt);
      const [, closeState] = await Promise.all([reader.done, close]);
      const stderrFailure = stderr.error();
      if (stderrFailure !== undefined) throw stderrFailure;
      if (closeState.error !== undefined) {
        fail("spawn-failure", "Linux study supervisor process reported a launch error.", { cause: closeState.error });
      }
      if (closeState.signal !== null || closeState.code !== terminalReceipt.supervisorExitCode) {
        fail("terminal-mismatch", "Linux study supervisor process exit does not match its terminal receipt.");
      }
      if (stderr.text() !== "") {
        fail("supervisor-failure", "Linux study supervisor reported an error on stderr.");
      }
      for (const identity of [terminalReceipt.supervisor, ...terminalReceipt.retainedOwnedIdentities]) {
        const observed = readProcessIdentity(identity.pid);
        if (observed !== null) {
          fail(
            observed.startTimeTicks === identity.startTimeTicks ? "cleanup-proof" : "pid-reuse",
            `Linux study process identity ${identity.pid}:${identity.startTimeTicks} is not unambiguously absent after cleanup.`
          );
        }
      }
      return Object.freeze({ launchReceipt, terminalReceipt, exit: Object.freeze(closeState) });
    })();
    void completionPromise.catch(() => {});
    return child;
  };

  return Object.freeze({
    spawnProcess: spawnAdapter,
    waitForLaunch() {
      if (launchPromise === undefined) {
        return Promise.reject(
          new LinuxStudySupervisorError("not-started", "Linux study supervisor has not started an editor tree.")
        );
      }
      return launchPromise;
    },
    waitForCompletion() {
      if (completionPromise === undefined) {
        return Promise.reject(
          new LinuxStudySupervisorError("not-started", "Linux study supervisor has not started an editor tree.")
        );
      }
      return completionPromise;
    },
    child() {
      return spawnedChild;
    }
  });
}

export function readLinuxProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail("invalid-invocation", "Linux process PID must be positive.");
  return readDefaultProcessIdentity(pid);
}

export function resolveLinuxStudySupervisorExecutable(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail("invalid-invocation", "Linux process PID must be positive.");
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch (error) {
    fail("process-identity", `Linux process executable for PID ${pid} could not be read.`, { cause: error });
  }
}

export const LINUX_STUDY_SUPERVISOR_INTERNALS = Object.freeze({
  parseProcStat,
  validateLaunchReceipt,
  validateTerminalReceipt
});
