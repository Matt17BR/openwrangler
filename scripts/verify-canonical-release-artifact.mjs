import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readInstalledPerformanceChecksum,
  readInstalledPerformanceProvenance,
  readInstalledPerformanceVsixReceipt,
  revalidateInstalledPerformanceChecksum,
  revalidateInstalledPerformanceProvenance,
  revalidateInstalledPerformanceVsix
} from "./run-installed-performance.mjs";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

const CANONICAL_FILES = Object.freeze([
  "openwrangler.vsix",
  "openwrangler.vsix.provenance.json",
  "openwrangler.vsix.sha256"
]);
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;

function canonicalArtifactDirectory(directory) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("Canonical release verification requires one artifact directory.");
  }
  const requested = resolve(directory);
  const metadata = lstatSync(requested, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync.native(requested) !== requested ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("The canonical release artifact directory must be canonical, owned, and non-symlinked.");
  }
  const entries = readdirSync(requested).sort();
  if (entries.length !== CANONICAL_FILES.length || entries.some((entry, index) => entry !== CANONICAL_FILES[index])) {
    throw new Error("The canonical release artifact directory must contain exactly the canonical three files.");
  }
  return requested;
}

function validateSourceManifest(sourcePackageJson) {
  const manifest = parseStrictJson(sourcePackageJson, { maxBytes: PACKAGE_JSON_MAX_BYTES });
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    manifest.publisher !== "Matt17BR" ||
    manifest.name !== "openwrangler" ||
    typeof manifest.version !== "string" ||
    classifyNumericReleaseVersion(manifest.version)?.channel !== "stable" ||
    manifest.version.startsWith("0.") ||
    manifest.preview !== false
  ) {
    throw new Error("The checked-out source must describe stable Matt17BR.openwrangler 1.0.0 or newer.");
  }
  return Object.freeze({
    extensionId: `${manifest.publisher}.${manifest.name}`,
    preview: manifest.preview,
    version: manifest.version
  });
}

function exactHead(root) {
  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true
  }).trim();
  if (!FULL_COMMIT.test(commit)) {
    throw new Error("The checked-out release source did not resolve to one full Git commit.");
  }
  return commit;
}

export async function verifyCanonicalReleaseArtifact({
  directory,
  expectedCommit,
  releaseTag,
  sourceCommit,
  sourcePackageJson
}) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full lowercase hexadecimal Git commit ID.");
  }
  if (typeof releaseTag !== "string" || !STABLE_TAG.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be one canonical stable vmajor.minor.patch tag.");
  }
  if (sourceCommit !== expectedCommit) {
    throw new Error("The canonical release artifact must be verified from the exact event commit.");
  }
  const source = validateSourceManifest(sourcePackageJson);
  if (releaseTag !== `v${source.version}`) {
    throw new Error("RELEASE_TAG must exactly match the checked-out stable package version.");
  }

  const artifactDirectory = canonicalArtifactDirectory(directory);
  const candidatePath = join(artifactDirectory, "openwrangler.vsix");
  const checksumPath = join(artifactDirectory, "openwrangler.vsix.sha256");
  const provenancePath = join(artifactDirectory, "openwrangler.vsix.provenance.json");
  const candidate = readInstalledPerformanceVsixReceipt(candidatePath);
  const checksum = readInstalledPerformanceChecksum(checksumPath, candidatePath);
  const provenance = readInstalledPerformanceProvenance(provenancePath);

  if (
    checksum.candidateSha256 !== candidate.sha256 ||
    provenance.extensionId !== source.extensionId ||
    provenance.extensionVersion !== source.version ||
    provenance.preview !== source.preview ||
    provenance.releaseTag !== releaseTag ||
    provenance.sourceCommit !== expectedCommit ||
    provenance.vsixSha256 !== candidate.sha256 ||
    provenance.vsixBytes !== candidate.bytes
  ) {
    throw new Error("The canonical release files do not describe one exact stable artifact.");
  }

  const archiveSnapshot = readBoundedVsixFileSnapshot(candidatePath, { requireOwner: true });
  if (
    archiveSnapshot.bytes.length !== candidate.bytes ||
    createHash("sha256").update(archiveSnapshot.bytes).digest("hex") !== candidate.sha256
  ) {
    throw new Error("The canonical release VSIX changed before packaged metadata verification.");
  }
  const archive = await inspectVsixArchive(archiveSnapshot.bytes);
  const packaged = validateSourceManifest(archive.packagedPackageJson);
  if (
    packaged.extensionId !== source.extensionId ||
    packaged.version !== source.version ||
    packaged.preview !== source.preview
  ) {
    throw new Error("The packaged extension identity or stable version does not match its checked-out source.");
  }

  revalidateInstalledPerformanceVsix(candidate);
  revalidateInstalledPerformanceChecksum(checksum, candidatePath);
  revalidateInstalledPerformanceProvenance(provenance);
  return Object.freeze({
    candidateBytes: candidate.bytes,
    candidatePath,
    candidateSha256: candidate.sha256,
    extensionId: source.extensionId,
    releaseTag,
    sourceCommit: expectedCommit,
    version: source.version
  });
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one downloaded canonical artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const receipt = await verifyCanonicalReleaseArtifact({
    directory: process.argv[2],
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    sourceCommit: exactHead(root),
    sourcePackageJson: readFileSync(join(root, "package.json"), "utf8")
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `candidate_path=${receipt.candidatePath}`,
        `candidate_sha256=${receipt.candidateSha256}`,
        `candidate_bytes=${receipt.candidateBytes}`,
        `extension_version=${receipt.version}`,
        `release_tag=${receipt.releaseTag}`,
        ""
      ].join("\n"),
      "utf8"
    );
  }
  console.log(
    `Verified ${receipt.extensionId} ${receipt.version} canonical release artifact at ${receipt.sourceCommit}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
