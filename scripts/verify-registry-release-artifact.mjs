import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectReleaseMetadata } from "./release-metadata.mjs";
import {
  readInstalledPerformanceChecksum,
  readInstalledPerformanceVsixReceipt,
  revalidateInstalledPerformanceChecksum,
  revalidateInstalledPerformanceVsix
} from "./run-installed-performance.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { verifyCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";
import { inspectVsixPreReleaseMetadata } from "./vsix-contents.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PREVIEW_FILES = Object.freeze(["openwrangler.vsix", "openwrangler.vsix.sha256"]);

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
    throw new Error("A canonical pre-release directory must contain exactly its VSIX and checksum.");
  }
  return requested;
}

async function verifyPreviewReleaseArtifact({ directory, expectedCommit, releaseTag, sourcePackageJson }) {
  const source = releaseSource(sourcePackageJson, releaseTag, true);
  const artifactDirectory = previewDirectory(directory);
  const candidatePath = join(artifactDirectory, "openwrangler.vsix");
  const candidate = readInstalledPerformanceVsixReceipt(candidatePath);
  const checksum = readInstalledPerformanceChecksum(join(artifactDirectory, "openwrangler.vsix.sha256"), candidatePath);
  if (checksum.candidateSha256 !== candidate.sha256) {
    throw new Error("The canonical pre-release checksum does not match its VSIX.");
  }
  const snapshot = readBoundedVsixFileSnapshot(candidatePath, { requireOwner: true });
  if (
    snapshot.bytes.length !== candidate.bytes ||
    createHash("sha256").update(snapshot.bytes).digest("hex") !== candidate.sha256
  ) {
    throw new Error("The canonical pre-release VSIX changed before packaged metadata verification.");
  }
  const archive = await inspectVsixArchive(snapshot.bytes);
  const packaged = releaseSource(archive.packagedPackageJson, releaseTag, true);
  const preReleaseProblems = inspectVsixPreReleaseMetadata(archive.packagedPackageJson, archive.vsixManifest);
  if (
    packaged.extensionId !== source.extensionId ||
    packaged.version !== source.version ||
    preReleaseProblems.length > 0
  ) {
    throw new Error(
      `The canonical pre-release package does not match its source or channel metadata: ${preReleaseProblems.join(" ")}`
    );
  }
  revalidateInstalledPerformanceVsix(candidate);
  revalidateInstalledPerformanceChecksum(checksum, candidatePath);
  return Object.freeze({
    candidateBytes: candidate.bytes,
    candidatePath,
    candidateSha256: candidate.sha256,
    extensionId: source.extensionId,
    prerelease: true,
    releaseTag,
    sourceCommit: expectedCommit,
    version: source.version
  });
}

export async function verifyRegistryReleaseArtifact({
  directory,
  expectedCommit,
  prerelease,
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
    return verifyPreviewReleaseArtifact({ directory, expectedCommit, releaseTag, sourcePackageJson });
  }
  const stable = await verifyCanonicalReleaseArtifact({
    directory,
    expectedCommit,
    releaseTag,
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
  return verifyRegistryReleaseArtifact({
    directory,
    expectedCommit: tagCommit,
    prerelease,
    releaseTag,
    sourcePackageJson: sourcePackageJson(canonicalRoot, tagCommit)
  });
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
