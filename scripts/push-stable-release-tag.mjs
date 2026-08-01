import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pushExactReleaseTag } from "./release-tag-publisher.mjs";
import { classifyNumericReleaseVersion, releaseSourcePolicyForVersion } from "./release-metadata.mjs";

function stableSourceRef(releaseTag) {
  const version = typeof releaseTag === "string" && releaseTag.startsWith("v") ? releaseTag.slice(1) : undefined;
  const classification = classifyNumericReleaseVersion(version);
  const policy = releaseSourcePolicyForVersion(version);
  if (classification?.channel !== "stable" || policy === undefined) {
    throw new Error("The stable-tag publisher requires one canonical stable release version.");
  }
  return `refs/remotes/origin/${policy.branch}`;
}

export function pushStableReleaseTag(options) {
  return pushExactReleaseTag({
    ...options,
    sourceRef: stableSourceRef(options?.releaseTag)
  });
}

function runCli() {
  if (process.argv.length !== 2) {
    throw new Error("The stable-tag publisher accepts no command-line arguments.");
  }
  const receipt = pushStableReleaseTag({
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
