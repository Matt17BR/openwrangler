import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  verifyPinnedPreviewReleaseArtifact,
  verifyPreviewReleaseArtifact
} from "./verify-registry-release-artifact.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;

function git(root, arguments_, maxBuffer = 4096) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer,
    timeout: 10_000,
    windowsHide: true
  });
}

function canonicalRepositoryRoot(root) {
  const requested = resolve(root);
  const canonical = realpathSync.native(requested);
  const metadata = lstatSync(requested);
  if (canonical !== requested || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Preview release verification requires one canonical repository directory.");
  }
  const topLevel = realpathSync.native(resolve(git(canonical, ["rev-parse", "--show-toplevel"]).trim()));
  if (topLevel !== canonical) {
    throw new Error("Preview release verification must run from the exact Git repository root.");
  }
  return canonical;
}

export async function verifyPreviewReleaseArtifactFromCheckout({ directory, expectedCommit, releaseTag, root }) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full lowercase hexadecimal Git commit ID.");
  }
  const canonicalRoot = canonicalRepositoryRoot(root);
  const head = git(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (head !== expectedCommit) {
    throw new Error("Preview release verification must run from the exact candidate commit.");
  }
  const sourcePackageJson = git(canonicalRoot, ["cat-file", "blob", `${expectedCommit}:package.json`], 1024 * 1024);
  return verifyPreviewReleaseArtifact({
    directory,
    expectedCommit,
    releaseTag,
    sourcePackageJson
  });
}

export async function verifyPinnedPreviewReleaseArtifactFromCheckout({
  directory,
  expectedCommit,
  pinned,
  releaseTag,
  root
}) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full lowercase hexadecimal Git commit ID.");
  }
  const canonicalRoot = canonicalRepositoryRoot(root);
  const head = git(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (head !== expectedCommit) {
    throw new Error("Preview release verification must run from the exact candidate commit.");
  }
  const sourcePackageJson = git(canonicalRoot, ["cat-file", "blob", `${expectedCommit}:package.json`], 1024 * 1024);
  return verifyPinnedPreviewReleaseArtifact({
    directory,
    expectedCommit,
    pinned,
    releaseTag,
    sourcePackageJson
  });
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one canonical preview artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const receipt = await verifyPreviewReleaseArtifactFromCheckout({
    directory: process.argv[2],
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    root
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `candidate_path=${receipt.candidatePath}`,
        `candidate_sha256=${receipt.candidateSha256}`,
        `candidate_bytes=${receipt.candidateBytes}`,
        `extension_version=${receipt.version}`,
        `release_tag=${receipt.releaseTag}`,
        ""
      ].join("\n"),
      "utf8"
    );
  }
  console.log(
    `Verified ${receipt.extensionId} ${receipt.version} canonical preview artifact at ${receipt.sourceCommit}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
