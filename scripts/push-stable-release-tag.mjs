import { spawnSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectRemoteStableTagOutput } from "./prepare-stable-candidate-tag.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const EXPECTED_REPOSITORY = "Matt17BR/openwrangler";
const REMOTE_URL = `https://github.com/${EXPECTED_REPOSITORY}.git`;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const GIT_OUTPUT_MAX_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const PACKAGE_JSON_MAX_BYTES = 2 * 1024 * 1024;
const TOKEN_MAX_BYTES = 4096;

function defaultGitRunner({ args, cwd, env, timeoutMs }) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true
  });
}

function git(root, args, label, gitRunner, { env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const result = gitRunner({ args, cwd: root, env, timeoutMs });
  if (
    result === null ||
    typeof result !== "object" ||
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    Buffer.byteLength(result.stdout, "utf8") > GIT_OUTPUT_MAX_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > GIT_OUTPUT_MAX_BYTES
  ) {
    throw new Error(`Git could not ${label}.`, { cause: result?.error });
  }
  return result.stdout;
}

function resolveCommit(root, revision, label, gitRunner) {
  const commit = git(
    root,
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    `resolve ${label}`,
    gitRunner
  ).trim();
  if (!FULL_COMMIT.test(commit)) {
    throw new Error(`${label} did not resolve to one lowercase full Git commit ID.`);
  }
  return commit;
}

function validateToken(token) {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    Buffer.byteLength(token, "utf8") > TOKEN_MAX_BYTES ||
    [...token].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint <= 0x20 || codePoint >= 0x7f;
    })
  ) {
    throw new Error("GITHUB_TOKEN must be one bounded printable-ASCII token.");
  }
}

function readVersion(root) {
  const packageJsonPath = join(root, "package.json");
  const source = readFileSync(packageJsonPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > PACKAGE_JSON_MAX_BYTES) {
    throw new Error("package.json exceeds the stable-tag publication bound.");
  }
  const manifest = parseStrictJson(source, { maxBytes: PACKAGE_JSON_MAX_BYTES });
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.version !== "string" ||
    !STABLE_VERSION.test(manifest.version)
  ) {
    throw new Error("package.json must contain one canonical stable version.");
  }
  return manifest.version;
}

function inspectRemoteTag({ expectedCommit, gitRunner, releaseTag, root }) {
  const stdout = git(
    root,
    ["ls-remote", REMOTE_URL, `refs/tags/${releaseTag}`, `refs/tags/${releaseTag}^{}`],
    "inspect the exact public stable tag",
    gitRunner
  );
  const receipt = inspectRemoteStableTagOutput({
    expectedCommit,
    output: stdout,
    releaseTag,
    requirePresent: false
  });
  if (receipt.annotated) {
    throw new Error("The stable release tag must be an exact lightweight tag, not an annotated tag.");
  }
  return receipt;
}

function createCredentialLease(token) {
  const root = mkdtempSync(join(tmpdir(), "ow-stable-tag-"));
  // Windows stat modes do not represent inherited ACLs. Keep exact modes as a
  // POSIX invariant while relying on exclusive creation and file identities on Windows.
  const enforcePosixModes = process.platform !== "win32";
  if (enforcePosixModes) chmodSync(root, 0o700);
  const rootStat = lstatSync(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (enforcePosixModes && (rootStat.mode & 0o777) !== 0o700)
  ) {
    throw new Error("The private Git credential directory is invalid.");
  }
  const path = join(root, "credentials");
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    if (enforcePosixModes) fchmodSync(descriptor, 0o600);
    const value = `https://x-access-token:${encodeURIComponent(token)}@github.com\n`;
    if (Buffer.byteLength(value, "utf8") > TOKEN_MAX_BYTES * 3 + 64) {
      throw new Error("The encoded Git credential exceeds its bound.");
    }
    writeSync(descriptor, value, undefined, "utf8");
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (enforcePosixModes && (stat.mode & 0o777) !== 0o600)) {
      throw new Error("The private Git credential file is invalid.");
    }
    return Object.freeze({
      descriptor,
      identity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
      path,
      root,
      rootIdentity: Object.freeze({ dev: rootStat.dev, ino: rootStat.ino })
    });
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        ftruncateSync(descriptor, 0);
        closeSync(descriptor);
      } catch {
        // The original error remains authoritative during incomplete setup.
      }
    }
    try {
      const current = lstatSync(path);
      if (current.isFile() && !current.isSymbolicLink()) unlinkSync(path);
    } catch {
      // The original setup error remains authoritative.
    }
    try {
      rmdirSync(root);
    } catch {
      // The original setup error remains authoritative.
    }
    throw error;
  }
}

function closeCredentialLease(lease) {
  const cleanupErrors = [];
  try {
    ftruncateSync(lease.descriptor, 0);
    fsyncSync(lease.descriptor);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    closeSync(lease.descriptor);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    const current = lstatSync(lease.path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== lease.identity.dev ||
      current.ino !== lease.identity.ino
    ) {
      throw new Error("The private Git credential path changed before cleanup.");
    }
    unlinkSync(lease.path);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    const rootStat = lstatSync(lease.root);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      rootStat.dev !== lease.rootIdentity.dev ||
      rootStat.ino !== lease.rootIdentity.ino
    ) {
      throw new Error("The private Git credential directory changed before cleanup.");
    }
    rmdirSync(lease.root);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "The private Git credential could not be cleaned safely.");
  }
}

function pushTag({ expectedCommit, gitRunner, releaseTag, root, token }) {
  const lease = createCredentialLease(token);
  let pushError;
  try {
    const helper = `credential.helper=store --file=${lease.path}`;
    const refspec = `${expectedCommit}:refs/tags/${releaseTag}`;
    const args = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      helper,
      "push",
      "--atomic",
      "--porcelain",
      REMOTE_URL,
      refspec
    ];
    const env = {
      ...process.env,
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "/bin/false",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: "/bin/false"
    };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    git(root, args, "atomically push the one exact stable tag", gitRunner, { env });
  } catch (error) {
    pushError = error;
  }
  try {
    closeCredentialLease(lease);
  } catch (cleanupError) {
    if (pushError !== undefined) {
      throw new AggregateError([pushError, cleanupError], "Stable-tag push and credential cleanup both failed.");
    }
    throw cleanupError;
  }
  if (pushError !== undefined) throw pushError;
}

function assertRepositoryState({ expectedCommit, gitRunner, root }) {
  const discoveredRoot = realpathSync.native(
    git(root, ["rev-parse", "--show-toplevel"], "find the repository root", gitRunner).trim()
  );
  if (discoveredRoot !== root) {
    throw new Error("Stable-tag publication must run at the repository root.");
  }
  if (resolveCommit(root, "HEAD", "HEAD", gitRunner) !== expectedCommit) {
    throw new Error("Stable-tag publication must run at EXPECTED_SHA.");
  }
  if (resolveCommit(root, "refs/remotes/origin/main", "origin/main", gitRunner) !== expectedCommit) {
    throw new Error("Stable-tag publication requires EXPECTED_SHA to be the checked-out origin/main.");
  }
  if (
    git(
      root,
      ["status", "--porcelain=v1", "--untracked-files=no"],
      "inspect the tracked worktree",
      gitRunner
    ).trim() !== ""
  ) {
    throw new Error("Stable-tag publication requires a clean tracked worktree.");
  }
}

export function pushStableReleaseTag({
  expectedCommit,
  gitRunner = defaultGitRunner,
  releaseTag,
  repository,
  root,
  token
}) {
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error(`Stable-tag publication is restricted to ${EXPECTED_REPOSITORY}.`);
  }
  if (typeof expectedCommit !== "string" || !FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one lowercase full Git commit ID.");
  }
  validateToken(token);
  const repositoryRoot = realpathSync.native(resolve(root));
  const version = readVersion(repositoryRoot);
  if (releaseTag !== `v${version}`) {
    throw new Error("RELEASE_TAG must exactly equal v<package.json version>.");
  }
  assertRepositoryState({ expectedCommit, gitRunner, root: repositoryRoot });

  const before = inspectRemoteTag({ expectedCommit, gitRunner, releaseTag, root: repositoryRoot });
  if (before.exists) {
    assertRepositoryState({ expectedCommit, gitRunner, root: repositoryRoot });
    return Object.freeze({ created: false, releaseTag, sourceCommit: expectedCommit });
  }

  pushTag({ expectedCommit, gitRunner, releaseTag, root: repositoryRoot, token });
  const after = inspectRemoteTag({ expectedCommit, gitRunner, releaseTag, root: repositoryRoot });
  if (!after.exists) {
    throw new Error("The exact stable release tag was not visible after its Git push completed.");
  }
  assertRepositoryState({ expectedCommit, gitRunner, root: repositoryRoot });
  return Object.freeze({ created: true, releaseTag, sourceCommit: expectedCommit });
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
