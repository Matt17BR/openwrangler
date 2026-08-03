import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL,
  withDataWranglerComparisonSourceCopyDescriptor
} from "./data-wrangler-comparison-source-copy.mjs";

export const DATA_WRANGLER_COMPARISON_CACHE_CONTROLLER_PROTOCOL =
  "openwrangler-data-wrangler-comparison-cache-controller-v1";
export const DATA_WRANGLER_COMPARISON_CACHE_TOOLCHAIN_PROTOCOL =
  "openwrangler-data-wrangler-comparison-cache-toolchain-v1";

const STUDY_V2_PROOF_PROTOCOL = "openwrangler-source-cache-proof-study-v2";
const STUDY_V2_TOOLCHAIN_PROTOCOL = "openwrangler-cache-toolchain-study-v2";
const MAXIMUM_AUTHORITY_BYTES = 256 * 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 32 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const CHILD_CONTROLLER_PATH = "/proc/self/fd/3";
const CHILD_PYTHON_PATH = "/proc/self/fd/4";
const CHILD_SOURCE_DESCRIPTOR = 5;

function fail(message, cause) {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be one canonical absolute single-line path.`);
  }
  return value;
}

function snapshot(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  });
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function publicIdentity(value) {
  return Object.freeze({
    device: value.dev.toString(),
    inode: value.ino.toString(),
    sizeBytes: Number(value.size),
    mtimeNs: value.mtimeNs.toString()
  });
}

function hashDescriptor(descriptor, size) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Number(size)));
  let position = 0;
  while (position < Number(size)) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(size) - position), position);
    if (!Number.isSafeInteger(count) || count <= 0) fail("A comparison authority ended before its pinned size.");
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  if (readSync(descriptor, buffer, 0, 1, position) !== 0) {
    fail("A comparison authority exceeded its pinned size.");
  }
  return digest.digest("hex");
}

function openAuthority(path, label) {
  const authorityPath = absolutePath(path, label);
  let descriptor;
  try {
    descriptor = openSync(
      authorityPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(authorityPath, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1n ||
      opened.size <= 0n ||
      opened.size > BigInt(MAXIMUM_AUTHORITY_BYTES) ||
      !sameSnapshot(snapshot(opened), snapshot(named))
    ) {
      fail(`${label} must be one bounded no-follow single-link regular file.`);
    }
    const openedSnapshot = snapshot(opened);
    const sha256 = hashDescriptor(descriptor, opened.size);
    const completed = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(authorityPath, { bigint: true });
    if (!sameSnapshot(openedSnapshot, snapshot(completed)) || !sameSnapshot(openedSnapshot, snapshot(namedAfter))) {
      fail(`${label} changed while it was hashed.`);
    }
    return {
      path: authorityPath,
      descriptor,
      snapshot: openedSnapshot,
      receipt: Object.freeze({ sha256, filesystemIdentity: publicIdentity(openedSnapshot) })
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    fail(`${label} could not be pinned.`, error);
  }
}

function assertAuthority(authority, label) {
  const opened = fstatSync(authority.descriptor, { bigint: true });
  const named = lstatSync(authority.path, { bigint: true });
  const sha256 = hashDescriptor(authority.descriptor, authority.snapshot.size);
  const completed = fstatSync(authority.descriptor, { bigint: true });
  const namedAfter = lstatSync(authority.path, { bigint: true });
  if (
    !sameSnapshot(authority.snapshot, snapshot(opened)) ||
    !sameSnapshot(authority.snapshot, snapshot(named)) ||
    sha256 !== authority.receipt.sha256 ||
    !sameSnapshot(authority.snapshot, snapshot(completed)) ||
    !sameSnapshot(authority.snapshot, snapshot(namedAfter))
  ) {
    fail(`${label} changed after its host receipt was pinned.`);
  }
}

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      );
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function validateFilesystemIdentity(value, label) {
  exactKeys(value, ["device", "inode", "sizeBytes", "mtimeNs"], label);
  if (
    typeof value.device !== "string" ||
    !/^\d+$/u.test(value.device) ||
    typeof value.inode !== "string" ||
    !/^\d+$/u.test(value.inode) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    typeof value.mtimeNs !== "string" ||
    !/^\d+$/u.test(value.mtimeNs)
  ) {
    fail(`${label} is invalid.`);
  }
}

function parseProof(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAXIMUM_OUTPUT_BYTES) {
    fail("The study-v2 cache controller returned invalid bounded output.");
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    fail("The study-v2 cache controller did not return strict JSON.", error);
  }
}

function validateProof(proof, sourceCopy, cacheState, controller, pythonExecutable) {
  exactKeys(
    proof,
    [
      "protocol",
      "requestedState",
      "fdatasyncApplied",
      "adviceAccepted",
      "verification",
      "pageSizeBytes",
      "totalPages",
      "residentPagesBefore",
      "residentPagesAfter",
      "identityStable",
      "verified",
      "sourceFilesystemIdentityBefore",
      "sourceFilesystemIdentityAfter",
      "controller",
      "pythonExecutable"
    ],
    "Study-v2 cache proof"
  );
  exactKeys(proof.controller, ["sha256", "filesystemIdentity"], "Study-v2 controller proof");
  exactKeys(
    proof.pythonExecutable,
    ["implementation", "version", "sha256", "filesystemIdentity"],
    "Study-v2 Python proof"
  );
  for (const [identity, label] of [
    [proof.sourceFilesystemIdentityBefore, "Study-v2 source identity before"],
    [proof.sourceFilesystemIdentityAfter, "Study-v2 source identity after"],
    [proof.controller.filesystemIdentity, "Study-v2 controller identity"],
    [proof.pythonExecutable.filesystemIdentity, "Study-v2 Python identity"]
  ]) {
    validateFilesystemIdentity(identity, label);
  }
  const sizeBytes = sourceCopy.copyReceipt.filesystemIdentity.sizeBytes;
  const expectedPages = Math.ceil(sizeBytes / proof.pageSizeBytes);
  const expectedState = cacheState === "warm" ? "resident" : "evicted";
  if (
    proof.protocol !== STUDY_V2_PROOF_PROTOCOL ||
    proof.requestedState !== expectedState ||
    proof.fdatasyncApplied !== true ||
    proof.adviceAccepted !== (cacheState === "cold") ||
    proof.verification !== "linux-mincore" ||
    !Number.isSafeInteger(proof.pageSizeBytes) ||
    proof.pageSizeBytes <= 0 ||
    !Number.isSafeInteger(proof.totalPages) ||
    proof.totalPages !== expectedPages ||
    !Number.isSafeInteger(proof.residentPagesBefore) ||
    proof.residentPagesBefore < 0 ||
    proof.residentPagesBefore > expectedPages ||
    !Number.isSafeInteger(proof.residentPagesAfter) ||
    proof.residentPagesAfter !== (cacheState === "warm" ? expectedPages : 0) ||
    proof.identityStable !== true ||
    proof.verified !== true ||
    !sameJson(proof.sourceFilesystemIdentityBefore, sourceCopy.copyReceipt.filesystemIdentity) ||
    !sameJson(proof.sourceFilesystemIdentityAfter, sourceCopy.copyReceipt.filesystemIdentity) ||
    !SHA256.test(proof.controller.sha256 ?? "") ||
    !sameJson(proof.controller, controller.receipt) ||
    proof.pythonExecutable?.implementation !== "CPython" ||
    typeof proof.pythonExecutable?.version !== "string" ||
    !SHA256.test(proof.pythonExecutable?.sha256 ?? "") ||
    proof.pythonExecutable.sha256 !== pythonExecutable.receipt.sha256 ||
    !sameJson(proof.pythonExecutable.filesystemIdentity, pythonExecutable.receipt.filesystemIdentity)
  ) {
    fail("The study-v2 cache proof does not match its host-pinned source and toolchain.");
  }
  return proof;
}

function toolchainReceipt(controller, pythonExecutable, runtimePython) {
  return Object.freeze({
    protocol: DATA_WRANGLER_COMPARISON_CACHE_TOOLCHAIN_PROTOCOL,
    controller: controller.receipt,
    pythonExecutable: Object.freeze({
      implementation: runtimePython.implementation,
      version: runtimePython.version,
      ...pythonExecutable.receipt
    })
  });
}

function runPinnedToolchainDescription(controller, pythonExecutable, spawn) {
  const result = spawn(
    CHILD_PYTHON_PATH,
    [CHILD_CONTROLLER_PATH, "--contract", "toolchain-v2", "--controller-fd", "3", "--python-fd", "4"],
    {
      argv0: pythonExecutable.path,
      cwd: dirname(controller.path),
      encoding: "utf8",
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PYTHONHASHSEED: "0",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      maxBuffer: MAXIMUM_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe", controller.descriptor, pythonExecutable.descriptor],
      timeout: 30_000,
      windowsHide: true
    }
  );
  if (result?.error !== undefined || result?.status !== 0 || result?.signal !== null || result?.stderr !== "") {
    fail("The study-v2 toolchain probe did not exit cleanly.");
  }
  const description = parseProof(result.stdout);
  exactKeys(description, ["protocol", "controller", "pythonExecutable"], "Study-v2 toolchain description");
  exactKeys(description.controller, ["sha256", "filesystemIdentity"], "Study-v2 toolchain controller");
  exactKeys(
    description.pythonExecutable,
    ["implementation", "version", "sha256", "filesystemIdentity"],
    "Study-v2 toolchain Python"
  );
  if (
    description.protocol !== STUDY_V2_TOOLCHAIN_PROTOCOL ||
    description.pythonExecutable.implementation !== "CPython" ||
    typeof description.pythonExecutable.version !== "string" ||
    !sameJson(description.controller, controller.receipt) ||
    description.pythonExecutable.sha256 !== pythonExecutable.receipt.sha256 ||
    !sameJson(description.pythonExecutable.filesystemIdentity, pythonExecutable.receipt.filesystemIdentity)
  ) {
    fail("The running study-v2 toolchain does not match its host-pinned files.");
  }
  return description;
}

export function captureDataWranglerComparisonStudyV2Toolchain(
  { pythonExecutablePath, controllerPath },
  { spawn = spawnSync } = {}
) {
  if (spawn !== spawnSync && typeof spawn !== "function") fail("The study-v2 toolchain spawn seam must be a function.");
  const controller = openAuthority(controllerPath, "The study-v2 cache controller");
  let pythonExecutable;
  try {
    pythonExecutable = openAuthority(pythonExecutablePath, "The study-v2 Python executable");
  } catch (error) {
    closeSync(controller.descriptor);
    throw error;
  }
  let operationError;
  let receipt;
  const closeErrors = [];
  try {
    assertAuthority(controller, "The study-v2 cache controller");
    assertAuthority(pythonExecutable, "The study-v2 Python executable");
    const description = runPinnedToolchainDescription(controller, pythonExecutable, spawn);
    assertAuthority(controller, "The study-v2 cache controller");
    assertAuthority(pythonExecutable, "The study-v2 Python executable");
    receipt = toolchainReceipt(controller, pythonExecutable, description.pythonExecutable);
  } catch (error) {
    operationError = error;
  }
  for (const authority of [pythonExecutable, controller]) {
    try {
      closeSync(authority.descriptor);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (operationError !== undefined || closeErrors.length > 0) {
    throw new AggregateError(
      operationError === undefined ? closeErrors : [operationError, ...closeErrors],
      "Could not capture the study-v2 cache toolchain."
    );
  }
  return receipt;
}

export function runDataWranglerComparisonStudyV2CacheController(
  { sourceCopy, cacheState, pythonExecutablePath, controllerPath },
  { spawn = spawnSync, faultInjector } = {}
) {
  if (sourceCopy?.protocol !== DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL) {
    fail("The study-v2 cache controller requires one live comparison source-copy lease.");
  }
  if (!["warm", "cold"].includes(cacheState)) fail("The study-v2 cache state must be warm or cold.");
  if (spawn !== spawnSync && typeof spawn !== "function") fail("The study-v2 cache spawn seam must be a function.");
  if (faultInjector !== undefined && typeof faultInjector !== "function") {
    fail("The study-v2 cache fault injector must be a function.");
  }

  return withDataWranglerComparisonSourceCopyDescriptor(sourceCopy, ({ descriptor: sourceDescriptor }) => {
    const controller = openAuthority(controllerPath, "The study-v2 cache controller");
    let pythonExecutable;
    try {
      pythonExecutable = openAuthority(pythonExecutablePath, "The study-v2 Python executable");
    } catch (error) {
      closeSync(controller.descriptor);
      throw error;
    }
    let operationError;
    let result;
    const closeErrors = [];
    try {
      faultInjector?.("before-spawn");
      assertAuthority(controller, "The study-v2 cache controller");
      assertAuthority(pythonExecutable, "The study-v2 Python executable");
      result = spawn(
        CHILD_PYTHON_PATH,
        [
          CHILD_CONTROLLER_PATH,
          "--source-fd",
          String(CHILD_SOURCE_DESCRIPTOR),
          "--mode",
          cacheState,
          "--contract",
          "study-v2",
          "--controller-fd",
          "3",
          "--python-fd",
          "4"
        ],
        {
          argv0: pythonExecutable.path,
          cwd: dirname(controller.path),
          encoding: "utf8",
          env: {
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PYTHONHASHSEED: "0",
            PYTHONNOUSERSITE: "1",
            PYTHONDONTWRITEBYTECODE: "1"
          },
          maxBuffer: MAXIMUM_OUTPUT_BYTES,
          stdio: ["ignore", "pipe", "pipe", controller.descriptor, pythonExecutable.descriptor, sourceDescriptor],
          timeout: 30_000,
          windowsHide: true
        }
      );
      faultInjector?.("after-spawn");
      assertAuthority(controller, "The study-v2 cache controller");
      assertAuthority(pythonExecutable, "The study-v2 Python executable");
      if (result?.error !== undefined || result?.status !== 0 || result?.signal !== null || result?.stderr !== "") {
        fail("The study-v2 cache controller did not exit cleanly.");
      }
      result = validateProof(parseProof(result.stdout), sourceCopy, cacheState, controller, pythonExecutable);
    } catch (error) {
      operationError = error;
    }
    for (const authority of [pythonExecutable, controller]) {
      try {
        closeSync(authority.descriptor);
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (operationError !== undefined || closeErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? closeErrors : [operationError, ...closeErrors],
        "Could not prove study-v2 cache preparation against the host-pinned toolchain."
      );
    }
    return Object.freeze({
      protocol: DATA_WRANGLER_COMPARISON_CACHE_CONTROLLER_PROTOCOL,
      toolchain: toolchainReceipt(controller, pythonExecutable, result.pythonExecutable),
      proof: Object.freeze(result)
    });
  });
}
