import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pushExactReleaseTag } from "./release-tag-publisher.mjs";

export function pushReleaseTag(options) {
  return pushExactReleaseTag({
    ...options,
    sourceRef: "refs/remotes/origin/main"
  });
}

function runCli() {
  if (process.argv.length !== 2) {
    throw new Error("The release-tag publisher accepts no command-line arguments.");
  }
  const receipt = pushReleaseTag({
    expectedCommit: process.env.EXPECTED_SHA,
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
