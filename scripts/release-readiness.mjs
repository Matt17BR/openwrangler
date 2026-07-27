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
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { SaxesParser } from "saxes";
import { fromBuffer as openZipBuffer } from "yauzl";
import {
  inspectChangelog,
  inspectPrimaryParityMatrix,
  inspectStableReadme,
  STABLE_README_RELEASE_SECTION
} from "./release-documents.mjs";
import { NUMERIC_RELEASE_VERSION } from "./release-metadata.mjs";
import { DuplicateJsonKeyError, parseStrictJson } from "./strict-json.mjs";
import { inspectVsixEntries, inspectVsixPreReleaseMetadata } from "./vsix-contents.mjs";

const VSIX_MANIFEST_NAMESPACE = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const PYTHON_VERSION = /^__version__\s*=\s*"([^"\r\n]+)"\s*$/gmu;
const README_MAX_BYTES = 2 * 1024 * 1024;
const MAX_VSIX_BYTES = 128 * 1024 * 1024;
const MAX_VSIX_ENTRIES = 4096;
const MAX_VSIX_ENTRY_NAME = 1024;
const REQUIRED_VSIX_ENTRIES = new Map([
  ["extension/package.json", { key: "packagedPackageJson", maxBytes: 1024 * 1024 }],
  ["extension/python/openwrangler_runtime/version.py", { key: "packagedPythonVersionFile", maxBytes: 64 * 1024 }],
  ["extension/readme.md", { key: "packagedReadme", maxBytes: README_MAX_BYTES }],
  ["extension.vsixmanifest", { key: "vsixManifest", maxBytes: 1024 * 1024 }]
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

  if (sourceVersion === undefined || !NUMERIC_RELEASE_VERSION.test(sourceVersion)) {
    problems.push("Source package.json version must use stable major.minor.patch syntax.");
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

function openVsixArchive(bytes) {
  return new Promise((resolveArchive, rejectArchive) => {
    openZipBuffer(
      bytes,
      {
        autoClose: true,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true
      },
      (error, archive) => {
        if (error) {
          rejectArchive(error);
        } else if (archive === undefined) {
          rejectArchive(new Error("Stable VSIX candidate did not open as a ZIP archive."));
        } else {
          resolveArchive(archive);
        }
      }
    );
  });
}

function readUtf8ArchiveEntry(archive, entry, maxBytes) {
  if (entry.uncompressedSize > maxBytes) {
    return Promise.reject(new Error(`Stable VSIX metadata entry ${entry.fileName} exceeds its size limit.`));
  }
  return new Promise((resolveEntry, rejectEntry) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectEntry(error);
        return;
      }
      if (stream === undefined) {
        rejectEntry(new Error(`Stable VSIX metadata entry ${entry.fileName} could not be opened.`));
        return;
      }

      const chunks = [];
      let length = 0;
      stream.on("data", (chunk) => {
        length += chunk.length;
        if (length > maxBytes) {
          stream.destroy(new Error(`Stable VSIX metadata entry ${entry.fileName} exceeds its size limit.`));
        } else {
          chunks.push(chunk);
        }
      });
      stream.once("error", rejectEntry);
      stream.once("end", () => {
        try {
          resolveEntry(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
        } catch (error) {
          rejectEntry(new Error(`Stable VSIX metadata entry ${entry.fileName} must be valid UTF-8.`, { cause: error }));
        }
      });
    });
  });
}

export async function readStableVsixPayload(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_VSIX_BYTES) {
    throw new Error("Stable VSIX snapshot must be one bounded non-empty Buffer.");
  }
  const archive = await openVsixArchive(bytes);
  return await new Promise((resolvePayload, rejectPayload) => {
    const archiveEntries = [];
    const seen = new Set();
    const values = new Map();
    let settled = false;

    const reject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        archive.close();
      } catch {
        // The original bounded archive failure remains authoritative.
      }
      rejectPayload(error);
    };

    archive.once("error", reject);
    archive.on("entry", async (entry) => {
      try {
        if (
          archiveEntries.length >= MAX_VSIX_ENTRIES ||
          Buffer.byteLength(entry.fileName, "utf8") > MAX_VSIX_ENTRY_NAME
        ) {
          throw new Error("Stable VSIX candidate exceeds its bounded archive inventory.");
        }
        if (seen.has(entry.fileName)) {
          throw new Error(`Stable VSIX candidate contains duplicate entry ${entry.fileName}.`);
        }
        seen.add(entry.fileName);
        archiveEntries.push(entry.fileName);

        const requirement = REQUIRED_VSIX_ENTRIES.get(entry.fileName);
        if (requirement !== undefined) {
          values.set(requirement.key, await readUtf8ArchiveEntry(archive, entry, requirement.maxBytes));
        }
        if (!settled) {
          archive.readEntry();
        }
      } catch (error) {
        reject(error);
      }
    });
    archive.once("end", () => {
      if (settled) {
        return;
      }
      try {
        const { forbidden, missing, duplicates } = inspectVsixEntries(archiveEntries);
        if (forbidden.length > 0 || missing.length > 0 || duplicates.length > 0) {
          throw new Error("Stable VSIX snapshot does not satisfy the production archive allowlist.");
        }
        for (const requirement of REQUIRED_VSIX_ENTRIES.values()) {
          if (!values.has(requirement.key)) {
            throw new Error(`Stable VSIX snapshot is missing required metadata ${requirement.key}.`);
          }
        }
        settled = true;
        resolvePayload({
          archiveEntries,
          packagedPackageJson: values.get("packagedPackageJson"),
          packagedPythonVersionFile: values.get("packagedPythonVersionFile"),
          packagedReadme: values.get("packagedReadme"),
          vsixManifest: values.get("vsixManifest")
        });
      } catch (error) {
        reject(error);
      }
    });
    archive.readEntry();
  });
}

function sameReceipt(path, receipt) {
  try {
    const current = lstatSync(path, { bigint: true });
    return (
      current.isFile() &&
      current.nlink === 1n &&
      sameFileIdentity(current, receipt) &&
      (receipt.size === undefined || current.size === receipt.size) &&
      (receipt.mode === undefined || (current.mode & 0o777n) === receipt.mode)
    );
  } catch {
    return false;
  }
}

function removeOwnedOutput(path, receipt) {
  if (!sameReceipt(path, receipt)) {
    throw new Error(`Refusing to clean an unverified release output: ${basename(path)}.`);
  }
  unlinkSync(path);
}

function writeExclusiveOwnedOutput(path, contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor;
  let receipt;
  let failure;
  try {
    descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      (typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid()))
    ) {
      throw new Error(`Release output ownership could not be established: ${basename(path)}.`);
    }
    receipt = { dev: opened.dev, ino: opened.ino };

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

  const vsixReceipt = writeExclusiveOwnedOutput(resolvedVsixOutput, snapshot.bytes);
  try {
    const checksumReceipt = writeExclusiveOwnedOutput(
      resolvedChecksumOutput,
      `${snapshot.sha256}  ${basename(resolvedVsixOutput)}\n`
    );
    return Object.freeze({ checksumReceipt, vsixReceipt });
  } catch (error) {
    removeOwnedOutput(resolvedVsixOutput, vsixReceipt);
    throw error;
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
  const trackedEvidencePaths = new Set(
    execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
      .split("\0")
      .filter(Boolean)
  );

  const problems = inspectStableReleaseReadiness({
    releaseTag: process.env.RELEASE_TAG,
    sourcePackageJson: readFileSync(resolve(root, "package.json"), "utf8"),
    pythonVersionFile: readFileSync(resolve(root, "python/openwrangler_runtime/version.py"), "utf8"),
    featureParity: readFileSync(resolve(root, "docs/feature-parity.md"), "utf8"),
    changelog: readFileSync(resolve(root, "CHANGELOG.md"), "utf8"),
    readme: readFileSync(resolve(root, "README.md"), "utf8"),
    packagedPackageJson: packaged.packagedPackageJson,
    packagedPythonVersionFile: packaged.packagedPythonVersionFile,
    packagedReadme: packaged.packagedReadme,
    trackedEvidencePaths,
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
