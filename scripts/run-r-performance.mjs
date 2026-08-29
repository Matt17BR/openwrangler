import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync
} from "node:fs";
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { fromBuffer as openZipBuffer } from "yauzl";
import {
  CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL,
  CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
  PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL,
  PERFORMANCE_EVIDENCE_ARTIFACT_KIND,
  PREVIEW_RELEASE_ARTIFACT_KIND,
  STABLE_RELEASE_ARTIFACT_KIND,
  acceptInstalledPerformanceCandidate,
  assertInstalledPerformanceArtifactPathSeparation,
  readBoundedJsonSnapshot,
  readInstalledPerformanceProvenance,
  readPerformanceEvidenceProvenance,
  readPreviewReleaseProvenance,
  revalidateAcceptedPerformanceProvenance,
  revalidateInstalledPerformanceChecksum,
  revalidateInstalledPerformanceVsix
} from "./run-installed-performance.mjs";
import {
  R_PERFORMANCE_FIXTURE_BYTES,
  R_PERFORMANCE_FIXTURE_DEFINITION,
  R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT,
  R_PERFORMANCE_HARNESS_PROTOCOL,
  R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS,
  R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
  assertRPerformanceMeasurementValid,
  buildRPerformanceReport,
  removeRPerformanceReport,
  revalidateRPerformanceReport,
  rPerformanceFixtureEvidence,
  writeRPerformanceReport
} from "./r-performance-report.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";
import {
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";

const repositoryRoot = realpathSync.native(resolve(import.meta.dirname, ".."));
const HARNESS_RELATIVE_PATH = "scripts/r-performance-harness.R";
const FRAME_ARCHIVE_ENTRY = "extension/r/openwrangler_runtime/frame_contract.R";
const EXPORTS_ARCHIVE_ENTRY = "extension/r/openwrangler_runtime/kernel_exports.R";
const KERNEL_ARCHIVE_ENTRY = "extension/r/openwrangler_runtime/kernel_agent.R";
const PRIVATE_FILES = Object.freeze({
  candidate: "candidate.vsix",
  fixture: "fixture.json",
  frame: "frame_contract.R",
  harness: "r-performance-harness.R",
  exports: "kernel_exports.R",
  kernel: "kernel_agent.R"
});
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const MAX_PROVENANCE_BYTES = 4096;
const MAX_HARNESS_BYTES = 256 * 1024;
const MAX_RUNTIME_ASSET_BYTES = 1024 * 1024;
const MAX_RSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_NODE_BYTES = 256 * 1024 * 1024;
const MAX_CHILD_JSON_BYTES = 8 * 1024 * 1024;
const MAX_CHILD_STDERR_BYTES = 64 * 1024;
const MAX_LIBRARY_PROBE_FRAME_BYTES = 64 * 1024;
const MAX_LIBRARY_DIRECTORIES = 64;
const PROCESS_GROUP_SETTLE_MS = 5_000;
const PROCESS_TERMINATE_GRACE_MS = 2_000;
const PRIVATE_ROOT_PREFIX = "ow-r-performance-";
const TRANSPORT_VERSION = 14;
export const R_PERFORMANCE_LIBRARY_DISCOVERY_PROTOCOL = "openwrangler-native-r-library-discovery-v1";
export const R_PERFORMANCE_PROCESS_SCHEDULE = Object.freeze({
  libraryProbeRscriptProcesses: 1,
  directRscriptProcesses: 1,
  freshKernelRscriptProcesses: R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT,
  workloadKernelRscriptProcesses: 1,
  measuredRscriptProcesses: R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT + 2,
  totalOwnedRscriptProcesses: R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT + 3
});
const OWNERSHIP_UNCERTAIN = "OPEN_WRANGLER_R_PERFORMANCE_OWNERSHIP_UNCERTAIN";

function ownershipUncertainError(message, options) {
  const error = new Error(message, options);
  error.code = OWNERSHIP_UNCERTAIN;
  return error;
}

export function parseRPerformanceArguments(arguments_, root = repositoryRoot) {
  const options = {};
  const names = new Map([
    ["--candidate-in", "candidateInput"],
    ["--candidate-checksum", "candidateChecksum"],
    ["--candidate-provenance", "candidateProvenance"],
    ["--out", "output"]
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const key = names.get(argument);
    if (key === undefined) throw new Error(`Unknown native R performance option ${argument}.`);
    if (options[key] !== undefined) throw new Error(`${argument} may be provided only once.`);
    const value = arguments_[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${argument} requires one filesystem path.`);
    }
    options[key] = resolve(root, value);
  }
  for (const [argument, key] of names) {
    if (options[key] === undefined) throw new Error(`Native R performance requires ${argument}.`);
  }
  if (basename(options.candidateInput) !== "openwrangler.vsix") {
    throw new Error("Native R performance requires the canonical filename openwrangler.vsix.");
  }
  if (basename(options.candidateChecksum) !== "openwrangler.vsix.sha256") {
    throw new Error("Native R performance requires the canonical checksum filename.");
  }
  if (basename(options.candidateProvenance) !== "openwrangler.vsix.provenance.json") {
    throw new Error("Native R performance requires the canonical provenance filename.");
  }
  assertInstalledPerformanceArtifactPathSeparation({
    output: options.output,
    candidateInput: options.candidateInput,
    candidateChecksum: options.candidateChecksum,
    candidateProvenance: options.candidateProvenance
  });
  return Object.freeze(options);
}

export function selectRPerformanceProvenanceReader(protocol, readers = {}) {
  if (protocol === CANONICAL_RELEASE_ARTIFACT_PROTOCOL) {
    return Object.freeze({
      artifactKind: "canonical-stable-release",
      intakeArtifactKind: STABLE_RELEASE_ARTIFACT_KIND,
      read: readers.stable ?? readInstalledPerformanceProvenance
    });
  }
  if (protocol === CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL) {
    return Object.freeze({
      artifactKind: "canonical-preview-release",
      intakeArtifactKind: PREVIEW_RELEASE_ARTIFACT_KIND,
      read: readers.preview ?? readPreviewReleaseProvenance
    });
  }
  if (protocol === PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL) {
    return Object.freeze({
      artifactKind: "performance-evidence",
      intakeArtifactKind: PERFORMANCE_EVIDENCE_ARTIFACT_KIND,
      read: readers.evidence ?? readPerformanceEvidenceProvenance
    });
  }
  throw new Error("Native R performance received an unsupported candidate provenance protocol.");
}

export function readRPerformanceProvenance(provenancePath, readers = {}) {
  const snapshot = readBoundedJsonSnapshot(provenancePath, MAX_PROVENANCE_BYTES);
  const selection = selectRPerformanceProvenanceReader(snapshot.value?.protocol, readers);
  const receipt = selection.read(provenancePath);
  if (
    receipt.protocol !== snapshot.value.protocol ||
    receipt.bytes !== snapshot.bytes ||
    receipt.sha256 !== snapshot.sha256
  ) {
    throw new Error("Candidate provenance changed between strict protocol dispatch and validation.");
  }
  return Object.freeze({ artifactKind: selection.artifactKind, receipt });
}

export function readRPerformanceSourceBinding({
  expectedCommit,
  releaseTag,
  root = repositoryRoot,
  harnessRelativePath = HARNESS_RELATIVE_PATH
}) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full lowercase Git commit ID.");
  }
  if (typeof releaseTag !== "string" || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be one vmajor.minor.patch release tag.");
  }
  const canonicalRoot = canonicalRepository(root);
  const head = git(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"], 4096).trim();
  if (head !== expectedCommit) throw new Error("Native R performance must run at exact EXPECTED_SHA.");
  const status = git(
    canonicalRoot,
    ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=no"],
    1024 * 1024
  );
  if (status.length !== 0) throw new Error("Native R performance requires a clean tracked worktree.");
  const harnessPath = resolve(canonicalRoot, harnessRelativePath);
  const harness = readPinnedFile(harnessPath, MAX_HARNESS_BYTES, "native R performance harness", {
    requireOwner: false
  });
  const committed = Buffer.from(
    git(canonicalRoot, ["cat-file", "blob", `${expectedCommit}:${harnessRelativePath}`], MAX_HARNESS_BYTES),
    "utf8"
  );
  if (!harness.bytes.equals(committed)) {
    throw new Error("Native R performance harness bytes do not match the candidate commit.");
  }
  return Object.freeze({
    commit: expectedCommit,
    releaseTag,
    root: canonicalRoot,
    harnessPath,
    harnessRelativePath,
    harness,
    harnessSha256: createHash("sha256").update(harness.bytes).digest("hex")
  });
}

export function revalidateRPerformanceSourceBinding(binding) {
  const current = readRPerformanceSourceBinding({
    expectedCommit: binding.commit,
    releaseTag: binding.releaseTag,
    root: binding.root,
    harnessRelativePath: binding.harnessRelativePath
  });
  requireSamePinnedFile(current.harness, binding.harness, "Native R performance harness changed after source binding.");
  if (current.harnessSha256 !== binding.harnessSha256) {
    throw new Error("Native R performance harness digest changed after source binding.");
  }
  return binding;
}

export async function acceptRPerformanceCandidate({
  candidatePath,
  checksumPath,
  provenancePath,
  privateCandidatePath,
  expectedCommit,
  releaseTag,
  environment = process.env,
  acceptCandidate = acceptInstalledPerformanceCandidate
}) {
  const dispatched = readRPerformanceProvenance(provenancePath);
  const selection = selectRPerformanceProvenanceReader(dispatched.receipt.protocol);
  if (selection.artifactKind !== dispatched.artifactKind) {
    throw new Error("Native R performance provenance dispatch changed between reads.");
  }
  const accepted = await acceptCandidate({
    artifactKind: selection.intakeArtifactKind,
    candidatePath,
    checksumPath,
    provenancePath,
    privateDestination: privateCandidatePath,
    environment,
    expectedCommit,
    releaseTag
  });
  const metadata = accepted.publicProvenanceReceipt;
  if (
    metadata.path !== dispatched.receipt.path ||
    metadata.protocol !== dispatched.receipt.protocol ||
    metadata.bytes !== dispatched.receipt.bytes ||
    metadata.sha256 !== dispatched.receipt.sha256
  ) {
    throw new Error("Canonical candidate intake did not retain the protocol-dispatched provenance receipt.");
  }
  revalidateInstalledPerformanceVsix(accepted.candidateReceipt);
  const privateSnapshot = readBoundedVsixFileSnapshot(accepted.candidateReceipt.path, { requireOwner: true });
  if (
    privateSnapshot.bytes.length !== accepted.candidateReceipt.bytes ||
    createHash("sha256").update(privateSnapshot.bytes).digest("hex") !== accepted.candidateReceipt.sha256
  ) {
    throw new Error("Canonical candidate changed before packaged R asset extraction.");
  }
  const archive = await inspectVsixArchive(privateSnapshot.bytes);
  const extracted = await extractPackagedRAssets(privateSnapshot.bytes);
  const archiveDigests = new Map(archive.entryDigests);
  const archiveSizes = new Map(archive.entrySizes);
  for (const asset of [extracted.frameContract, extracted.kernelExports, extracted.kernelAgent]) {
    if (archiveDigests.get(asset.entry) !== asset.sha256 || archiveSizes.get(asset.entry) !== asset.bytes.length) {
      throw new Error(`Extracted packaged R asset ${asset.name} does not match the sealed archive receipt.`);
    }
  }
  revalidateInstalledPerformanceVsix(accepted.candidateReceipt);
  const candidate = Object.freeze({
    artifactKind: selection.artifactKind,
    extensionId: accepted.candidate.extensionId,
    extensionVersion: accepted.candidate.extensionVersion,
    preview: accepted.candidate.preview,
    releaseTag: accepted.candidate.releaseTag,
    sourceCommit: accepted.candidate.sourceCommit,
    vsixSha256: accepted.candidate.vsixSha256,
    vsixBytes: accepted.candidate.vsixBytes,
    checksumSha256: accepted.publicChecksumReceipt.sha256,
    provenanceProtocol: metadata.protocol,
    provenanceSha256: metadata.sha256
  });
  return Object.freeze({
    candidate,
    accepted,
    extracted
  });
}

export function revalidateRPerformanceCandidate(intake) {
  revalidateInstalledPerformanceVsix(intake.accepted.publicCandidateReceipt);
  revalidateInstalledPerformanceVsix(intake.accepted.candidateReceipt);
  revalidateInstalledPerformanceChecksum(
    intake.accepted.publicChecksumReceipt,
    intake.accepted.publicCandidateReceipt.path
  );
  revalidateAcceptedPerformanceProvenance(intake.accepted.publicProvenanceReceipt);
  return intake;
}

export async function extractPackagedRAssets(vsixBytes) {
  const wanted = new Map([
    [FRAME_ARCHIVE_ENTRY, { key: "frameContract", name: "frame_contract.R" }],
    [EXPORTS_ARCHIVE_ENTRY, { key: "kernelExports", name: "kernel_exports.R" }],
    [KERNEL_ARCHIVE_ENTRY, { key: "kernelAgent", name: "kernel_agent.R" }]
  ]);
  const archive = await new Promise((resolveArchive, reject) => {
    openZipBuffer(
      vsixBytes,
      { autoClose: true, decodeStrings: true, lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, value) => (error ? reject(error) : resolveArchive(value))
    );
  });
  const found = new Map();
  await new Promise((resolveEntries, rejectEntries) => {
    let settled = false;
    const reject = (error) => {
      if (settled) return;
      settled = true;
      try {
        archive.close();
      } catch {
        // Preserve the extraction failure.
      }
      rejectEntries(error);
    };
    archive.once("error", reject);
    archive.on("entry", (entry) => {
      const spec = wanted.get(entry.fileName);
      if (spec === undefined) {
        archive.readEntry();
        return;
      }
      if (
        found.has(entry.fileName) ||
        entry.uncompressedSize <= 0 ||
        entry.uncompressedSize > MAX_RUNTIME_ASSET_BYTES
      ) {
        reject(new Error(`Packaged R asset ${spec.name} is duplicated or exceeds its bound.`));
        return;
      }
      archive.openReadStream(entry, (error, stream) => {
        if (error || stream === undefined) {
          reject(error ?? new Error(`Packaged R asset ${spec.name} could not be opened.`));
          return;
        }
        const chunks = [];
        let length = 0;
        stream.on("data", (chunk) => {
          length += chunk.length;
          if (length > MAX_RUNTIME_ASSET_BYTES) stream.destroy(new Error("Packaged R asset exceeded its bound."));
          else chunks.push(chunk);
        });
        stream.once("error", reject);
        stream.once("end", () => {
          const bytes = Buffer.concat(chunks, length);
          if (bytes.length !== entry.uncompressedSize) {
            reject(new Error(`Packaged R asset ${spec.name} ended before its declared size.`));
            return;
          }
          found.set(
            entry.fileName,
            Object.freeze({
              entry: entry.fileName,
              key: spec.key,
              name: spec.name,
              bytes,
              sha256: createHash("sha256").update(bytes).digest("hex")
            })
          );
          archive.readEntry();
        });
      });
    });
    archive.once("end", () => {
      if (settled) return;
      settled = true;
      resolveEntries();
    });
    archive.readEntry();
  });
  if (found.size !== wanted.size) throw new Error("Canonical candidate omitted a packaged native R runtime asset.");
  return Object.freeze({
    frameContract: found.get(FRAME_ARCHIVE_ENTRY),
    kernelExports: found.get(EXPORTS_ARCHIVE_ENTRY),
    kernelAgent: found.get(KERNEL_ARCHIVE_ENTRY)
  });
}

function canonicalRepository(root) {
  const requested = resolve(root);
  if (realpathSync.native(requested) !== requested) {
    throw new Error("Native R performance repository root must be canonical.");
  }
  const metadata = lstatSync(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Native R performance repository root must be one directory.");
  }
  const top = realpathSync.native(resolve(git(requested, ["rev-parse", "--show-toplevel"], 4096).trim()));
  if (top !== requested) throw new Error("Native R performance must run from the repository root.");
  return requested;
}

function git(root, arguments_, maxBuffer) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer,
    timeout: 10_000,
    windowsHide: true
  });
}

function readPinnedFile(file, maximumBytes, label, { requireOwner = true } = {}) {
  const path = resolve(file);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    requireSameRegularFile(named, before, `${label} path changed before it was read.`, { requireOwner });
    if (before.size <= 0n || before.size > BigInt(maximumBytes)) throw new Error(`${label} exceeds its byte bound.`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count <= 0) throw new Error(`${label} ended before its pinned byte size.`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    requireSameRegularFile(after, before, `${label} changed while it was read.`, { requireOwner });
    requireSameRegularFile(lstatSync(path, { bigint: true }), before, `${label} path changed while it was read.`, {
      requireOwner
    });
    return Object.freeze({
      path,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: fileIdentity(after)
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireSamePinnedFile(actual, expected, message) {
  if (
    actual.path !== expected.path ||
    actual.sha256 !== expected.sha256 ||
    !actual.bytes.equals(expected.bytes) ||
    !sameFileIdentity(actual.identity, expected.identity)
  ) {
    throw new Error(message);
  }
}

function requireSameRegularFile(actual, expected, message, { requireOwner = true } = {}) {
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeNs !== expected.mtimeNs ||
    actual.ctimeNs !== expected.ctimeNs ||
    (requireOwner && typeof process.getuid === "function" && actual.uid !== BigInt(process.getuid()))
  ) {
    throw new Error(message);
  }
}

function fileIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    mode: metadata.mode,
    uid: metadata.uid
  });
}

function sameFileIdentity(left, right) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "uid"].every((key) => left[key] === right[key]);
}

function requireSameWritableFile(actual, opened, expectedBytes, message) {
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    actual.dev !== opened.dev ||
    actual.ino !== opened.ino ||
    actual.mode !== opened.mode ||
    actual.uid !== opened.uid ||
    actual.gid !== opened.gid ||
    actual.size !== BigInt(expectedBytes)
  ) {
    throw new Error(message);
  }
}

export function writeRPerformancePrivateFile(root, name, bytes, hooks = {}) {
  const path = join(root, name);
  let descriptor;
  let complete;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const opened = fstatSync(descriptor, { bigint: true });
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error("Private native R asset write made no progress.");
      offset += count;
    }
    fsyncSync(descriptor);
    complete = fstatSync(descriptor, { bigint: true });
    requireSameWritableFile(
      complete,
      opened,
      bytes.length,
      "Private native R asset changed unexpectedly while it was written."
    );
    hooks.afterWrite?.(path);
    requireSameRegularFile(
      lstatSync(path, { bigint: true }),
      complete,
      "Private native R asset path changed while it was written."
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const receipt = readPinnedFile(path, Math.max(bytes.length, 1), `private native R asset ${name}`);
  if (!sameFileIdentity(receipt.identity, fileIdentity(complete))) {
    throw new Error("Private native R asset path changed after its writer closed.");
  }
  return receipt;
}

function revalidatePrivateFile(receipt) {
  const current = readPinnedFile(
    receipt.path,
    receipt.bytes.length,
    `private native R asset ${basename(receipt.path)}`
  );
  requireSamePinnedFile(current, receipt, "A private native R measurement asset changed.");
  return receipt;
}

function createPrivateRoot() {
  if (platform() !== "linux") throw new Error("Native R performance v1 requires the Linux reference platform.");
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), PRIVATE_ROOT_PREFIX));
  const metadata = lstatSync(root, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777n) !== 0o700n ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())) ||
    realpathSync.native(root) !== root
  ) {
    throw new Error("Native R performance private root is not an owned canonical mode-0700 directory.");
  }
  return Object.freeze({
    root,
    cleanupReceipt: createEditorAcceptancePrivateRootReceipt(root, {
      containedBy: realpathSync.native(tmpdir())
    })
  });
}

function removePrivateRoot(receipt, { requireCompleteInventory = false, processGroupsGone = false } = {}) {
  if (requireCompleteInventory) {
    const expected = Object.values(PRIVATE_FILES).sort();
    const actual = readdirSync(receipt.root).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Native R performance persistent private-root inventory changed before cleanup.");
    }
    for (const entry of actual) {
      const child = lstatSync(join(receipt.root, entry), { bigint: true });
      if (!child.isFile() || child.isSymbolicLink() || child.nlink !== 1n) {
        throw new Error("Native R performance persistent private-root inventory contains an unsafe entry.");
      }
    }
  }
  removeEditorAcceptancePrivateRoot(receipt.cleanupReceipt, {
    processTreeVerifiedStopped: processGroupsGone,
    privatePathsVerified: true
  });
}

function resolveExecutable(command, searchPath = process.env.PATH ?? "") {
  const candidates = isAbsolute(command)
    ? [command]
    : searchPath
        .split(delimiter)
        .filter(Boolean)
        .map((entry) => resolve(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync.native(candidate);
    } catch {
      // Continue searching the explicit PATH.
    }
  }
  throw new Error(`Could not resolve the selected Rscript executable: ${command}`);
}

function readRscriptReceipt(executable) {
  const receipt = readPinnedFile(executable, MAX_RSCRIPT_BYTES, "selected Rscript executable", { requireOwner: false });
  const metadata = lstatSync(receipt.path, { bigint: true });
  if (!metadata.isFile() || metadata.nlink !== 1n || realpathSync.native(receipt.path) !== receipt.path) {
    throw new Error("Selected Rscript must resolve to one canonical single-link regular executable.");
  }
  return receipt;
}

function revalidateRscript(receipt) {
  const current = readRscriptReceipt(receipt.path);
  requireSamePinnedFile(current, receipt, "Selected Rscript changed during native R measurement.");
  return receipt;
}

function readNodeReceipt() {
  const executable = realpathSync.native(process.execPath);
  const receipt = readPinnedFile(executable, MAX_NODE_BYTES, "selected Node executable", { requireOwner: false });
  const metadata = lstatSync(receipt.path, { bigint: true });
  if (!metadata.isFile() || metadata.nlink !== 1n || realpathSync.native(receipt.path) !== receipt.path) {
    throw new Error("Selected Node must resolve to one canonical single-link regular executable.");
  }
  return receipt;
}

function revalidateNode(receipt) {
  const current = readNodeReceipt();
  requireSamePinnedFile(current, receipt, "Selected Node executable changed during native R measurement.");
  return receipt;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function withDeadline(promise, deadline, label) {
  const milliseconds = Math.max(0, deadline - performance.now());
  if (milliseconds <= 0) return Promise.reject(new Error(`${label} exceeded its operational process deadline.`));
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its operational process deadline.`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function createLineReader(stream, label, maximumFrameBytes = MAX_CHILD_JSON_BYTES) {
  let buffer = Buffer.alloc(0);
  let ended = false;
  let failure;
  const queue = [];
  const waiters = [];
  let completeReader;
  const completion = new Promise((resolveCompletion) => {
    completeReader = resolveCompletion;
  });
  let completionSettled = false;
  const settleCompletion = () => {
    if (completionSettled) return;
    completionSettled = true;
    completeReader();
  };
  const deliver = (entry) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(entry);
    else if (queue.length === 0) queue.push(entry);
    else {
      rejectAll(new Error(`${label} emitted unsolicited extra stdout frames.`));
      return false;
    }
    return true;
  };
  const rejectAll = (error) => {
    failure ??= error;
    while (waiters.length > 0) waiters.shift().reject(failure);
  };
  stream.on("data", (chunk) => {
    if (failure) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maximumFrameBytes) {
      rejectAll(new Error(`${label} exceeded its per-frame JSON bound.`));
      return;
    }
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (frame.length === 0 || frame.length > maximumFrameBytes || frame.includes(0x0d)) {
        rejectAll(new Error(`${label} emitted an invalid newline JSON frame.`));
        return;
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
      } catch (error) {
        rejectAll(new Error(`${label} emitted non-UTF-8 stdout.`, { cause: error }));
        return;
      }
      if (!deliver(Object.freeze({ text, arrivedAt: performance.now() }))) return;
    }
  });
  stream.once("error", () => {
    rejectAll(new Error(`${label} stdout stream failed.`));
    ended = true;
    settleCompletion();
  });
  stream.once("end", () => {
    ended = true;
    if (buffer.length !== 0) rejectAll(new Error(`${label} ended with a partial stdout frame.`));
    else {
      const error = new Error(`${label} ended before the next expected stdout frame.`);
      while (waiters.length > 0) waiters.shift().reject(error);
    }
    settleCompletion();
  });
  stream.once("close", () => {
    if (!ended) {
      ended = true;
      if (buffer.length !== 0) rejectAll(new Error(`${label} closed with a partial stdout frame.`));
      else if (!failure) rejectAll(new Error(`${label} closed without a complete stdout end.`));
    }
    settleCompletion();
  });
  return Object.freeze({
    next(deadline) {
      if (failure) return Promise.reject(failure);
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (ended) return Promise.reject(new Error(`${label} has no further stdout frame.`));
      return withDeadline(
        new Promise((resolveLine, rejectLine) => waiters.push({ resolve: resolveLine, reject: rejectLine })),
        deadline,
        `${label} stdout frame`
      );
    },
    waitForEnd(deadline) {
      return withDeadline(completion, deadline, `${label} stream completion`);
    },
    assertComplete() {
      if (buffer.length !== 0 || queue.length !== 0 || waiters.length !== 0) {
        throw new Error(`${label} emitted extra or incomplete stdout frames.`);
      }
      if (!ended) throw new Error(`${label} stdout did not close after process exit.`);
      if (failure) throw failure;
    }
  });
}

function readLinuxRssKiB(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+([0-9]+)\s+kB$/mu.exec(status);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function processGroupGone(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

async function waitForProcessGroupGone(pid, timeoutMs = PROCESS_GROUP_SETTLE_MS, probeProcessGroup = processGroupGone) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (probeProcessGroup(pid)) return true;
    await sleep(25);
  }
  return probeProcessGroup(pid);
}

function canonicalLibraryBytes({ libraries, siteLibraries, baseLibrary }) {
  return Buffer.from(`${JSON.stringify({ libraries, siteLibraries, baseLibrary })}\n`, "utf8");
}

function libraryDirectoryIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
    gid: metadata.gid,
    nlink: metadata.nlink,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  });
}

function sameLibraryDirectoryIdentity(actual, expected) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs"].every(
    (key) => actual[key] === expected[key]
  );
}

function readCanonicalLibraryDirectory(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > 4096 ||
    !isAbsolute(path) ||
    /[\0\r\n:]/u.test(path)
  ) {
    throw new Error(`${label} is not one bounded absolute POSIX directory name.`);
  }
  const absolute = resolve(path);
  const canonical = realpathSync.native(absolute);
  const metadata = lstatSync(absolute, { bigint: true });
  const groupWritable = (metadata.mode & 0o020n) !== 0n;
  const ownedByCurrentUserAndGroup =
    typeof process.getuid === "function" &&
    typeof process.getgid === "function" &&
    metadata.uid === BigInt(process.getuid()) &&
    metadata.gid === BigInt(process.getgid());
  if (
    absolute !== path ||
    canonical !== absolute ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o002n) !== 0n ||
    (groupWritable && !ownedByCurrentUserAndGroup)
  ) {
    throw new Error(`${label} is not one canonical non-writable-by-others directory.`);
  }
  return Object.freeze({ path: absolute, identity: libraryDirectoryIdentity(metadata) });
}

function revalidateLibraryDirectory(receipt, label) {
  const current = readCanonicalLibraryDirectory(receipt.path, label);
  if (!sameLibraryDirectoryIdentity(current.identity, receipt.identity)) {
    throw new Error(`${label} changed during native R measurement.`);
  }
  return receipt;
}

export function readRPerformanceCallerHomeReceipt(sourceEnvironment = process.env) {
  const path =
    typeof sourceEnvironment.HOME === "string" && sourceEnvironment.HOME.length > 0
      ? sourceEnvironment.HOME
      : homedir();
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path) || /[\0\r\n]/u.test(path)) {
    throw new Error("Native R library discovery requires one explicit absolute caller HOME.");
  }
  const absolute = resolve(path);
  const canonical = realpathSync.native(absolute);
  const metadata = lstatSync(absolute, { bigint: true });
  if (
    absolute !== path ||
    canonical !== absolute ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Native R library discovery requires one canonical current-user-owned caller HOME.");
  }
  return Object.freeze({ path: absolute, identity: libraryDirectoryIdentity(metadata) });
}

export function preflightRPerformanceLibraryEnvironment(sourceEnvironment = process.env) {
  for (const name of ["R_LIBS", "R_LIBS_USER", "R_LIBS_SITE"]) {
    const value = sourceEnvironment[name];
    if (value === undefined || value === "") continue;
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > MAX_LIBRARY_PROBE_FRAME_BYTES ||
      /[\0\r\n]/u.test(value)
    ) {
      throw new Error(`Native R library discovery rejected malformed ${name}.`);
    }
    const entries = value.split(delimiter);
    if (entries.some((entry) => entry.length === 0) || new Set(entries).size !== entries.length) {
      throw new Error(`Native R library discovery rejected empty or duplicate ${name} entries.`);
    }
    for (const [index, entry] of entries.entries()) {
      if (Buffer.byteLength(entry, "utf8") > 4096) {
        throw new Error(`Native R library discovery rejected an oversized ${name} entry.`);
      }
      const withoutSpecifiers = entry.replace(/%[vVpoaUS]/gu, "");
      const supportedName =
        isAbsolute(entry) ||
        entry === "~" ||
        (entry.startsWith("~/") && !entry.startsWith("~//")) ||
        /^(?:%U|%S)(?:\/|$)/u.test(entry);
      if (!supportedName || /[%]/u.test(withoutSpecifiers) || /^~[^/]/u.test(entry)) {
        throw new Error(`Native R library discovery rejected a relative or unsupported ${name} entry.`);
      }
      if (isAbsolute(entry) && !entry.includes("%")) {
        readCanonicalLibraryDirectory(entry, `Caller ${name} directory ${index}`);
      }
    }
  }
}

function revalidateCallerHome(receipt) {
  const current = readRPerformanceCallerHomeReceipt({ HOME: receipt.path });
  if (!sameLibraryDirectoryIdentity(current.identity, receipt.identity)) {
    throw new Error("Caller HOME changed during native R library discovery.");
  }
  return receipt;
}

export function createRPerformanceLibraryReceipt({ libraries, siteLibraries, baseLibrary }) {
  if (
    !Array.isArray(libraries) ||
    libraries.length === 0 ||
    libraries.length > MAX_LIBRARY_DIRECTORIES ||
    !Array.isArray(siteLibraries) ||
    siteLibraries.length > MAX_LIBRARY_DIRECTORIES ||
    typeof baseLibrary !== "string"
  ) {
    throw new Error("Native R library discovery returned an invalid directory count.");
  }
  const libraryReceipts = libraries.map((path, index) =>
    readCanonicalLibraryDirectory(path, `Native R library directory ${index}`)
  );
  const siteReceipts = siteLibraries.map((path, index) =>
    readCanonicalLibraryDirectory(path, `Native R site-library directory ${index}`)
  );
  const baseReceipt = readCanonicalLibraryDirectory(baseLibrary, "Native R base-library directory");
  const canonicalLibraries = libraryReceipts.map((receipt) => receipt.path);
  const canonicalSiteLibraries = siteReceipts.map((receipt) => receipt.path);
  if (
    new Set(canonicalLibraries).size !== canonicalLibraries.length ||
    new Set(canonicalSiteLibraries).size !== canonicalSiteLibraries.length ||
    !canonicalLibraries.includes(baseReceipt.path) ||
    canonicalSiteLibraries.some((path) => !canonicalLibraries.includes(path))
  ) {
    throw new Error("Native R library discovery returned an inconsistent ordered directory set.");
  }
  const bytes = canonicalLibraryBytes({
    libraries: canonicalLibraries,
    siteLibraries: canonicalSiteLibraries,
    baseLibrary: baseReceipt.path
  });
  if (bytes.length > MAX_LIBRARY_PROBE_FRAME_BYTES) {
    throw new Error("Native R library discovery receipt exceeds its private byte bound.");
  }
  return Object.freeze({
    libraries: Object.freeze(canonicalLibraries),
    siteLibraries: Object.freeze(canonicalSiteLibraries),
    baseLibrary: baseReceipt.path,
    receipts: Object.freeze(libraryReceipts),
    siteReceipts: Object.freeze(siteReceipts),
    baseReceipt,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

function revalidateLibraryReceipt(receipt) {
  for (const [index, directory] of receipt.receipts.entries()) {
    revalidateLibraryDirectory(directory, `Native R library directory ${index}`);
  }
  for (const [index, directory] of receipt.siteReceipts.entries()) {
    revalidateLibraryDirectory(directory, `Native R site-library directory ${index}`);
  }
  revalidateLibraryDirectory(receipt.baseReceipt, "Native R base-library directory");
  const bytes = canonicalLibraryBytes(receipt);
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.sha256) {
    throw new Error("Native R library discovery receipt changed during measurement.");
  }
  return receipt;
}

export function buildRPerformanceChildEnvironment({
  privateRoot,
  sourceEnvironment = process.env,
  home = privateRoot,
  libraryReceipt
}) {
  const allowed = [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "R_HOME",
    "R_LIBS",
    "R_LIBS_USER",
    "R_LIBS_SITE",
    "LD_LIBRARY_PATH"
  ];
  const environment = {};
  for (const key of allowed) {
    if (typeof sourceEnvironment[key] === "string") environment[key] = sourceEnvironment[key];
  }
  if (libraryReceipt !== undefined) {
    revalidateLibraryReceipt(libraryReceipt);
    environment.R_LIBS = libraryReceipt.libraries.join(delimiter);
    environment.R_LIBS_USER = "";
    environment.R_LIBS_SITE = libraryReceipt.siteLibraries.join(delimiter);
    environment.OPEN_WRANGLER_R_PERFORMANCE_LIBRARIES = libraryReceipt.libraries.join(delimiter);
    environment.OPEN_WRANGLER_R_PERFORMANCE_SITE_LIBRARIES = libraryReceipt.siteLibraries.join(delimiter);
    environment.OPEN_WRANGLER_R_PERFORMANCE_BASE_LIBRARY = libraryReceipt.baseLibrary;
    environment.OPEN_WRANGLER_R_PERFORMANCE_LIBRARY_PROTOCOL = R_PERFORMANCE_LIBRARY_DISCOVERY_PROTOCOL;
  }
  return { ...environment, HOME: home, TMPDIR: privateRoot, TMP: privateRoot, TEMP: privateRoot, TZ: "UTC" };
}

const R_LIBRARY_PROBE_EXPRESSION = [
  "paths <- .libPaths()",
  "site <- .Library.site",
  "base <- .Library",
  "if (!is.character(paths) || length(paths) < 1L || anyNA(paths) || any(!nzchar(paths))) quit(status = 91L)",
  "if (!is.character(site) || anyNA(site) || any(!nzchar(site))) quit(status = 92L)",
  "if (!is.character(base) || length(base) != 1L || is.na(base) || !nzchar(base)) quit(status = 93L)",
  "hex <- function(value) paste(sprintf('%02x', as.integer(charToRaw(enc2utf8(value)))), collapse = '')",
  "fields <- c('openwrangler-native-r-library-discovery-v1', as.character(length(paths)), vapply(paths, hex, character(1L), USE.NAMES = FALSE), as.character(length(site)), vapply(site, hex, character(1L), USE.NAMES = FALSE), hex(base))",
  "cat(paste(fields, collapse = '\\t'), '\\n', sep = '')"
].join("; ");

function decodeLibraryHex(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    throw new Error(`${label} has invalid strict hexadecimal encoding.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex"));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8.`, { cause: error });
  }
}

export function parseRPerformanceLibraryProbeFrame(frame) {
  if (typeof frame !== "string" || Buffer.byteLength(frame, "utf8") > MAX_LIBRARY_PROBE_FRAME_BYTES) {
    throw new Error("Native R library discovery frame exceeds its strict byte bound.");
  }
  const fields = frame.split("\t");
  if (fields.shift() !== R_PERFORMANCE_LIBRARY_DISCOVERY_PROTOCOL) {
    throw new Error("Native R library discovery protocol changed.");
  }
  const libraryCountText = fields.shift();
  if (!/^(?:[1-9]|[1-5][0-9]|6[0-4])$/u.test(libraryCountText ?? "")) {
    throw new Error("Native R library discovery returned an invalid library count.");
  }
  const libraryCount = Number(libraryCountText);
  if (fields.length < libraryCount + 2) {
    throw new Error("Native R library discovery frame ended before its library entries.");
  }
  const libraries = fields
    .splice(0, libraryCount)
    .map((value, index) => decodeLibraryHex(value, `Native R library directory ${index}`));
  const siteCountText = fields.shift();
  if (!/^(?:0|[1-9]|[1-5][0-9]|6[0-4])$/u.test(siteCountText ?? "")) {
    throw new Error("Native R library discovery returned an invalid site-library count.");
  }
  const siteCount = Number(siteCountText);
  if (fields.length !== siteCount + 1) {
    throw new Error("Native R library discovery frame has missing or extra fields.");
  }
  const siteLibraries = fields
    .splice(0, siteCount)
    .map((value, index) => decodeLibraryHex(value, `Native R site-library directory ${index}`));
  const baseLibrary = decodeLibraryHex(fields[0], "Native R base-library directory");
  return Object.freeze({
    libraries: Object.freeze(libraries),
    siteLibraries: Object.freeze(siteLibraries),
    baseLibrary
  });
}

export async function spawnOwnedRscript({
  executable,
  arguments_,
  privateRoot,
  environment = process.env,
  home = privateRoot,
  libraryReceipt,
  spawnImpl = spawn,
  readRss = readLinuxRssKiB,
  probeProcessGroup = processGroupGone,
  signalProcessGroup = (pid, signal) => process.kill(-pid, signal),
  maxStdoutFrameBytes = MAX_CHILD_JSON_BYTES,
  processDeadlineMs = R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS
}) {
  if (platform() !== "linux") throw new Error("Owned native R process groups require Linux.");
  if (
    !Number.isSafeInteger(processDeadlineMs) ||
    processDeadlineMs <= 0 ||
    processDeadlineMs > R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS
  ) {
    throw new Error("Owned native R process deadline must be within its fixed operational safety bound.");
  }
  if (
    !Number.isSafeInteger(maxStdoutFrameBytes) ||
    maxStdoutFrameBytes <= 0 ||
    maxStdoutFrameBytes > MAX_CHILD_JSON_BYTES
  ) {
    throw new Error("Owned native R stdout-frame bound is invalid.");
  }
  const waitForOwnedGroupGone = (pid, timeoutMs = PROCESS_GROUP_SETTLE_MS) =>
    waitForProcessGroupGone(pid, timeoutMs, probeProcessGroup);
  const cleanMalformedOwnedGroup = async (pid) => {
    try {
      let gone = probeProcessGroup(pid);
      if (!gone) {
        try {
          signalProcessGroup(pid, "SIGTERM");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        gone = await waitForOwnedGroupGone(pid, PROCESS_TERMINATE_GRACE_MS);
      }
      if (!gone) {
        try {
          signalProcessGroup(pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        gone = await waitForOwnedGroupGone(pid);
      }
      if (!gone) throw new Error("process group remained live");
    } catch (error) {
      throw ownershipUncertainError("Malformed owned Rscript process-group cleanup was uncertain.", {
        cause: error
      });
    }
  };
  const child = spawnImpl(executable, arguments_, {
    cwd: privateRoot,
    detached: true,
    env: buildRPerformanceChildEnvironment({ privateRoot, sourceEnvironment: environment, home, libraryReceipt }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let spawnError;
  if (!child || typeof child.once !== "function") {
    if (Number.isSafeInteger(child?.pid) && child.pid > 0) await cleanMalformedOwnedGroup(child.pid);
    throw new Error("Native R performance spawn did not return a child-process handle.");
  }
  child.once("error", () => {
    spawnError = true;
  });
  const stdinValid =
    child.stdin && ["on", "write", "end", "destroy"].every((name) => typeof child.stdin[name] === "function");
  const stdoutValid =
    child.stdout && ["on", "once", "destroy"].every((name) => typeof child.stdout[name] === "function");
  const stderrValid = child.stderr && ["on", "destroy"].every((name) => typeof child.stderr[name] === "function");
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || !stdinValid || !stdoutValid || !stderrValid) {
    if (Number.isSafeInteger(child.pid) && child.pid > 0) await cleanMalformedOwnedGroup(child.pid);
    throw new Error("Native R performance could not own one Rscript process group.");
  }
  const pid = child.pid;
  let setupSampler;
  try {
    const absoluteDeadline = performance.now() + processDeadlineMs;
    const lines = createLineReader(child.stdout, "owned Rscript", maxStdoutFrameBytes);
    const stderrDigest = createHash("sha256");
    let stderrBytes = 0;
    let stderrOverflow = false;
    let stdinError = false;
    let stderrError = false;
    let rejectPendingWrite;
    child.stdin.on("error", () => {
      stdinError = true;
      rejectPendingWrite?.();
    });
    child.stderr.on("error", () => {
      stderrError = true;
    });
    child.stderr.on("data", (chunk) => {
      stderrDigest.update(chunk);
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CHILD_STDERR_BYTES && !stderrOverflow) {
        stderrOverflow = true;
        try {
          signalProcessGroup(pid, "SIGTERM");
        } catch {
          // The terminal ownership check determines whether cleanup is safe.
        }
      }
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const close = new Promise((resolveClose) => {
      child.once("close", (code, signal) => resolveClose(Object.freeze({ code, signal })));
    });
    let maxObservedRssKiB = 0;
    let stageMaxObservedRssKiB = 0;
    let stageActive = false;
    let rssObservations = 0;
    let rssSamplerFailed = false;
    const sampleRss = () => {
      let rss;
      try {
        rss = readRss(pid);
      } catch {
        rssSamplerFailed = true;
        return undefined;
      }
      if (rss !== undefined) {
        rssObservations += 1;
        maxObservedRssKiB = Math.max(maxObservedRssKiB, rss);
        if (stageActive) stageMaxObservedRssKiB = Math.max(stageMaxObservedRssKiB, rss);
      }
      return rss;
    };
    sampleRss();
    const sampler = setInterval(sampleRss, 5);
    setupSampler = sampler;
    sampler.unref?.();
    let ownershipCertain = true;
    let naturallyExited = false;
    let finalized = false;

    async function signalLiveGroup(signal) {
      try {
        if (probeProcessGroup(pid)) return true;
        signalProcessGroup(pid, signal);
      } catch (error) {
        if (error?.code === "ESRCH") return true;
        ownershipCertain = false;
        return false;
      }
      try {
        return await waitForOwnedGroupGone(pid, PROCESS_TERMINATE_GRACE_MS);
      } catch {
        ownershipCertain = false;
        return false;
      }
    }

    async function terminate() {
      if (finalized) return ownershipCertain;
      if (!(await signalLiveGroup("SIGTERM"))) await signalLiveGroup("SIGKILL");
      try {
        if (!(await waitForOwnedGroupGone(pid))) ownershipCertain = false;
      } catch {
        ownershipCertain = false;
      }
      await Promise.race([close, sleep(PROCESS_TERMINATE_GRACE_MS)]);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      clearInterval(sampler);
      finalized = true;
      return ownershipCertain;
    }

    return Object.freeze({
      pid,
      async nextLine() {
        return lines.next(absoluteDeadline);
      },
      beginStage() {
        stageActive = true;
        stageMaxObservedRssKiB = 0;
        sampleRss();
      },
      endStage() {
        sampleRss();
        stageActive = false;
        if (rssSamplerFailed) throw new Error("Owned Rscript Linux RSS sampler failed.");
        if (stageMaxObservedRssKiB <= 0) throw new Error("Owned Rscript stage had no Linux RSS observation.");
        return stageMaxObservedRssKiB;
      },
      async writeJson(value) {
        if (exited) throw new Error("Owned Rscript exited before its request write.");
        if (stdinError) throw new Error("Owned Rscript stdin stream failed before its request write.");
        const payload = `${JSON.stringify(value)}\n`;
        if (Buffer.byteLength(payload, "utf8") > MAX_CHILD_JSON_BYTES) {
          throw new Error("Native R performance request exceeds its JSON bound.");
        }
        return withDeadline(
          new Promise((resolveWrite, rejectWrite) => {
            let settled = false;
            const settle = (callback) => {
              if (settled) return;
              settled = true;
              rejectPendingWrite = undefined;
              callback();
            };
            rejectPendingWrite = () =>
              settle(() => rejectWrite(new Error("Owned Rscript stdin stream failed during its request write.")));
            child.stdin.write(payload, "utf8", (error) => {
              if (error) settle(() => rejectWrite(new Error("Owned Rscript stdin write failed.")));
              else settle(() => resolveWrite(performance.now()));
            });
          }),
          absoluteDeadline,
          "owned Rscript stdin write"
        );
      },
      endInput() {
        child.stdin.end();
      },
      async waitNaturalExit() {
        const result = await withDeadline(close, absoluteDeadline, "owned Rscript natural exit");
        sampleRss();
        clearInterval(sampler);
        if (spawnError !== undefined) throw new Error("Owned Rscript emitted a spawn error.");
        if (result.code !== 0 || result.signal !== null) {
          const digest = stderrDigest.copy().digest("hex");
          throw new Error(
            `Owned Rscript failed (${result.signal === null ? "nonzero-exit" : "signal"}; stderrBytes=${stderrBytes}; stderrSha256=${digest}).`
          );
        }
        if (stderrOverflow) throw new Error("Owned Rscript stderr exceeded its fixed bound.");
        if (stdinError) throw new Error("Owned Rscript stdin stream failed.");
        if (stderrError) throw new Error("Owned Rscript stderr stream failed.");
        if (rssSamplerFailed) throw new Error("Owned Rscript Linux RSS sampler failed.");
        if (stderrBytes !== 0) throw new Error("Owned Rscript emitted unexpected stderr.");
        let groupGone = false;
        try {
          groupGone = await waitForOwnedGroupGone(pid);
        } catch {
          ownershipCertain = false;
        }
        if (!groupGone) {
          await terminate();
          throw new Error("Owned Rscript left a descendant in its process group after leader exit.");
        }
        await lines.waitForEnd(absoluteDeadline);
        lines.assertComplete();
        naturallyExited = true;
        finalized = true;
        return true;
      },
      terminate,
      get maxObservedRssKiB() {
        return maxObservedRssKiB;
      },
      get rssObservations() {
        return rssObservations;
      },
      get naturallyExited() {
        return naturallyExited;
      },
      get ownershipCertain() {
        return ownershipCertain;
      },
      get exited() {
        return exited;
      }
    });
  } catch (error) {
    if (setupSampler !== undefined) clearInterval(setupSampler);
    try {
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
    } catch {
      // The process-group receipt, not stream disposal, decides ownership certainty.
    }
    await cleanMalformedOwnedGroup(pid);
    throw error;
  }
}

export async function runRPerformanceLibraryProbe({
  executable,
  privateRoot,
  environment = process.env,
  children = new Set(),
  ownershipLease,
  spawnProcess = spawnOwnedRscript,
  beforeSpawn = () => {},
  afterExit = () => {}
}) {
  preflightRPerformanceLibraryEnvironment(environment);
  const homeReceipt = readRPerformanceCallerHomeReceipt(environment);
  beforeSpawn();
  revalidateCallerHome(homeReceipt);
  let child;
  try {
    child = await spawnProcess({
      executable,
      arguments_: ["--vanilla", "-e", R_LIBRARY_PROBE_EXPRESSION],
      privateRoot,
      environment,
      home: homeReceipt.path,
      maxStdoutFrameBytes: MAX_LIBRARY_PROBE_FRAME_BYTES
    });
  } catch (error) {
    if (error?.code === OWNERSHIP_UNCERTAIN && ownershipLease) ownershipLease.uncertain = true;
    throw error;
  }
  children.add(child);
  try {
    child.beginStage();
    const frame = await child.nextLine();
    const decoded = parseRPerformanceLibraryProbeFrame(frame.text);
    const receipt = createRPerformanceLibraryReceipt(decoded);
    child.endStage();
    child.endInput();
    await child.waitNaturalExit();
    children.delete(child);
    revalidateCallerHome(homeReceipt);
    revalidateLibraryReceipt(receipt);
    afterExit();
    if (child.rssObservations <= 0 || child.maxObservedRssKiB <= 0) {
      throw new Error("Owned R library-probe process had no Linux VmRSS observation.");
    }
    return Object.freeze({
      receipt,
      maxObservedRssKiB: child.maxObservedRssKiB,
      exitedNaturally: child.naturallyExited
    });
  } catch (error) {
    const certain = await child.terminate();
    if (certain) children.delete(child);
    throw error;
  }
}

function parseChildJson(frame, _label) {
  return parseStrictJson(frame.text, { maxBytes: MAX_CHILD_JSON_BYTES });
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has missing or unknown fields.`);
  }
}

function validateHarnessRuntime(runtime) {
  exactKeys(
    runtime,
    ["rVersion", "platform", "architecture", "operatingSystem", "libraryResolution", "packages"],
    "R harness runtime"
  );
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(runtime.rVersion)) {
    throw new Error("R harness reported an invalid R version.");
  }
  for (const key of ["platform", "architecture", "operatingSystem"]) {
    if (typeof runtime[key] !== "string" || runtime[key].length === 0 || runtime[key].length > 256) {
      throw new Error(`R harness runtime ${key} is invalid.`);
    }
  }
  if (runtime.operatingSystem !== "Linux") throw new Error("Native R performance requires R on Linux.");
  exactKeys(
    runtime.libraryResolution,
    ["protocol", "directoryCount", "explicitDirectoriesVerified"],
    "R harness library resolution"
  );
  if (
    runtime.libraryResolution.protocol !== R_PERFORMANCE_LIBRARY_DISCOVERY_PROTOCOL ||
    !Number.isSafeInteger(runtime.libraryResolution.directoryCount) ||
    runtime.libraryResolution.directoryCount <= 0 ||
    runtime.libraryResolution.directoryCount > MAX_LIBRARY_DIRECTORIES ||
    runtime.libraryResolution.explicitDirectoriesVerified !== true
  ) {
    throw new Error("R harness library-resolution proof is invalid.");
  }
  exactKeys(
    runtime.packages,
    ["jsonlite", "dataTable", "rlang", "bit64", "tibble", "nanoparquet", "collapse"],
    "R harness package provenance"
  );
  for (const [name, version] of Object.entries(runtime.packages)) {
    if (version !== null && (typeof version !== "string" || version.length === 0 || version.length > 128)) {
      throw new Error(`R harness package version ${name} is invalid.`);
    }
  }
  for (const required of ["jsonlite", "dataTable", "rlang", "bit64"]) {
    if (runtime.packages[required] === null) throw new Error(`R harness requires package ${required}.`);
  }
  return runtime;
}

function validateFixtureEcho(value) {
  if (JSON.stringify(value) !== JSON.stringify(R_PERFORMANCE_FIXTURE_DEFINITION)) {
    throw new Error("R harness fixture echo does not match the SHA-256-bound descriptor.");
  }
}

export function validateRPerformanceDirectFrame(value) {
  exactKeys(
    value,
    [
      "protocol",
      "kind",
      "runtime",
      "fixture",
      "freshOpenSamplesMs",
      "projectedPageSamplesMs",
      "compoundFilterPageSamplesMs",
      "stableMultiKeySortFirstUncachedMs",
      "stableMultiKeySortPageSamplesMs",
      "eightColumnSummarySamplesMs",
      "resourceProof",
      "semanticProof"
    ],
    "direct R harness result"
  );
  if (value.protocol !== R_PERFORMANCE_HARNESS_PROTOCOL || value.kind !== "direct") {
    throw new Error("Direct R harness protocol or kind changed.");
  }
  validateHarnessRuntime(value.runtime);
  validateFixtureEcho(value.fixture);
  for (const [samples, count, label] of [
    [value.freshOpenSamplesMs, 5, "fresh open"],
    [value.projectedPageSamplesMs, 20, "projected page"],
    [value.compoundFilterPageSamplesMs, 20, "compound filter"],
    [value.stableMultiKeySortPageSamplesMs, 20, "stable sort"],
    [value.eightColumnSummarySamplesMs, 20, "summary"]
  ]) {
    if (!Array.isArray(samples) || samples.length !== count || samples.some((entry) => !validDuration(entry))) {
      throw new Error(`Direct R harness ${label} samples are invalid.`);
    }
  }
  if (!validDuration(value.stableMultiKeySortFirstUncachedMs)) {
    throw new Error("Direct R harness first uncached sort timing is invalid.");
  }
  exactKeys(value.resourceProof, ["processVmHwmKiB", "stageVmHwmKiB"], "direct R resource proof");
  exactKeys(
    value.resourceProof.stageVmHwmKiB,
    [
      "freshOpen",
      "projectedPage",
      "compoundFilterPage",
      "stableMultiKeySortPage",
      "eightColumnSummary",
      "semanticProof"
    ],
    "direct R stage RSS proof"
  );
  const stageValues = Object.values(value.resourceProof.stageVmHwmKiB);
  if (
    stageValues.some((entry) => !Number.isSafeInteger(entry) || entry <= 0) ||
    !Number.isSafeInteger(value.resourceProof.processVmHwmKiB) ||
    value.resourceProof.processVmHwmKiB < Math.max(...stageValues)
  ) {
    throw new Error("Direct R harness omitted an exact Linux VmHWM stage receipt.");
  }
  const expectedProof = {
    passed: true,
    sourceUnchanged: true,
    freshPagesVerified: 5,
    projectedPagesVerified: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    compoundFilterPagesVerified: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    stableSortPagesVerified: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    summariesVerified: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    datasetStatsVerified: true,
    millionRowSampledSummaryVerified: true,
    keyedDataTableVerified: true
  };
  if (JSON.stringify(value.semanticProof) !== JSON.stringify(expectedProof)) {
    throw new Error("Direct R harness semantic proof is incomplete.");
  }
  return value;
}

function validateReadyFrame(value, runKind) {
  exactKeys(value, ["protocol", "kind", "runKind", "runtime", "fixture"], "R harness ready frame");
  if (value.protocol !== R_PERFORMANCE_HARNESS_PROTOCOL || value.kind !== "ready" || value.runKind !== runKind) {
    throw new Error("R harness emitted the wrong ready frame.");
  }
  validateHarnessRuntime(value.runtime);
  validateFixtureEcho(value.fixture);
  return value;
}

function validDuration(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= R_PERFORMANCE_PROCESS_SAFETY_DEADLINE_MS
  );
}

const COLUMN_NAMES = Object.freeze(R_PERFORMANCE_FIXTURE_DEFINITION.columnDefinitions.map((entry) => entry.name));
const PROFILE_COLUMN_NAMES = Object.freeze([...R_PERFORMANCE_FIXTURE_DEFINITION.profileColumns]);
const PROFILE_COLUMN_POSITIONS = Object.freeze(PROFILE_COLUMN_NAMES.map((name) => COLUMN_NAMES.indexOf(name)));
const EXPECTED_SCHEMA_KINDS = Object.freeze([
  "integer",
  "character",
  "double",
  "character",
  "logical",
  "integer",
  "double",
  "factor",
  "factor",
  "date",
  "datetime",
  "difftime",
  "integer64",
  "character",
  "logical",
  "double",
  "integer",
  "double",
  "character",
  "integer"
]);
const EXPECTED_RAW_TYPES = Object.freeze([
  "integer",
  "character",
  "double",
  "character",
  "logical",
  "integer",
  "double",
  "factor",
  "ordered factor",
  "Date",
  "POSIXct",
  "difftime",
  "integer64",
  "character",
  "logical",
  "double",
  "integer",
  "double",
  "character",
  "integer"
]);
const EXPECTED_PUBLIC_TYPES = Object.freeze([
  "integer",
  "string",
  "float",
  "string",
  "boolean",
  "integer",
  "float",
  "string",
  "string",
  "date",
  "datetime",
  "duration",
  "integer",
  "string",
  "boolean",
  "float",
  "integer",
  "float",
  "string",
  "integer"
]);

function requireJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} changed.`);
}

function emptyView() {
  return { filters: [], sorts: [] };
}

function compoundFilterView() {
  return {
    filters: [
      {
        column: { id: "r:c:5", name: "bucket" },
        type: "integer",
        predicates: [{ kind: "predicate", operator: "between", value: 100, secondValue: 800 }]
      },
      {
        column: { id: "r:c:4", name: "flag" },
        type: "boolean",
        predicates: [{ kind: "predicate", operator: "equals", value: true }]
      }
    ],
    sorts: [],
    logic: "and"
  };
}

function stableSortView() {
  return {
    filters: [],
    sorts: [
      { column: { id: "r:c:1", name: "group" }, direction: "asc", nulls: "last" },
      { column: { id: "r:c:2", name: "value" }, direction: "desc", nulls: "last" }
    ]
  };
}

function pageWindow(rowOffset, columnOffset, view = emptyView(), rowLimit = 200, columnLimit = 16) {
  return { rowOffset, rowLimit, columnOffset, columnLimit, view };
}

function workloadRowOffset(sampleNumber, totalRows) {
  if (sampleNumber === 1) return 0;
  if (sampleNumber === 2) return totalRows - R_PERFORMANCE_FIXTURE_DEFINITION.pageRows;
  return ((sampleNumber - 1) * 7919) % (totalRows - R_PERFORMANCE_FIXTURE_DEFINITION.pageRows);
}

function workloadColumnOffset(sampleNumber) {
  return sampleNumber > 10 ? 4 : 0;
}

function fixtureValue(row, column) {
  switch (column) {
    case 0:
      return { kind: "integer", raw: String(row) };
    case 1:
      return { kind: "string", raw: `g${String(row % 127).padStart(3, "0")}` };
    case 2: {
      if (row % 991 === 0) return { kind: "infinity", raw: null, sign: -1 };
      if (row % 997 === 0) return { kind: "infinity", raw: null, sign: 1 };
      if (row % 777 === 0) return { kind: "nan", raw: null };
      if (row % 1000 === 0) return { kind: "null", raw: null };
      return { kind: "number", raw: ((row * 17) % 10007) - 5003 };
    }
    case 3: {
      if (row === 1) return { kind: "string", raw: "row-000001" };
      if (row === 250_000) return { kind: "string", raw: "row-250000" };
      if (row === 12_345) return { kind: "string", raw: "Grüße-Δ" };
      if (row % 503 === 0) return { kind: "null", raw: null };
      return { kind: "string", raw: `row-${String(((row - 1) % 10_000) + 1).padStart(6, "0")}` };
    }
    case 4:
      return row % 509 === 0 ? { kind: "null", raw: null } : { kind: "boolean", raw: row % 2 === 0 };
    case 5:
      return { kind: "integer", raw: String(row % 997) };
    case 6:
      return row % 101 === 0 ? { kind: "null", raw: null } : { kind: "number", raw: row / 10 };
    case 7:
      return { kind: "string", raw: `level-${row % 5}` };
    case 8:
      return { kind: "string", raw: `rank-${row % 4}` };
    case 9: {
      const value = new Date(Date.UTC(2020, 0, 1) + (row % 1461) * 86_400_000).toISOString().slice(0, 10);
      return { kind: "date", raw: value };
    }
    case 10:
      return { kind: "datetime", raw: 1_577_836_800 + (row % 100_000) };
    case 11:
      return { kind: "duration", raw: row % 7200 };
    case 12:
      return { kind: "integer", raw: String(9_007_199_254_740_992n + BigInt(row)) };
    case 13:
      return { kind: "string", raw: `secondary-${String(row % 211).padStart(3, "0")}` };
    case 14:
      return row % 307 === 0 ? { kind: "null", raw: null } : { kind: "boolean", raw: row % 11 === 0 };
    case 15:
      return { kind: "number", raw: (row % 4093) / 7 };
    case 16:
      return { kind: "integer", raw: String(row % 8191) };
    case 17:
      return { kind: "number", raw: -(row % 1237) };
    case 18:
      return { kind: "string", raw: `category-${String(row % 23).padStart(2, "0")}` };
    case 19:
      return { kind: "integer", raw: "7" };
    default:
      throw new Error("Native R fixture column is outside its deterministic schema.");
  }
}

function validateCell(cell, row, column) {
  const expected = fixtureValue(row, column);
  const fields =
    expected.kind === "infinity"
      ? ["kind", "raw", "display", "isNull", "isNaN", "sign"]
      : ["kind", "raw", "display", "isNull", "isNaN"];
  exactKeys(cell, fields, `kernel cell ${row}:${column}`);
  if (cell.kind !== expected.kind || typeof cell.display !== "string") {
    throw new Error("Kernel page changed a deterministic mixed-type cell.");
  }
  if (expected.kind === "null") {
    if (cell.raw !== null || cell.isNull !== true || cell.isNaN !== false || cell.display !== "NA") {
      throw new Error("Kernel page changed a deterministic null cell.");
    }
    return;
  }
  if (expected.kind === "nan") {
    if (cell.raw !== null || cell.isNull !== false || cell.isNaN !== true || cell.display !== "NaN") {
      throw new Error("Kernel page changed a deterministic NaN cell.");
    }
    return;
  }
  if (expected.kind === "infinity") {
    if (
      cell.raw !== null ||
      cell.isNull !== false ||
      cell.isNaN !== false ||
      cell.sign !== expected.sign ||
      cell.display !== (expected.sign < 0 ? "-Inf" : "Inf")
    ) {
      throw new Error("Kernel page changed a deterministic infinity cell.");
    }
    return;
  }
  if (cell.isNull !== false || cell.isNaN !== false) {
    throw new Error("Kernel page changed deterministic cell missingness.");
  }
  if (typeof expected.raw === "number") {
    if (typeof cell.raw !== "string" || Number(cell.raw) !== expected.raw) {
      throw new Error("Kernel page changed a deterministic numeric cell.");
    }
  } else if (cell.raw !== expected.raw) {
    throw new Error("Kernel page changed a deterministic exact cell.");
  }
}

function validateSchemaSemantics(semantics, position) {
  const kind = EXPECTED_SCHEMA_KINDS[position];
  const extra =
    kind === "factor"
      ? ["levels", "ordered"]
      : kind === "datetime"
        ? ["timezone"]
        : kind === "difftime"
          ? ["units"]
          : [];
  exactKeys(semantics, ["kind", "storageMode", "classes", ...extra], `kernel schema semantics ${position}`);
  if (semantics.kind !== kind || !Array.isArray(semantics.classes)) {
    throw new Error("Kernel schema changed deterministic column semantics.");
  }
  const expectedStorage = [
    "integer",
    "character",
    "double",
    "character",
    "logical",
    "integer",
    "double",
    "integer",
    "integer",
    "double",
    "double",
    "double",
    "double",
    "character",
    "logical",
    "double",
    "integer",
    "double",
    "character",
    "integer"
  ][position];
  const expectedClasses = [
    ["integer"],
    ["character"],
    ["numeric"],
    ["character"],
    ["logical"],
    ["integer"],
    ["numeric"],
    ["factor"],
    ["ordered", "factor"],
    ["Date"],
    ["POSIXct", "POSIXt"],
    ["difftime"],
    ["integer64"],
    ["character"],
    ["logical"],
    ["numeric"],
    ["integer"],
    ["numeric"],
    ["character"],
    ["integer"]
  ][position];
  if (
    semantics.storageMode !== expectedStorage ||
    JSON.stringify(semantics.classes) !== JSON.stringify(expectedClasses)
  ) {
    throw new Error("Kernel schema changed deterministic storage or S3 classes.");
  }
  if (position === 7) {
    requireJsonEqual(semantics.levels, ["level-0", "level-1", "level-2", "level-3", "level-4"], "factor levels");
    if (semantics.ordered !== false) throw new Error("Kernel schema changed factor ordering.");
  }
  if (position === 8) {
    requireJsonEqual(semantics.levels, ["rank-0", "rank-1", "rank-2", "rank-3"], "ordered-factor levels");
    if (semantics.ordered !== true) throw new Error("Kernel schema changed ordered-factor ordering.");
  }
  if (position === 10 && semantics.timezone !== "UTC") throw new Error("Kernel schema changed the UTC timezone.");
  if (position === 11 && semantics.units !== "secs") throw new Error("Kernel schema changed difftime units.");
}

function validateFixtureDescriptor(value, flavor, keyColumnIds) {
  exactKeys(
    value,
    ["contractVersion", "dataframeFlavor", "shape", "frameSemantics", "schema", "page"],
    "kernel frame page"
  );
  if (value.contractVersion !== 5 || value.dataframeFlavor !== flavor) {
    throw new Error("Kernel frame contract version or dataframe flavor changed.");
  }
  exactKeys(value.shape, ["rows", "columns"], "kernel frame shape");
  if (value.shape.rows !== 250_000 || value.shape.columns !== 20) throw new Error("Kernel fixture shape changed.");
  exactKeys(value.frameSemantics, ["classes", "rowNames", "keyColumnIds"], "kernel frame semantics");
  requireJsonEqual(
    value.frameSemantics.classes,
    flavor === "r.data.table" ? ["data.table", "data.frame"] : ["data.frame"],
    "kernel frame classes"
  );
  if (value.frameSemantics.rowNames !== "positional") throw new Error("Kernel fixture row identity mode changed.");
  requireJsonEqual(value.frameSemantics.keyColumnIds, keyColumnIds, "kernel frame key IDs");
  if (!Array.isArray(value.schema) || value.schema.length !== 20)
    throw new Error("Kernel fixture schema width changed.");
  value.schema.forEach((column, position) => {
    exactKeys(
      column,
      ["id", "name", "position", "rawType", "type", "nullable", "semantics"],
      `kernel schema ${position}`
    );
    if (
      column.id !== `r:c:${position}` ||
      column.name !== COLUMN_NAMES[position] ||
      column.position !== position ||
      column.rawType !== EXPECTED_RAW_TYPES[position] ||
      column.type !== EXPECTED_PUBLIC_TYPES[position] ||
      column.nullable !== true
    ) {
      throw new Error("Kernel fixture schema changed.");
    }
    validateSchemaSemantics(column.semantics, position);
  });
}

export function validateFixturePage(
  value,
  { expectedPositions, rowOffset, columnOffset, totalRows, flavor = "r.data.frame", keyColumnIds = [] }
) {
  validateFixtureDescriptor(value, flavor, keyColumnIds);
  const page = value.page;
  exactKeys(
    page,
    ["offset", "limit", "totalRows", "columnOffset", "columnLimit", "columnIds", "rows"],
    "kernel page window"
  );
  const expectedColumnIds = Array.from({ length: 16 }, (_, index) => `r:c:${columnOffset + index}`);
  if (
    page.offset !== rowOffset ||
    page.limit !== 200 ||
    page.totalRows !== totalRows ||
    page.columnOffset !== columnOffset ||
    page.columnLimit !== 16
  ) {
    throw new Error("Kernel page changed its exact 200x16 window.");
  }
  requireJsonEqual(page.columnIds, expectedColumnIds, "kernel page column IDs");
  if (!Array.isArray(page.rows) || page.rows.length !== expectedPositions.length) {
    throw new Error("Kernel page returned the wrong row count.");
  }
  page.rows.forEach((row, index) => {
    exactKeys(row, ["id", "rowNumber", "values"], `kernel page row ${index}`);
    if (
      row.id !== `r:r:${expectedPositions[index] - 1}` ||
      row.rowNumber !== rowOffset + index ||
      !Array.isArray(row.values) ||
      row.values.length !== 16
    ) {
      throw new Error("Kernel page changed deterministic row or projection identities.");
    }
  });
  for (const index of new Set([0, expectedPositions.length - 1])) {
    const row = page.rows[index];
    const sourceRow = expectedPositions[index];
    row.values.forEach((cell, projectedPosition) => validateCell(cell, sourceRow, columnOffset + projectedPosition));
  }
}

function assertResponseEnvelope(value, request, expectedKind, expectedFields) {
  exactKeys(
    value,
    ["transportVersion", "requestId", "kind", "sessionId", ...expectedFields],
    `${request.kind} response`
  );
  if (
    value.transportVersion !== TRANSPORT_VERSION ||
    value.requestId !== request.requestId ||
    value.kind !== expectedKind ||
    value.sessionId !== request.payload.sessionId
  ) {
    throw new Error(`${request.kind} response changed its exact correlation envelope.`);
  }
}

function validatePageResponse(value, request, expected, open = false) {
  assertResponseEnvelope(value, request, "page", open ? ["exportFormats", "page"] : ["page"]);
  if (open) requireJsonEqual(value.exportFormats, ["csv", "parquet"], "kernel export formats");
  validateFixturePage(value.page, expected);
}

export function validateClosedResponse(value, request) {
  assertResponseEnvelope(value, request, "closed", []);
}

let filterPositionsCache;
function filterPositions() {
  if (filterPositionsCache !== undefined) return filterPositionsCache;
  const output = [];
  for (let row = 1; row <= 250_000; row += 1) {
    const bucket = row % 997;
    if (bucket >= 100 && bucket <= 800 && row % 509 !== 0 && row % 2 === 0) output.push(row);
  }
  filterPositionsCache = Object.freeze(output);
  return filterPositionsCache;
}

function fixtureSortValue(row) {
  const value = fixtureValue(row, 2);
  return value.kind === "null" || value.kind === "nan"
    ? undefined
    : value.sign === -1
      ? -Infinity
      : value.sign === 1
        ? Infinity
        : value.raw;
}

let sortPositionsCache;
function sortPositions() {
  if (sortPositionsCache !== undefined) return sortPositionsCache;
  const output = Array.from({ length: 250_000 }, (_, index) => index + 1);
  output.sort((left, right) => {
    const leftGroup = left % 127;
    const rightGroup = right % 127;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    const leftValue = fixtureSortValue(left);
    const rightValue = fixtureSortValue(right);
    if (leftValue === undefined) return rightValue === undefined ? left - right : 1;
    if (rightValue === undefined) return -1;
    if (leftValue !== rightValue) return rightValue - leftValue;
    return left - right;
  });
  sortPositionsCache = Object.freeze(output);
  return sortPositionsCache;
}

export function validateSummaryResponse(value, request) {
  assertResponseEnvelope(value, request, "summary", ["summaries"]);
  if (!Array.isArray(value.summaries) || value.summaries.length !== 8) {
    throw new Error("Kernel summary changed its exact eight-column result.");
  }
  value.summaries.forEach((summary, index) => {
    const position = PROFILE_COLUMN_POSITIONS[index];
    if (
      summary?.columnId !== `r:c:${position}` ||
      summary.column !== PROFILE_COLUMN_NAMES[index] ||
      summary.totalCount !== 250_000 ||
      summary.rawType !== EXPECTED_RAW_TYPES[position] ||
      summary.type !== EXPECTED_PUBLIC_TYPES[position]
    ) {
      throw new Error("Kernel summary changed ordered mixed-type provenance.");
    }
  });
  const [numeric, text, logical, factor, date, datetime, duration, wide] = value.summaries;
  if (
    numeric.nullCount !== 250 ||
    numeric.nanCount !== 321 ||
    text.nullCount !== 497 ||
    text.text?.minLength !== 7 ||
    text.text?.maxLength !== 10 ||
    logical.nullCount !== 491 ||
    logical.visualization?.trueCount !== 124_755 ||
    logical.visualization?.falseCount !== 124_754 ||
    factor.type !== "string" ||
    date.type !== "date" ||
    date.visualization?.min !== "2020-01-01" ||
    date.visualization?.max !== "2023-12-31" ||
    datetime.type !== "datetime" ||
    datetime.visualization?.min !== "2020-01-01T00:00:00.000000" ||
    datetime.visualization?.max !== "2020-01-02T03:46:39.000000" ||
    duration.type !== "duration" ||
    duration.numeric?.min !== 0 ||
    duration.numeric?.max !== 7199 ||
    wide.rawType !== "integer64" ||
    wide.numeric?.exactMin?.raw !== "9007199254740993" ||
    wide.numeric?.exactMax?.raw !== "9007199254990992"
  ) {
    throw new Error("Kernel summary changed mixed-type counts or integer64 sentinels.");
  }
}

export function validateDatasetStatsResponse(value, request) {
  assertResponseEnvelope(value, request, "datasetStats", ["totalRows", "stats"]);
  exactKeys(
    value.stats,
    ["missingCells", "missingRows", "duplicateRows", "duplicateRowsSampleSize", "missingValuesByColumn"],
    "kernel dataset statistics"
  );
  const expected = R_PERFORMANCE_FIXTURE_DEFINITION.expectedStats;
  if (
    value.totalRows !== 250_000 ||
    value.stats.missingCells !== expected.missingCells ||
    value.stats.missingRows !== expected.missingRows ||
    value.stats.duplicateRows !== expected.duplicateRows ||
    value.stats.duplicateRowsSampleSize !== expected.duplicateRowsSampleSize ||
    !Array.isArray(value.stats.missingValuesByColumn) ||
    value.stats.missingValuesByColumn.length !== 20
  ) {
    throw new Error("Kernel dataset statistics changed deterministic aggregates.");
  }
  value.stats.missingValuesByColumn.forEach((entry, index) => {
    exactKeys(entry, ["column", "count"], `kernel missing-value statistic ${index}`);
    if (entry.column !== COLUMN_NAMES[index] || entry.count !== expected.missingValuesByColumn[index]) {
      throw new Error("Kernel dataset statistics changed the ordered per-column distribution.");
    }
  });
}

export function validateLargeOpenResponse(value, request) {
  assertResponseEnvelope(value, request, "page", ["exportFormats", "page"]);
  requireJsonEqual(value.exportFormats, ["csv", "parquet"], "large-profile export formats");
  const page = value.page;
  if (
    page?.contractVersion !== 5 ||
    page.dataframeFlavor !== "r.data.frame" ||
    page.shape?.rows !== 1_000_001 ||
    page.shape?.columns !== 1 ||
    page.page?.totalRows !== 1_000_001 ||
    page.page?.rows?.length !== 1 ||
    page.schema?.[0]?.id !== "r:c:0" ||
    page.schema?.[0]?.name !== "value"
  ) {
    throw new Error("Kernel million-row profile fixture changed.");
  }
}

export function validateLargeSummaryResponse(value, request) {
  assertResponseEnvelope(value, request, "summary", ["summaries"]);
  const summary = value.summaries?.[0];
  if (
    value.summaries?.length !== 1 ||
    summary?.columnId !== "r:c:0" ||
    summary.totalCount !== 1_000_001 ||
    summary.visualization?.sampled !== true ||
    summary.numeric?.min !== 0 ||
    summary.numeric?.max !== 999
  ) {
    throw new Error("Kernel million-row sampled summary proof changed.");
  }
}

function kernelRequest(kind, payload) {
  return { transportVersion: TRANSPORT_VERSION, requestId: randomUUID(), kind, payload };
}

export async function sendCorrelated(child, request, validate, { timingBase } = {}) {
  child.beginStage();
  let responsePromise;
  try {
    responsePromise = child.nextLine().then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    const writeCompletedAt = await child.writeJson(request);
    const response = await responsePromise;
    if (response.error !== undefined) throw response.error;
    const frame = response.value;
    if (frame.arrivedAt < writeCompletedAt) {
      throw new Error("Owned Rscript response arrived before the request write completed.");
    }
    const value = parseChildJson(frame, `${request.kind} response`);
    validate(value, request);
    const validatedAt = performance.now();
    const durationMs = validatedAt - (timingBase ?? writeCompletedAt);
    if (!validDuration(durationMs)) throw new Error(`${request.kind} produced an invalid measured duration.`);
    return Object.freeze({ value, durationMs, rssKiB: child.endStage(), validatedAt, writeCompletedAt });
  } catch (error) {
    // responsePromise owns both settlements, including an abandoned waiter
    // that the process-abort path will close after a failed stdin write.
    try {
      child.endStage();
    } catch {
      // Preserve the semantic or transport failure.
    }
    throw error;
  }
}

function revalidateSpawnInputs({ sourceBinding, intake, nodeReceipt, rscriptReceipt, privateFiles, revalidators }) {
  revalidators.node(nodeReceipt);
  revalidators.rscript(rscriptReceipt);
  for (const receipt of Object.values(privateFiles)) revalidatePrivateFile(receipt);
  revalidators.candidate(intake);
  revalidators.source(sourceBinding);
}

function revalidateMeasuredSpawnInputs(context) {
  revalidateSpawnInputs(context);
  context.revalidators.library(context.libraryReceipt);
}

function sameRuntime(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Native R runtime/package provenance changed between owned processes.");
  }
}

export function assertRuntimeMatchesLibraryReceipt(runtime, receipt) {
  validateHarnessRuntime(runtime);
  if (
    runtime.libraryResolution.protocol !== R_PERFORMANCE_LIBRARY_DISCOVERY_PROTOCOL ||
    runtime.libraryResolution.explicitDirectoriesVerified !== true ||
    runtime.libraryResolution.directoryCount !== receipt.libraries.length
  ) {
    throw new Error("Measured R library-resolution proof differs from its private discovery receipt.");
  }
  return runtime;
}

function processArguments(privateFiles, mode) {
  return [
    "--vanilla",
    privateFiles.harness.path,
    mode,
    privateFiles.frame.path,
    privateFiles.exports.path,
    privateFiles.kernel.path,
    privateFiles.fixture.path
  ];
}

async function startOwnedProcess(context, mode, spawnProcess = spawnOwnedRscript) {
  revalidateMeasuredSpawnInputs(context);
  const startedAt = performance.now();
  let child;
  try {
    child = await spawnProcess({
      executable: context.rscriptReceipt.path,
      arguments_: processArguments(context.privateFiles, mode),
      privateRoot: context.privateRoot.root,
      environment: context.environment,
      libraryReceipt: context.libraryReceipt
    });
  } catch (error) {
    if (error?.code === OWNERSHIP_UNCERTAIN) context.ownershipLease.uncertain = true;
    throw error;
  }
  context.children.add(child);
  return Object.freeze({ child, startedAt });
}

async function finishOwnedProcess(context, child) {
  child.endInput();
  await child.waitNaturalExit();
  context.children.delete(child);
  revalidateMeasuredSpawnInputs(context);
}

async function abortOwnedProcess(context, child) {
  const certain = await child.terminate();
  if (certain) context.children.delete(child);
  return certain;
}

export async function runDirectRPerformanceMeasurement(context, dependencies = {}) {
  const { child } = await startOwnedProcess(context, "direct", dependencies.spawnProcess);
  try {
    child.beginStage();
    const frame = await child.nextLine();
    const value = validateRPerformanceDirectFrame(parseChildJson(frame, "direct R harness result"));
    child.endStage();
    await finishOwnedProcess(context, child);
    if (child.rssObservations <= 0) throw new Error("Direct owned Rscript had no parent-observed RSS receipt.");
    return Object.freeze({
      value,
      parentMaxObservedRssKiB: child.maxObservedRssKiB,
      runtime: value.runtime,
      exitedNaturally: child.naturallyExited
    });
  } catch (error) {
    await abortOwnedProcess(context, child);
    throw error;
  }
}

export async function runFreshKernelMeasurement(context, dependencies = {}) {
  const { child, startedAt } = await startOwnedProcess(context, "kernel-fresh", dependencies.spawnProcess);
  const sessionId = randomUUID();
  try {
    const ready = validateReadyFrame(parseChildJson(await child.nextLine(), "fresh kernel ready frame"), "fresh");
    const open = kernelRequest("openSession", {
      sessionId,
      variableName: "frame",
      page: pageWindow(0, 0)
    });
    const opened = await sendCorrelated(
      child,
      open,
      (value, request) =>
        validatePageResponse(
          value,
          request,
          {
            expectedPositions: Array.from({ length: 200 }, (_, index) => index + 1),
            rowOffset: 0,
            columnOffset: 0,
            totalRows: 250_000
          },
          true
        ),
      { timingBase: startedAt }
    );
    const closeRequest = kernelRequest("closeSession", { sessionId });
    await sendCorrelated(child, closeRequest, validateClosedResponse);
    await finishOwnedProcess(context, child);
    if (child.rssObservations <= 0 || child.maxObservedRssKiB <= 0) {
      throw new Error("Fresh owned kernel Rscript had no Linux VmRSS observation.");
    }
    return Object.freeze({
      durationMs: opened.durationMs,
      maxObservedRssKiB: child.maxObservedRssKiB,
      runtime: ready.runtime,
      exitedNaturally: child.naturallyExited,
      correlatedResponses: 2,
      closedSessions: 1,
      readyFrames: 1
    });
  } catch (error) {
    await abortOwnedProcess(context, child);
    throw error;
  }
}

function mainOpenValidator(value, request) {
  validatePageResponse(
    value,
    request,
    {
      expectedPositions: Array.from({ length: 200 }, (_, index) => index + 1),
      rowOffset: 0,
      columnOffset: 0,
      totalRows: 250_000
    },
    true
  );
}

function projectedValidator(sampleNumber) {
  const rowOffset = workloadRowOffset(sampleNumber, 250_000);
  const columnOffset = workloadColumnOffset(sampleNumber);
  return (value, request) =>
    validatePageResponse(value, request, {
      expectedPositions: Array.from({ length: 200 }, (_, index) => rowOffset + index + 1),
      rowOffset,
      columnOffset,
      totalRows: 250_000
    });
}

function filteredValidator(sampleNumber) {
  const positions = filterPositions();
  const rowOffset = workloadRowOffset(sampleNumber, positions.length);
  const columnOffset = workloadColumnOffset(sampleNumber);
  return (value, request) =>
    validatePageResponse(value, request, {
      expectedPositions: positions.slice(rowOffset, rowOffset + 200),
      rowOffset,
      columnOffset,
      totalRows: positions.length
    });
}

function sortedValidator(sampleNumber) {
  const positions = sortPositions();
  const rowOffset = workloadRowOffset(sampleNumber, positions.length);
  const columnOffset = workloadColumnOffset(sampleNumber);
  return (value, request) =>
    validatePageResponse(value, request, {
      expectedPositions: positions.slice(rowOffset, rowOffset + 200),
      rowOffset,
      columnOffset,
      totalRows: positions.length
    });
}

function pageRequest(sessionId, rowOffset, columnOffset, view) {
  return kernelRequest("getPage", { sessionId, page: pageWindow(rowOffset, columnOffset, view) });
}

function summaryRequest(sessionId) {
  return kernelRequest("getSummary", {
    sessionId,
    columns: PROFILE_COLUMN_POSITIONS.map((position, index) => ({
      id: `r:c:${position}`,
      name: PROFILE_COLUMN_NAMES[index]
    })),
    view: emptyView()
  });
}

export async function runWorkloadKernelMeasurement(context, dependencies = {}) {
  const { child } = await startOwnedProcess(context, "kernel-workload", dependencies.spawnProcess);
  const mainSessionId = randomUUID();
  const largeSessionId = randomUUID();
  const keyedSessionId = randomUUID();
  const projectedPageSamplesMs = [];
  const compoundFilterPageSamplesMs = [];
  const stableMultiKeySortPageSamplesMs = [];
  const eightColumnSummarySamplesMs = [];
  const projectedPageRss = [];
  const compoundFilterPageRss = [];
  const stableMultiKeySortPageRss = [];
  const eightColumnSummaryRss = [];
  const controlRss = [];
  let correlatedResponses = 0;
  let closedSessions = 0;
  try {
    const ready = validateReadyFrame(parseChildJson(await child.nextLine(), "workload kernel ready frame"), "workload");
    const control = async (request, validate) => {
      const result = await sendCorrelated(child, request, validate);
      controlRss.push(result.rssKiB);
      correlatedResponses += 1;
      return result;
    };
    const measured = async (request, validate, samples, rss) => {
      const result = await sendCorrelated(child, request, validate);
      samples.push(result.durationMs);
      rss.push(result.rssKiB);
      correlatedResponses += 1;
      return result;
    };

    await control(
      kernelRequest("openSession", {
        sessionId: mainSessionId,
        variableName: "frame",
        page: pageWindow(0, 0)
      }),
      mainOpenValidator
    );

    for (let sample = 1; sample <= R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT; sample += 1) {
      const rowOffset = workloadRowOffset(sample, 250_000);
      const columnOffset = workloadColumnOffset(sample);
      await measured(
        pageRequest(mainSessionId, rowOffset, columnOffset, emptyView()),
        projectedValidator(sample),
        projectedPageSamplesMs,
        projectedPageRss
      );
    }

    const filtered = filterPositions();
    for (let sample = 1; sample <= R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT; sample += 1) {
      const rowOffset = workloadRowOffset(sample, filtered.length);
      const columnOffset = workloadColumnOffset(sample);
      await measured(
        pageRequest(mainSessionId, rowOffset, columnOffset, compoundFilterView()),
        filteredValidator(sample),
        compoundFilterPageSamplesMs,
        compoundFilterPageRss
      );
    }

    // Build the deterministic semantic oracle outside every timed request.
    sortPositions();
    const firstSort = await sendCorrelated(
      child,
      pageRequest(mainSessionId, 0, 0, stableSortView()),
      sortedValidator(1)
    );
    correlatedResponses += 1;
    for (let sample = 1; sample <= R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT; sample += 1) {
      const rowOffset = workloadRowOffset(sample, 250_000);
      const columnOffset = workloadColumnOffset(sample);
      await measured(
        pageRequest(mainSessionId, rowOffset, columnOffset, stableSortView()),
        sortedValidator(sample),
        stableMultiKeySortPageSamplesMs,
        stableMultiKeySortPageRss
      );
    }

    for (let sample = 1; sample <= R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT; sample += 1) {
      await measured(
        summaryRequest(mainSessionId),
        validateSummaryResponse,
        eightColumnSummarySamplesMs,
        eightColumnSummaryRss
      );
    }

    await control(
      kernelRequest("getDatasetStats", { sessionId: mainSessionId, view: emptyView() }),
      validateDatasetStatsResponse
    );
    await control(
      kernelRequest("openSession", {
        sessionId: largeSessionId,
        variableName: "large_profile",
        page: pageWindow(0, 0, emptyView(), 1, 1)
      }),
      validateLargeOpenResponse
    );
    await control(
      kernelRequest("getSummary", {
        sessionId: largeSessionId,
        columns: [{ id: "r:c:0", name: "value" }],
        view: emptyView()
      }),
      validateLargeSummaryResponse
    );
    await control(kernelRequest("closeSession", { sessionId: largeSessionId }), validateClosedResponse);
    closedSessions += 1;

    await control(
      kernelRequest("openSession", {
        sessionId: keyedSessionId,
        variableName: "keyed_frame",
        page: pageWindow(0, 0)
      }),
      (value, request) =>
        validatePageResponse(
          value,
          request,
          {
            expectedPositions: Array.from({ length: 200 }, (_, index) => index + 1),
            rowOffset: 0,
            columnOffset: 0,
            totalRows: 250_000,
            flavor: "r.data.table",
            keyColumnIds: ["r:c:0"]
          },
          true
        )
    );
    await control(kernelRequest("closeSession", { sessionId: keyedSessionId }), validateClosedResponse);
    closedSessions += 1;
    await control(kernelRequest("closeSession", { sessionId: mainSessionId }), validateClosedResponse);
    closedSessions += 1;

    await finishOwnedProcess(context, child);
    if (correlatedResponses !== 89 || closedSessions !== 3 || child.rssObservations <= 0) {
      throw new Error("Workload kernel response, cleanup, or RSS accounting changed.");
    }
    return Object.freeze({
      runtime: ready.runtime,
      exitedNaturally: child.naturallyExited,
      projectedPageSamplesMs,
      compoundFilterPageSamplesMs,
      stableMultiKeySortFirstUncachedMs: firstSort.durationMs,
      stableMultiKeySortPageSamplesMs,
      eightColumnSummarySamplesMs,
      resources: Object.freeze({
        maxObservedRssKiB: child.maxObservedRssKiB,
        projectedPage: projectedPageRss,
        compoundFilterPage: compoundFilterPageRss,
        stableMultiKeySortFirstUncached: firstSort.rssKiB,
        stableMultiKeySortPage: stableMultiKeySortPageRss,
        eightColumnSummary: eightColumnSummaryRss,
        semanticControls: Math.max(...controlRss)
      }),
      correlatedResponses,
      closedSessions,
      readyFrames: 1
    });
  } catch (error) {
    await abortOwnedProcess(context, child);
    throw error;
  }
}

export function kernelResponseAccounting() {
  const measured = {
    freshOpen: 5,
    projectedPage: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    compoundFilterPage: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    stableSortFirstUncached: 1,
    stableSortPage: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
    eightColumnSummary: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT
  };
  const controls = {
    sessionClose: 8,
    workloadOpen: 1,
    datasetStats: 1,
    millionRowOpen: 1,
    millionRowSummary: 1,
    keyedDataTableOpen: 1
  };
  const measuredTotal = Object.values(measured).reduce((sum, value) => sum + value, 0);
  const controlTotal = Object.values(controls).reduce((sum, value) => sum + value, 0);
  return { measured, controls, measuredTotal, controlTotal, allTotal: measuredTotal + controlTotal };
}

export function normalizeRPerformanceCpuModel(value) {
  if (typeof value !== "string") throw new TypeError("Native R CPU model must be a string.");
  const normalized = value.replace(/[\\/]/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new Error("Native R CPU model is empty or exceeds its public bound.");
  }
  return normalized;
}

function publicMachineProvenance() {
  const processors = cpus();
  if (!Array.isArray(processors) || processors.length === 0 || typeof processors[0].model !== "string") {
    throw new Error("Native R performance could not identify the public CPU model.");
  }
  return {
    operatingSystem: "Linux",
    release: release(),
    architecture: arch(),
    cpuModel: normalizeRPerformanceCpuModel(processors[0].model),
    logicalCpuCount: processors.length,
    memoryBytes: totalmem()
  };
}

export function assertSafeOutput(output, sourceBinding, privateRoot) {
  const absolute = resolve(output);
  const parent = dirname(absolute);
  const canonicalParent = realpathSync.native(parent);
  const parentMetadata = lstatSync(parent, { bigint: true });
  if (
    canonicalParent !== parent ||
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (typeof process.getuid === "function" && parentMetadata.uid !== BigInt(process.getuid())) ||
    join(canonicalParent, basename(absolute)) !== absolute
  ) {
    throw new Error("Native R performance output requires one existing canonical current-user-owned parent directory.");
  }
  if (absolute === sourceBinding.harnessPath) {
    throw new Error("Native R performance output cannot replace its commit-bound harness.");
  }
  try {
    const existing = lstatSync(absolute, { bigint: true });
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1n ||
      realpathSync.native(absolute) !== absolute ||
      (typeof process.getuid === "function" && existing.uid !== BigInt(process.getuid())) ||
      (existing.dev === sourceBinding.harness.identity.dev && existing.ino === sourceBinding.harness.identity.ino)
    ) {
      throw new Error("Native R performance output cannot alias a source or unsafe destination file.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const relation = relative(sourceBinding.root, absolute);
  if (relation && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)) {
    try {
      git(sourceBinding.root, ["ls-files", "--error-unmatch", "--", relation], 4096);
      throw new Error("Native R performance output cannot replace a Git-tracked source file.");
    } catch (error) {
      if (error?.message === "Native R performance output cannot replace a Git-tracked source file.") throw error;
      if (error?.status !== 1) throw new Error("Native R performance could not prove that its output is untracked.");
    }
  }
  if (privateRoot !== undefined) {
    const privateRelation = relative(privateRoot.root, absolute);
    if (
      !privateRelation ||
      (privateRelation !== ".." && !privateRelation.startsWith(`..${sep}`) && !isAbsolute(privateRelation))
    ) {
      throw new Error("Native R performance output must remain outside its private measurement root.");
    }
  }
  return Object.freeze({
    path: absolute,
    parentReceipt: Object.freeze({
      path: parent,
      dev: parentMetadata.dev,
      ino: parentMetadata.ino,
      mode: parentMetadata.mode,
      uid: parentMetadata.uid
    })
  });
}

function revalidateSafeOutput(binding) {
  const parent = binding.parentReceipt.path;
  const metadata = lstatSync(parent, { bigint: true });
  if (
    realpathSync.native(parent) !== parent ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== binding.parentReceipt.dev ||
    metadata.ino !== binding.parentReceipt.ino ||
    metadata.mode !== binding.parentReceipt.mode ||
    metadata.uid !== binding.parentReceipt.uid
  ) {
    throw new Error("Native R performance output parent changed after preflight.");
  }
}

function revalidatePublicCandidate(intake) {
  const accepted = intake.accepted;
  revalidateInstalledPerformanceVsix(accepted.publicCandidateReceipt);
  revalidateInstalledPerformanceChecksum(accepted.publicChecksumReceipt, accepted.publicCandidateReceipt.path);
  revalidateAcceptedPerformanceProvenance(accepted.publicProvenanceReceipt);
}

async function terminateAll(children) {
  let allCertain = true;
  for (const child of [...children]) {
    try {
      if (!(await child.terminate())) allCertain = false;
    } catch {
      allCertain = false;
    }
  }
  return allCertain;
}

export async function runRPerformance(options, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  if (platform() !== "linux") throw new Error("Native R performance evidence v1 requires Linux.");
  assertInstalledPerformanceArtifactPathSeparation(options);
  const sourceBinding = (dependencies.readSourceBinding ?? readRPerformanceSourceBinding)({
    expectedCommit: environment.EXPECTED_SHA,
    releaseTag: environment.RELEASE_TAG,
    root: dependencies.root ?? repositoryRoot
  });
  let outputBinding = assertSafeOutput(options.output, sourceBinding);
  revalidateSafeOutput(outputBinding);

  let privateRoot;
  let privateRootRemoved = false;
  let publishedReceipt;
  const ownershipLease = { uncertain: false };
  const children = new Set();
  try {
    privateRoot = createPrivateRoot();
    outputBinding = assertSafeOutput(options.output, sourceBinding, privateRoot);
    revalidateSafeOutput(outputBinding);

    const intake = await (dependencies.acceptPerformanceCandidate ?? acceptRPerformanceCandidate)({
      candidatePath: options.candidateInput,
      checksumPath: options.candidateChecksum,
      provenancePath: options.candidateProvenance,
      privateCandidatePath: join(privateRoot.root, PRIVATE_FILES.candidate),
      expectedCommit: sourceBinding.commit,
      releaseTag: sourceBinding.releaseTag,
      environment,
      acceptCandidate: dependencies.acceptCandidate
    });
    const privateFiles = Object.freeze({
      fixture: writeRPerformancePrivateFile(privateRoot.root, PRIVATE_FILES.fixture, R_PERFORMANCE_FIXTURE_BYTES),
      harness: writeRPerformancePrivateFile(privateRoot.root, PRIVATE_FILES.harness, sourceBinding.harness.bytes),
      frame: writeRPerformancePrivateFile(privateRoot.root, PRIVATE_FILES.frame, intake.extracted.frameContract.bytes),
      exports: writeRPerformancePrivateFile(
        privateRoot.root,
        PRIVATE_FILES.exports,
        intake.extracted.kernelExports.bytes
      ),
      kernel: writeRPerformancePrivateFile(privateRoot.root, PRIVATE_FILES.kernel, intake.extracted.kernelAgent.bytes)
    });
    const rscriptReceipt =
      dependencies.rscriptReceipt ??
      readRscriptReceipt(resolveExecutable(environment.RSCRIPT ?? "Rscript", environment.PATH ?? ""));
    const nodeReceipt = dependencies.nodeReceipt ?? readNodeReceipt();
    const revalidators = Object.freeze({
      node: dependencies.revalidateNodeReceipt ?? revalidateNode,
      rscript: dependencies.revalidateRscriptReceipt ?? revalidateRscript,
      candidate: dependencies.revalidateCandidateReceipt ?? revalidateRPerformanceCandidate,
      publicCandidate: dependencies.revalidatePublicCandidateReceipt ?? revalidatePublicCandidate,
      source: dependencies.revalidateSourceReceipt ?? revalidateRPerformanceSourceBinding,
      library: dependencies.revalidateLibraryReceipt ?? revalidateLibraryReceipt
    });
    const probeContext = Object.freeze({
      environment,
      sourceBinding,
      intake,
      privateRoot,
      privateFiles,
      rscriptReceipt,
      nodeReceipt,
      children,
      ownershipLease,
      outputBinding,
      revalidators
    });
    revalidateSpawnInputs(probeContext);
    const revalidateProbeInputs = () => {
      revalidateSpawnInputs(probeContext);
      revalidateSafeOutput(outputBinding);
    };
    const libraryProbe = dependencies.runLibraryProbe
      ? await dependencies.runLibraryProbe(probeContext)
      : await runRPerformanceLibraryProbe({
          executable: rscriptReceipt.path,
          privateRoot: privateRoot.root,
          environment,
          children,
          ownershipLease,
          spawnProcess: dependencies.spawnProcess,
          beforeSpawn: revalidateProbeInputs,
          afterExit: revalidateProbeInputs
        });
    revalidateProbeInputs();
    const context = Object.freeze({ ...probeContext, libraryReceipt: libraryProbe.receipt });
    revalidateMeasuredSpawnInputs(context);
    const runMeasurementOwner = async (owner) => {
      revalidateMeasuredSpawnInputs(context);
      revalidateSafeOutput(outputBinding);
      const value = await owner();
      revalidateMeasuredSpawnInputs(context);
      revalidateSafeOutput(outputBinding);
      return value;
    };

    const direct = await runMeasurementOwner(() =>
      (dependencies.runDirectMeasurement ?? runDirectRPerformanceMeasurement)(context, dependencies)
    );
    assertRuntimeMatchesLibraryReceipt(direct.runtime, libraryProbe.receipt);
    const fresh = [];
    for (let index = 0; index < R_PERFORMANCE_FRESH_OPEN_SAMPLE_COUNT; index += 1) {
      const result = await runMeasurementOwner(() =>
        (dependencies.runFreshMeasurement ?? runFreshKernelMeasurement)(context, dependencies)
      );
      assertRuntimeMatchesLibraryReceipt(result.runtime, libraryProbe.receipt);
      sameRuntime(result.runtime, direct.runtime);
      fresh.push(result);
    }
    const workload = await runMeasurementOwner(() =>
      (dependencies.runWorkloadMeasurement ?? runWorkloadKernelMeasurement)(context, dependencies)
    );
    assertRuntimeMatchesLibraryReceipt(workload.runtime, libraryProbe.receipt);
    sameRuntime(workload.runtime, direct.runtime);
    if (children.size !== 0) throw new Error("An owned Rscript remained registered after measurement.");

    const freshOpenSamplesMs = fresh.map((entry) => entry.durationMs);
    const freshKernelRss = fresh.map((entry) => entry.maxObservedRssKiB);
    const responseAccounting = kernelResponseAccounting();
    const observedResponses =
      fresh.reduce((sum, entry) => sum + entry.correlatedResponses, 0) + workload.correlatedResponses;
    const observedClosedSessions =
      fresh.reduce((sum, entry) => sum + entry.closedSessions, 0) + workload.closedSessions;
    const observedReadyFrames = fresh.reduce((sum, entry) => sum + entry.readyFrames, 0) + workload.readyFrames;
    const observedNaturalProcessExits =
      Number(libraryProbe.exitedNaturally) +
      Number(direct.exitedNaturally) +
      fresh.filter((entry) => entry.exitedNaturally).length +
      Number(workload.exitedNaturally);
    if (
      observedResponses !== responseAccounting.allTotal ||
      observedClosedSessions !== 8 ||
      observedReadyFrames !== 6 ||
      observedNaturalProcessExits !== R_PERFORMANCE_PROCESS_SCHEDULE.totalOwnedRscriptProcesses
    ) {
      throw new Error("Native R kernel schedule accounting changed before report construction.");
    }

    revalidateMeasuredSpawnInputs(context);
    revalidateSafeOutput(outputBinding);
    removePrivateRoot(privateRoot, { requireCompleteInventory: true, processGroupsGone: true });
    privateRootRemoved = true;

    const runtime = {
      ...direct.runtime,
      nodeVersion: process.version,
      nodeExecutable: { bytes: nodeReceipt.bytes.length, sha256: nodeReceipt.sha256 },
      rscript: { bytes: rscriptReceipt.bytes.length, sha256: rscriptReceipt.sha256 }
    };
    const measurements = {
      directFrame: {
        freshOpenSamplesMs: direct.value.freshOpenSamplesMs,
        projectedPageSamplesMs: direct.value.projectedPageSamplesMs,
        compoundFilterPageSamplesMs: direct.value.compoundFilterPageSamplesMs,
        stableMultiKeySortFirstUncachedMs: direct.value.stableMultiKeySortFirstUncachedMs,
        stableMultiKeySortPageSamplesMs: direct.value.stableMultiKeySortPageSamplesMs,
        eightColumnSummarySamplesMs: direct.value.eightColumnSummarySamplesMs,
        semanticProof: direct.value.semanticProof
      },
      kernelRoundTrip: {
        freshOpenSamplesMs,
        projectedPageSamplesMs: workload.projectedPageSamplesMs,
        compoundFilterPageSamplesMs: workload.compoundFilterPageSamplesMs,
        stableMultiKeySortFirstUncachedMs: workload.stableMultiKeySortFirstUncachedMs,
        stableMultiKeySortPageSamplesMs: workload.stableMultiKeySortPageSamplesMs,
        eightColumnSummarySamplesMs: workload.eightColumnSummarySamplesMs,
        semanticProof: {
          passed: true,
          sourceUnchanged: true,
          freshPagesVerified: 5,
          projectedPagesVerified: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
          compoundFilterPagesVerified: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
          stableSortPagesVerified: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
          summariesVerified: R_PERFORMANCE_WORKLOAD_SAMPLE_COUNT,
          datasetStatsVerified: true,
          millionRowSampledSummaryVerified: true,
          keyedDataTableVerified: true,
          responseAccounting,
          readyFramesVerified: observedReadyFrames,
          closedSessions: observedClosedSessions
        }
      }
    };
    const directStages = direct.value.resourceProof.stageVmHwmKiB;
    const kernelResources = workload.resources;
    const resources = {
      directMethod: "linux-proc-self-status-vmhwm-after-stage-v1",
      directProcessVmHwmKiB: direct.value.resourceProof.processVmHwmKiB,
      directStagesVmHwmKiB: directStages,
      libraryProbeMethod: "linux-proc-status-vmrss-parent-sampled-v1",
      libraryProbeSamplingIntervalMs: 5,
      libraryProbeMaxObservedRssKiB: libraryProbe.maxObservedRssKiB,
      kernelMethod: "linux-proc-status-vmrss-parent-sampled-v1",
      kernelSamplingIntervalMs: 5,
      freshKernelMaxObservedRssKiB: freshKernelRss,
      workloadKernelMaxObservedRssKiB: kernelResources.maxObservedRssKiB,
      kernelRequestsMaxObservedRssKiB: {
        projectedPage: kernelResources.projectedPage,
        compoundFilterPage: kernelResources.compoundFilterPage,
        stableMultiKeySortFirstUncached: kernelResources.stableMultiKeySortFirstUncached,
        stableMultiKeySortPage: kernelResources.stableMultiKeySortPage,
        eightColumnSummary: kernelResources.eightColumnSummary,
        semanticControls: kernelResources.semanticControls
      },
      everyProcessObserved:
        libraryProbe.maxObservedRssKiB > 0 &&
        direct.parentMaxObservedRssKiB > 0 &&
        freshKernelRss.every((value) => value > 0) &&
        kernelResources.maxObservedRssKiB > 0,
      everyStageObserved:
        Object.values(directStages).every((value) => value > 0) &&
        [
          ...kernelResources.projectedPage,
          ...kernelResources.compoundFilterPage,
          kernelResources.stableMultiKeySortFirstUncached,
          ...kernelResources.stableMultiKeySortPage,
          ...kernelResources.eightColumnSummary,
          kernelResources.semanticControls
        ].every((value) => value > 0)
    };
    const report = buildRPerformanceReport({
      generatedAtUtc: (dependencies.now ?? (() => new Date()))().toISOString(),
      candidate: intake.candidate,
      packagedRuntime: {
        frameContract: {
          name: intake.extracted.frameContract.name,
          bytes: intake.extracted.frameContract.bytes.length,
          sha256: intake.extracted.frameContract.sha256
        },
        kernelExports: {
          name: intake.extracted.kernelExports.name,
          bytes: intake.extracted.kernelExports.bytes.length,
          sha256: intake.extracted.kernelExports.sha256
        },
        kernelAgent: {
          name: intake.extracted.kernelAgent.name,
          bytes: intake.extracted.kernelAgent.bytes.length,
          sha256: intake.extracted.kernelAgent.sha256
        }
      },
      harness: {
        protocol: R_PERFORMANCE_HARNESS_PROTOCOL,
        bytes: sourceBinding.harness.bytes.length,
        sha256: sourceBinding.harnessSha256,
        sourceCommit: sourceBinding.commit
      },
      fixture: rPerformanceFixtureEvidence(),
      machine: publicMachineProvenance(),
      runtime,
      measurements,
      resources,
      cleanup: {
        libraryProbeProcessExitedNaturally: libraryProbe.exitedNaturally,
        directProcessExitedNaturally: direct.exitedNaturally,
        freshKernelProcessesExitedNaturally: fresh.filter((entry) => entry.exitedNaturally).length,
        workloadKernelProcessExitedNaturally: workload.exitedNaturally,
        ownedRscriptProcessesExitedNaturally: observedNaturalProcessExits,
        sessionsClosed: observedClosedSessions,
        processGroupsGone: children.size === 0,
        privateRootRemoved
      }
    });
    assertRPerformanceMeasurementValid(report);

    revalidators.publicCandidate(intake);
    revalidators.source(sourceBinding);
    revalidators.node(nodeReceipt);
    revalidators.rscript(rscriptReceipt);
    revalidators.library(libraryProbe.receipt);
    revalidateSafeOutput(outputBinding);
    publishedReceipt = writeRPerformanceReport(outputBinding.path, report, {
      parentReceipt: outputBinding.parentReceipt
    });
    revalidateSafeOutput(outputBinding);
    revalidators.publicCandidate(intake);
    revalidators.source(sourceBinding);
    revalidators.node(nodeReceipt);
    revalidators.rscript(rscriptReceipt);
    revalidators.library(libraryProbe.receipt);
    revalidateRPerformanceReport(publishedReceipt);
    return Object.freeze({ report, receipt: publishedReceipt });
  } catch (error) {
    const failures = [error];
    if (publishedReceipt !== undefined) {
      try {
        removeRPerformanceReport(publishedReceipt);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    const registeredGroupsGone = await terminateAll(children);
    const processGroupsGone = !ownershipLease.uncertain && registeredGroupsGone;
    if (!processGroupsGone) {
      failures.push(
        new Error("Native R performance cleanup was withheld because an owned process group could not be proven gone.")
      );
    }
    if (privateRoot !== undefined && !privateRootRemoved && processGroupsGone) {
      try {
        removePrivateRoot(privateRoot, { requireCompleteInventory: false, processGroupsGone: true });
        privateRootRemoved = true;
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(failures, "Native R performance failed and cleanup was incomplete.");
    throw error;
  }
}

async function main() {
  try {
    const result = await runRPerformance(parseRPerformanceArguments(process.argv.slice(2)));
    process.stdout.write(
      `Native R performance measurement published (${result.receipt.bytes} bytes, sha256 ${result.receipt.sha256}).\n`
    );
  } catch (error) {
    process.stderr.write(
      `Native R performance failed: ${error instanceof Error ? error.message : "unknown failure"}\n`
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
