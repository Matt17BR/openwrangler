import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withPinnedCanonicalReleaseAssets } from "./canonical-release-assets.mjs";
import { parseGitHubImmutableReleaseExpectation, publishGitHubRelease } from "./github-release-publisher.mjs";
import { readReleaseNotesFromCommit } from "./release-notes.mjs";
import { verifyPinnedPreviewReleaseArtifactFromCheckout } from "./verify-preview-release-artifact.mjs";

export async function publishGitHubPreviewRelease(options) {
  return publishGitHubRelease({ ...options, channel: "preview" });
}

export async function publishVerifiedGitHubPreviewRelease({
  directory,
  expectImmutable,
  expectedCommit,
  fetchImpl,
  releaseTag,
  releaseNotes,
  repository,
  root,
  token
}) {
  return withPinnedCanonicalReleaseAssets(directory, async (pinned) => {
    const receipt = await verifyPinnedPreviewReleaseArtifactFromCheckout({
      directory,
      expectedCommit,
      pinned,
      releaseTag,
      root
    });
    const assets = pinned.assets.map(({ bytes, contentType, name }) => ({ bytes, contentType, name }));
    const result = await publishGitHubPreviewRelease({
      assets,
      beforeMutation: pinned.assertUnchanged,
      expectImmutable,
      expectedCommit: receipt.sourceCommit,
      fetchImpl,
      releaseTag: receipt.releaseTag,
      releaseNotes,
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
    throw new Error("Pass exactly one downloaded canonical preview artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const directory = resolve(process.argv[2]);
  const result = await publishVerifiedGitHubPreviewRelease({
    directory,
    expectImmutable: parseGitHubImmutableReleaseExpectation(process.env.GITHUB_IMMUTABLE_RELEASES_EXPECTED),
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    releaseNotes: readReleaseNotesFromCommit({
      commit: process.env.EXPECTED_SHA,
      root,
      version: process.env.RELEASE_TAG?.slice(1)
    }),
    repository: process.env.GITHUB_REPOSITORY,
    root,
    token: process.env.GITHUB_TOKEN
  });
  console.log(`GitHub preview ${result.releaseTag} is exact and public${result.immutable ? " (immutable)" : ""}.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
