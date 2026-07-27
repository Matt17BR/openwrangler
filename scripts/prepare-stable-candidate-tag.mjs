import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024,
    windowsHide: true
  });
}

function resolveCommit(root, revision, label) {
  const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).trim();
  if (!FULL_COMMIT.test(commit)) {
    throw new Error(`${label} did not resolve to one full Git commit ID.`);
  }
  return commit;
}

function localTagExists(root, releaseTag) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${releaseTag}`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    windowsHide: true
  });
  if (result.error !== undefined) {
    throw new Error("Git could not inspect the intended stable release tag.", { cause: result.error });
  }
  if (result.signal !== null || (result.status !== 0 && result.status !== 1)) {
    throw new Error("Git returned an invalid result while inspecting the intended stable release tag.");
  }
  return result.status === 0;
}

export function prepareStableCandidateTag({ expectedCommit, releaseTag, root }) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one lowercase full Git commit ID.");
  }
  if (typeof releaseTag !== "string" || !RELEASE_TAG.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be one canonical v<major>.<minor>.<patch> tag.");
  }

  const repositoryRoot = realpathSync.native(resolve(root));
  const discoveredRoot = realpathSync.native(git(repositoryRoot, ["rev-parse", "--show-toplevel"]).trim());
  if (discoveredRoot !== repositoryRoot) {
    throw new Error("Stable candidate tag preparation must run at the repository root.");
  }
  if (resolveCommit(repositoryRoot, "HEAD", "HEAD") !== expectedCommit) {
    throw new Error("Stable candidate tag preparation must run at EXPECTED_SHA.");
  }
  if (git(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
    throw new Error("Stable candidate tag preparation requires a clean tracked worktree.");
  }

  const existed = localTagExists(repositoryRoot, releaseTag);
  if (existed) {
    if (resolveCommit(repositoryRoot, releaseTag, "RELEASE_TAG") !== expectedCommit) {
      throw new Error("The existing RELEASE_TAG does not resolve to EXPECTED_SHA.");
    }
  } else {
    git(repositoryRoot, ["tag", "--no-sign", releaseTag, expectedCommit]);
  }

  if (resolveCommit(repositoryRoot, releaseTag, "RELEASE_TAG") !== expectedCommit) {
    throw new Error("The prepared RELEASE_TAG does not resolve to EXPECTED_SHA.");
  }
  if (git(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
    throw new Error("Stable candidate tag preparation changed the tracked worktree.");
  }
  return Object.freeze({ created: !existed, releaseTag, sourceCommit: expectedCommit });
}

function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const receipt = prepareStableCandidateTag({
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    root
  });
  console.log(
    `${receipt.created ? "Prepared local" : "Verified existing"} ${receipt.releaseTag} at ${receipt.sourceCommit}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
