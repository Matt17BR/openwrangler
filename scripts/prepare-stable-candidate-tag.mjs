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

export function inspectRemoteStableTagOutput({ expectedCommit, output, releaseTag, requirePresent = false }) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one lowercase full Git commit ID.");
  }
  if (typeof releaseTag !== "string" || !RELEASE_TAG.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be one canonical v<major>.<minor>.<patch> tag.");
  }
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 16 * 1024 || output.includes("\0")) {
    throw new Error("The remote release tag response is malformed or oversized.");
  }
  const directRef = `refs/tags/${releaseTag}`;
  const peeledRef = `${directRef}^{}`;
  const refs = new Map();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{40})\t([^\t\r\n]+)$/u);
    if (match === null || (match[2] !== directRef && match[2] !== peeledRef) || refs.has(match[2])) {
      throw new Error("The remote release tag response contains an unexpected reference.");
    }
    refs.set(match[2], match[1]);
  }
  if (refs.size === 0) {
    if (requirePresent) {
      throw new Error("The required remote RELEASE_TAG does not exist.");
    }
    return Object.freeze({ annotated: false, exists: false, releaseTag, sourceCommit: expectedCommit });
  }
  const direct = refs.get(directRef);
  const peeled = refs.get(peeledRef);
  if (
    direct === undefined ||
    (peeled === undefined && direct !== expectedCommit) ||
    (peeled !== undefined && (peeled !== expectedCommit || direct === expectedCommit))
  ) {
    throw new Error("The existing remote RELEASE_TAG does not resolve exactly to EXPECTED_SHA.");
  }
  return Object.freeze({
    annotated: peeled !== undefined,
    exists: true,
    releaseTag,
    sourceCommit: expectedCommit
  });
}

export function verifyRemoteStableTag({ expectedCommit, releaseTag, requirePresent = false, root }) {
  inspectRemoteStableTagOutput({ expectedCommit, output: "", releaseTag, requirePresent: false });
  const repositoryRoot = realpathSync.native(resolve(root));
  const discoveredRoot = realpathSync.native(git(repositoryRoot, ["rev-parse", "--show-toplevel"]).trim());
  if (discoveredRoot !== repositoryRoot || resolveCommit(repositoryRoot, "HEAD", "HEAD") !== expectedCommit) {
    throw new Error("Remote stable tag verification must run at EXPECTED_SHA in the repository root.");
  }
  const result = spawnSync("git", ["ls-remote", "origin", `refs/tags/${releaseTag}`, `refs/tags/${releaseTag}^{}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0 || result.stderr !== "") {
    throw new Error("Git could not inspect the exact remote stable release tag.", { cause: result.error });
  }
  return inspectRemoteStableTagOutput({ expectedCommit, output: result.stdout, releaseTag, requirePresent });
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
  const defaultRoot = resolve(import.meta.dirname, "..");
  if (
    (process.argv.length === 3 || process.argv.length === 4) &&
    (process.argv[2] === "--verify-remote" || process.argv[2] === "--require-remote")
  ) {
    const root = process.argv[3] === undefined ? defaultRoot : resolve(process.argv[3]);
    const receipt = verifyRemoteStableTag({
      expectedCommit: process.env.EXPECTED_SHA,
      releaseTag: process.env.RELEASE_TAG,
      requirePresent: process.argv[2] === "--require-remote",
      root
    });
    console.log(
      receipt.exists
        ? `Verified existing remote ${receipt.releaseTag} at ${receipt.sourceCommit}.`
        : `Verified remote ${receipt.releaseTag} is available for ${receipt.sourceCommit}.`
    );
    return;
  }
  if (process.argv.length !== 2) {
    throw new Error("Pass no arguments, or pass a remote-verification mode and optional repository root.");
  }
  const receipt = prepareStableCandidateTag({
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    root: defaultRoot
  });
  console.log(
    `${receipt.created ? "Prepared local" : "Verified existing"} ${receipt.releaseTag} at ${receipt.sourceCommit}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
