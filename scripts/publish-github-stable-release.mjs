import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CANONICAL_GITHUB_RELEASE_ASSETS, publishGitHubRelease } from "./github-release-publisher.mjs";
import { verifyCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function publishGitHubStableRelease(options) {
  return publishGitHubRelease({ ...options, channel: "stable" });
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

export function parseGitHubImmutableReleaseExpectation(value) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("GITHUB_IMMUTABLE_RELEASES_EXPECTED must be exactly true or false when provided.");
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one downloaded canonical artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const directory = resolve(process.argv[2]);
  const receipt = await verifyCanonicalReleaseArtifact({
    directory,
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    sourceCommit: exactHead(root),
    sourcePackageJson: readFileSync(join(root, "package.json"), "utf8")
  });
  const assets = CANONICAL_GITHUB_RELEASE_ASSETS.map(({ contentType, name }) =>
    Object.freeze({ bytes: readFileSync(join(directory, name)), contentType, name })
  );
  if (sha256(assets[0].bytes) !== receipt.candidateSha256 || basename(receipt.candidatePath) !== assets[0].name) {
    throw new Error("The canonical VSIX changed before GitHub publication.");
  }
  const result = await publishGitHubStableRelease({
    assets,
    expectImmutable: parseGitHubImmutableReleaseExpectation(process.env.GITHUB_IMMUTABLE_RELEASES_EXPECTED),
    expectedCommit: receipt.sourceCommit,
    releaseTag: receipt.releaseTag,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    version: receipt.version
  });
  console.log(`GitHub release ${result.releaseTag} is exact and public${result.immutable ? " (immutable)" : ""}.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
