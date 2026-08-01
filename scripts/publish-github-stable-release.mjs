import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withPinnedCanonicalReleaseAssets } from "./canonical-release-assets.mjs";
import { parseGitHubImmutableReleaseExpectation, publishGitHubRelease } from "./github-release-publisher.mjs";
import { verifyPinnedCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;

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

export { parseGitHubImmutableReleaseExpectation } from "./github-release-publisher.mjs";

export async function publishVerifiedGitHubStableRelease({
  directory,
  expectImmutable,
  expectedCommit,
  fetchImpl,
  releaseTag,
  repository,
  sourceCommit,
  sourcePackageJson,
  token
}) {
  return withPinnedCanonicalReleaseAssets(directory, async (pinned) => {
    const receipt = await verifyPinnedCanonicalReleaseArtifact({
      directory,
      expectedCommit,
      pinned,
      releaseTag,
      sourceCommit,
      sourcePackageJson
    });
    const assets = pinned.assets.map(({ bytes, contentType, name }) => ({ bytes, contentType, name }));
    const result = await publishGitHubStableRelease({
      assets,
      beforeMutation: pinned.assertUnchanged,
      expectImmutable,
      expectedCommit: receipt.sourceCommit,
      fetchImpl,
      releaseTag: receipt.releaseTag,
      repository,
      token,
      version: receipt.version
    });
    pinned.assertUnchanged();
    return result;
  });
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one downloaded canonical artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const directory = resolve(process.argv[2]);
  const result = await publishVerifiedGitHubStableRelease({
    directory,
    expectImmutable: parseGitHubImmutableReleaseExpectation(process.env.GITHUB_IMMUTABLE_RELEASES_EXPECTED),
    expectedCommit: process.env.EXPECTED_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    releaseTag: process.env.RELEASE_TAG,
    sourceCommit: exactHead(root),
    sourcePackageJson: readFileSync(join(root, "package.json"), "utf8"),
    token: process.env.GITHUB_TOKEN
  });
  console.log(`GitHub release ${result.releaseTag} is exact and public${result.immutable ? " (immutable)" : ""}.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
