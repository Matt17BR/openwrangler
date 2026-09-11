import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SaxesParser } from "saxes";
import { inspectChangelog, inspectPreviewRParityMatrix, inspectPrimaryParityMatrix } from "./release-documents.mjs";
import { classifyNumericReleaseVersion, NUMERIC_RELEASE_VERSION } from "./release-metadata.mjs";
import { DuplicateJsonKeyError, parseStrictJson } from "./strict-json.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";
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
const STABLE_PACKAGE_IDENTITY = Object.freeze({
  name: "openwrangler",
  displayName: "Open Wrangler",
  publisher: "Matt17BR"
});
export const PRIMARY_PARITY_SCOPE = Object.freeze([
  ["File entry points; Windows Polars JSONL excludes glob paths", "Yes", "Yes"],
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
  ["Drop missing/duplicate rows", "Yes", "Yes"],
  ["Mark duplicate groups", "Yes", "Yes"],
  ["Fill missing values", "Yes", "Yes"],
  ["One-hot and multi-label binarization", "Yes", "Yes"],
  ["Find/replace/strip/split/case transforms", "Yes", "Yes"],
  ["Scale/rank/round/floor/ceiling/datetime format", "Yes", "Yes"],
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
  ["VS Code package acceptance and compatibility seam", "N/A", "N/A"]
]);
function previewRScope(...values) {
  if (values.length !== 2 || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Every Native R preview scope entry requires one surface and availability.");
  }
  return Object.freeze(values);
}

export const R_PREVIEW_PARITY_SCOPE = Object.freeze([
  previewRScope("Native R frame paging and typed cells", "Preview"),
  previewRScope("Native R compound viewing filters", "Preview"),
  previewRScope("Native R value search and selections", "Preview"),
  previewRScope("Native R ordered viewing sorts", "Preview"),
  previewRScope("Native R column and dataset profiles", "Preview"),
  previewRScope("Base data.frame, tibble, and data.table", "Preview"),
  previewRScope("Exact IRkernel session transport", "Preview"),
  previewRScope("Exact active R-terminal transport", "Preview"),
  previewRScope("Cursor-owned .Rmd and .qmd R/Python chunk", "Preview"),
  previewRScope("Owned .R source process", "macOS and Linux Preview"),
  previewRScope("Owned .Rmd and .qmd cell process", "macOS and Linux Preview"),
  previewRScope("Notebook workbench", "Preview"),
  previewRScope("R cleaning operations and generated code", "Generated catalog"),
  previewRScope("Copy or save generated R", "Generated catalog"),
  previewRScope("Insert generated R into its IRkernel notebook", "Preview"),
  previewRScope("Insert generated R into its source .R file", "macOS and Linux Preview"),
  previewRScope("Insert generated R into .Rmd and .qmd", "macOS and Linux Preview"),
  previewRScope("Cleaned-data export", "R notebook/document CSV/Parquet"),
  previewRScope("Active R-terminal cleaned-data export", "Preview"),
  previewRScope("Quarto and R Markdown lexical R-cell run", "Preview")
]);

function numericReleaseMajor(version) {
  const match = typeof version === "string" ? NUMERIC_RELEASE_VERSION.exec(version) : null;
  return match === null ? undefined : BigInt(match.groups?.major ?? "");
}

function stableRParityProblems(featureParity, version) {
  const major = numericReleaseMajor(version);
  return major !== undefined && major >= 2n ? inspectPreviewRParityMatrix(featureParity, R_PREVIEW_PARITY_SCOPE) : [];
}

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
  packagedPackageJson,
  packagedPythonVersionFile,
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
  problems.push(...stableRParityProblems(featureParity, sourceVersion));

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

export function inspectPreviewReleaseReadiness({
  releaseTag,
  sourcePackageJson,
  pythonVersionFile,
  packagedPackageJson,
  packagedPythonVersionFile,
  vsixManifest
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
    problems.push("Source package.json version must use major.minor.patch syntax.");
  } else if (sourceVersionClassification.channel !== "preview") {
    problems.push(`Source package.json version ${sourceVersion} is not reserved for preview releases.`);
  }
  for (const [field, expected] of Object.entries(STABLE_PACKAGE_IDENTITY)) {
    if (sourceManifest?.[field] !== expected) {
      problems.push(`Source package.json ${field} must be ${JSON.stringify(expected)} for a preview release.`);
    }
  }
  if (sourceManifest?.preview !== true) {
    problems.push("Source package.json preview must be true for a preview release.");
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

  if (packagedManifest?.preview !== true) {
    problems.push("Packaged package.json preview must be true for a preview release.");
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

export function inspectPreviewRParitySource({ featureParity }) {
  return inspectPreviewRParityMatrix(featureParity, R_PREVIEW_PARITY_SCOPE);
}

export function inspectReleaseDocumentationSource({
  featureParity,
  preview,
  trackedEvidencePaths = new Set(),
  version
}) {
  const classification = classifyNumericReleaseVersion(version);
  const problems = [
    ...(classification === undefined ? ["Source version must use major.minor.patch syntax."] : []),
    ...(typeof preview === "boolean" ? [] : ['Source package.json "preview" must be an explicit boolean.']),
    ...(classification !== undefined &&
    typeof preview === "boolean" &&
    preview !== (classification.channel === "preview")
      ? [
          classification.channel === "preview"
            ? `Preview-channel version ${version} requires source package.json "preview" to be true.`
            : `Stable-channel version ${version} requires source package.json "preview" to be false.`
        ]
      : [])
  ];
  if (problems.length > 0 || classification === undefined) {
    return problems;
  }
  return classification.channel === "preview"
    ? inspectPreviewRParitySource({ featureParity })
    : [
        ...inspectPrimaryParityMatrix(featureParity, PRIMARY_PARITY_SCOPE, trackedEvidencePaths, {
          requireComplete: false
        }),
        ...stableRParityProblems(featureParity, version)
      ];
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
  const readCommitFile = (path, maxBytes, required) => {
    if (!trackedPaths.has(path)) {
      if (!required) return;
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
  };
  for (const [path, maxBytes] of RELEASE_SOURCE_FILES) {
    readCommitFile(path, maxBytes, true);
  }
  return Object.freeze({
    commit,
    files,
    trackedPaths
  });
}

export function readOwnedVsixSnapshot(vsixPath) {
  const snapshot = readBoundedVsixFileSnapshot(vsixPath, { requireOwner: true });
  return Object.freeze({
    bytes: snapshot.bytes,
    sha256: sha256(snapshot.bytes),
    sourceIdentity: snapshot.identity
  });
}

export async function readStableVsixPayload(bytes) {
  return await inspectVsixArchive(bytes);
}
