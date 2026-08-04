import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requirePinnedCanonicalReleaseAssets, withPinnedCanonicalReleaseAssets } from "./canonical-release-assets.mjs";
import { validateInstalledPerformanceProvenance } from "./run-installed-performance.mjs";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { inspectVsixArchive } from "./vsix-archive.mjs";

const CANONICAL_FILES = Object.freeze([
  "openwrangler.vsix",
  "openwrangler.vsix.provenance.json",
  "openwrangler.vsix.sha256"
]);
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const PROVENANCE_MAX_BYTES = 4 * 1024;

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

export async function verifyPinnedCanonicalReleaseArtifact({
  directory,
  expectedCommit,
  pinned,
  requireRFrameContract = true,
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
  const [candidateAsset, provenanceAsset, checksumAsset] = requirePinnedCanonicalReleaseAssets(
    pinned,
    artifactDirectory
  );
  const candidateSha256 = createHash("sha256").update(candidateAsset.bytes).digest("hex");
  const checksumMatch = /^([0-9a-f]{64}) {2}openwrangler\.vsix\n$/u.exec(checksumAsset.bytes.toString("utf8"));
  if (checksumMatch === null || Buffer.byteLength(checksumMatch[0], "utf8") !== checksumAsset.bytes.length) {
    throw new Error("The canonical release checksum must contain exactly one lowercase SHA-256 line.");
  }
  const provenance = validateInstalledPerformanceProvenance(
    parseStrictJson(provenanceAsset.bytes.toString("utf8"), { maxBytes: PROVENANCE_MAX_BYTES })
  );

  if (
    checksumMatch[1] !== candidateSha256 ||
    provenance.extensionId !== source.extensionId ||
    provenance.extensionVersion !== source.version ||
    provenance.preview !== source.preview ||
    provenance.releaseTag !== releaseTag ||
    provenance.sourceCommit !== expectedCommit ||
    provenance.vsixSha256 !== candidateSha256 ||
    provenance.vsixBytes !== candidateAsset.bytes.length
  ) {
    throw new Error("The canonical release files do not describe one exact stable artifact.");
  }

  const archive = await inspectVsixArchive(candidateAsset.bytes, { requireRFrameContract });
  const packaged = validateSourceManifest(archive.packagedPackageJson);
  if (
    packaged.extensionId !== source.extensionId ||
    packaged.version !== source.version ||
    packaged.preview !== source.preview
  ) {
    throw new Error("The packaged extension identity or stable version does not match its checked-out source.");
  }

  pinned.assertUnchanged();
  return Object.freeze({
    candidateBytes: candidateAsset.bytes.length,
    candidatePath,
    candidateSha256,
    extensionId: source.extensionId,
    releaseTag,
    sourceCommit: expectedCommit,
    version: source.version
  });
}

export async function verifyCanonicalReleaseArtifact(options) {
  const artifactDirectory = canonicalArtifactDirectory(options?.directory);
  return withPinnedCanonicalReleaseAssets(artifactDirectory, (pinned) =>
    verifyPinnedCanonicalReleaseArtifact({ ...options, directory: artifactDirectory, pinned })
  );
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
