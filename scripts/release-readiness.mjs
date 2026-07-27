import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { SaxesParser } from "saxes";
import {
  inspectChangelog,
  inspectPrimaryParityMatrix,
  inspectStableReadme,
  STABLE_README_RELEASE_SECTION
} from "./release-documents.mjs";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { DuplicateJsonKeyError, parseStrictJson } from "./strict-json.mjs";
import { inspectVsixArchive, MAX_VSIX_BYTES } from "./vsix-archive.mjs";
import { inspectVsixPreReleaseMetadata } from "./vsix-contents.mjs";

const VSIX_MANIFEST_NAMESPACE = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const PYTHON_VERSION = /^__version__\s*=\s*"([^"\r\n]+)"\s*$/gmu;
const FULL_COMMIT_ID = /^[0-9a-f]{40}$/iu;
const RELEASE_SOURCE_FILES = new Map([
  ["package.json", 1024 * 1024],
  ["python/openwrangler_runtime/version.py", 64 * 1024],
  ["docs/feature-parity.md", 2 * 1024 * 1024],
  ["CHANGELOG.md", 2 * 1024 * 1024],
  ["README.md", 2 * 1024 * 1024]
]);
export { STABLE_README_RELEASE_SECTION };
const STABLE_PACKAGE_IDENTITY = Object.freeze({
  name: "openwrangler",
  displayName: "Open Wrangler",
  publisher: "Matt17BR"
});
export const PRIMARY_PARITY_SCOPE = Object.freeze([
  ["CSV/TSV/Parquet/Excel/JSONL entry points", "Yes", "Yes"],
  ["Notebook variable viewer and toolbar", "Yes", "Yes"],
  ["Inline notebook renderer and full-view expansion", "Yes", "Yes"],
  ["Virtual grid, column sizing, navigation", "Yes", "Yes"],
  ["Dataset summary and quick insights", "Yes", "Yes"],
  ["Basic and advanced viewing filters", "Yes", "Yes"],
  ["Multi-column viewing sorts", "Yes", "Yes"],
  ["Editing mode and operation catalog", "Yes", "Yes"],
  ["Draft preview and data diff", "Yes", "Yes"],
  ["Cleaning-step history, edit, discard, undo", "Yes", "Yes"],
  ["Generated code preview and editing", "Yes", "Yes"],
  ["Sort/filter cleaning steps", "Yes", "Yes"],
  ["Select/drop/rename/clone/cast/formula/length", "Yes", "Yes"],
  ["Missing/duplicate row operations", "Yes", "Yes"],
  ["One-hot and multi-label binarization", "Yes", "Yes"],
  ["Find/replace/strip/split/case transforms", "Yes", "Yes"],
  ["Scale/round/floor/ceiling/datetime format", "Yes", "Yes"],
  ["Group and aggregate", "Yes", "Yes"],
  ["Custom engine-native code", "Yes", "Yes"],
  ["String/datetime/new-column by example", "Yes", "Yes"],
  ["Copy/script/notebook code export", "Yes", "Yes"],
  ["CSV and Parquet data export", "Yes", "Yes"],
  ["Runtime selection, setup, change, clear", "Yes", "Yes"],
  ["Original icons, native views, themes, accessibility", "N/A", "N/A"],
  ["Runtime crash/reload/session replay", "Yes", "Yes"],
  ["Column-projected grid-block transport", "Yes", "Yes"],
  ["Duplicate/non-string Pandas column operations", "Yes", "N/A"],
  ["Restricted Mode and trust-gated execution", "N/A", "N/A"],
  ["Installed-editor first-usable-grid performance", "Yes", "Yes"],
  ["Cross-platform first-class editor package acceptance", "N/A", "N/A"]
]);

function parseJsonObject(contents, label, problems) {
  let value;
  try {
    value = parseStrictJson(contents);
  } catch (error) {
    problems.push(
      error instanceof DuplicateJsonKeyError
        ? `${label} must not contain duplicate object keys.`
        : `${label} must contain valid bounded JSON.`
    );
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${label} must contain a JSON object.`);
    return undefined;
  }
  return value;
}

function parsePythonRuntimeVersion(contents, label, problems) {
  const matches = [...contents.matchAll(PYTHON_VERSION)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    problems.push(`${label} must contain exactly one __version__ = "..." assignment.`);
    return undefined;
  }
  return matches[0][1];
}

function parseVsixIdentity(contents) {
  const path = [];
  const identities = [];
  let rootIsCanonical = false;
  let metadataCount = 0;
  let canonicalMetadataCount = 0;
  let parseFailed = false;
  const parser = new SaxesParser({ xmlns: true });

  parser.on("doctype", () => {
    parseFailed = true;
  });
  parser.on("opentag", (tag) => {
    path.push({ name: tag.name, uri: tag.uri });
    const canonicalPrefix = (names) =>
      path.length >= names.length &&
      path
        .slice(0, names.length)
        .every((element, index) => element.name === names[index] && element.uri === VSIX_MANIFEST_NAMESPACE);

    if (path.length === 1) {
      rootIsCanonical = canonicalPrefix(["PackageManifest"]);
      return;
    }
    if (path.length === 2 && path[0]?.name === "PackageManifest" && tag.name === "Metadata") {
      metadataCount += 1;
      canonicalMetadataCount += Number(canonicalPrefix(["PackageManifest", "Metadata"]));
      return;
    }
    if (path.length !== 3 || !canonicalPrefix(["PackageManifest", "Metadata", "Identity"])) {
      return;
    }

    const plainAttributes = Object.values(tag.attributes).filter(
      (attribute) => typeof attribute === "object" && attribute.prefix === "" && attribute.uri === ""
    );
    const attribute = (name) =>
      plainAttributes.find((candidate) => candidate.local === name && candidate.name === name)?.value;
    identities.push({
      id: attribute("Id"),
      version: attribute("Version"),
      publisher: attribute("Publisher")
    });
  });
  parser.on("closetag", () => {
    path.pop();
  });

  try {
    parser.write(contents).close();
  } catch {
    parseFailed = true;
  }

  if (
    parseFailed ||
    !rootIsCanonical ||
    metadataCount !== 1 ||
    canonicalMetadataCount !== 1 ||
    identities.length !== 1
  ) {
    return undefined;
  }
  return identities[0];
}

export function inspectStableReleaseReadiness({
  releaseTag,
  sourcePackageJson,
  pythonVersionFile,
  featureParity,
  changelog,
  readme,
  packagedPackageJson,
  packagedPythonVersionFile,
  packagedReadme,
  vsixManifest,
  trackedEvidencePaths = new Set()
}) {
  const problems = [];
  const sourceManifest = parseJsonObject(sourcePackageJson, "Source package.json", problems);
  const packagedManifest = parseJsonObject(packagedPackageJson, "Packaged package.json", problems);
  const sourceVersion = typeof sourceManifest?.version === "string" ? sourceManifest.version : undefined;
  const pythonVersion = parsePythonRuntimeVersion(
    pythonVersionFile,
    "python/openwrangler_runtime/version.py",
    problems
  );
  const packagedPythonVersion = parsePythonRuntimeVersion(
    packagedPythonVersionFile,
    "Packaged Python runtime version.py",
    problems
  );

  const sourceVersionClassification = classifyNumericReleaseVersion(sourceVersion);
  if (sourceVersionClassification === undefined) {
    problems.push("Source package.json version must use stable major.minor.patch syntax.");
  } else if (sourceVersionClassification.channel !== "stable") {
    problems.push(
      `Source package.json version ${sourceVersion} is reserved for preview releases and cannot pass stable readiness.`
    );
  }
  for (const [field, expected] of Object.entries(STABLE_PACKAGE_IDENTITY)) {
    if (sourceManifest?.[field] !== expected) {
      problems.push(`Source package.json ${field} must be ${JSON.stringify(expected)} for a stable release.`);
    }
  }
  if (sourceManifest?.preview !== false) {
    problems.push("Source package.json preview must be false for a stable release.");
  }
  if (sourceVersion !== undefined && releaseTag !== `v${sourceVersion}`) {
    problems.push(`Release tag ${String(releaseTag)} does not match source version v${sourceVersion}.`);
  }
  if (sourceVersion !== undefined && pythonVersion !== undefined && sourceVersion !== pythonVersion) {
    problems.push(`Python runtime version ${pythonVersion} does not match source package version ${sourceVersion}.`);
  }
  if (sourceVersion !== undefined && packagedPythonVersion !== undefined && sourceVersion !== packagedPythonVersion) {
    problems.push(
      `Packaged Python runtime version ${packagedPythonVersion} does not match source package version ${sourceVersion}.`
    );
  }

  if (sourceVersion !== undefined) {
    problems.push(...inspectChangelog(changelog, sourceVersion));
  }
  problems.push(...inspectPrimaryParityMatrix(featureParity, PRIMARY_PARITY_SCOPE, trackedEvidencePaths));
  problems.push(...inspectStableReadme(readme, "README.md"));
  problems.push(...inspectStableReadme(packagedReadme, "Packaged README"));

  if (packagedManifest?.preview !== false) {
    problems.push("Packaged package.json preview must be false for a stable release.");
  }
  for (const field of ["name", "displayName", "publisher", "version"]) {
    if (sourceManifest?.[field] !== packagedManifest?.[field]) {
      problems.push(`Packaged package.json ${field} does not match source package.json.`);
    }
  }
  if (
    sourceManifest !== undefined &&
    packagedManifest !== undefined &&
    !isDeepStrictEqual(sourceManifest, packagedManifest)
  ) {
    problems.push(
      "Packaged package.json must exactly match source package.json; no packaging transformations are permitted."
    );
  }

  problems.push(...inspectVsixPreReleaseMetadata(packagedPackageJson, vsixManifest));
  if (packagedManifest !== undefined) {
    problems.push(
      ...inspectVsixPreReleaseMetadata(JSON.stringify({ ...packagedManifest, preview: false }), vsixManifest)
    );
  }
  const identity = parseVsixIdentity(vsixManifest);
  if (identity === undefined) {
    problems.push("VSIX manifest must contain one canonical Metadata > Identity element.");
  } else {
    if (identity.id !== sourceManifest?.name) {
      problems.push("VSIX identity ID does not match source package.json name.");
    }
    if (identity.publisher !== sourceManifest?.publisher) {
      problems.push("VSIX identity publisher does not match source package.json publisher.");
    }
    if (identity.version !== sourceVersion) {
      problems.push("VSIX identity version does not match source package.json version.");
    }
  }

  return [...new Set(problems)];
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFileSnapshot(before, after) {
  return (
    sameFileIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function runGit(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true
  });
}

function decodeUtf8(contents, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8 at the release commit.`, { cause: error });
  }
}

export function readReleaseSourceSnapshot({ expectedCommit, root }) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT_ID.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full hexadecimal Git commit ID.");
  }
  const absoluteRoot = resolve(root);
  const commit = runGit(absoluteRoot, ["rev-parse", "--verify", `${expectedCommit}^{commit}`], {
    encoding: "utf8"
  }).trim();
  const head = runGit(absoluteRoot, ["rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8"
  }).trim();
  if (commit !== expectedCommit.toLowerCase() || head !== commit) {
    throw new Error("Release readiness must inspect the exact checked-out event commit.");
  }

  const trackedPaths = new Set(
    runGit(absoluteRoot, ["ls-tree", "-r", "--name-only", "-z", commit, "--"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
  );
  const files = new Map();
  for (const [path, maxBytes] of RELEASE_SOURCE_FILES) {
    if (!trackedPaths.has(path)) {
      throw new Error(`Release commit is missing required tracked source ${path}.`);
    }
    const object = `${commit}:${path}`;
    const sizeText = runGit(absoluteRoot, ["cat-file", "-s", object], {
      encoding: "utf8",
      maxBuffer: 1024
    }).trim();
    if (!/^(?:0|[1-9]\d*)$/u.test(sizeText)) {
      throw new Error(`Release source ${path} has an invalid Git object size.`);
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
      throw new Error(`Release source ${path} exceeds its ${maxBytes}-byte commit snapshot limit.`);
    }
    const contents = runGit(absoluteRoot, ["cat-file", "blob", object], {
      maxBuffer: maxBytes + 1
    });
    if (!Buffer.isBuffer(contents) || contents.length !== size) {
      throw new Error(`Release source ${path} did not match its Git object size.`);
    }
    files.set(path, decodeUtf8(contents, path));
  }
  return Object.freeze({
    commit,
    files,
    trackedPaths
  });
}

export function readOwnedVsixSnapshot(vsixPath) {
  const absolutePath = resolve(vsixPath);
  let pathIdentity;
  try {
    pathIdentity = lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    throw new Error(`Stable VSIX candidate cannot be inspected: ${basename(absolutePath)}.`, { cause: error });
  }
  if (!pathIdentity.isFile() || pathIdentity.nlink !== 1n) {
    throw new Error("Stable VSIX candidate must be one regular, unlinked file.");
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(absolutePath, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameFileIdentity(pathIdentity, before) ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("Stable VSIX candidate identity or ownership changed before inspection.");
    }
    if (before.size <= 0n || before.size > BigInt(MAX_VSIX_BYTES)) {
      throw new Error(`Stable VSIX candidate must be between 1 and ${MAX_VSIX_BYTES} bytes.`);
    }

    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (bytes.length !== Number(before.size) || !unchangedFileSnapshot(before, after)) {
      throw new Error("Stable VSIX candidate changed while its immutable snapshot was read.");
    }
    return Object.freeze({
      bytes,
      sha256: sha256(bytes),
      sourceIdentity: Object.freeze({ dev: before.dev, ino: before.ino, size: before.size })
    });
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export async function readStableVsixPayload(bytes) {
  return await inspectVsixArchive(bytes);
}

function readParentIdentity(path) {
  const absolutePath = resolve(path);
  const parentPath = realpathSync.native(dirname(absolutePath));
  const parent = lstatSync(parentPath, { bigint: true });
  if (!parent.isDirectory()) {
    throw new Error(`Release output parent must be a directory: ${basename(path)}.`);
  }
  return Object.freeze({
    parentDev: parent.dev,
    parentIno: parent.ino,
    parentPath,
    outputName: basename(absolutePath),
    outputPath: join(parentPath, basename(absolutePath))
  });
}

function sameParent(path, receipt) {
  try {
    const absolutePath = resolve(path);
    const current = lstatSync(receipt.parentPath, { bigint: true });
    return (
      basename(absolutePath) === receipt.outputName &&
      realpathSync.native(dirname(absolutePath)) === receipt.parentPath &&
      current.isDirectory() &&
      current.dev === receipt.parentDev &&
      current.ino === receipt.parentIno &&
      realpathSync.native(receipt.parentPath) === receipt.parentPath
    );
  } catch {
    return false;
  }
}

function sameReceipt(path, receipt) {
  try {
    const current = lstatSync(receipt.outputPath, { bigint: true });
    return (
      sameParent(path, receipt) &&
      current.isFile() &&
      current.nlink === 1n &&
      sameFileIdentity(current, receipt) &&
      (receipt.size === undefined || current.size === receipt.size) &&
      (receipt.mode === undefined || (current.mode & 0o777n) === receipt.mode) &&
      (receipt.mtimeNs === undefined || current.mtimeNs === receipt.mtimeNs) &&
      (receipt.ctimeNs === undefined || current.ctimeNs === receipt.ctimeNs)
    );
  } catch {
    return false;
  }
}

function removeOwnedOutput(path, receipt) {
  if (!sameReceipt(path, receipt)) {
    throw new Error(`Refusing to clean an unverified release output: ${basename(path)}.`);
  }
  unlinkSync(receipt.outputPath);
}

function writeExclusiveOwnedOutput(path, contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const parentReceipt = readParentIdentity(path);
  const outputPath = parentReceipt.outputPath;
  let descriptor;
  let receipt;
  let failure;
  try {
    descriptor = openSync(
      outputPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      (typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid()))
    ) {
      throw new Error(`Release output ownership could not be established: ${basename(path)}.`);
    }
    receipt = { ...parentReceipt, dev: opened.dev, ino: opened.ino };

    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        throw new Error(`Release output write did not make progress: ${basename(path)}.`);
      }
      offset += written;
    }
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o444);
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, completed) || completed.size !== BigInt(bytes.length)) {
      throw new Error(`Release output changed while it was published: ${basename(path)}.`);
    }
    receipt = {
      ...receipt,
      ctimeNs: completed.ctimeNs,
      mtimeNs: completed.mtimeNs,
      sha256: sha256(bytes),
      mode: process.platform === "win32" ? undefined : 0o444n,
      size: completed.size
    };
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure !== undefined) {
    if (receipt !== undefined && sameReceipt(path, receipt)) {
      removeOwnedOutput(path, receipt);
    }
    throw failure;
  }
  if (receipt === undefined || !sameReceipt(path, receipt)) {
    throw new Error(`Release output identity was lost after close: ${basename(path)}.`);
  }
  return Object.freeze(receipt);
}

function readVerifiedOutput(path, receipt) {
  if (!sameReceipt(path, receipt)) {
    throw new Error(`Release output identity or parent changed: ${basename(path)}.`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(receipt.outputPath, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameFileIdentity(before, receipt) || before.size !== receipt.size) {
      throw new Error(`Release output changed before final content verification: ${basename(path)}.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes.length !== Number(before.size) ||
      !unchangedFileSnapshot(before, after) ||
      sha256(bytes) !== receipt.sha256 ||
      !sameReceipt(path, receipt)
    ) {
      throw new Error(`Release output content changed during final verification: ${basename(path)}.`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function revalidateStableReleaseArtifacts({
  afterVsixRead,
  checksumOutput,
  checksumReceipt,
  snapshot,
  vsixOutput,
  vsixReceipt
}) {
  if (
    !Buffer.isBuffer(snapshot?.bytes) ||
    typeof snapshot?.sha256 !== "string" ||
    sha256(snapshot.bytes) !== snapshot.sha256
  ) {
    throw new Error("Stable release snapshot digest no longer matches its inspected bytes.");
  }
  const vsixBytes = readVerifiedOutput(resolve(vsixOutput), vsixReceipt);
  if (!vsixBytes.equals(snapshot.bytes)) {
    throw new Error("Published stable VSIX does not match the inspected immutable snapshot.");
  }
  afterVsixRead?.();
  const checksumBytes = readVerifiedOutput(resolve(checksumOutput), checksumReceipt);
  const expectedChecksum = Buffer.from(`${snapshot.sha256}  ${basename(resolve(vsixOutput))}\n`, "utf8");
  if (!checksumBytes.equals(expectedChecksum)) {
    throw new Error("Published stable checksum does not match the inspected immutable snapshot.");
  }
  if (!sameReceipt(resolve(vsixOutput), vsixReceipt) || !sameReceipt(resolve(checksumOutput), checksumReceipt)) {
    throw new Error("Published stable outputs did not retain one joint final identity.");
  }
}

export function writeStableReleaseArtifacts({ snapshot, vsixOutput, checksumOutput }) {
  if (
    !Buffer.isBuffer(snapshot?.bytes) ||
    typeof snapshot?.sha256 !== "string" ||
    sha256(snapshot.bytes) !== snapshot.sha256
  ) {
    throw new Error("Stable release snapshot digest no longer matches its inspected bytes.");
  }
  const resolvedVsixOutput = resolve(vsixOutput);
  const resolvedChecksumOutput = resolve(checksumOutput);
  if (resolvedVsixOutput === resolvedChecksumOutput) {
    throw new Error("Stable VSIX and checksum outputs must be different paths.");
  }

  let vsixReceipt;
  let checksumReceipt;
  try {
    vsixReceipt = writeExclusiveOwnedOutput(resolvedVsixOutput, snapshot.bytes);
    checksumReceipt = writeExclusiveOwnedOutput(
      resolvedChecksumOutput,
      `${snapshot.sha256}  ${basename(resolvedVsixOutput)}\n`
    );
    revalidateStableReleaseArtifacts({
      checksumOutput: resolvedChecksumOutput,
      checksumReceipt,
      snapshot,
      vsixOutput: resolvedVsixOutput,
      vsixReceipt
    });
    return Object.freeze({ checksumReceipt, vsixReceipt });
  } catch (error) {
    const cleanupErrors = [];
    for (const [path, receipt] of [
      [resolvedChecksumOutput, checksumReceipt],
      [resolvedVsixOutput, vsixReceipt]
    ]) {
      if (receipt !== undefined) {
        try {
          removeOwnedOutput(path, receipt);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    }
    throw cleanupErrors.length === 0
      ? error
      : new AggregateError([error, ...cleanupErrors], "Stable release publication and cleanup failed.");
  }
}

function parseCliArguments(args) {
  if (args.length !== 5 || args[1] !== "--out" || args[3] !== "--checksum-out" || !args[0] || !args[2] || !args[4]) {
    throw new Error(
      "Pass one stable candidate plus explicit outputs: <candidate.vsix> --out <openwrangler.vsix> --checksum-out <openwrangler.vsix.sha256>."
    );
  }
  return { candidate: args[0], checksumOutput: args[4], vsixOutput: args[2] };
}

async function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const requested = parseCliArguments(process.argv.slice(2));
  const candidate = resolve(root, requested.candidate);
  const vsixOutput = resolve(root, requested.vsixOutput);
  const checksumOutput = resolve(root, requested.checksumOutput);
  if (new Set([candidate, vsixOutput, checksumOutput]).size !== 3) {
    throw new Error("Stable candidate, VSIX output, and checksum output must be three distinct paths.");
  }
  const snapshot = readOwnedVsixSnapshot(candidate);
  const packaged = await readStableVsixPayload(snapshot.bytes);
  const source = readReleaseSourceSnapshot({
    expectedCommit: process.env.EXPECTED_SHA,
    root
  });

  const problems = inspectStableReleaseReadiness({
    releaseTag: process.env.RELEASE_TAG,
    sourcePackageJson: source.files.get("package.json"),
    pythonVersionFile: source.files.get("python/openwrangler_runtime/version.py"),
    featureParity: source.files.get("docs/feature-parity.md"),
    changelog: source.files.get("CHANGELOG.md"),
    readme: source.files.get("README.md"),
    packagedPackageJson: packaged.packagedPackageJson,
    packagedPythonVersionFile: packaged.packagedPythonVersionFile,
    packagedReadme: packaged.packagedReadme,
    trackedEvidencePaths: source.trackedPaths,
    vsixManifest: packaged.vsixManifest
  });

  if (problems.length > 0) {
    throw new Error(`Stable release readiness failed for ${basename(candidate)}:\n- ${problems.join("\n- ")}`);
  }
  if (sha256(snapshot.bytes) !== snapshot.sha256) {
    throw new Error("Stable VSIX snapshot changed during readiness inspection.");
  }
  writeStableReleaseArtifacts({ checksumOutput, snapshot, vsixOutput });
  console.log(`Stable release readiness verified for ${basename(vsixOutput)} (${snapshot.sha256}).`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
