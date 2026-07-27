import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createVSIX, listFiles } from "@vscode/vsce";
import {
  EDITOR_ACCEPTANCE_ARTIFACT_RECEIPT_PROTOCOL,
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  downloadEditorWithRetry,
  editorAcceptanceProgressPath,
  editorDisplayLaunchArgs,
  editorProcessTreeMayBeLive,
  resolveDownloadedEditorCliPath,
  runBoundedEditorCliCommand,
  runEditorAcceptancePhase,
  sanitizeEditorAcceptanceDiagnostic,
  spawnOwnedEditorProcess,
  startIsolatedEditorDisplay,
  validateEditorAcceptancePrivatePathOverrides,
  writeEditorAcceptanceHarness,
  writeEditorSettings
} from "./editor-acceptance.mjs";
import {
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";
import {
  assertInstalledPerformanceReleaseGate,
  buildInstalledPerformanceReport,
  revalidateInstalledPerformanceReport,
  validateInstalledFixtureManifest,
  validateInstalledPerformancePhase,
  writeInstalledPerformanceReport
} from "./installed-performance-report.mjs";
import {
  createInstalledResourceSampler,
  readInstalledPlatformProvenance,
  readInstalledStorageProvenance
} from "./installed-performance-system.mjs";
import { prepareRepositoryLocalXvfb } from "./prepare-xvfb.mjs";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import {
  inspectVsixArchive,
  MAX_VSIX_BYTES as VSIX_MAX_BYTES,
  MAX_VSIX_ENTRY_BYTES,
  MAX_VSIX_UNCOMPRESSED_BYTES,
  readBoundedVsixFileSnapshot
} from "./vsix-archive.mjs";
import {
  inspectNotebookRendererBundle,
  inspectReadmeSourceSrcsets,
  inspectVsixPreReleaseMetadata
} from "./vsix-contents.mjs";

const root = resolve(import.meta.dirname, "..");
const INSTALLED_RUN_PROTOCOL = "openwrangler-installed-performance-run-v5";
const INSTALLED_PERFORMANCE_PHASES = [
  "perf-csv-cold",
  "perf-csv-warm",
  "perf-parquet-cold",
  "perf-parquet-warm",
  "perf-grid-interaction"
];
const EXPECTED_HARNESS = "openwrangler-tests.openwrangler-packaged-test-harness@0.0.0";
const VSIX_PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const INSTALLED_CHECKSUM_MAX_BYTES = 512;
const INSTALLED_PROVENANCE_MAX_BYTES = 4096;
export const CANONICAL_RELEASE_ARTIFACT_PROTOCOL = "openwrangler-canonical-release-artifact-v1";
const OUTPUT_MAX_BYTES = 1024 * 1024;
const INSTALLED_PHASE_FRAGMENT_MAX_BYTES = 16 * 1024;
const guardedCandidateReceipts = new WeakSet();
const GENERATED_MEDIA_PACKAGE_FILES = Object.freeze([
  "media/activity-icon.svg",
  "media/codePreview.js",
  "media/codicon.ttf",
  "media/icon-128.png",
  "media/icon.png",
  "media/icon.svg",
  "media/notebookRenderer.js",
  "media/webview.css",
  "media/webview.js"
]);

export function parseInstalledPerformanceArguments(arguments_) {
  const options = {
    smoke: false,
    editors: ["vscode", "cursor"],
    candidateOutput: resolve(root, "tmp", "performance", "openwrangler-installed-candidate.vsix"),
    output: resolve(root, "tmp", "performance", "installed-performance.json")
  };
  let candidateOutputExplicit = false;
  let editorsExplicit = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--smoke") {
      options.smoke = true;
      continue;
    }
    if (argument === "--editors") {
      editorsExplicit = true;
      const value = arguments_[++index];
      if (!value) throw new Error("--editors requires vscode, cursor, or vscode,cursor.");
      const editors = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (
        editors.length === 0 ||
        new Set(editors).size !== editors.length ||
        editors.some((entry) => entry !== "vscode" && entry !== "cursor")
      ) {
        throw new Error("--editors requires a unique comma-separated subset of vscode,cursor.");
      }
      options.editors = editors;
      continue;
    }
    if (argument === "--out") {
      const value = arguments_[++index];
      if (!value) throw new Error("--out requires one filesystem path.");
      options.output = resolve(root, value);
      continue;
    }
    if (argument === "--candidate-out") {
      candidateOutputExplicit = true;
      const value = arguments_[++index];
      if (!value) throw new Error("--candidate-out requires one filesystem path.");
      options.candidateOutput = resolve(root, value);
      continue;
    }
    if (argument === "--candidate-in") {
      const value = arguments_[++index];
      if (!value) throw new Error("--candidate-in requires one filesystem path.");
      if (options.candidateInput !== undefined) throw new Error("--candidate-in may be provided only once.");
      options.candidateInput = resolve(root, value);
      continue;
    }
    if (argument === "--candidate-checksum") {
      const value = arguments_[++index];
      if (!value) throw new Error("--candidate-checksum requires one filesystem path.");
      if (options.candidateChecksum !== undefined) {
        throw new Error("--candidate-checksum may be provided only once.");
      }
      options.candidateChecksum = resolve(root, value);
      continue;
    }
    if (argument === "--candidate-provenance") {
      const value = arguments_[++index];
      if (!value) throw new Error("--candidate-provenance requires one filesystem path.");
      if (options.candidateProvenance !== undefined) {
        throw new Error("--candidate-provenance may be provided only once.");
      }
      options.candidateProvenance = resolve(root, value);
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown installed-performance option ${argument}.`);
    throw new Error(
      "Installed performance requires named candidate options; use --candidate-out or --candidate-in with --candidate-checksum and --candidate-provenance."
    );
  }
  const consumesCandidate =
    options.candidateInput !== undefined ||
    options.candidateChecksum !== undefined ||
    options.candidateProvenance !== undefined;
  if (
    consumesCandidate &&
    (options.candidateInput === undefined ||
      options.candidateChecksum === undefined ||
      options.candidateProvenance === undefined)
  ) {
    throw new Error("--candidate-in, --candidate-checksum, and --candidate-provenance are required together.");
  }
  if (consumesCandidate && candidateOutputExplicit) {
    throw new Error(
      "--candidate-in/--candidate-checksum/--candidate-provenance cannot be combined with --candidate-out."
    );
  }
  if (consumesCandidate && options.smoke) {
    throw new Error("Canonical candidate consumption is stable release evidence and cannot use --smoke.");
  }
  if (consumesCandidate && editorsExplicit) {
    throw new Error("Canonical candidate consumption always runs both first-class editors and cannot use --editors.");
  }
  if (consumesCandidate) {
    const canonicalPaths = [
      options.candidateInput,
      options.candidateChecksum,
      options.candidateProvenance,
      options.output
    ];
    if (new Set(canonicalPaths).size !== canonicalPaths.length) {
      throw new Error("Canonical candidate inputs and the installed-performance report must use different paths.");
    }
    options.candidateOutput = undefined;
    options.mode = "consume";
  } else {
    if (options.output === options.candidateOutput) {
      throw new Error("The preview candidate and installed-performance report must use different paths.");
    }
    options.mode = "package";
  }
  return options;
}

export function assertInstalledPerformanceArtifactPathSeparation({
  output,
  candidateInput,
  candidateChecksum,
  candidateProvenance,
  candidateOutput
}) {
  if (typeof output !== "string" || output.length === 0) {
    throw new TypeError("Installed performance requires one report output path.");
  }
  const protectedPaths = [candidateInput, candidateChecksum, candidateProvenance, candidateOutput].filter(
    (path) => typeof path === "string" && path.length > 0
  );
  if (protectedPaths.length === 0) {
    throw new TypeError("Installed performance requires at least one protected candidate artifact path.");
  }
  const resolvedOutput = resolve(output);
  const outputTarget = canonicalProspectivePath(resolvedOutput);
  const outputIdentity = existingPathIdentity(resolvedOutput);
  for (const protectedPath of protectedPaths) {
    const resolvedProtected = resolve(protectedPath);
    if (
      resolvedProtected === resolvedOutput ||
      canonicalProspectivePath(resolvedProtected) === outputTarget ||
      sameExistingPathIdentity(existingPathIdentity(resolvedProtected), outputIdentity)
    ) {
      throw new Error("The installed-performance report path aliases a protected candidate artifact.");
    }
  }
}

export function stageInstalledPerformanceVsix(source, destination, hooks = {}) {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);

  let sourceDescriptor;
  let sourceIdentity;
  let destinationDescriptor;
  let destinationIdentity;
  let complete = false;
  const digest = createHash("sha256");
  try {
    sourceDescriptor = openReadOnlyNoFollow(
      sourcePath,
      "The installed-performance candidate must be a single-link regular VSIX."
    );
    sourceIdentity = fstatSync(sourceDescriptor, { bigint: true });
    if (!sourceIdentity.isFile() || sourceIdentity.nlink !== 1n) {
      throw new Error("The installed-performance candidate must be a single-link regular VSIX.");
    }
    if (sourceIdentity.size <= 0n || sourceIdentity.size > BigInt(VSIX_MAX_BYTES)) {
      throw new Error("The installed-performance candidate has an invalid byte size.");
    }
    hooks.afterSourceOpen?.(sourcePath);
    const sourceAtPath = lstatSync(sourcePath, { bigint: true });
    requireSameRegularFile(sourceAtPath, sourceIdentity, "The candidate changed before it was staged.");
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    assertAbsent(destinationPath, "staged installed-performance VSIX");
    destinationDescriptor = openSync(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    destinationIdentity = fstatSync(destinationDescriptor, { bigint: true });
    if (!destinationIdentity.isFile() || destinationIdentity.nlink !== 1n) {
      throw new Error("The staged candidate is not an exclusively owned regular file.");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) {
        const written = writeSync(destinationDescriptor, buffer, offset, count - offset);
        if (written === 0) throw new Error("The staged candidate copy made no write progress.");
        offset += written;
      }
      total += count;
    }
    if (BigInt(total) !== sourceIdentity.size) throw new Error("The staged candidate copy was incomplete.");
    fsyncSync(destinationDescriptor);
    const completedDestination = fstatSync(destinationDescriptor, { bigint: true });
    requireSameFileIdentity(
      completedDestination,
      destinationIdentity,
      "The staged candidate changed while it was written."
    );
    if (completedDestination.size !== sourceIdentity.size) {
      throw new Error("The staged candidate copy has an invalid published byte size.");
    }
    const completedSource = fstatSync(sourceDescriptor, { bigint: true });
    const completedSourcePath = lstatSync(sourcePath, { bigint: true });
    requireSameRegularFile(completedSource, sourceIdentity, "The candidate changed while it was staged.");
    requireSameRegularFile(completedSourcePath, sourceIdentity, "The candidate path changed while it was staged.");
    closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    const published = lstatSync(destinationPath, { bigint: true });
    requireSameRegularFile(published, completedDestination, "The staged candidate path changed after publication.");
    complete = true;
    return Object.freeze({
      path: destinationPath,
      sha256: digest.digest("hex"),
      bytes: total,
      fileIdentity: fileIdentityReceipt(published)
    });
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    if (!complete && destinationIdentity !== undefined) removeIdentifiedFile(destinationPath, destinationIdentity);
  }
}

export function readInstalledPerformanceVsixReceipt(candidatePath) {
  const path = resolve(candidatePath);
  const snapshot = readBoundedVsixFileSnapshot(path, { requireOwner: true });
  return Object.freeze({
    path,
    sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
    bytes: snapshot.bytes.length,
    fileIdentity: fileIdentityReceipt(snapshot.identity)
  });
}

export function readInstalledPerformanceChecksum(checksumPath, candidatePath, hooks = {}) {
  const path = resolve(checksumPath);
  const resolvedCandidate = resolve(candidatePath);
  const candidateName = basename(resolvedCandidate);
  if (candidateName !== "openwrangler.vsix") {
    throw new Error("Canonical installed performance requires the candidate filename openwrangler.vsix.");
  }
  let descriptor;
  try {
    descriptor = openReadOnlyNoFollow(path, "The installed-performance checksum must be a single-link regular file.");
    const before = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(path, { bigint: true });
    requireSameRegularFile(namedBefore, before, "The installed-performance checksum changed before it was read.");
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(INSTALLED_CHECKSUM_MAX_BYTES) ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("The installed-performance checksum must be one bounded current-user-owned regular file.");
    }
    hooks.afterOpen?.(path);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error("The installed-performance checksum ended before its validated byte size.");
      offset += count;
    }
    hooks.afterRead?.(path);
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    requireSameRegularFile(after, before, "The installed-performance checksum changed while it was read.");
    requireSameRegularFile(namedAfter, before, "The installed-performance checksum path changed while it was read.");
    const match = /^([0-9a-f]{64}) {2}openwrangler\.vsix\n$/u.exec(bytes.toString("utf8"));
    if (!match || Buffer.byteLength(match[0], "utf8") !== bytes.length) {
      throw new Error(
        "The installed-performance checksum must contain exactly one lowercase SHA-256 line for openwrangler.vsix."
      );
    }
    return Object.freeze({
      path,
      candidatePath: resolvedCandidate,
      candidateSha256: match[1],
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      fileIdentity: fileIdentityReceipt(after)
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readInstalledPerformanceProvenance(provenancePath, hooks = {}) {
  const path = resolve(provenancePath);
  if (basename(path) !== "openwrangler.vsix.provenance.json") {
    throw new Error(
      "Canonical installed performance requires the provenance filename openwrangler.vsix.provenance.json."
    );
  }
  let descriptor;
  try {
    descriptor = openReadOnlyNoFollow(path, "The installed-performance provenance must be a single-link regular file.");
    const before = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(path, { bigint: true });
    requireSameRegularFile(namedBefore, before, "The installed-performance provenance changed before it was read.");
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(INSTALLED_PROVENANCE_MAX_BYTES) ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("The installed-performance provenance must be one bounded current-user-owned regular file.");
    }
    hooks.afterOpen?.(path);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error("The installed-performance provenance ended before its validated byte size.");
      offset += count;
    }
    hooks.afterRead?.(path);
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    requireSameRegularFile(after, before, "The installed-performance provenance changed while it was read.");
    requireSameRegularFile(namedAfter, before, "The installed-performance provenance path changed while it was read.");
    const value = validateInstalledPerformanceProvenance(
      parseStrictJson(bytes.toString("utf8"), { maxBytes: INSTALLED_PROVENANCE_MAX_BYTES })
    );
    return Object.freeze({
      path,
      ...value,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      fileIdentity: fileIdentityReceipt(after)
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function validateInstalledPerformanceProvenance(value) {
  const expectedKeys = [
    "extensionId",
    "extensionVersion",
    "preview",
    "protocol",
    "releaseTag",
    "sourceCommit",
    "vsixBytes",
    "vsixSha256"
  ];
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("The installed-performance provenance must contain exactly the canonical artifact fields.");
  }
  if (
    value.protocol !== CANONICAL_RELEASE_ARTIFACT_PROTOCOL ||
    value.extensionId !== "Matt17BR.openwrangler" ||
    typeof value.extensionVersion !== "string" ||
    classifyNumericReleaseVersion(value.extensionVersion)?.channel !== "stable" ||
    value.extensionVersion.startsWith("0.") ||
    value.preview !== false ||
    value.releaseTag !== `v${value.extensionVersion}` ||
    typeof value.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceCommit) ||
    typeof value.vsixSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.vsixSha256) ||
    !Number.isSafeInteger(value.vsixBytes) ||
    value.vsixBytes <= 0 ||
    value.vsixBytes > VSIX_MAX_BYTES
  ) {
    throw new Error("The installed-performance provenance does not describe one canonical stable artifact.");
  }
  return Object.freeze({
    protocol: value.protocol,
    extensionId: value.extensionId,
    extensionVersion: value.extensionVersion,
    preview: value.preview,
    releaseTag: value.releaseTag,
    sourceCommit: value.sourceCommit,
    vsixSha256: value.vsixSha256,
    vsixBytes: value.vsixBytes
  });
}

export async function readInstalledPerformanceCandidate(receipt) {
  if (!guardedCandidateReceipts.has(receipt)) {
    throw new Error("Installed performance candidate metadata requires one guarded candidate receipt.");
  }
  const snapshot = readInstalledPerformanceVsixSnapshot(receipt);
  const archive = await inspectVsixArchive(snapshot.bytes);
  const packageJson = parseStrictJson(archive.packagedPackageJson, {
    maxBytes: VSIX_PACKAGE_JSON_MAX_BYTES
  });
  const packagedManifest = validateInstalledPerformanceSourceManifest(packageJson);
  if (JSON.stringify(packagedManifest) !== JSON.stringify(receipt.sourceManifest)) {
    throw new Error("The staged VSIX manifest does not match its guarded source manifest.");
  }
  const expectedBuildMethod =
    packagedManifest.channel === "stable" ? "canonical-release-artifact-v1" : "guarded-clean-head-v1";
  if (receipt.buildMethod !== expectedBuildMethod) {
    throw new Error("The staged VSIX release channel does not match its guarded candidate provenance.");
  }
  return {
    extensionId: `${packagedManifest.publisher}.${packagedManifest.name}`,
    extensionVersion: packagedManifest.version,
    preview: packagedManifest.preview,
    channel: packagedManifest.channel,
    buildMethod: receipt.buildMethod,
    releaseTag: receipt.releaseTag ?? null,
    provenanceSha256: receipt.provenanceSha256 ?? null,
    sourceCommit: receipt.source.commit,
    vsixSha256: receipt.sha256,
    vsixBytes: receipt.bytes
  };
}

export function readInstalledPerformanceSourceManifest(file = resolve(root, "package.json")) {
  return validateInstalledPerformanceSourceManifest(readBoundedJson(file, VSIX_PACKAGE_JSON_MAX_BYTES));
}

export function validateInstalledPerformanceSourceManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Installed performance requires one object-valued source package manifest.");
  }
  if (manifest.publisher !== "Matt17BR" || manifest.name !== "openwrangler") {
    throw new TypeError("Installed performance requires the canonical Matt17BR.openwrangler package identity.");
  }
  const classification = classifyNumericReleaseVersion(manifest.version);
  if (classification === undefined) {
    throw new TypeError("Installed performance requires a numeric major.minor.patch package version.");
  }
  if (typeof manifest.preview !== "boolean") {
    throw new TypeError("Installed performance requires an explicit boolean package preview flag.");
  }
  const expectedPreview = classification.channel === "preview";
  if (manifest.preview !== expectedPreview) {
    throw new TypeError(
      expectedPreview
        ? `Preview-channel version ${manifest.version} requires the package preview flag to be true.`
        : `Version ${manifest.version} belongs to the stable channel and requires the package preview flag to be false.`
    );
  }
  if (!manifest.preview && manifest.version.startsWith("0.")) {
    throw new TypeError("A stable installed-performance candidate requires package version 1.0.0 or newer.");
  }
  return Object.freeze({
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    preview: manifest.preview,
    channel: classification.channel
  });
}

export async function packageInstalledPerformanceCandidate({
  destination,
  snapshotDestination,
  environment = process.env,
  readSource = readSourceProvenance,
  readSourceManifest = readInstalledPerformanceSourceManifest,
  build = runInstalledPerformanceBuild,
  packageCandidate = createInstalledPerformanceVsix,
  assertPackageSource = assertNoPackageableUntrackedFiles,
  verifyPackageInventory = verifyInstalledPerformancePackageInventory,
  verifyCandidate = verifyInstalledPerformanceVsix,
  snapshotCandidate = stageInstalledPerformanceVsix
}) {
  if (typeof snapshotDestination !== "string" || snapshotDestination.length === 0) {
    throw new TypeError("Guarded installed-performance packaging requires a private snapshot destination.");
  }
  const before = readSource();
  requireCleanSource(before, "before candidate build");
  const sourceManifest = validateInstalledPerformanceSourceManifest(await readSourceManifest());
  if (sourceManifest.channel === "stable") {
    throw new Error("Stable installed-performance evidence must consume the canonical release artifact.");
  }
  await build(environment);
  requireSameSource(readSource(), before, "during candidate build");
  const packageSource = await assertPackageSource();
  requirePackageSourceReceipt(packageSource);
  await packageCandidate(destination, { preRelease: sourceManifest.preview });
  const packageSourceAfter = await assertPackageSource();
  assertSameInstalledPerformancePackageSources(packageSource, packageSourceAfter);
  requireSameSource(readSource(), before, "during candidate packaging");
  const snapshot = await snapshotCandidate(destination, snapshotDestination);
  requireVsixReceipt(snapshot);
  requireSameSource(readSource(), before, "during candidate snapshot");
  const snapshotReceipt = Object.freeze({
    path: snapshot.path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes,
    fileIdentity: Object.freeze({ ...snapshot.fileIdentity })
  });
  await verifyPackageInventory(snapshotReceipt, packageSource);
  await verifyCandidate(snapshotReceipt, environment);
  requireSameSource(readSource(), before, "during candidate verification");
  const receipt = Object.freeze({
    ...snapshotReceipt,
    source: Object.freeze({ ...before }),
    sourceManifest,
    buildMethod: "guarded-clean-head-v1"
  });
  guardedCandidateReceipts.add(receipt);
  return receipt;
}

export async function acceptInstalledPerformanceCandidate({
  candidatePath,
  checksumPath,
  provenancePath,
  privateDestination,
  environment = process.env,
  expectedCommit = environment.EXPECTED_SHA,
  releaseTag = environment.RELEASE_TAG,
  readSource = readSourceProvenance,
  readSourceManifest = readInstalledPerformanceSourceManifest,
  readExternalCandidate = readInstalledPerformanceVsixReceipt,
  readChecksum = readInstalledPerformanceChecksum,
  readProvenance = readInstalledPerformanceProvenance,
  readReleaseTagCommit = readInstalledPerformanceReleaseTagCommit,
  stageCandidate = stageInstalledPerformanceVsix,
  verifyCandidate = verifyInstalledPerformanceVsix,
  readCandidate = readInstalledPerformanceCandidate,
  revalidateCandidate = revalidateInstalledPerformanceVsix,
  revalidateChecksum = revalidateInstalledPerformanceChecksum,
  revalidateProvenance = revalidateInstalledPerformanceProvenance
}) {
  if (
    typeof candidatePath !== "string" ||
    candidatePath.length === 0 ||
    typeof checksumPath !== "string" ||
    checksumPath.length === 0 ||
    typeof provenancePath !== "string" ||
    provenancePath.length === 0 ||
    typeof privateDestination !== "string" ||
    privateDestination.length === 0
  ) {
    throw new TypeError(
      "Canonical installed performance requires candidate, checksum, provenance, and private destination paths."
    );
  }
  const resolvedCandidate = resolve(candidatePath);
  const resolvedChecksum = resolve(checksumPath);
  const resolvedProvenance = resolve(provenancePath);
  const resolvedPrivate = resolve(privateDestination);
  if (new Set([resolvedCandidate, resolvedChecksum, resolvedProvenance, resolvedPrivate]).size !== 4) {
    throw new Error("Canonical candidate, checksum, provenance, and private destination paths must be different.");
  }
  if (typeof expectedCommit !== "string" || !/^[0-9a-f]{40}$/u.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full lowercase hexadecimal Git commit ID.");
  }
  if (typeof releaseTag !== "string" || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be one stable vmajor.minor.patch tag.");
  }

  const sourceBefore = readSource();
  requireCleanSource(sourceBefore, "before canonical candidate intake");
  if (sourceBefore.commit !== expectedCommit) {
    throw new Error("Canonical installed performance must inspect the exact expected source commit.");
  }
  const sourceManifest = validateInstalledPerformanceSourceManifest(await readSourceManifest());
  if (sourceManifest.channel !== "stable" || sourceManifest.preview !== false) {
    throw new Error("Canonical candidate consumption requires stable package metadata.");
  }
  if (releaseTag !== `v${sourceManifest.version}`) {
    throw new Error("RELEASE_TAG must exactly match the stable source package version.");
  }
  if ((await readReleaseTagCommit(releaseTag)) !== expectedCommit) {
    throw new Error("RELEASE_TAG must resolve to the exact expected source commit.");
  }

  const externalCandidate = await readExternalCandidate(resolvedCandidate);
  requireVsixReceipt(externalCandidate);
  if (externalCandidate.path !== resolvedCandidate) {
    throw new Error("The canonical candidate receipt does not match its requested path.");
  }
  const checksum = await readChecksum(resolvedChecksum, resolvedCandidate);
  if (checksum?.candidateSha256 !== externalCandidate.sha256) {
    throw new Error("The canonical candidate does not match its transferred checksum.");
  }
  const provenance = await readProvenance(resolvedProvenance);
  requireProvenanceReceipt(provenance);
  if (
    provenance.path !== resolvedProvenance ||
    provenance.extensionId !== `${sourceManifest.publisher}.${sourceManifest.name}` ||
    provenance.extensionVersion !== sourceManifest.version ||
    provenance.preview !== sourceManifest.preview ||
    provenance.releaseTag !== releaseTag ||
    provenance.sourceCommit !== expectedCommit ||
    provenance.vsixSha256 !== externalCandidate.sha256 ||
    provenance.vsixBytes !== externalCandidate.bytes
  ) {
    throw new Error("The canonical candidate does not match its trusted build provenance.");
  }
  revalidateCandidate(externalCandidate);
  revalidateChecksum(checksum, resolvedCandidate);
  revalidateProvenance(provenance);
  const staged = await stageCandidate(externalCandidate.path, resolvedPrivate);
  requireVsixReceipt(staged);
  if (
    staged.path !== resolvedPrivate ||
    staged.sha256 !== externalCandidate.sha256 ||
    staged.bytes !== externalCandidate.bytes
  ) {
    throw new Error("The private installed-performance candidate does not match the canonical input.");
  }
  revalidateCandidate(externalCandidate);
  revalidateChecksum(checksum, resolvedCandidate);
  revalidateProvenance(provenance);
  const privateReceipt = Object.freeze({
    path: staged.path,
    sha256: staged.sha256,
    bytes: staged.bytes,
    fileIdentity: Object.freeze({ ...staged.fileIdentity })
  });
  await verifyCandidate(privateReceipt, environment);
  requireSameSource(readSource(), sourceBefore, "during canonical candidate intake");
  revalidateCandidate(privateReceipt);
  revalidateCandidate(externalCandidate);
  revalidateChecksum(checksum, resolvedCandidate);
  revalidateProvenance(provenance);

  const candidateReceipt = Object.freeze({
    ...privateReceipt,
    source: Object.freeze({ ...sourceBefore }),
    sourceManifest,
    buildMethod: "canonical-release-artifact-v1",
    releaseTag,
    provenanceSha256: provenance.sha256
  });
  guardedCandidateReceipts.add(candidateReceipt);
  const candidate = await readCandidate(candidateReceipt);
  revalidateCandidate(candidateReceipt);
  revalidateCandidate(externalCandidate);
  revalidateChecksum(checksum, resolvedCandidate);
  revalidateProvenance(provenance);
  return Object.freeze({
    candidate,
    candidateReceipt,
    publicCandidateReceipt: externalCandidate,
    publicChecksumReceipt: checksum,
    publicProvenanceReceipt: provenance,
    sourceBefore: candidateReceipt.source
  });
}

export async function prepareInstalledPerformanceCandidate({
  options,
  privateRoot,
  environment = process.env,
  acceptCandidate = acceptInstalledPerformanceCandidate,
  packageCandidate = packageInstalledPerformanceCandidate,
  readCandidate = readInstalledPerformanceCandidate,
  stageCandidate = stageInstalledPerformanceVsix,
  buildHarness = runInstalledPerformanceHarnessBuild,
  readSource = readSourceProvenance,
  revalidateCandidate = revalidateInstalledPerformanceVsix,
  revalidateChecksum = revalidateInstalledPerformanceChecksum,
  revalidateProvenance = revalidateInstalledPerformanceProvenance
}) {
  if (!options || typeof options !== "object" || typeof privateRoot !== "string" || privateRoot.length === 0) {
    throw new TypeError("Installed performance candidate preparation requires options and one private root.");
  }
  if (options.mode === "consume") {
    if (
      typeof options.candidateInput !== "string" ||
      typeof options.candidateChecksum !== "string" ||
      typeof options.candidateProvenance !== "string" ||
      options.candidateOutput !== undefined ||
      options.smoke !== false ||
      JSON.stringify(options.editors) !== JSON.stringify(["vscode", "cursor"])
    ) {
      throw new Error("Canonical candidate consumption received an inconsistent option set.");
    }
    const accepted = await acceptCandidate({
      candidatePath: options.candidateInput,
      checksumPath: options.candidateChecksum,
      provenancePath: options.candidateProvenance,
      privateDestination: resolve(privateRoot, "candidate.vsix"),
      environment
    });
    await buildHarness(environment);
    requireSameSource(readSource(), accepted.sourceBefore, "during the acceptance-harness build");
    revalidateCandidate(accepted.candidateReceipt);
    revalidateCandidate(accepted.publicCandidateReceipt);
    revalidateChecksum(accepted.publicChecksumReceipt, accepted.publicCandidateReceipt.path);
    revalidateProvenance(accepted.publicProvenanceReceipt);
    return accepted;
  }
  if (
    options.mode !== "package" ||
    options.candidateInput !== undefined ||
    options.candidateChecksum !== undefined ||
    options.candidateProvenance !== undefined ||
    typeof options.candidateOutput !== "string"
  ) {
    throw new Error("Self-packaged installed performance received an inconsistent option set.");
  }
  const guardedCandidate = await packageCandidate({
    destination: resolve(privateRoot, "built-candidate.vsix"),
    snapshotDestination: resolve(privateRoot, "candidate.vsix"),
    environment
  });
  const sourceBefore = guardedCandidate.source;
  const candidate = await readCandidate(guardedCandidate);
  const published = await stageCandidate(guardedCandidate.path, options.candidateOutput);
  if (published.sha256 !== guardedCandidate.sha256 || published.bytes !== guardedCandidate.bytes) {
    throw new Error("The published installed-performance candidate does not match its private snapshot.");
  }
  requireSameSource(readSource(), sourceBefore, "after candidate publication");
  return Object.freeze({
    candidate,
    candidateReceipt: guardedCandidate,
    publicCandidateReceipt: published,
    publicChecksumReceipt: undefined,
    publicProvenanceReceipt: undefined,
    sourceBefore
  });
}

export function writeInstalledPerformanceRun(destination, result) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > OUTPUT_MAX_BYTES) {
    throw new Error("The installed performance result exceeded its fixed 1 MiB limit.");
  }
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  assertReplaceableRegularFile(target, "installed performance result");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  let identity;
  let published = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) {
      throw new Error("The installed performance result temporary is not exclusively owned.");
    }
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    const complete = fstatSync(descriptor, { bigint: true });
    requireSameFileIdentity(complete, identity, "The installed performance result changed while it was written.");
    closeSync(descriptor);
    descriptor = undefined;
    assertReplaceableRegularFile(target, "installed performance result");
    const atPath = lstatSync(temporary, { bigint: true });
    requireSameRegularFile(atPath, complete, "The installed performance result temporary path changed.");
    renameSync(temporary, target);
    published = true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published && identity !== undefined) removeIdentifiedFile(temporary, identity);
  }
}

export function cleanupInstalledPerformancePrivateRoot({
  processTreeUncertain,
  receipt,
  removePrivateRoot = removeEditorAcceptancePrivateRoot
}) {
  if (processTreeUncertain) return false;
  removePrivateRoot(receipt);
  return true;
}

export function revalidateInstalledPerformanceVsix(receipt) {
  readInstalledPerformanceVsixSnapshot(receipt);
  return receipt;
}

export function revalidateInstalledPerformanceChecksum(receipt, candidatePath = receipt?.candidatePath) {
  requireChecksumReceipt(receipt);
  const current = readInstalledPerformanceChecksum(receipt.path, candidatePath);
  if (
    current.path !== receipt.path ||
    current.candidatePath !== receipt.candidatePath ||
    current.candidateSha256 !== receipt.candidateSha256 ||
    current.sha256 !== receipt.sha256 ||
    current.bytes !== receipt.bytes ||
    !sameFileIdentityReceipt(current.fileIdentity, receipt.fileIdentity)
  ) {
    throw new Error("The installed-performance checksum receipt changed.");
  }
  return receipt;
}

export function revalidateInstalledPerformanceProvenance(receipt) {
  requireProvenanceReceipt(receipt);
  const current = readInstalledPerformanceProvenance(receipt.path);
  if (
    current.path !== receipt.path ||
    current.protocol !== receipt.protocol ||
    current.extensionId !== receipt.extensionId ||
    current.extensionVersion !== receipt.extensionVersion ||
    current.preview !== receipt.preview ||
    current.releaseTag !== receipt.releaseTag ||
    current.sourceCommit !== receipt.sourceCommit ||
    current.vsixSha256 !== receipt.vsixSha256 ||
    current.vsixBytes !== receipt.vsixBytes ||
    current.sha256 !== receipt.sha256 ||
    current.bytes !== receipt.bytes ||
    !sameFileIdentityReceipt(current.fileIdentity, receipt.fileIdentity)
  ) {
    throw new Error("The installed-performance provenance receipt changed.");
  }
  return receipt;
}

function readInstalledPerformanceVsixSnapshot(receipt) {
  requireVsixReceipt(receipt);
  const snapshot = readBoundedVsixFileSnapshot(receipt.path, { requireOwner: true });
  if (
    snapshot.identity.dev !== receipt.fileIdentity.dev ||
    snapshot.identity.ino !== receipt.fileIdentity.ino ||
    snapshot.identity.size !== receipt.fileIdentity.size ||
    snapshot.identity.mtimeNs !== receipt.fileIdentity.mtimeNs ||
    snapshot.identity.ctimeNs !== receipt.fileIdentity.ctimeNs
  ) {
    throw new Error("The installed-performance VSIX receipt changed.");
  }
  const sha256 = createHash("sha256").update(snapshot.bytes).digest("hex");
  if (snapshot.bytes.length !== receipt.bytes || sha256 !== receipt.sha256) {
    throw new Error("The installed-performance VSIX no longer matches its checksum receipt.");
  }
  return snapshot;
}

export async function collectInstalledPerformanceEditorRuns({
  editors,
  candidateReceipt,
  publicCandidateReceipt,
  publicChecksumReceipt,
  publicProvenanceReceipt,
  runEditor,
  revalidateCandidate = revalidateInstalledPerformanceVsix,
  revalidateChecksum = revalidateInstalledPerformanceChecksum,
  revalidateProvenance = revalidateInstalledPerformanceProvenance
}) {
  const runs = [];
  for (const editor of editors) runs.push(await runEditor(editor));
  revalidateCandidate(candidateReceipt);
  if (publicCandidateReceipt !== undefined) revalidateCandidate(publicCandidateReceipt);
  if (publicChecksumReceipt !== undefined) {
    revalidateChecksum(publicChecksumReceipt, publicCandidateReceipt?.path);
  }
  if (publicProvenanceReceipt !== undefined) revalidateProvenance(publicProvenanceReceipt);
  return runs;
}

export async function runInstalledPerformance(options, environment = process.env) {
  validateEditorAcceptancePrivatePathOverrides();
  if (process.platform !== "linux") {
    throw new Error("Strict installed performance evidence currently requires a Linux reference machine.");
  }
  assertInstalledPerformanceArtifactPathSeparation(options);
  const privateParent = resolve(root, "tmp", "ow");
  mkdirSync(privateParent, { recursive: true, mode: 0o700 });
  const privateRoot = mkdtempSync(join(privateParent, "x-"));
  const privateRootReceipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: privateParent });
  configureEditorAcceptanceTempRoot(privateRoot, environment);
  const privatePaths = [
    privateRoot,
    ...[options.candidateOutput, options.candidateInput, options.candidateChecksum, options.candidateProvenance].filter(
      (path) => typeof path === "string"
    )
  ];
  let processTreeUncertain = false;
  let primaryError;
  let result;
  let publicCandidateReceipt;
  let publicChecksumReceipt;
  let publicProvenanceReceipt;
  try {
    const prepared = await prepareInstalledPerformanceCandidate({
      options,
      privateRoot,
      environment
    });
    const guardedCandidate = prepared.candidateReceipt;
    const sourceBefore = prepared.sourceBefore;
    const candidate = prepared.candidate;
    publicCandidateReceipt = prepared.publicCandidateReceipt;
    publicChecksumReceipt = prepared.publicChecksumReceipt;
    publicProvenanceReceipt = prepared.publicProvenanceReceipt;
    const python = resolveTestPython(environment);
    const fixtureRoot = resolve(privateRoot, "f");
    const fixtureDirectory = resolve(fixtureRoot, "fixtures");
    const fixtureManifestPath = resolve(fixtureRoot, "performance-fixtures.json");
    mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
    execFileSync(
      python,
      [
        resolve(root, "python", "benchmarks", "installed_editor_fixtures.py"),
        "--output-dir",
        fixtureDirectory,
        "--manifest-out",
        fixtureManifestPath,
        ...(options.smoke ? ["--smoke"] : [])
      ],
      {
        cwd: root,
        env: createEditorAcceptanceEnvironment(environment),
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        windowsHide: true
      }
    );
    const fixtureManifest = validateInstalledFixtureManifest(readBoundedJson(fixtureManifestPath, 64 * 1024));

    const editors = await resolveEditors(options.editors, environment);
    const editorRuns = await collectInstalledPerformanceEditorRuns({
      editors,
      candidateReceipt: guardedCandidate,
      publicCandidateReceipt,
      publicChecksumReceipt,
      publicProvenanceReceipt,
      runEditor: (editor) =>
        runEditorPerformanceWithIsolatedDisplay({
          editor,
          candidateReceipt: guardedCandidate,
          candidate,
          python,
          privateRoot,
          fixtureRoot,
          fixtureManifest,
          environment
        })
    });
    const sourceAfter = readSourceProvenance();
    requireSameSource(sourceAfter, sourceBefore, "during the editor run");
    result = options.smoke
      ? {
          protocol: INSTALLED_RUN_PROTOCOL,
          generatedAtUtc: new Date().toISOString(),
          smoke: true,
          candidate,
          source: sourceAfter,
          fixtureManifest,
          editors: editorRuns
        }
      : buildInstalledPerformanceReport({
          generatedAtUtc: new Date().toISOString(),
          candidate,
          source: sourceAfter,
          fixtureManifest,
          editorRuns
        });
  } catch (error) {
    primaryError = error;
    processTreeUncertain ||= editorProcessTreeMayBeLive(error);
  }

  let cleanupError;
  try {
    cleanupInstalledPerformancePrivateRoot({
      processTreeUncertain,
      receipt: privateRootReceipt
    });
  } catch (error) {
    cleanupError = error;
  }

  const failures = [primaryError, cleanupError].filter((error) => error !== undefined);
  if (failures.length > 0) {
    const error = failures.length === 1 ? failures[0] : new AggregateError(failures, "Installed performance failed.");
    throw new Error(sanitizeEditorAcceptanceDiagnostic(error, privatePaths));
  }
  if (!result) throw new Error("Installed performance completed without a result.");
  if (!publicCandidateReceipt) throw new Error("Installed performance completed without a public candidate receipt.");
  try {
    revalidateInstalledPerformanceVsix(publicCandidateReceipt);
    if (publicChecksumReceipt !== undefined) {
      revalidateInstalledPerformanceChecksum(publicChecksumReceipt, publicCandidateReceipt.path);
    }
    if (publicProvenanceReceipt !== undefined) {
      revalidateInstalledPerformanceProvenance(publicProvenanceReceipt);
    }
    assertInstalledPerformanceArtifactPathSeparation(options);
  } catch (error) {
    throw new Error(sanitizeEditorAcceptanceDiagnostic(error, privatePaths));
  }
  if (options.smoke) {
    writeInstalledPerformanceRun(options.output, result);
    revalidateInstalledPerformanceVsix(publicCandidateReceipt);
  } else {
    publishInstalledPerformanceReleaseResult({
      output: options.output,
      result,
      publicCandidateReceipt,
      publicChecksumReceipt,
      publicProvenanceReceipt
    });
  }
  return result;
}

export function publishInstalledPerformanceReleaseResult({
  output,
  result,
  publicCandidateReceipt,
  publicChecksumReceipt,
  publicProvenanceReceipt,
  writeReport = writeInstalledPerformanceReport,
  assertGate = assertInstalledPerformanceReleaseGate,
  revalidateCandidate = revalidateInstalledPerformanceVsix,
  revalidateChecksum = revalidateInstalledPerformanceChecksum,
  revalidateProvenance = revalidateInstalledPerformanceProvenance,
  revalidateReport = revalidateInstalledPerformanceReport
}) {
  assertInstalledPerformanceArtifactPathSeparation({
    output,
    candidateInput: publicCandidateReceipt?.path,
    candidateChecksum: publicChecksumReceipt?.path,
    candidateProvenance: publicProvenanceReceipt?.path
  });
  const reportReceipt = writeReport(output, result);
  let gateError;
  try {
    assertGate(result);
  } catch (error) {
    gateError = error;
  }
  let validationError;
  try {
    const revalidateArtifacts = () => {
      revalidateCandidate(publicCandidateReceipt);
      if (publicChecksumReceipt !== undefined) {
        revalidateChecksum(publicChecksumReceipt, publicCandidateReceipt.path);
      }
      if (publicProvenanceReceipt !== undefined) revalidateProvenance(publicProvenanceReceipt);
    };
    revalidateArtifacts();
    let artifactsValidatedWhileReportOpen = false;
    revalidateReport(reportReceipt, {
      afterOpen() {
        revalidateArtifacts();
        artifactsValidatedWhileReportOpen = true;
      }
    });
    if (!artifactsValidatedWhileReportOpen) {
      throw new Error("Installed-performance publication could not jointly validate its candidate and report.");
    }
    revalidateArtifacts();
  } catch (error) {
    validationError = error;
  }
  if (gateError !== undefined && validationError !== undefined) {
    throw new AggregateError(
      [gateError, validationError],
      "Installed-performance release gate and retained evidence validation both failed."
    );
  }
  if (validationError !== undefined) throw validationError;
  if (gateError !== undefined) throw gateError;
  return reportReceipt;
}

export function installedPerformanceDisplayMode(editor, environment = process.env) {
  const explicit = environment.OPEN_WRANGLER_EDITOR_DISPLAY;
  const mode = explicit ?? (editor?.key === "cursor" ? "xvfb" : "headless");
  if (!["headless", "xvfb", "current"].includes(mode)) {
    throw new Error('OPEN_WRANGLER_EDITOR_DISPLAY must be "headless", "xvfb", or "current".');
  }
  return mode;
}

async function runEditorPerformanceWithIsolatedDisplay(options) {
  const mode = installedPerformanceDisplayMode(options.editor, options.environment);
  const environment = { ...options.environment, OPEN_WRANGLER_EDITOR_DISPLAY: mode };
  if (mode === "xvfb" && !environment.OPEN_WRANGLER_XVFB_EXECUTABLE) {
    environment.OPEN_WRANGLER_XVFB_EXECUTABLE = await prepareRepositoryLocalXvfb();
  }
  let display;
  let result;
  let primaryError;
  let processTreeUncertain = false;
  try {
    display = await startIsolatedEditorDisplay({ environment });
    result = await runEditorPerformancePhases({
      ...options,
      environment,
      editorDisplayMode: display.mode
    });
  } catch (error) {
    primaryError = error;
    processTreeUncertain = editorProcessTreeMayBeLive(error);
  }
  let displayError;
  if (display) {
    try {
      await display.stop({ preservePrivateFiles: processTreeUncertain });
    } catch (error) {
      displayError = error;
    }
  }
  const failures = [primaryError, displayError].filter((error) => error !== undefined);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${options.editor.name} performance or display cleanup failed.`);
  }
  if (!result) throw new Error(`${options.editor.name} performance completed without a result.`);
  return result;
}

export async function runInstalledMeasuredEditorPhase({
  phase,
  sampler,
  runPhase,
  spawnOwned = spawnOwnedEditorProcess
}) {
  if (typeof runPhase !== "function" || typeof spawnOwned !== "function") {
    throw new TypeError("Installed performance requires callable phase and process launchers.");
  }
  let phaseError;
  let samplerStartError;
  let samplerEndError;
  let samplerStarted = false;
  let phaseResult;
  const measuredSpawn = (...arguments_) => {
    const child = spawnOwned(...arguments_);
    try {
      sampler.begin(phase, child.pid);
      samplerStarted = true;
    } catch (error) {
      samplerStartError = error;
    }
    return child;
  };
  try {
    phaseResult = await runPhase(measuredSpawn);
  } catch (error) {
    phaseError = error;
  }
  if (samplerStarted) {
    try {
      sampler.end();
    } catch (error) {
      samplerEndError = error;
    }
  } else if (!phaseError && !samplerStartError) {
    samplerEndError = new Error("Installed performance completed an editor phase without attaching RSS sampling.");
  }
  const failures = [phaseError, samplerStartError, samplerEndError].filter((error) => error !== undefined);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Installed performance editor phase or RSS sampling failed.");
  }
  return phaseResult;
}

export async function installInstalledPerformanceCandidate({
  editor,
  candidateReceipt,
  userData,
  extensions,
  sandboxArgs,
  environment,
  runCli = runBoundedEditorCliCommand,
  revalidateCandidate = revalidateInstalledPerformanceVsix,
  spawnOwned = spawnOwnedEditorProcess
}) {
  requireVsixReceipt(candidateReceipt);
  if (!editor || typeof editor !== "object" || typeof editor.name !== "string") {
    throw new TypeError("Installed performance requires one identified editor for candidate installation.");
  }
  if (
    typeof userData !== "string" ||
    typeof extensions !== "string" ||
    !Array.isArray(sandboxArgs) ||
    !environment ||
    typeof environment !== "object"
  ) {
    throw new TypeError("Installed performance requires exact private editor installation paths and arguments.");
  }

  let commandResult;
  let commandError;
  let spawned = false;
  try {
    commandResult = await runCli(
      {
        editor,
        args: [
          "--user-data-dir",
          userData,
          "--extensions-dir",
          extensions,
          "--install-extension",
          candidateReceipt.path,
          "--force",
          ...sandboxArgs
        ],
        environment,
        label: `${editor.name} Open Wrangler candidate installation`
      },
      {
        timeoutMs: 120_000,
        spawnProcess(...arguments_) {
          revalidateCandidate(candidateReceipt);
          const child = spawnOwned(...arguments_);
          spawned = true;
          return child;
        }
      }
    );
    if (!spawned) {
      throw new Error(`${editor.name} candidate installation completed without an owned CLI spawn.`);
    }
  } catch (error) {
    commandError = error;
  }

  let postInstallError;
  if (spawned) {
    try {
      revalidateCandidate(candidateReceipt);
    } catch (error) {
      postInstallError = error;
    }
  }
  const failures = [commandError, postInstallError].filter((error) => error !== undefined);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${editor.name} candidate installation or receipt validation failed.`);
  }
  return commandResult;
}

async function runEditorPerformancePhases({
  editor,
  candidateReceipt,
  candidate,
  python,
  privateRoot,
  fixtureRoot,
  fixtureManifest,
  environment,
  editorDisplayMode
}) {
  const profile = mkdtempSync(join(privateRoot, `p-${editor.key.slice(0, 1)}-`));
  const workspace = resolve(profile, "workspace");
  const userData = resolve(profile, "user");
  const extensions = resolve(profile, "extensions");
  const harness = resolve(profile, "harness");
  const harnessVsix = resolve(profile, "harness.vsix");
  prepareEditorWorkspace(workspace, fixtureRoot);
  writeEditorSettings(userData, {
    "window.dialogStyle": "custom",
    "window.menuStyle": "custom",
    "files.simpleDialog.enable": true,
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false
  });
  writeEditorAcceptanceHarness(harness);
  await createVSIX({
    cwd: harness,
    packagePath: harnessVsix,
    dependencies: false,
    skipLicense: true,
    allowStarActivation: true,
    allowMissingRepository: true
  });

  const sandboxArgs = [
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ...editorDisplayLaunchArgs(process.platform, environment)
  ];
  const editorEnvironment = createEditorAcceptanceEnvironment(environment);
  const identifiedEditor = {
    ...editor,
    version: await readEditorVersion(editor, userData, extensions, sandboxArgs, editorEnvironment)
  };
  await installInstalledPerformanceCandidate({
    editor: identifiedEditor,
    candidateReceipt,
    userData,
    extensions,
    sandboxArgs,
    environment: editorEnvironment
  });
  await runBoundedEditorCliCommand(
    {
      editor: identifiedEditor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--install-extension",
        harnessVsix,
        "--force",
        ...sandboxArgs
      ],
      environment: editorEnvironment,
      label: `${identifiedEditor.name} installed-performance harness installation`
    },
    { timeoutMs: 120_000 }
  );
  const { stdout: installed } = await runBoundedEditorCliCommand(
    {
      editor: identifiedEditor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--list-extensions",
        "--show-versions",
        ...sandboxArgs
      ],
      environment: editorEnvironment,
      label: `${identifiedEditor.name} installed-extension query`
    },
    { timeoutMs: 60_000 }
  );
  const installedLines = installed
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  const expectedCandidate = `${candidate.extensionId}@${candidate.extensionVersion}`.toLowerCase();
  if (!installedLines.includes(expectedCandidate) || !installedLines.includes(EXPECTED_HARNESS)) {
    throw new Error(`${identifiedEditor.name} did not report the exact installed candidate and harness.`);
  }

  const sampler = createInstalledResourceSampler();
  const phases = [];
  for (const phase of INSTALLED_PERFORMANCE_PHASES) {
    const runId = randomUUID();
    const resultPath = resolve(profile, `${phase}-result.json`);
    const artifactReceipt = await runInstalledMeasuredEditorPhase({
      phase,
      sampler,
      runPhase: (spawnProcess) =>
        runEditorAcceptancePhase(
          {
            editor: identifiedEditor,
            workspace,
            userData,
            extensions,
            developmentPaths: [],
            testModule: resolve(root, "dist-test", "test", "extensionHost", "installedPerformance.js"),
            python,
            phase,
            resultPath,
            editorProductVersion: identifiedEditor.version,
            runId,
            progressPath: editorAcceptanceProgressPath(resultPath, runId, phase),
            requiresWorkbenchCdp: true
          },
          { environment, spawnProcess }
        )
    });
    const fragment = validateInstalledPerformancePhase(
      readInstalledPerformanceFragment(
        resolve(workspace, "results", `${phase}.json`),
        INSTALLED_PHASE_FRAGMENT_MAX_BYTES,
        artifactReceipt
      ),
      { runId, phase }
    );
    const expectedFixture = fixtureManifest.fixtures[fragment.fixture.format];
    if (
      fragment.editor.key !== identifiedEditor.key ||
      fragment.editor.productVersion !== identifiedEditor.version ||
      fragment.fixture.sha256 !== expectedFixture.sha256
    ) {
      throw new Error(`${identifiedEditor.name} ${phase} fragment does not match its installed run.`);
    }
    phases.push(fragment);
  }
  const runtime = phases[0].runtime;
  if (phases.some((phase) => JSON.stringify(phase.runtime) !== JSON.stringify(runtime))) {
    throw new Error(`${identifiedEditor.name} changed Python runtime provenance between performance phases.`);
  }
  const productConfiguration = phases[0].productConfiguration;
  if (phases.some((phase) => JSON.stringify(phase.productConfiguration) !== JSON.stringify(productConfiguration))) {
    throw new Error(`${identifiedEditor.name} changed shipped product configuration between performance phases.`);
  }
  return {
    provenance: {
      editor: phases[0].editor,
      runtime,
      productConfiguration,
      platform: readInstalledPlatformProvenance({ editorDisplayMode }),
      storage: readInstalledStorageProvenance(fixtureRoot)
    },
    resources: sampler.finish(),
    phases
  };
}

function prepareEditorWorkspace(workspace, fixtureRoot) {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  cpSync(resolve(fixtureRoot, "fixtures"), resolve(workspace, "fixtures"), {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  cpSync(resolve(fixtureRoot, "performance-fixtures.json"), resolve(workspace, "performance-fixtures.json"), {
    errorOnExist: true,
    force: false
  });
  mkdirSync(resolve(workspace, "benchmarks"), { recursive: true, mode: 0o700 });
  cpSync(
    resolve(root, "python", "benchmarks", "source_cache_control.py"),
    resolve(workspace, "benchmarks", "source_cache_control.py"),
    { errorOnExist: true, force: false }
  );
  mkdirSync(resolve(workspace, "results"), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(workspace, "warmup.csv"), "c00,c01\n0,1\n1,2\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

async function resolveEditors(requested, environment) {
  const candidates = [
    {
      name: "VS Code",
      key: "vscode",
      executable: environment.OPEN_WRANGLER_VSCODE_EXECUTABLE ?? "/usr/share/code/code",
      cli: environment.OPEN_WRANGLER_VSCODE_CLI ?? "/usr/share/code/bin/code",
      sharedDataDir: true
    },
    {
      name: "Cursor",
      key: "cursor",
      executable: environment.OPEN_WRANGLER_CURSOR_EXECUTABLE ?? "/usr/share/cursor/cursor",
      cli: environment.OPEN_WRANGLER_CURSOR_CLI ?? "/usr/share/cursor/bin/cursor",
      sharedDataDir: false
    }
  ].filter((editor) => requested.includes(editor.key) && existsSync(editor.executable) && existsSync(editor.cli));
  if (requested.includes("vscode") && !candidates.some((editor) => editor.key === "vscode")) {
    const executable = await downloadEditorWithRetry(environment.VSCODE_TEST_VERSION ?? "stable");
    const cli = resolveDownloadedEditorCliPath(executable);
    if (!existsSync(cli)) throw new Error("The downloaded VS Code CLI was not found.");
    candidates.unshift({ name: "VS Code", key: "vscode", executable, cli, sharedDataDir: true });
  }
  const missing = requested.filter((key) => !candidates.some((editor) => editor.key === key));
  if (missing.length > 0) {
    throw new Error(
      `Requested installed-performance editor(s) were not found: ${missing.join(", ")}. Configure the corresponding OPEN_WRANGLER_* executable and CLI paths.`
    );
  }
  return requested.map((key) => candidates.find((editor) => editor.key === key));
}

function resolveTestPython(environment) {
  const hosted = environment.pythonLocation
    ? process.platform === "win32"
      ? resolve(environment.pythonLocation, "python.exe")
      : resolve(environment.pythonLocation, "bin", "python")
    : undefined;
  const local =
    process.platform === "win32"
      ? resolve(root, ".venv", "Scripts", "python.exe")
      : resolve(root, ".venv", "bin", "python");
  const python = environment.OPEN_WRANGLER_TEST_PYTHON ?? (hosted && existsSync(hosted) ? hosted : local);
  if (!isAbsolute(python) || !existsSync(python)) {
    throw new Error("Installed performance requires an existing absolute OPEN_WRANGLER_TEST_PYTHON.");
  }
  return python;
}

async function readEditorVersion(editor, userData, extensions, sandboxArgs, environment) {
  const { stdout } = await runBoundedEditorCliCommand(
    {
      editor,
      args: ["--user-data-dir", userData, "--extensions-dir", extensions, "--version", ...sandboxArgs],
      environment,
      label: `${editor.name} version probe`
    },
    { timeoutMs: 30_000 }
  );
  const version = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(line));
  if (!version) throw new Error(`${editor.name} did not report a numeric major.minor.patch version.`);
  return version;
}

function readSourceProvenance() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024,
    timeout: 10_000
  }).trim();
  const trackedStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000
  });
  return { commit, trackedWorktreeDirty: trackedStatus.trim().length > 0 };
}

function readInstalledPerformanceReleaseTagCommit(releaseTag) {
  const commit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${releaseTag}^{commit}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024,
    timeout: 10_000
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("RELEASE_TAG did not resolve to one full Git commit ID.");
  }
  return commit;
}

function readTrackedSourceFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000
  });
  return output.split("\0").filter((entry) => entry.length > 0);
}

function packagePathIdentity(file) {
  if (typeof file !== "string" || file.length === 0 || isAbsolute(file)) return undefined;
  const identity = file.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (identity.length === 0 || identity.split("/").some((segment) => segment === "" || segment === "..")) {
    return undefined;
  }
  return identity;
}

function expectedGeneratedPackageFiles(trackedFiles) {
  const generated = new Set(GENERATED_MEDIA_PACKAGE_FILES);
  for (const file of trackedFiles) {
    if (/^src\/(?:extension|shared)\/.+\.ts$/u.test(file) && !file.endsWith(".d.ts")) {
      generated.add(`dist/${file.slice("src/".length, -".ts".length)}.js`);
    }
  }
  return generated;
}

function readPackageSourceReceipt(file, { sourceKind, requireNonEmpty }) {
  const identity = packagePathIdentity(file);
  if (identity === undefined) {
    throw new Error(`Installed performance could not bind one ${sourceKind} package source path.`);
  }
  const absolute = resolve(root, identity);
  let descriptor;
  try {
    descriptor = openReadOnlyNoFollow(
      absolute,
      `Installed performance ${sourceKind} package source must not be a symbolic link.`
    );
    const before = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(absolute, { bigint: true });
    requireSameRegularFile(
      namedBefore,
      before,
      `Installed performance ${sourceKind} package source changed before it was read.`
    );
    if ((requireNonEmpty && before.size <= 0n) || before.size < 0n || before.size > BigInt(MAX_VSIX_ENTRY_BYTES)) {
      throw new Error(`Installed performance ${sourceKind} package source exceeds its bounded file size.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(Number(before.size), 64 * 1024));
    let bytes = 0;
    while (bytes < Number(before.size)) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(before.size) - bytes), null);
      if (count === 0) {
        throw new Error(`Installed performance ${sourceKind} package source ended before its validated byte size.`);
      }
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(absolute, { bigint: true });
    requireSameRegularFile(
      after,
      before,
      `Installed performance ${sourceKind} package source changed while it was read.`
    );
    requireSameRegularFile(
      namedAfter,
      before,
      `Installed performance ${sourceKind} package source path changed while it was read.`
    );
    return Object.freeze({
      path: identity,
      archiveEntry: archiveEntryForPackageFile(identity),
      bytes,
      sha256: hash.digest("hex"),
      fileIdentity: fileIdentityReceipt(after)
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readTrackedPackageSourceReceipt(file) {
  return readPackageSourceReceipt(file, { sourceKind: "tracked", requireNonEmpty: false });
}

function readGeneratedPackageSourceReceipt(file) {
  return readPackageSourceReceipt(file, { sourceKind: "generated", requireNonEmpty: true });
}

function requirePackageSourceReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !Array.isArray(receipt.packageFiles) ||
    !Array.isArray(receipt.trackedFiles) ||
    !Array.isArray(receipt.generatedFiles) ||
    receipt.packageFiles.some((entry) => packagePathIdentity(entry) === undefined) ||
    new Set(receipt.packageFiles).size !== receipt.packageFiles.length
  ) {
    throw new Error("Guarded installed-performance packaging did not pin its package source set.");
  }
  const packageFiles = new Set(receipt.packageFiles);
  const pinnedPaths = new Set();
  const archiveEntries = new Set();
  for (const [key, sourceKind, requireNonEmpty] of [
    ["trackedFiles", "tracked", false],
    ["generatedFiles", "generated", true]
  ]) {
    for (const entry of receipt[key]) {
      if (
        !entry ||
        typeof entry !== "object" ||
        packagePathIdentity(entry.path) !== entry.path ||
        entry.archiveEntry !== archiveEntryForPackageFile(entry.path) ||
        !packageFiles.has(entry.path) ||
        pinnedPaths.has(entry.path) ||
        archiveEntries.has(entry.archiveEntry) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < (requireNonEmpty ? 1 : 0) ||
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
        !entry.fileIdentity ||
        typeof entry.fileIdentity !== "object" ||
        !["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((field) => typeof entry.fileIdentity[field] === "bigint") ||
        entry.fileIdentity.size !== BigInt(entry.bytes)
      ) {
        throw new Error(`Guarded installed-performance packaging did not pin its ${sourceKind} source set.`);
      }
      pinnedPaths.add(entry.path);
      archiveEntries.add(entry.archiveEntry);
    }
  }
  if (pinnedPaths.size !== packageFiles.size || [...packageFiles].some((entry) => !pinnedPaths.has(entry))) {
    throw new Error("Guarded installed-performance packaging did not pin every package source byte set.");
  }
}

export async function assertNoPackageableUntrackedFiles({
  readTrackedFiles = readTrackedSourceFiles,
  listPackageFiles = () => listFiles({ cwd: root }),
  pinTrackedFile = readTrackedPackageSourceReceipt,
  pinGeneratedFile = readGeneratedPackageSourceReceipt,
  deriveGeneratedFiles = expectedGeneratedPackageFiles
} = {}) {
  const packaged = await listPackageFiles();
  if (!Array.isArray(packaged) || packaged.some((entry) => packagePathIdentity(entry) === undefined)) {
    throw new Error("Installed performance could not determine the package file set.");
  }
  const packageFiles = packaged.map(packagePathIdentity).sort();
  if (new Set(packageFiles).size !== packageFiles.length) {
    throw new Error("Installed performance found colliding package source paths.");
  }
  const rawTracked = readTrackedFiles();
  if (!Array.isArray(rawTracked) || rawTracked.some((entry) => packagePathIdentity(entry) === undefined)) {
    throw new Error("Installed performance could not determine the tracked source file set.");
  }
  const trackedFiles = rawTracked.map(packagePathIdentity);
  if (new Set(trackedFiles).size !== trackedFiles.length) {
    throw new Error("Installed performance found colliding tracked source paths.");
  }
  const tracked = new Set(trackedFiles);
  const expectedGenerated = deriveGeneratedFiles(trackedFiles);
  if (
    !(expectedGenerated instanceof Set) ||
    [...expectedGenerated].some((entry) => packagePathIdentity(entry) !== entry)
  ) {
    throw new Error("Installed performance could not determine the expected generated package outputs.");
  }
  if ([...expectedGenerated].some((entry) => tracked.has(entry))) {
    throw new Error("Installed performance generated package outputs must remain build-owned.");
  }
  const unexpected = packageFiles.filter((entry) => !tracked.has(entry) && !expectedGenerated.has(entry));
  if (unexpected.length > 0) {
    throw new Error("Installed performance refuses to package an untracked or unexpected generated source file.");
  }
  const generatedPaths = packageFiles.filter((entry) => expectedGenerated.has(entry));
  if (
    generatedPaths.length !== expectedGenerated.size ||
    [...expectedGenerated].some((entry) => !generatedPaths.includes(entry))
  ) {
    throw new Error("Installed performance generated package output set is incomplete.");
  }
  const trackedPaths = packageFiles.filter((entry) => tracked.has(entry));
  const trackedSourceReceipts = [];
  const generatedFiles = [];
  let sourceBytes = 0;
  for (const [paths, pinFile, receipts] of [
    [trackedPaths, pinTrackedFile, trackedSourceReceipts],
    [generatedPaths, pinGeneratedFile, generatedFiles]
  ]) {
    for (const file of paths) {
      const receipt = await pinFile(file);
      receipts.push(receipt);
      sourceBytes += receipt?.bytes ?? Number.NaN;
      if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_VSIX_UNCOMPRESSED_BYTES) {
        throw new Error("Installed performance package sources exceed their aggregate size budget.");
      }
    }
  }
  const receipt = Object.freeze({
    packageFiles: Object.freeze(packageFiles),
    trackedFiles: Object.freeze(trackedSourceReceipts),
    generatedFiles: Object.freeze(generatedFiles)
  });
  requirePackageSourceReceipt(receipt);
  return receipt;
}

function archiveEntryForPackageFile(file) {
  const identity = packagePathIdentity(file);
  if (identity === undefined) {
    throw new Error("Installed performance could not bind one package source path.");
  }
  const lower = identity.toLowerCase();
  if (lower === "readme.md") return "extension/readme.md";
  if (lower === "changelog.md") return "extension/changelog.md";
  if (lower === "license" || lower === "license.txt" || lower === "license.md") return "extension/LICENSE.txt";
  return `extension/${identity}`;
}

export function assertSameInstalledPerformancePackageSources(expected, actual) {
  requirePackageSourceReceipt(expected);
  requirePackageSourceReceipt(actual);
  if (
    expected.packageFiles.length !== actual.packageFiles.length ||
    expected.packageFiles.some((entry, index) => entry !== actual.packageFiles[index]) ||
    expected.trackedFiles.length !== actual.trackedFiles.length ||
    expected.generatedFiles.length !== actual.generatedFiles.length
  ) {
    throw new Error("Installed-performance package sources changed while the candidate was created.");
  }
  for (const [key, sourceKind] of [
    ["trackedFiles", "tracked package source"],
    ["generatedFiles", "generated package output"]
  ]) {
    for (let index = 0; index < expected[key].length; index += 1) {
      const before = expected[key][index];
      const after = actual[key][index];
      if (
        before.path !== after.path ||
        before.archiveEntry !== after.archiveEntry ||
        before.bytes !== after.bytes ||
        before.sha256 !== after.sha256 ||
        ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(
          (field) => before.fileIdentity[field] !== after.fileIdentity[field]
        )
      ) {
        throw new Error(`Installed-performance ${sourceKind} changed while the candidate was created.`);
      }
    }
  }
}

export function assertInstalledPerformancePackageInventory(packageSource, archiveEntries, archiveEntryDigests = []) {
  requirePackageSourceReceipt(packageSource);
  if (!Array.isArray(archiveEntries) || !Array.isArray(archiveEntryDigests)) {
    throw new TypeError("Installed performance package inventory validation requires bounded archive arrays.");
  }
  const expected = packageSource.packageFiles.map(archiveEntryForPackageFile).sort();
  const actual = archiveEntries
    .filter((entry) => entry !== "[Content_Types].xml" && entry !== "extension.vsixmanifest" && !entry.endsWith("/"))
    .sort();
  if (
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((entry, index) => entry !== actual[index])
  ) {
    throw new Error("The installed-performance VSIX inventory drifted from its pinned pre-package source set.");
  }
  const digests = new Map();
  for (const item of archiveEntryDigests) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== "string" ||
      typeof item[1] !== "string" ||
      !/^[0-9a-f]{64}$/u.test(item[1]) ||
      digests.has(item[0])
    ) {
      throw new Error("The installed-performance VSIX returned an invalid entry-digest inventory.");
    }
    digests.set(item[0], item[1]);
  }
  for (const source of [...packageSource.trackedFiles, ...packageSource.generatedFiles]) {
    if (digests.get(source.archiveEntry) !== source.sha256) {
      throw new Error("The installed-performance VSIX source bytes drifted from their pinned package inputs.");
    }
  }
}

async function verifyInstalledPerformancePackageInventory(receipt, packageSource) {
  requirePackageSourceReceipt(packageSource);
  const snapshot = readInstalledPerformanceVsixSnapshot(receipt);
  const archive = await inspectVsixArchive(snapshot.bytes);
  assertInstalledPerformancePackageInventory(packageSource, archive.archiveEntries, archive.entryDigests);
  revalidateInstalledPerformanceVsix(receipt);
}

function requireCleanSource(source, stage) {
  if (!/^[0-9a-f]{40}$/u.test(source?.commit) || source.trackedWorktreeDirty !== false) {
    throw new Error(`Installed performance requires one clean exact HEAD ${stage}.`);
  }
}

function requireSameSource(current, expected, stage) {
  requireCleanSource(current, stage);
  if (current.commit !== expected.commit) {
    throw new Error(`The installed-performance source commit changed ${stage}.`);
  }
}

function runInstalledPerformanceBuild(environment) {
  for (const [script, timeout] of [
    ["clean", 60_000],
    ["build", 180_000],
    ["build:test-extension", 120_000]
  ]) {
    execFileSync("npm", ["run", script], {
      cwd: root,
      env: environment,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      windowsHide: true
    });
  }
}

function runInstalledPerformanceHarnessBuild(environment) {
  execFileSync("npm", ["run", "build:test-extension"], {
    cwd: root,
    env: environment,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    windowsHide: true
  });
}

async function createInstalledPerformanceVsix(destination, { preRelease }) {
  if (typeof preRelease !== "boolean") {
    throw new TypeError("Guarded installed-performance packaging requires an explicit release channel.");
  }
  assertAbsent(destination, "guarded installed-performance candidate");
  await createVSIX({
    cwd: root,
    packagePath: destination,
    preRelease,
    allowStarActivation: false,
    allowMissingRepository: false
  });
}

async function verifyInstalledPerformanceVsix(receipt, _environment) {
  const snapshot = readInstalledPerformanceVsixSnapshot(receipt);
  const payload = await inspectVsixArchive(snapshot.bytes);
  const { packagedPackageJson, packagedReadme, vsixManifest, webviewCss, webviewPanel, notebookRenderer } = payload;
  const problems = [
    ...inspectVsixPreReleaseMetadata(packagedPackageJson, vsixManifest),
    ...inspectReadmeSourceSrcsets(packagedReadme),
    ...inspectNotebookRendererBundle(notebookRenderer)
  ];
  if (!/url\((?:["'])?\.\/codicon\.ttf(?:\?[^)"']*)?(?:["'])?\)/u.test(webviewCss)) {
    problems.push("webview.css must load codicon.ttf from its own bundle directory.");
  }
  if (!/font-src \$\{webview\.cspSource\};/u.test(webviewPanel)) {
    problems.push("The main webview CSP must allow its bundled font origin.");
  }
  if (problems.length > 0) {
    throw new Error(`Invalid ${basename(receipt.path)}. ${problems.join(" ")}`);
  }
  revalidateInstalledPerformanceVsix(receipt);
}

export function readBoundedJson(file, maxBytes, hooks = {}) {
  return readBoundedJsonSnapshot(file, maxBytes, hooks).value;
}

export function readBoundedJsonSnapshot(file, maxBytes, hooks = {}) {
  let descriptor;
  try {
    descriptor = openReadOnlyNoFollow(file, "Installed performance produced an invalid bounded JSON file.");
    const identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n || identity.size <= 0n || identity.size > BigInt(maxBytes)) {
      throw new Error("Installed performance produced an invalid bounded JSON file.");
    }
    const initialPath = lstatSync(file, { bigint: true });
    requireSameRegularFile(initialPath, identity, "Installed performance JSON changed before it was read.");
    hooks.afterOpen?.(file);
    const contents = Buffer.alloc(Number(identity.size));
    let offset = 0;
    while (offset < contents.length) {
      const count = readSync(descriptor, contents, offset, contents.length - offset, null);
      if (count === 0) throw new Error("Installed performance JSON ended before its validated byte size.");
      offset += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    const completedPath = lstatSync(file, { bigint: true });
    requireSameRegularFile(completed, identity, "Installed performance JSON changed while it was read.");
    requireSameRegularFile(completedPath, identity, "Installed performance JSON path changed while it was read.");
    return Object.freeze({
      value: parseStrictJson(contents.toString("utf8"), { maxBytes }),
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex")
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readInstalledPerformanceFragment(file, maxBytes, receipt, hooks = {}) {
  const expectedKeys = ["bytes", "protocol", "sha256"];
  const actualKeys =
    receipt && typeof receipt === "object" && !Array.isArray(receipt) ? Object.keys(receipt).sort() : [];
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    receipt.protocol !== EDITOR_ACCEPTANCE_ARTIFACT_RECEIPT_PROTOCOL ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes <= 0 ||
    receipt.bytes > maxBytes ||
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256)
  ) {
    throw new Error("Installed performance phase returned an invalid artifact receipt.");
  }
  const snapshot = readBoundedJsonSnapshot(file, maxBytes, hooks);
  if (snapshot.bytes !== receipt.bytes || snapshot.sha256 !== receipt.sha256) {
    throw new Error("Installed performance phase fragment does not match its editor-host artifact receipt.");
  }
  return snapshot.value;
}

function requireSameRegularFile(actual, expected, message) {
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeNs !== expected.mtimeNs ||
    actual.ctimeNs !== expected.ctimeNs
  ) {
    throw new Error(message);
  }
}

function fileIdentityReceipt(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  });
}

function requireVsixReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    typeof receipt.path !== "string" ||
    receipt.path.length === 0 ||
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256) ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes <= 0 ||
    !receipt.fileIdentity ||
    typeof receipt.fileIdentity !== "object" ||
    !["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => typeof receipt.fileIdentity[key] === "bigint") ||
    receipt.fileIdentity.size !== BigInt(receipt.bytes)
  ) {
    throw new Error("The installed-performance VSIX receipt is invalid.");
  }
}

function requireChecksumReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    typeof receipt.path !== "string" ||
    receipt.path.length === 0 ||
    typeof receipt.candidatePath !== "string" ||
    receipt.candidatePath.length === 0 ||
    typeof receipt.candidateSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.candidateSha256) ||
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256) ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes <= 0 ||
    receipt.bytes > INSTALLED_CHECKSUM_MAX_BYTES ||
    !receipt.fileIdentity ||
    typeof receipt.fileIdentity !== "object" ||
    !["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => typeof receipt.fileIdentity[key] === "bigint") ||
    receipt.fileIdentity.size !== BigInt(receipt.bytes)
  ) {
    throw new Error("The installed-performance checksum receipt is invalid.");
  }
}

function requireProvenanceReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    typeof receipt.path !== "string" ||
    receipt.path.length === 0 ||
    receipt.protocol !== CANONICAL_RELEASE_ARTIFACT_PROTOCOL ||
    receipt.extensionId !== "Matt17BR.openwrangler" ||
    typeof receipt.extensionVersion !== "string" ||
    classifyNumericReleaseVersion(receipt.extensionVersion)?.channel !== "stable" ||
    receipt.preview !== false ||
    receipt.releaseTag !== `v${receipt.extensionVersion}` ||
    typeof receipt.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(receipt.sourceCommit) ||
    typeof receipt.vsixSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.vsixSha256) ||
    !Number.isSafeInteger(receipt.vsixBytes) ||
    receipt.vsixBytes <= 0 ||
    receipt.vsixBytes > VSIX_MAX_BYTES ||
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256) ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes <= 0 ||
    receipt.bytes > INSTALLED_PROVENANCE_MAX_BYTES ||
    !receipt.fileIdentity ||
    typeof receipt.fileIdentity !== "object" ||
    !["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => typeof receipt.fileIdentity[key] === "bigint") ||
    receipt.fileIdentity.size !== BigInt(receipt.bytes)
  ) {
    throw new Error("The installed-performance provenance receipt is invalid.");
  }
}

function sameFileIdentityReceipt(actual, expected) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => actual[key] === expected[key]);
}

function canonicalProspectivePath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try {
      return resolve(realpathSync.native(cursor), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function existingPathIdentity(path) {
  try {
    const identity = statSync(path, { bigint: true });
    return Object.freeze({ dev: identity.dev, ino: identity.ino });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameExistingPathIdentity(first, second) {
  return first !== undefined && second !== undefined && first.dev === second.dev && first.ino === second.ino;
}

function openReadOnlyNoFollow(file, symlinkMessage) {
  try {
    return openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(symlinkMessage, { cause: error });
    throw error;
  }
}

function requireSameFileIdentity(actual, expected, message) {
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error(message);
  }
}

function removeIdentifiedFile(file, identity) {
  try {
    const current = lstatSync(file, { bigint: true });
    requireSameFileIdentity(current, identity, "Owned temporary cleanup was withheld after an identity change.");
    rmSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertAbsent(file, label) {
  try {
    lstatSync(file);
    throw new Error(`The ${label} destination must be absent.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertReplaceableRegularFile(file, label) {
  try {
    const metadata = lstatSync(file, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
      throw new Error(`The ${label} destination must be absent or a single-link regular file.`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = parseInstalledPerformanceArguments(process.argv.slice(2));
    await runInstalledPerformance(options);
    const relativeOutput = relative(root, options.output);
    const label =
      relativeOutput && relativeOutput !== ".." && !relativeOutput.startsWith(`..${sep}`) && !isAbsolute(relativeOutput)
        ? relativeOutput.replaceAll("\\", "/")
        : "the requested output file";
    console.log(`Installed performance passed; path-free results were written to ${label}.`);
    if (options.smoke) console.log("Smoke-sized fixtures were used; this is not release evidence.");
  } catch (error) {
    console.error(`Installed performance failed: ${sanitizeEditorAcceptanceDiagnostic(error)}`);
    process.exitCode = 1;
  }
}
