import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CANONICAL_GITHUB_RELEASE_ASSETS,
  parseGitHubImmutableReleaseExpectation,
  publishGitHubRelease
} from "./github-release-publisher.mjs";
import { verifyPreviewReleaseArtifactFromCheckout } from "./verify-preview-release-artifact.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
    throw new Error("The checked-out preview source did not resolve to one full Git commit.");
  }
  return commit;
}

export async function publishGitHubPreviewRelease(options) {
  return publishGitHubRelease({ ...options, channel: "preview" });
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one downloaded canonical preview artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const directory = resolve(process.argv[2]);
  const receipt = await verifyPreviewReleaseArtifactFromCheckout({
    directory,
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    root
  });
  if (receipt.sourceCommit !== exactHead(root)) {
    throw new Error("The canonical preview artifact is not bound to the checked-out release source.");
  }
  const assets = CANONICAL_GITHUB_RELEASE_ASSETS.map(({ contentType, name }) =>
    Object.freeze({ bytes: readFileSync(join(directory, name)), contentType, name })
  );
  if (sha256(assets[0].bytes) !== receipt.candidateSha256 || basename(receipt.candidatePath) !== assets[0].name) {
    throw new Error("The canonical preview VSIX changed before GitHub publication.");
  }
  const result = await publishGitHubPreviewRelease({
    assets,
    expectImmutable: parseGitHubImmutableReleaseExpectation(process.env.GITHUB_IMMUTABLE_RELEASES_EXPECTED),
    expectedCommit: receipt.sourceCommit,
    releaseTag: receipt.releaseTag,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    version: receipt.version
  });
  console.log(`GitHub preview ${result.releaseTag} is exact and public${result.immutable ? " (immutable)" : ""}.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
