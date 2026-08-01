import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectReleaseMetadata, releaseSourcePolicyForVersion } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const EXPECTED_REMOTES = new Set([
  "https://github.com/Matt17BR/openwrangler",
  "https://github.com/Matt17BR/openwrangler.git"
]);

function git(root, arguments_, maximumBytes = 64 * 1024) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: maximumBytes,
    timeout: 30_000,
    windowsHide: true
  });
}

function canonicalSourceRoot(sourceRoot) {
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0) {
    throw new TypeError("Registry release intake requires one source checkout root.");
  }
  const root = resolve(sourceRoot);
  const metadata = lstatSync(root, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync.native(root) !== root ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("The release source checkout must be one canonical, owned, non-symlinked directory.");
  }
  const discovered = realpathSync.native(git(root, ["rev-parse", "--show-toplevel"]).trim());
  if (discovered !== root) {
    throw new Error("The release source checkout must be inspected from its repository root.");
  }
  return root;
}

export function inspectRegistryReleaseManifest({ packageJson, releaseTag }) {
  const result = inspectReleaseMetadata({ packageJson, releaseTag });
  const problems = [...result.problems];
  let manifest;
  try {
    manifest = parseStrictJson(packageJson, { maxBytes: PACKAGE_JSON_MAX_BYTES });
  } catch {
    problems.push("The release source package.json must be bounded strict JSON.");
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    manifest.publisher !== "Matt17BR" ||
    manifest.name !== "openwrangler" ||
    manifest.displayName !== "Open Wrangler"
  ) {
    problems.push("The release source must describe the canonical Matt17BR.openwrangler package identity.");
  }
  const channel = result.prerelease === true ? "preview" : result.prerelease === false ? "stable" : undefined;
  return Object.freeze({
    channel,
    manifest,
    problems: Object.freeze(problems),
    releaseTag,
    version: result.version
  });
}

export function readRegistryReleaseSource({ releaseTag, sourceRoot }) {
  const root = canonicalSourceRoot(sourceRoot);
  const commit = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!FULL_COMMIT.test(commit)) {
    throw new Error("The release source checkout did not resolve to one full lowercase Git commit.");
  }
  const tagRef = git(root, ["rev-parse", "--verify", "--end-of-options", `refs/tags/${releaseTag}`]).trim();
  const tagType = git(root, ["cat-file", "-t", `refs/tags/${releaseTag}`]).trim();
  if (tagType !== "commit" || tagRef !== commit) {
    throw new Error("The checked-out release tag must be one exact lightweight ref at the release source commit.");
  }
  if (git(root, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
    throw new Error("The release source checkout has modified tracked files.");
  }
  if (!EXPECTED_REMOTES.has(git(root, ["remote", "get-url", "origin"]).trim())) {
    throw new Error("The release source checkout does not use the canonical public GitHub origin.");
  }
  const packageJson = git(root, ["show", "--no-textconv", "--format=", "HEAD:package.json"], PACKAGE_JSON_MAX_BYTES);
  if (Buffer.byteLength(packageJson, "utf8") > PACKAGE_JSON_MAX_BYTES) {
    throw new Error("The release source package.json exceeds its byte limit.");
  }
  const inspected = inspectRegistryReleaseManifest({ packageJson, releaseTag });
  if (
    inspected.problems.length > 0 ||
    inspected.channel === undefined ||
    inspected.version === undefined ||
    inspected.manifest === undefined
  ) {
    throw new Error(`Registry release source validation failed:\n- ${inspected.problems.join("\n- ")}`);
  }
  const sourcePolicy = releaseSourcePolicyForVersion(inspected.version);
  if (sourcePolicy === undefined) {
    throw new Error("The release source version does not have a protected source-branch policy.");
  }
  const remoteSourceRef = `refs/remotes/origin/${sourcePolicy.branch}`;
  const remoteSourceCommit = git(root, ["rev-parse", "--verify", `${remoteSourceRef}^{commit}`]).trim();
  if (!FULL_COMMIT.test(remoteSourceCommit)) {
    throw new Error("The protected release source did not resolve to one full lowercase Git commit.");
  }
  try {
    git(root, ["merge-base", "--is-ancestor", commit, remoteSourceRef]);
  } catch {
    throw new Error(`The release commit is not on its version-owned protected ${sourcePolicy.branch} branch.`);
  }
  return Object.freeze({
    branch: sourcePolicy.branch,
    channel: inspected.channel,
    commit,
    packageJson,
    releaseTag,
    root,
    version: inspected.version
  });
}

function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one release source checkout root.");
  }
  const receipt = readRegistryReleaseSource({
    releaseTag: process.env.RELEASE_TAG,
    sourceRoot: process.argv[2]
  });
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required for registry release intake.");
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `release_channel=${receipt.channel}`,
      `release_branch=${receipt.branch}`,
      `release_commit=${receipt.commit}`,
      `release_prerelease=${receipt.channel === "preview" ? "true" : "false"}`,
      `release_tag=${receipt.releaseTag}`,
      `release_version=${receipt.version}`,
      ""
    ].join("\n"),
    "utf8"
  );
  console.log(`Bound ${receipt.releaseTag} (${receipt.channel}) to ${receipt.commit}.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
