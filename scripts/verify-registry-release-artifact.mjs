import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectReleaseMetadata } from "./release-metadata.mjs";
import { requirePinnedCanonicalReleaseAssets, withPinnedCanonicalReleaseAssets } from "./canonical-release-assets.mjs";
import { validatePreviewReleaseProvenance } from "./run-installed-performance.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { verifyCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";
import { inspectVsixArchive } from "./vsix-archive.mjs";
import { inspectVsixPreReleaseMetadata } from "./vsix-contents.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PREVIEW_FILES = Object.freeze([
  "openwrangler.vsix",
  "openwrangler.vsix.provenance.json",
  "openwrangler.vsix.sha256"
]);
const PROVENANCE_MAX_BYTES = 4 * 1024;

function exactHead(root) {
  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true
  }).trim();
  if (!FULL_COMMIT.test(commit)) {
    throw new Error("Registry promotion automation did not resolve to one full Git commit.");
  }
  return commit;
}

function releaseCommit(root, releaseTag) {
  const commit = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `refs/tags/${releaseTag}^{commit}`],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4096,
      timeout: 10_000,
      windowsHide: true
    }
  ).trim();
  if (!FULL_COMMIT.test(commit)) {
    throw new Error("Registry promotion release tag did not resolve to one full Git commit.");
  }
  return commit;
}

function sourcePackageJson(root, commit) {
  return execFileSync("git", ["cat-file", "blob", `${commit}:package.json`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true
  });
}

const R_FRAME_CONTRACT_SOURCE = "r/openwrangler_runtime/frame_contract.R";

function releaseTreeHasRFrameContract(root, commit) {
  const output = execFileSync("git", ["ls-tree", "-z", "--full-tree", commit, "--", R_FRAME_CONTRACT_SOURCE], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true
  });
  if (output.length === 0) {
    return false;
  }
  const expected = new RegExp(
    `^100(?:644|755) blob [0-9a-f]{40}\\t${R_FRAME_CONTRACT_SOURCE.replaceAll(".", "\\.")}\\0$`,
    "u"
  );
  if (!expected.test(output)) {
    throw new Error("The selected release has an invalid R frame-contract source entry.");
  }
  return true;
}

function releaseVersionRequiresRFrameContract(version) {
  const [major, minor] = version.split(".").map(Number);
  return major >= 2 || (major === 1 && minor === 99);
}

function releaseSource(packageJson, releaseTag, prerelease) {
  const metadata = inspectReleaseMetadata({ packageJson, releaseTag });
  let manifest;
  try {
    manifest = parseStrictJson(packageJson, { maxBytes: 1024 * 1024 });
  } catch {
    throw new Error("The selected release source package.json is not bounded strict JSON.");
  }
  if (
    metadata.problems.length > 0 ||
    metadata.version === undefined ||
    metadata.prerelease !== prerelease ||
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    manifest.publisher !== "Matt17BR" ||
    manifest.name !== "openwrangler"
  ) {
    const problems = [
      ...metadata.problems,
      ...(manifest?.publisher === "Matt17BR" && manifest?.name === "openwrangler"
        ? []
        : ["The release identity must be Matt17BR.openwrangler."])
    ];
    throw new Error(`The selected release source is invalid:\n- ${problems.join("\n- ")}`);
  }
  return Object.freeze({
    extensionId: `${manifest.publisher}.${manifest.name}`,
    manifest,
    prerelease,
    version: metadata.version
  });
}

function previewDirectory(directory) {
  const requested = resolve(directory);
  const metadata = lstatSync(requested, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync.native(requested) !== requested ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("The registry release artifact directory must be canonical, owned, and non-symlinked.");
  }
  const entries = readdirSync(requested).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...PREVIEW_FILES].sort())) {
    throw new Error("A canonical pre-release directory must contain exactly its VSIX, checksum, and provenance.");
  }
  return requested;
}

export async function verifyPinnedPreviewReleaseArtifact({
  directory,
  expectedCommit,
  pinned,
  requireRFrameContract = true,
  releaseTag,
  sourcePackageJson
}) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("Preview release verification requires one full lowercase release commit.");
  }
  if (typeof releaseTag !== "string" || !RELEASE_TAG.test(releaseTag)) {
    throw new Error("Preview release verification requires one canonical numeric release tag.");
  }
  const source = releaseSource(sourcePackageJson, releaseTag, true);
  const artifactDirectory = previewDirectory(directory);
  const candidatePath = join(artifactDirectory, "openwrangler.vsix");
  const [candidateAsset, provenanceAsset, checksumAsset] = requirePinnedCanonicalReleaseAssets(
    pinned,
    artifactDirectory
  );
  const candidateSha256 = createHash("sha256").update(candidateAsset.bytes).digest("hex");
  const checksumMatch = /^([0-9a-f]{64}) {2}openwrangler\.vsix\n$/u.exec(checksumAsset.bytes.toString("utf8"));
  if (checksumMatch === null || Buffer.byteLength(checksumMatch[0], "utf8") !== checksumAsset.bytes.length) {
    throw new Error("The canonical pre-release checksum must contain exactly one lowercase SHA-256 line.");
  }
  const provenance = validatePreviewReleaseProvenance(
    parseStrictJson(provenanceAsset.bytes.toString("utf8"), { maxBytes: PROVENANCE_MAX_BYTES })
  );
  if (checksumMatch[1] !== candidateSha256) {
    throw new Error("The canonical pre-release checksum does not match its VSIX.");
  }
  if (
    provenance.extensionId !== source.extensionId ||
    provenance.extensionVersion !== source.version ||
    provenance.preview !== true ||
    provenance.releaseTag !== releaseTag ||
    provenance.sourceCommit !== expectedCommit ||
    provenance.vsixSha256 !== candidateSha256 ||
    provenance.vsixBytes !== candidateAsset.bytes.length
  ) {
    throw new Error("The canonical pre-release files do not describe one exact preview artifact.");
  }
  const archive = await inspectVsixArchive(candidateAsset.bytes, { requireRFrameContract });
  const packaged = releaseSource(archive.packagedPackageJson, releaseTag, true);
  const preReleaseProblems = inspectVsixPreReleaseMetadata(archive.packagedPackageJson, archive.vsixManifest);
  if (
    packaged.extensionId !== source.extensionId ||
    packaged.version !== source.version ||
    !isDeepStrictEqual(packaged.manifest, source.manifest) ||
    preReleaseProblems.length > 0
  ) {
    throw new Error(
      `The canonical pre-release package does not match its source or channel metadata: ${preReleaseProblems.join(" ")}`
    );
  }
  pinned.assertUnchanged();
  return Object.freeze({
    candidateBytes: candidateAsset.bytes.length,
    candidatePath,
    candidateSha256,
    extensionId: source.extensionId,
    prerelease: true,
    releaseTag,
    sourceCommit: expectedCommit,
    version: source.version
  });
}

export async function verifyPreviewReleaseArtifact(options) {
  const artifactDirectory = previewDirectory(options?.directory);
  return withPinnedCanonicalReleaseAssets(artifactDirectory, (pinned) =>
    verifyPinnedPreviewReleaseArtifact({ ...options, directory: artifactDirectory, pinned })
  );
}

export async function verifyRegistryReleaseArtifact({
  directory,
  expectedCommit,
  prerelease,
  requireRFrameContract = true,
  releaseTag,
  sourcePackageJson
}) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("Registry release verification requires one full lowercase release commit.");
  }
  if (typeof releaseTag !== "string" || !RELEASE_TAG.test(releaseTag)) {
    throw new Error("Registry release verification requires one canonical numeric release tag.");
  }
  if (typeof prerelease !== "boolean") {
    throw new Error("Registry release verification requires an explicit pre-release boolean.");
  }
  if (prerelease) {
    return verifyPreviewReleaseArtifact({
      directory,
      expectedCommit,
      releaseTag,
      requireRFrameContract,
      sourcePackageJson
    });
  }
  const stable = await verifyCanonicalReleaseArtifact({
    directory,
    expectedCommit,
    releaseTag,
    requireRFrameContract,
    sourceCommit: expectedCommit,
    sourcePackageJson
  });
  return Object.freeze({ ...stable, prerelease: false });
}

export async function verifyRegistryReleaseArtifactFromCheckout({
  automationCommit: expectedAutomationCommit,
  directory,
  expectedCommit,
  prerelease,
  releaseTag,
  root
}) {
  const canonicalRoot = realpathSync.native(resolve(root));
  const automationCommit = exactHead(canonicalRoot);
  if (!FULL_COMMIT.test(expectedAutomationCommit) || expectedAutomationCommit !== automationCommit) {
    throw new Error("Registry promotion must run from its exact validated automation commit.");
  }
  if (!RELEASE_TAG.test(releaseTag ?? "")) {
    throw new Error("Registry promotion requires one canonical numeric release tag.");
  }
  if (!FULL_COMMIT.test(expectedCommit ?? "")) {
    throw new Error("Registry promotion requires one full release commit.");
  }
  const tagCommit = releaseCommit(canonicalRoot, releaseTag);
  if (tagCommit !== expectedCommit) {
    throw new Error("The selected release tag no longer resolves to its intake commit.");
  }
  const packageJson = sourcePackageJson(canonicalRoot, tagCommit);
  const source = releaseSource(packageJson, releaseTag, prerelease);
  const requireRFrameContract = releaseTreeHasRFrameContract(canonicalRoot, tagCommit);
  if (releaseVersionRequiresRFrameContract(source.version) && !requireRFrameContract) {
    throw new Error("Open Wrangler 2 release sources must include the native R frame contract.");
  }
  const receipt = await verifyRegistryReleaseArtifact({
    directory,
    expectedCommit: tagCommit,
    prerelease,
    requireRFrameContract,
    releaseTag,
    sourcePackageJson: packageJson
  });
  return Object.freeze({ ...receipt, requireRFrameContract });
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one downloaded registry release artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const prerelease =
    process.env.RELEASE_PRERELEASE === "true" ? true : process.env.RELEASE_PRERELEASE === "false" ? false : undefined;
  const receipt = await verifyRegistryReleaseArtifactFromCheckout({
    automationCommit: process.env.AUTOMATION_SHA,
    directory: process.argv[2],
    expectedCommit: process.env.EXPECTED_SHA,
    prerelease,
    releaseTag: process.env.RELEASE_TAG,
    root
  });
  console.log(
    `Verified ${receipt.extensionId} ${receipt.version} ${receipt.prerelease ? "pre-release" : "stable"} registry artifact at ${receipt.sourceCommit}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
