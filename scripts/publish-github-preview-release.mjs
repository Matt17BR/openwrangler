import { appendFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withPinnedCanonicalReleaseAssets } from "./canonical-release-assets.mjs";
import {
  dailyPreviewReleaseNotes,
  inspectDailyPreviewSourceCommit,
  readDailyPreviewSourceChanges,
  renderDailyPreviewReleaseNotes
} from "./daily-preview-artifact.mjs";
import {
  parseGitHubImmutableReleaseExpectation,
  publishGitHubRelease,
  readPublishedPreviewRelease,
  readPreviewPullRequests
} from "./github-release-publisher.mjs";
import { classifyNumericReleaseVersion, isDailyPreviewVersion } from "./release-metadata.mjs";
import { readReleaseNotesFromCommit } from "./release-notes.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { verifyPinnedPreviewReleaseArtifactFromCheckout } from "./verify-preview-release-artifact.mjs";

export async function publishGitHubPreviewRelease(options) {
  return publishGitHubRelease({ ...options, channel: "preview" });
}

export function readPreviewReleaseNotesFromCommit({
  baseSha,
  baseTag,
  commit,
  pullRequests,
  releaseTag,
  root,
  version
}) {
  if (!isDailyPreviewVersion(version)) return readReleaseNotesFromCommit({ commit, root, version });
  if (!Array.isArray(pullRequests)) throw new Error("Daily preview notes require frozen PR attribution.");
  const source = inspectDailyPreviewSourceCommit({ commit, releaseTag, root });
  if (
    classifyNumericReleaseVersion(baseTag?.slice(1))?.channel === "stable" &&
    (baseTag !== source.stableTag || baseSha !== source.stableCommit)
  ) {
    throw new Error("The first preview's notes must use its bound stable tag and commit.");
  }
  return dailyPreviewReleaseNotes({
    baseSha,
    baseTag,
    pullRequests,
    root,
    sourceSha: source.parentCommit,
    version: source.version
  });
}

export async function prepareDailyPreviewNotesBaseline({ commit, fetchImpl, releaseTag, repository, root, token }) {
  const source = inspectDailyPreviewSourceCommit({ commit, releaseTag, root });
  const previous = await readPublishedPreviewRelease({ fetchImpl, repository, token });
  if (previous?.releaseTag === releaseTag)
    throw new Error("The daily preview is already published; its notes baseline cannot be replaced.");
  const baseTag = previous?.releaseTag ?? source.stableTag;
  const baseSha = previous?.sourceCommit ?? source.stableCommit;
  const changes = readDailyPreviewSourceChanges({
    baseTag,
    baseSha,
    root,
    sourceSha: source.parentCommit,
    version: source.version
  });
  const pullRequests = await readPreviewPullRequests({
    commits: changes.commits.map(({ commit }) => commit),
    fetchImpl,
    repository,
    token
  });
  renderDailyPreviewReleaseNotes(changes, pullRequests);
  return Object.freeze({ baseTag, baseSha, pullRequests });
}

export async function publishVerifiedGitHubPreviewRelease({
  directory,
  expectImmutable,
  expectedCommit,
  fetchImpl,
  notesBaseSha,
  notesBaseTag,
  notesPullRequests,
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
    if (isDailyPreviewVersion(receipt.version)) {
      if (releaseNotes !== undefined)
        throw new Error("Daily preview notes must come from the frozen package-job baseline.");
      if (typeof notesPullRequests !== "string") throw new Error("Daily preview notes require frozen PR attribution.");
      releaseNotes = readPreviewReleaseNotesFromCommit({
        baseSha: notesBaseSha,
        baseTag: notesBaseTag,
        commit: receipt.sourceCommit,
        pullRequests: parseStrictJson(notesPullRequests, { maxBytes: 64 * 1024 }),
        releaseTag: receipt.releaseTag,
        root,
        version: receipt.version
      });
      if (classifyNumericReleaseVersion(notesBaseTag.slice(1))?.channel === "preview") {
        const previous = await readPublishedPreviewRelease({ fetchImpl, releaseTag: notesBaseTag, repository, token });
        if (previous.sourceCommit !== notesBaseSha)
          throw new Error("The published preview baseline moved from its frozen package-job source.");
      }
    }
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
  if (process.argv[2] === "--notes-baseline") {
    const baseline = await prepareDailyPreviewNotesBaseline({
      commit: process.env.EXPECTED_SHA,
      releaseTag: process.env.RELEASE_TAG,
      repository: process.env.GITHUB_REPOSITORY,
      root,
      token: process.env.GITHUB_TOKEN
    });
    if (!process.env.GITHUB_OUTPUT) throw new Error("Daily preview notes require the package job's output file.");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `notes_base_tag=${baseline.baseTag}\nnotes_base_sha=${baseline.baseSha}\nnotes_pull_requests=${JSON.stringify(baseline.pullRequests)}\n`
    );
    return;
  }
  const directory = resolve(process.argv[2]);
  const result = await publishVerifiedGitHubPreviewRelease({
    directory,
    expectImmutable: parseGitHubImmutableReleaseExpectation(process.env.GITHUB_IMMUTABLE_RELEASES_EXPECTED),
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    notesBaseSha: process.env.NOTES_BASE_SHA,
    notesBaseTag: process.env.NOTES_BASE_TAG,
    notesPullRequests: process.env.NOTES_PULL_REQUESTS,
    releaseNotes: isDailyPreviewVersion(process.env.RELEASE_TAG?.slice(1))
      ? undefined
      : readPreviewReleaseNotesFromCommit({
          commit: process.env.EXPECTED_SHA,
          releaseTag: process.env.RELEASE_TAG,
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
