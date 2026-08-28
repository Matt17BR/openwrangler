import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectDailyPreviewSourceCommit } from "./daily-preview-artifact.mjs";
import { isDailyPreviewVersion } from "./release-metadata.mjs";
import { pushExactReleaseTag } from "./release-tag-publisher.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;

export function pushReleaseTag(options) {
  const { expectedParentCommit, ...tagOptions } = options;
  if (isDailyPreviewVersion(options.releaseTag?.slice(1))) {
    if (!FULL_SHA.test(expectedParentCommit ?? "")) {
      throw new Error("A daily preview tag requires its exact protected-main SOURCE_SHA.");
    }
    const source = inspectDailyPreviewSourceCommit({
      commit: options.expectedCommit,
      expectedParent: expectedParentCommit,
      releaseTag: options.releaseTag,
      root: options.root
    });
    return pushExactReleaseTag({
      ...tagOptions,
      expectedParentCommit: source.parentCommit,
      sourceRef: "refs/remotes/origin/main",
      sourceRelation: "direct-child"
    });
  }
  return pushExactReleaseTag({
    ...tagOptions,
    sourceRef: "refs/remotes/origin/main"
  });
}

function runCli() {
  if (process.argv.length !== 2) {
    throw new Error("The release-tag publisher accepts no command-line arguments.");
  }
  const receipt = pushReleaseTag({
    expectedCommit: process.env.EXPECTED_SHA,
    expectedParentCommit: process.env.SOURCE_SHA,
    releaseTag: process.env.RELEASE_TAG,
    repository: process.env.GITHUB_REPOSITORY,
    root: resolve(import.meta.dirname, ".."),
    token: process.env.GITHUB_TOKEN
  });
  console.log(
    `${receipt.created ? "Published" : "Verified existing"} ${receipt.releaseTag} at ${receipt.sourceCommit}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
