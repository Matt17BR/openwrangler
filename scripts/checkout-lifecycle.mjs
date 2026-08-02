import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const ENTRY_PROTOCOL = "openwrangler-managed-checkout-v2";
const LOCK_PROTOCOL = "openwrangler-checkout-operation-lock-v2";
const LOCK_RELEASE_PROTOCOL = "openwrangler-checkout-operation-lock-release-v2";
const RECEIPT_PROTOCOL = "openwrangler-checkout-receipt-v2";
const CLEANUP_REQUEST_PROTOCOL = "openwrangler-cleanup-request-v2";
const RETIREMENT_PLAN_PROTOCOL = "openwrangler-retirement-plan-v1";
const RETIREMENT_CHECKS_PROTOCOL = "openwrangler-retirement-deferred-checks-v1";
const MAXIMUM_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAXIMUM_ENTRY_BYTES = 64 * 1024;
const MAXIMUM_LOCK_BYTES = 2048;
const MAXIMUM_ENTRIES = 256;
const MAXIMUM_REGISTRY_FILES = 4096;
const MAXIMUM_ENTRY_GENERATIONS = 1024;
const MAXIMUM_LOCK_FILES = 32_768;
const MAXIMUM_LOCK_GENERATIONS = 16_384;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const MAXIMUM_GENERATED_ROOTS = 16;
const MAXIMUM_WORKTREE_RECORDS = 4096;
const MAXIMUM_WORKTREE_FIELDS = 16;
const MAXIMUM_WORKTREE_FIELD_BYTES = 8192;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const REMOTE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;
const GENERATED_ROOT_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,80}$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const IDENTITY_PATTERN = /^(?:0|[1-9][0-9]{0,39})$/u;
const ENTRY_FILE_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})\.json$/u;
const LOCK_FILE_PATTERN = /^([1-9][0-9]{0,8})\.(claim|release)\.json$/u;

export class CheckoutLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CheckoutLifecycleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CheckoutLifecycleError(code, message);
}

function randomToken() {
  return randomBytes(16).toString("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function currentUserOwns(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function identityOf(metadata) {
  return Object.freeze({ device: metadata.dev.toString(), inode: metadata.ino.toString() });
}

function sameIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    fail("invalid-registry", `${label} has unknown or missing fields.`);
  }
}

function boundedPrintable(value, maximum, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    fail("invalid-registry", `${label} must be one bounded printable string.`);
  }
  return value;
}

function validateIdentity(value, label) {
  exactKeys(value, ["device", "inode"], label);
  if (!IDENTITY_PATTERN.test(value.device) || !IDENTITY_PATTERN.test(value.inode)) {
    fail("invalid-registry", `${label} is malformed.`);
  }
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32" || !["EINVAL", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertPrivateDirectory(path, label) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (typeof process.getuid === "function" && (metadata.mode & 0o777n) !== 0o700n) ||
    realpathSync(path) !== resolve(path)
  ) {
    fail("unsafe-manager", `${label} must be a current-user-owned, canonical mode-0700 directory.`);
  }
  return identityOf(metadata);
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    fsyncDirectory(dirname(path));
  }
  return assertPrivateDirectory(path, path);
}

function readBoundedFile(path, maximumBytes, label, privateMode = undefined) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !currentUserOwns(before) ||
      before.size > BigInt(maximumBytes) ||
      (privateMode !== undefined && typeof process.getuid === "function" && (before.mode & 0o777n) !== privateMode)
    ) {
      fail("unsafe-registry", `${label} is not one bounded owned file.`);
    }
    const buffer = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) fail("registry-changed", `${label} changed while it was read.`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identityOf(before), identityOf(after)) || before.size !== after.size) {
      fail("registry-changed", `${label} changed while it was read.`);
    }
    return Object.freeze({
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      identity: identityOf(before)
    });
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("unsafe-registry", `${label} could not be read safely: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function rejectDuplicateJsonKeys(text, label) {
  let offset = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const stringToken = () => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
      } else if (text[offset] === '"') {
        offset += 1;
        return text.slice(start, offset);
      } else offset += 1;
    }
    fail("invalid-registry", `${label} contains an unterminated string.`);
  };
  const value = (depth) => {
    nodes += 1;
    if (nodes > MAXIMUM_JSON_NODES || depth > MAXIMUM_JSON_DEPTH) {
      fail("invalid-registry", `${label} exceeds the JSON structure limit.`);
    }
    whitespace();
    if (text[offset] === "{") object(depth);
    else if (text[offset] === "[") array(depth);
    else if (text[offset] === '"') stringToken();
    else {
      const start = offset;
      while (offset < text.length && !/[\s,}\]]/u.test(text[offset])) offset += 1;
      if (start === offset) fail("invalid-registry", `${label} contains invalid JSON syntax.`);
    }
    whitespace();
  };
  const object = (depth) => {
    const keys = new Set();
    offset += 1;
    whitespace();
    if (text[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < text.length) {
      if (text[offset] !== '"') fail("invalid-registry", `${label} contains an invalid object key.`);
      let key;
      try {
        key = JSON.parse(stringToken());
      } catch {
        fail("invalid-registry", `${label} contains an invalid object key.`);
      }
      if (keys.has(key)) fail("duplicate-json-key", `${label} contains duplicate key ${JSON.stringify(key)}.`);
      keys.add(key);
      whitespace();
      if (text[offset] !== ":") fail("invalid-registry", `${label} contains invalid object syntax.`);
      offset += 1;
      value(depth + 1);
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      if (text[offset] !== ",") fail("invalid-registry", `${label} contains invalid object syntax.`);
      offset += 1;
      whitespace();
    }
    fail("invalid-registry", `${label} contains an unterminated object.`);
  };
  const array = (depth) => {
    offset += 1;
    whitespace();
    if (text[offset] === "]") {
      offset += 1;
      return;
    }
    while (offset < text.length) {
      value(depth + 1);
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      if (text[offset] !== ",") fail("invalid-registry", `${label} contains invalid array syntax.`);
      offset += 1;
    }
    fail("invalid-registry", `${label} contains an unterminated array.`);
  };
  whitespace();
  value(0);
  if (offset !== text.length) fail("invalid-registry", `${label} contains trailing JSON content.`);
}

function readJson(path, maximumBytes, label, privateMode = 0o600n) {
  const file = readBoundedFile(path, maximumBytes, label, privateMode);
  try {
    rejectDuplicateJsonKeys(file.text, label);
    return Object.freeze({ value: JSON.parse(file.text), identity: file.identity });
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("invalid-registry", `${label} is not valid JSON: ${error.message}`);
  }
}

function revalidatePathIdentity(path, expected, label, kind = "file") {
  const metadata = lstatSync(path, { bigint: true });
  const expectedKind = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (
    !expectedKind ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    !sameIdentity(identityOf(metadata), expected)
  ) {
    fail("registry-changed", `${label} changed filesystem identity.`);
  }
}

function writeJsonExclusive(path, value, expectedParentIdentity = undefined) {
  const parent = dirname(path);
  assertPrivateDirectory(parent, parent);
  if (expectedParentIdentity !== undefined) {
    revalidatePathIdentity(parent, expectedParentIdentity, parent, "directory");
  }
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    flush: true,
    mode: 0o600
  });
  fsyncDirectory(parent);
  if (expectedParentIdentity !== undefined) {
    revalidatePathIdentity(parent, expectedParentIdentity, parent, "directory");
  }
}

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error !== undefined) fail("command-failed", `${command} could not start: ${result.error.message}`);
  const normalized = Object.freeze({ status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  if (!options.allowFailure && normalized.status !== 0) {
    fail("command-failed", `${command} failed: ${normalized.stderr.trim() || `exit ${normalized.status}`}`);
  }
  return normalized;
}

function discoverRepository(run, cwd) {
  const topLevel = resolve(run("git", ["rev-parse", "--show-toplevel"], { cwd }).stdout.trim());
  const commonGitDirectory = realpathSync(
    run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }).stdout.trim()
  );
  const metadata = lstatSync(commonGitDirectory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !currentUserOwns(metadata)) {
    fail("unsafe-repository", "The Git common directory is not a current-user-owned directory.");
  }
  return Object.freeze({ topLevel, commonGitDirectory, identity: identityOf(metadata) });
}

function commonGit(run, paths, repository, args, options = {}) {
  return run("git", ["--git-dir", repository.commonGitDirectory, ...args], {
    cwd: paths.root,
    allowFailure: options.allowFailure,
    env: options.env
  });
}

function checkoutGit(run, paths, checkoutPath, args, options = {}) {
  return run("git", ["-C", checkoutPath, ...args], { cwd: paths.root, allowFailure: options.allowFailure });
}

function auditGitEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))
  );
  return {
    ...env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, args) {
  return run(
    "git",
    [
      "--git-dir",
      gitAdminPath,
      "--work-tree",
      checkoutPath,
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "submodule.recurse=false",
      ...args
    ],
    {
      cwd: paths.root,
      allowFailure: true,
      env: auditGitEnvironment()
    }
  );
}

function assertSlug(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    fail("invalid-slug", "The checkout slug must contain 1-64 lowercase letters, digits, or hyphens.");
  }
}

function assertOwner(ownerTask, label = "owner") {
  try {
    boundedPrintable(ownerTask, 200, `The ${label} task name`);
  } catch {
    fail("invalid-owner", `The ${label} task name must be one bounded printable string.`);
  }
}

function assertRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("invalid-revision", "The expected checkout revision must be a positive integer.");
  }
}

function assertGeneration(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAXIMUM_ENTRY_GENERATIONS) {
    fail("invalid-generation", "The expected checkout generation must be a positive bounded integer.");
  }
}

function assertRemote(remote) {
  if (typeof remote !== "string" || !REMOTE_PATTERN.test(remote)) fail("invalid-remote", "The remote name is invalid.");
}

function normalizeGeneratedRoots(roots) {
  if (
    !Array.isArray(roots) ||
    roots.length > MAXIMUM_GENERATED_ROOTS ||
    new Set(roots).size !== roots.length ||
    roots.some(
      (root) => typeof root !== "string" || !GENERATED_ROOT_PATTERN.test(root) || root.toLowerCase() === ".git"
    )
  ) {
    fail("invalid-generated-roots", "Generated roots must be unique, exact top-level directory names.");
  }
  return Object.freeze([...roots].sort());
}

function isContained(root, candidate) {
  const pathRelative = relative(root, candidate);
  return (
    pathRelative !== "" && pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative)
  );
}

export function normalizeWorktreeRegistryPath(value, platform = process.platform) {
  if (typeof value !== "string" || value === "") {
    fail("invalid-worktree-registry", "Git returned a non-canonical worktree path.");
  }
  const pathApi = platform === "win32" ? win32 : posix;
  const platformFormatted = platform === "win32" ? value.replaceAll("/", "\\") : value;
  if (!pathApi.isAbsolute(platformFormatted) || pathApi.normalize(platformFormatted) !== platformFormatted) {
    fail("invalid-worktree-registry", "Git returned a non-canonical worktree path.");
  }
  return platformFormatted;
}

function parseWorktreeList(output) {
  if (typeof output !== "string" || output === "" || !output.endsWith("\0")) {
    fail("invalid-worktree-registry", "Git returned a malformed worktree registry.");
  }
  const records = [];
  let record;
  let fields = 0;
  const finishRecord = () => {
    if (record === undefined) fail("invalid-worktree-registry", "Git returned an empty worktree record.");
    if (records.length === MAXIMUM_WORKTREE_RECORDS) {
      fail("invalid-worktree-registry", "Git returned too many worktree records.");
    }
    records.push(Object.freeze(record));
    record = undefined;
  };
  const items = output.split("\0");
  items.pop();
  for (const item of items) {
    if (item === "") {
      finishRecord();
      continue;
    }
    if (Buffer.byteLength(item, "utf8") > MAXIMUM_WORKTREE_FIELD_BYTES) {
      fail("invalid-worktree-registry", "Git returned a malformed worktree field.");
    }
    const space = item.indexOf(" ");
    const key = space === -1 ? item : item.slice(0, space);
    const value = space === -1 ? true : item.slice(space + 1);
    if (key === "worktree") {
      if (record !== undefined) {
        fail("invalid-worktree-registry", "Git returned a worktree without a record separator.");
      }
      record = { path: normalizeWorktreeRegistryPath(value) };
      fields = 1;
      continue;
    }
    if (record === undefined || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(key) || key in record) {
      fail("invalid-worktree-registry", "Git returned a duplicate or misplaced worktree field.");
    }
    fields += 1;
    if (fields > MAXIMUM_WORKTREE_FIELDS) {
      fail("invalid-worktree-registry", "Git returned too many fields for one worktree.");
    }
    record[key] = value;
  }
  if (record !== undefined) fail("invalid-worktree-registry", "Git omitted the final worktree record separator.");
  if (records.length === 0 || new Set(records.map((item) => item.path)).size !== records.length) {
    fail("invalid-worktree-registry", "Git returned duplicate or missing worktree records.");
  }
  return Object.freeze(records);
}

function parseStatus(output) {
  return Object.freeze(
    output
      .split("\0")
      .filter(Boolean)
      .map((line) =>
        line.startsWith("? ")
          ? Object.freeze({ kind: "untracked", path: line.slice(2) })
          : line.startsWith("! ")
            ? Object.freeze({ kind: "ignored", path: line.slice(2) })
            : Object.freeze({ kind: "tracked", path: null })
      )
  );
}

function configuredContentFilterKeys(output) {
  return Object.freeze(
    output
      .split("\0")
      .filter(Boolean)
      .map((key) => key.toLowerCase())
      .filter((key) => /^filter\..+\.(?:clean|process|required)$/u.test(key))
  );
}

function belongsToGeneratedRoot(path, roots) {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function readDirectoryBounded(path, maximumEntries, label) {
  const directory = opendirSync(path);
  const entries = [];
  try {
    let item;
    while ((item = directory.readSync()) !== null) {
      if (entries.length === maximumEntries) fail("too-many-checkouts", `${label} contains too many entries.`);
      entries.push(item);
    }
  } finally {
    directory.closeSync();
  }
  return entries;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function normalizePaths(root) {
  const managerRoot = resolve(root);
  return Object.freeze({
    root: managerRoot,
    entries: join(managerRoot, "entries"),
    checkouts: join(managerRoot, "checkouts"),
    locks: join(managerRoot, "locks"),
    retirements: join(managerRoot, "retirements")
  });
}

export function createCheckoutManager(options = {}) {
  const run = options.run ?? defaultRun;
  const repository = discoverRepository(run, options.repositoryPath ?? options.cwd ?? process.cwd());
  const paths = normalizePaths(
    options.managerRoot ?? join(dirname(repository.commonGitDirectory), "tmp", "agent-checkouts")
  );
  const tokenFactory = options.tokenFactory ?? randomToken;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const hooks = options.hooks;
  const entryIdentities = new WeakMap();
  const managedIdentities = new Map();

  function initializeManager(allowCreate) {
    if (managedIdentities.size > 0) return;
    for (const path of [paths.root, paths.entries, paths.checkouts, paths.locks]) {
      if (!allowCreate && !existsSync(path)) {
        fail("checkout-not-found", "The managed checkout registry does not exist.");
      }
      managedIdentities.set(path, allowCreate ? ensurePrivateDirectory(path) : assertPrivateDirectory(path, path));
    }
  }

  function initializeRetirementJournal() {
    const identity = managedIdentities.get(paths.retirements);
    if (identity === undefined) {
      managedIdentities.set(paths.retirements, ensurePrivateDirectory(paths.retirements));
      return;
    }
    assertPrivateDirectory(paths.retirements, paths.retirements);
    revalidatePathIdentity(paths.retirements, identity, paths.retirements, "directory");
  }

  function checkoutPathFor(slug) {
    assertSlug(slug);
    const path = resolve(paths.checkouts, slug);
    if (!isContained(paths.root, path) || dirname(path) !== paths.checkouts) {
      fail("outside-manager", `Checkout ${slug} is outside the manager.`);
    }
    return path;
  }

  function entryPath(slug, generation) {
    assertSlug(slug);
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAXIMUM_ENTRY_GENERATIONS) {
      fail("invalid-registry", "The checkout entry generation is out of range.");
    }
    return join(paths.entries, `${slug}.${generation}.json`);
  }

  function lockPath(generation, kind) {
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > MAXIMUM_LOCK_GENERATIONS ||
      !["claim", "release"].includes(kind)
    ) {
      fail("invalid-lock", "The operation lock generation is out of range.");
    }
    return join(paths.locks, `${generation}.${kind}.json`);
  }

  function retirementPath(slug, generation) {
    assertSlug(slug);
    assertGeneration(generation);
    return join(paths.retirements, `${slug}.${generation}.json`);
  }

  function validateLockClaim(value, generation, label) {
    exactKeys(value, ["protocol", "generation", "pid", "token"], label);
    if (
      value.protocol !== LOCK_PROTOCOL ||
      value.generation !== generation ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      !/^[0-9a-f]{32}$/u.test(value.token)
    ) {
      fail("invalid-lock", `${label} is malformed.`);
    }
    return value;
  }

  function validateLockRelease(value, claim, label) {
    exactKeys(value, ["protocol", "generation", "pid", "token", "claimIdentity", "releasedByPid", "reason"], label);
    validateIdentity(value.claimIdentity, `${label} claim identity`);
    if (
      value.protocol !== LOCK_RELEASE_PROTOCOL ||
      value.generation !== claim.value.generation ||
      value.pid !== claim.value.pid ||
      value.token !== claim.value.token ||
      !sameIdentity(value.claimIdentity, claim.identity) ||
      !Number.isSafeInteger(value.releasedByPid) ||
      value.releasedByPid < 1 ||
      !["released", "recovered"].includes(value.reason)
    ) {
      fail("invalid-lock", `${label} is malformed or does not match its claim.`);
    }
    return value;
  }

  function readLockJournal() {
    const files = readDirectoryBounded(paths.locks, MAXIMUM_LOCK_FILES, "The operation lock journal").map((item) => {
      const match = LOCK_FILE_PATTERN.exec(item.name);
      if (!item.isFile() || item.isSymbolicLink() || match === null) {
        fail("invalid-lock", "The operation lock journal contains an unknown entry.");
      }
      return Object.freeze({ generation: Number(match[1]), kind: match[2] });
    });
    const byGeneration = new Map();
    for (const file of files) {
      if (file.generation > MAXIMUM_LOCK_GENERATIONS) fail("invalid-lock", "The lock journal is too long.");
      const record = byGeneration.get(file.generation) ?? {};
      if (record[file.kind] !== undefined) fail("invalid-lock", "The lock journal contains a duplicate entry.");
      record[file.kind] = file;
      byGeneration.set(file.generation, record);
    }
    const generations = [...byGeneration.keys()].sort((left, right) => left - right);
    const journal = [];
    for (const [index, generation] of generations.entries()) {
      if (generation !== index + 1) fail("invalid-lock", "The lock journal contains a generation gap.");
      const filesForGeneration = byGeneration.get(generation);
      if (filesForGeneration.claim === undefined) fail("invalid-lock", "A lock release has no claim.");
      const claimPath = lockPath(generation, "claim");
      const claim = readJson(claimPath, MAXIMUM_LOCK_BYTES, `Operation lock claim ${generation}`);
      validateLockClaim(claim.value, generation, `Operation lock claim ${generation}`);
      revalidatePathIdentity(claimPath, claim.identity, `Operation lock claim ${generation}`);
      let release;
      if (filesForGeneration.release !== undefined) {
        const releasePath = lockPath(generation, "release");
        release = readJson(releasePath, MAXIMUM_LOCK_BYTES, `Operation lock release ${generation}`);
        validateLockRelease(release.value, claim, `Operation lock release ${generation}`);
        revalidatePathIdentity(releasePath, release.identity, `Operation lock release ${generation}`);
      }
      if (index < generations.length - 1 && release === undefined) {
        fail("invalid-lock", "A newer lock claim follows an unreleased claim.");
      }
      journal.push(Object.freeze({ claimPath, releasePath: lockPath(generation, "release"), claim, release }));
    }
    return Object.freeze(journal);
  }

  function verifyLockClaimSnapshot(lock) {
    try {
      revalidatePathIdentity(lock.claimPath, lock.claim.identity, "Operation lock claim");
      const current = readJson(lock.claimPath, MAXIMUM_LOCK_BYTES, "Operation lock claim");
      validateLockClaim(current.value, lock.claim.value.generation, "Operation lock claim");
      if (!sameIdentity(current.identity, lock.claim.identity) || !isDeepStrictEqual(current.value, lock.claim.value)) {
        fail("lock-changed", "The operation lock claim changed before release.");
      }
      revalidatePathIdentity(lock.claimPath, current.identity, "Operation lock claim");
    } catch (error) {
      if (error instanceof CheckoutLifecycleError && error.code === "lock-changed") throw error;
      fail("lock-changed", `The operation lock claim changed before release: ${error.message}`);
    }
  }

  function releaseOperationLock(lock, reason, invokeHook = true) {
    verifyLockClaimSnapshot(lock);
    if (invokeHook) hooks?.beforeOperationLockRelease?.(lock);
    const release = {
      protocol: LOCK_RELEASE_PROTOCOL,
      generation: lock.claim.value.generation,
      pid: lock.claim.value.pid,
      token: lock.claim.value.token,
      claimIdentity: lock.claim.identity,
      releasedByPid: process.pid,
      reason
    };
    try {
      writeJsonExclusive(lock.releasePath, release);
    } catch (error) {
      if (error.code === "EEXIST") fail("lock-changed", "The operation lock release path already exists.");
      throw error;
    }
    verifyLockClaimSnapshot(lock);
    const written = readJson(lock.releasePath, MAXIMUM_LOCK_BYTES, "Operation lock release");
    validateLockRelease(written.value, lock.claim, "Operation lock release");
    if (!isDeepStrictEqual(written.value, release)) {
      fail("lock-changed", "The operation lock release changed while it was recorded.");
    }
    revalidatePathIdentity(lock.releasePath, written.identity, "Operation lock release");
  }

  function acquireOperationLock() {
    const token = tokenFactory();
    if (!/^[0-9a-f]{32}$/u.test(token)) fail("invalid-lock", "The generated lock token is malformed.");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const journal = readLockJournal();
      const latest = journal.at(-1);
      if (latest !== undefined && latest.release === undefined) {
        if (isProcessAlive(latest.claim.value.pid)) fail("manager-busy", "Another lifecycle operation is active.");
        releaseOperationLock(latest, "recovered", false);
        continue;
      }
      const generation = (latest?.claim.value.generation ?? 0) + 1;
      if (generation > MAXIMUM_LOCK_GENERATIONS) fail("invalid-lock", "The operation lock journal is full.");
      const claimPath = lockPath(generation, "claim");
      const value = { protocol: LOCK_PROTOCOL, generation, pid: process.pid, token };
      try {
        writeJsonExclusive(claimPath, value);
      } catch (error) {
        if (error.code === "EEXIST") continue;
        throw error;
      }
      const claim = readJson(claimPath, MAXIMUM_LOCK_BYTES, "Operation lock claim");
      validateLockClaim(claim.value, generation, "Operation lock claim");
      if (!isDeepStrictEqual(claim.value, value)) fail("lock-changed", "The operation lock claim changed.");
      revalidatePathIdentity(claimPath, claim.identity, "Operation lock claim");
      return Object.freeze({ claimPath, releasePath: lockPath(generation, "release"), claim });
    }
    fail("manager-busy", "The operation lock journal changed repeatedly during acquisition.");
  }

  function withLock(callback) {
    initializeManager(true);
    for (const [path, identity] of managedIdentities) {
      assertPrivateDirectory(path, path);
      revalidatePathIdentity(path, identity, path, "directory");
    }
    revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
    const lock = acquireOperationLock();
    try {
      hooks?.afterOperationLockAcquired?.(lock);
      return callback();
    } finally {
      releaseOperationLock(lock, "released");
    }
  }

  function validateCheckoutReceipt(value, entry) {
    exactKeys(value, ["protocol", "directory", "gitFile", "gitAdmin", "branch", "head"], "Checkout receipt");
    if (value.protocol !== RECEIPT_PROTOCOL || value.branch !== entry.branch || !SHA_PATTERN.test(value.head)) {
      fail("invalid-registry", "The checkout receipt is malformed.");
    }
    validateIdentity(value.directory, "Checkout directory identity");
    exactKeys(value.gitFile, ["identity", "content"], "Checkout Git file receipt");
    validateIdentity(value.gitFile.identity, "Checkout Git file identity");
    exactKeys(value.gitAdmin, ["path", "identity", "gitdir"], "Checkout Git admin receipt");
    validateIdentity(value.gitAdmin.identity, "Checkout Git admin identity");
    exactKeys(value.gitAdmin.gitdir, ["identity", "content"], "Checkout Git admin backlink receipt");
    validateIdentity(value.gitAdmin.gitdir.identity, "Checkout Git admin backlink identity");
    const adminRoot = join(repository.commonGitDirectory, "worktrees");
    if (
      typeof value.gitFile.content !== "string" ||
      value.gitFile.content.length > 8192 ||
      typeof value.gitAdmin.gitdir.content !== "string" ||
      value.gitAdmin.gitdir.content.length > 8192 ||
      resolve(value.gitAdmin.path) !== value.gitAdmin.path ||
      dirname(value.gitAdmin.path) !== adminRoot ||
      !isContained(adminRoot, value.gitAdmin.path) ||
      value.gitFile.content !== `gitdir: ${value.gitAdmin.path}\n`
    ) {
      fail("invalid-registry", "The checkout Git receipt is malformed.");
    }
  }

  function validateRetirementEvidence(value, entry) {
    exactKeys(
      value,
      ["protocol", "slug", "source", "checkout", "git", "deferredChecks", "authorizesCleanup"],
      "Retirement evidence"
    );
    if (value.protocol !== RETIREMENT_PLAN_PROTOCOL || value.slug !== entry.slug || value.authorizesCleanup !== false) {
      fail("invalid-registry", "The retirement evidence is malformed.");
    }
    exactKeys(
      value.source,
      ["generation", "ownerTask", "revision", "cleanupRequest", "entryIdentity", "entryByteLength", "entrySha256"],
      "Retirement plan source"
    );
    validateIdentity(value.source.entryIdentity, "Retirement plan source identity");
    if (
      !Number.isSafeInteger(value.source.generation) ||
      value.source.generation !== entry.generation ||
      value.source.ownerTask !== entry.ownerTask ||
      value.source.revision !== entry.revision ||
      !isDeepStrictEqual(value.source.cleanupRequest, entry.cleanupRequest) ||
      !Number.isSafeInteger(value.source.entryByteLength) ||
      value.source.entryByteLength < 1 ||
      value.source.entryByteLength > MAXIMUM_ENTRY_BYTES ||
      !/^[0-9a-f]{64}$/u.test(value.source.entrySha256)
    ) {
      fail("invalid-registry", "The retirement plan source is malformed.");
    }
    validateCheckoutReceipt(value.checkout, entry);
    if (!isDeepStrictEqual(value.checkout, entry.checkout)) {
      fail("invalid-registry", "The retirement plan changes the checkout receipt.");
    }
    exactKeys(
      value.git,
      [
        "worktreeListSha256",
        "worktreeRecordCount",
        "nestedWorktreeCount",
        "checkoutPath",
        "targetRecord",
        "commonDir",
        "branch",
        "head",
        "headTree",
        "configNamesSha256",
        "contentFilterConfigKeyCount",
        "statusSha256",
        "statusRecordCount",
        "indexFlagsSha256",
        "unsafeIndexFlags",
        "indexStagesSha256",
        "gitlinkCount",
        "trackedWorktreeClean",
        "stagedClean"
      ],
      "Retirement Git receipt"
    );
    if (
      !/^[0-9a-f]{64}$/u.test(value.git.worktreeListSha256) ||
      !Number.isSafeInteger(value.git.worktreeRecordCount) ||
      value.git.worktreeRecordCount < 1 ||
      value.git.worktreeRecordCount > MAXIMUM_WORKTREE_RECORDS ||
      value.git.nestedWorktreeCount !== 0 ||
      value.git.checkoutPath !== checkoutPathFor(entry.slug) ||
      value.git.branch !== entry.branch ||
      !SHA_PATTERN.test(value.git.head) ||
      !SHA_PATTERN.test(value.git.headTree) ||
      !/^[0-9a-f]{64}$/u.test(value.git.configNamesSha256) ||
      value.git.contentFilterConfigKeyCount !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.statusSha256) ||
      value.git.statusRecordCount !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.indexFlagsSha256) ||
      value.git.unsafeIndexFlags !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.indexStagesSha256) ||
      value.git.gitlinkCount !== 0 ||
      value.git.trackedWorktreeClean !== true ||
      value.git.stagedClean !== true
    ) {
      fail("invalid-registry", "The retirement Git receipt is malformed.");
    }
    exactKeys(value.git.targetRecord, ["path", "HEAD", "branch"], "Retirement target worktree record");
    if (
      value.git.targetRecord.path !== value.git.checkoutPath ||
      value.git.targetRecord.HEAD !== value.git.head ||
      value.git.targetRecord.branch !== `refs/heads/${entry.branch}`
    ) {
      fail("invalid-registry", "The retirement target worktree record is malformed.");
    }
    validateGitAdminCommondirReceipt(value.git.commonDir, entry);
    exactKeys(value.deferredChecks, ["protocol", "recovery", "processUse", "mounts"], "Retirement deferred checks");
    if (
      value.deferredChecks.protocol !== RETIREMENT_CHECKS_PROTOCOL ||
      value.deferredChecks.recovery !== "not-checked-recheck-required" ||
      value.deferredChecks.processUse !== "not-checked-recheck-required" ||
      value.deferredChecks.mounts !== "not-checked-recheck-required"
    ) {
      fail("invalid-registry", "The retirement deferred checks are malformed.");
    }
  }

  function validateEntry(value, slug) {
    const base = [
      "protocol",
      "slug",
      "generation",
      "state",
      "ownerTask",
      "revision",
      "branch",
      "baseCommit",
      "remote",
      "generatedRoots",
      "repository"
    ];
    const keys =
      value?.state === "active"
        ? [...base, "checkout"]
        : value?.state === "cleanup-pending"
          ? [...base, "checkout", "cleanupRequest"]
          : value?.state === "abandoned-review-required"
            ? [...base, "cleanupRequest"]
            : base;
    exactKeys(value, keys, `Managed checkout ${slug}`);
    if (
      value.protocol !== ENTRY_PROTOCOL ||
      value.slug !== slug ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1 ||
      value.generation > MAXIMUM_ENTRY_GENERATIONS ||
      !["creating", "active", "cleanup-pending", "abandoned-review-required"].includes(value.state) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !SHA_PATTERN.test(value.baseCommit)
    ) {
      fail("invalid-registry", `Managed checkout ${slug} is malformed.`);
    }
    assertOwner(value.ownerTask);
    assertRemote(value.remote);
    boundedPrintable(value.branch, 240, "Branch name");
    normalizeGeneratedRoots(value.generatedRoots);
    exactKeys(value.repository, ["path", "identity"], "Repository receipt");
    validateIdentity(value.repository.identity, "Repository identity");
    if (
      value.repository.path !== repository.commonGitDirectory ||
      !sameIdentity(value.repository.identity, repository.identity)
    ) {
      fail("repository-changed", "The managed checkout belongs to another repository.");
    }
    if (["active", "cleanup-pending"].includes(value.state)) validateCheckoutReceipt(value.checkout, value);
    if (["cleanup-pending", "abandoned-review-required"].includes(value.state)) {
      exactKeys(value.cleanupRequest, ["protocol", "requestedBy", "requestedRevision", "reason"], "Cleanup request");
      if (
        value.cleanupRequest.protocol !== CLEANUP_REQUEST_PROTOCOL ||
        !["finish", "abandon"].includes(value.cleanupRequest.reason) ||
        !Number.isSafeInteger(value.cleanupRequest.requestedRevision) ||
        value.cleanupRequest.requestedRevision < 1 ||
        value.cleanupRequest.requestedRevision > value.revision
      ) {
        fail("invalid-registry", "The cleanup request is malformed.");
      }
      assertOwner(value.cleanupRequest.requestedBy, "cleanup requester");
    }
    return value;
  }

  function registryFiles() {
    const items = readDirectoryBounded(paths.entries, MAXIMUM_REGISTRY_FILES, "The checkout registry");
    return items.map((item) => {
      const match = ENTRY_FILE_PATTERN.exec(item.name);
      if (!item.isFile() || item.isSymbolicLink() || match === null) {
        fail("invalid-registry", "The checkout registry contains an unknown entry.");
      }
      return Object.freeze({ name: item.name, slug: match[1], generation: Number(match[2]) });
    });
  }

  function validateEntryTransition(previous, next) {
    for (const key of ["protocol", "slug", "branch", "baseCommit", "remote", "generatedRoots", "repository"]) {
      if (!isDeepStrictEqual(previous[key], next[key])) {
        fail("invalid-registry", `Managed checkout ${previous.slug} changes immutable field ${key}.`);
      }
    }
    if (next.generation !== previous.generation + 1) {
      fail("invalid-registry", `Managed checkout ${previous.slug} skips an entry generation.`);
    }
    const handoff = next.revision === previous.revision + 1;
    const sameOwnerRevision = next.revision === previous.revision && next.ownerTask === previous.ownerTask;
    if (previous.state === "creating") {
      if (!sameOwnerRevision || !["active", "abandoned-review-required"].includes(next.state)) {
        fail("invalid-registry", `Managed checkout ${previous.slug} has an invalid creation transition.`);
      }
    } else if (previous.state === "active") {
      if (!((next.state === "active" && handoff) || (next.state === "cleanup-pending" && sameOwnerRevision))) {
        fail("invalid-registry", `Managed checkout ${previous.slug} has an invalid active transition.`);
      }
    } else if (next.state !== previous.state || !handoff) {
      fail("invalid-registry", `Managed checkout ${previous.slug} has an invalid review transition.`);
    }
    if (handoff && next.ownerTask === previous.ownerTask) {
      fail("invalid-registry", `Managed checkout ${previous.slug} handoff does not change owner.`);
    }
    if (["active", "cleanup-pending"].includes(previous.state)) {
      if (!isDeepStrictEqual(previous.checkout, next.checkout)) {
        fail("invalid-registry", `Managed checkout ${previous.slug} changes its checkout receipt.`);
      }
    }
    if (["cleanup-pending", "abandoned-review-required"].includes(previous.state)) {
      if (!isDeepStrictEqual(previous.cleanupRequest, next.cleanupRequest)) {
        fail("invalid-registry", `Managed checkout ${previous.slug} changes its cleanup request.`);
      }
    }
  }

  function readEntryHistory(slug) {
    assertSlug(slug);
    const files = registryFiles()
      .filter((file) => file.slug === slug)
      .sort((left, right) => left.generation - right.generation);
    if (files.length === 0) fail("checkout-not-found", `Managed checkout ${slug} does not exist.`);
    if (files.length > MAXIMUM_ENTRY_GENERATIONS) {
      fail("invalid-registry", `Managed checkout ${slug} has too many generations.`);
    }
    const history = [];
    for (const [index, file] of files.entries()) {
      if (file.generation !== index + 1) {
        fail("invalid-registry", `Managed checkout ${slug} has a missing or duplicate generation.`);
      }
      const loaded = readJson(entryPath(slug, file.generation), MAXIMUM_ENTRY_BYTES, `Managed checkout ${slug}`);
      revalidatePathIdentity(entryPath(slug, file.generation), loaded.identity, `Managed checkout ${slug}`);
      const value = validateEntry(loaded.value, slug);
      if (value.generation !== file.generation) {
        fail("invalid-registry", `Managed checkout ${slug} has a mismatched entry generation.`);
      }
      if (index > 0) validateEntryTransition(history[index - 1], value);
      entryIdentities.set(value, loaded.identity);
      history.push(value);
    }
    return Object.freeze(history);
  }

  function readEntry(slug) {
    return readEntryHistory(slug).at(-1);
  }

  function writeInitialEntry(entry) {
    validateEntry(entry, entry.slug);
    if (entry.generation !== 1 || registryFiles().some((file) => file.slug === entry.slug)) {
      fail("checkout-exists", `Checkout ${entry.slug} exists.`);
    }
    try {
      writeJsonExclusive(entryPath(entry.slug, 1), entry);
    } catch (error) {
      if (error.code === "EEXIST") fail("registry-changed", `Managed checkout ${entry.slug} appeared concurrently.`);
      throw error;
    }
    const written = readJson(entryPath(entry.slug, 1), MAXIMUM_ENTRY_BYTES, `Managed checkout ${entry.slug}`);
    if (!isDeepStrictEqual(written.value, entry)) {
      fail("registry-changed", `Managed checkout ${entry.slug} changed while it was created.`);
    }
    revalidatePathIdentity(entryPath(entry.slug, 1), written.identity, `Managed checkout ${entry.slug}`);
    entryIdentities.set(entry, written.identity);
    return entry;
  }

  function verifyEntrySnapshot(entry) {
    const identity = entryIdentities.get(entry);
    if (identity === undefined) fail("registry-changed", `Managed checkout ${entry.slug} has no read receipt.`);
    revalidatePathIdentity(entryPath(entry.slug, entry.generation), identity, `Managed checkout ${entry.slug}`);
    const current = readJson(
      entryPath(entry.slug, entry.generation),
      MAXIMUM_ENTRY_BYTES,
      `Managed checkout ${entry.slug}`
    );
    if (!sameIdentity(current.identity, identity) || !isDeepStrictEqual(current.value, entry)) {
      fail("registry-changed", `Managed checkout ${entry.slug} changed before its update was recorded.`);
    }
    return identity;
  }

  function appendEntry(previous, value) {
    const next = { ...value, generation: previous.generation + 1 };
    validateEntry(next, previous.slug);
    validateEntryTransition(previous, next);
    const previousIdentity = verifyEntrySnapshot(previous);
    try {
      writeJsonExclusive(entryPath(next.slug, next.generation), next);
    } catch (error) {
      if (error.code === "EEXIST") {
        fail("registry-changed", `Managed checkout ${next.slug} changed before its update was recorded.`);
      }
      throw error;
    }
    revalidatePathIdentity(
      entryPath(previous.slug, previous.generation),
      previousIdentity,
      `Managed checkout ${previous.slug}`
    );
    const written = readJson(
      entryPath(next.slug, next.generation),
      MAXIMUM_ENTRY_BYTES,
      `Managed checkout ${next.slug}`
    );
    if (!isDeepStrictEqual(written.value, next)) {
      fail("registry-changed", `Managed checkout ${next.slug} changed while its update was recorded.`);
    }
    revalidatePathIdentity(entryPath(next.slug, next.generation), written.identity, `Managed checkout ${next.slug}`);
    entryIdentities.set(next, written.identity);
    return next;
  }

  function worktreeRegistry(readOnly = false) {
    const output = commonGit(run, paths, repository, ["worktree", "list", "--porcelain", "-z"], {
      env: readOnly ? auditGitEnvironment() : undefined
    }).stdout;
    return Object.freeze({ output, records: parseWorktreeList(output) });
  }

  function worktreeRecords(readOnly = false) {
    return worktreeRegistry(readOnly).records;
  }

  function worktreeRecord(checkoutPath, readOnly = false) {
    const matches = worktreeRecords(readOnly).filter((record) => record.path === checkoutPath);
    if (matches.length > 1) fail("ambiguous-checkout", "Git reported the managed checkout more than once.");
    return matches[0];
  }

  function readGitFile(checkoutPath) {
    return readBoundedFile(join(checkoutPath, ".git"), 8192, "Checkout .git file");
  }

  function captureCheckoutReceipt(entry) {
    const checkoutPath = checkoutPathFor(entry.slug);
    const metadata = lstatSync(checkoutPath, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      realpathSync(checkoutPath) !== checkoutPath
    ) {
      fail("unsafe-checkout", "The new checkout is not one owned canonical directory.");
    }
    const gitFile = readGitFile(checkoutPath);
    const match = /^gitdir: (.+)\n$/u.exec(gitFile.text);
    if (match === null) fail("unsafe-checkout", "The checkout .git file is malformed.");
    const adminPath = realpathSync(match[1]);
    const admin = lstatSync(adminPath, { bigint: true });
    const adminGitdir = readBoundedFile(join(adminPath, "gitdir"), 8192, "Checkout Git admin backlink");
    const receipt = {
      protocol: RECEIPT_PROTOCOL,
      directory: identityOf(metadata),
      gitFile: { identity: gitFile.identity, content: gitFile.text },
      gitAdmin: {
        path: adminPath,
        identity: identityOf(admin),
        gitdir: { identity: adminGitdir.identity, content: adminGitdir.text }
      },
      branch: checkoutGit(run, paths, checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim(),
      head: checkoutGit(run, paths, checkoutPath, ["rev-parse", "HEAD"]).stdout.trim()
    };
    validateCheckoutReceipt(receipt, entry);
    return receipt;
  }

  function reconcileCreating(entry) {
    if (entry.state !== "creating") return entry;
    const checkoutPath = checkoutPathFor(entry.slug);
    const present = existsSync(checkoutPath);
    const record = worktreeRecord(checkoutPath, true);
    if (!present && record === undefined) return entry;
    if (!present || record === undefined) fail("interrupted-create-mismatch", "Creation is only partly registered.");
    const checkout = captureCheckoutReceipt(entry);
    const recordBranch = record.branch?.replace(/^refs\/heads\//u, "") ?? null;
    if (checkout.branch !== entry.branch || recordBranch !== entry.branch || checkout.head !== record.HEAD) {
      fail("interrupted-create-mismatch", "The adopted checkout differs from its registry entry.");
    }
    for (const root of entry.generatedRoots) {
      if (existsSync(join(checkoutPath, root)))
        fail("interrupted-create-mismatch", `Generated root ${root} already exists.`);
    }
    return appendEntry(entry, { ...entry, state: "active", checkout });
  }

  function assertOwnerRevision(entry, ownerTask, revision) {
    assertOwner(ownerTask);
    assertRevision(revision);
    if (entry.ownerTask !== ownerTask || entry.revision !== revision) {
      fail("ownership-changed", `Managed checkout ${entry.slug} belongs to another task or revision.`);
    }
  }

  function auditEntry(entry) {
    const checkoutPath = checkoutPathFor(entry.slug);
    const record = worktreeRecord(checkoutPath, true);
    const issues = [];
    let receiptMatches = false;
    let branch = record?.branch?.replace(/^refs\/heads\//u, "") ?? null;
    let head = record?.HEAD ?? null;
    let unsafeIndexFlags = null;
    let registrationMatches = false;
    let porcelainClean = null;
    let generatedOnly = null;
    let trackedWorktreeClean = null;
    let stagedClean = null;
    let gitlinkCount = null;
    let contentFilterConfigKeys = null;
    if (entry.state === "creating") issues.push("creation-incomplete");
    else if (entry.state === "abandoned-review-required") issues.push("abandoned-review-required");
    else if (!existsSync(checkoutPath)) issues.push("checkout-path-missing");
    else {
      try {
        revalidatePathIdentity(checkoutPath, entry.checkout.directory, "Managed checkout", "directory");
        const gitFile = readGitFile(checkoutPath);
        revalidatePathIdentity(
          entry.checkout.gitAdmin.path,
          entry.checkout.gitAdmin.identity,
          "Git admin",
          "directory"
        );
        const adminGitdir = readBoundedFile(
          join(entry.checkout.gitAdmin.path, "gitdir"),
          8192,
          "Checkout Git admin backlink"
        );
        if (
          !sameIdentity(gitFile.identity, entry.checkout.gitFile.identity) ||
          gitFile.text !== entry.checkout.gitFile.content
        ) {
          fail("checkout-changed", "The checkout .git file changed.");
        }
        if (
          !sameIdentity(adminGitdir.identity, entry.checkout.gitAdmin.gitdir.identity) ||
          adminGitdir.text !== entry.checkout.gitAdmin.gitdir.content
        ) {
          fail("checkout-changed", "The checkout Git admin backlink changed.");
        }
        receiptMatches = true;
      } catch {
        issues.push("filesystem-receipt-mismatch");
      }
      if (receiptMatches) {
        const gitAdminPath = entry.checkout.gitAdmin.path;
        const observedBranch = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD"
        ]);
        const observedHead = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
          "rev-parse",
          "--verify",
          "HEAD"
        ]);
        branch = observedBranch.status === 0 ? observedBranch.stdout.trim() : null;
        head = observedHead.status === 0 ? observedHead.stdout.trim() : null;
        registrationMatches =
          branch === entry.branch && record?.branch === `refs/heads/${entry.branch}` && record?.HEAD === head;
        if (!registrationMatches) {
          issues.push("git-registration-mismatch");
        }
        const configNames = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
          "config",
          "--null",
          "--name-only",
          "--list"
        ]);
        if (configNames.status === 0) {
          contentFilterConfigKeys = configuredContentFilterKeys(configNames.stdout).length;
          if (contentFilterConfigKeys > 0) issues.push("external-content-filter-configured");
        } else issues.push("git-config-unreadable");
        const flags = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, ["ls-files", "-v", "-z"]);
        if (flags.status === 0) {
          unsafeIndexFlags = flags.stdout
            .split("\0")
            .filter(Boolean)
            .filter((item) => item[0] !== "H").length;
          if (unsafeIndexFlags > 0) issues.push("assume-unchanged-or-skip-worktree");
        } else issues.push("index-flags-unreadable");
        const stages = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, ["ls-files", "--stage", "-z"]);
        if (stages.status === 0) {
          gitlinkCount = stages.stdout
            .split("\0")
            .filter(Boolean)
            .filter((item) => item.startsWith("160000 ")).length;
          if (gitlinkCount > 0) issues.push("submodule-present");
        } else issues.push("index-stages-unreadable");
        if (contentFilterConfigKeys === 0) {
          const status = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--ignore-submodules=all"
          ]);
          if (status.status === 0) {
            const records = parseStatus(status.stdout);
            porcelainClean = records.length === 0;
            generatedOnly = records.every(
              (item) => item.kind === "ignored" && belongsToGeneratedRoot(item.path, entry.generatedRoots)
            );
            if (!generatedOnly) issues.push("tracked-or-user-work-present");
          } else issues.push("status-unreadable");
          const worktreeDiff = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
            "diff-files",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            "--"
          ]);
          trackedWorktreeClean = worktreeDiff.status === 0 && unsafeIndexFlags === 0 && gitlinkCount === 0;
          if (!trackedWorktreeClean) issues.push("tracked-worktree-not-proven-clean");
          const stagedDiff = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
            "diff-index",
            "--cached",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            "HEAD",
            "--"
          ]);
          stagedClean = stagedDiff.status === 0;
          if (!stagedClean) issues.push("index-not-clean");
        }
      }
    }
    return Object.freeze({
      slug: entry.slug,
      state: entry.state,
      ownerTask: entry.ownerTask,
      revision: entry.revision,
      checkoutPath,
      pathPresent: existsSync(checkoutPath),
      registered: record !== undefined,
      registrationMatches,
      receiptMatches,
      branch,
      head,
      unsafeIndexFlags,
      gitlinkCount,
      contentFilterConfigKeys,
      porcelainClean,
      generatedOnly,
      trackedWorktreeClean,
      stagedClean,
      candidateForReviewedCleanup:
        receiptMatches &&
        registrationMatches &&
        unsafeIndexFlags === 0 &&
        gitlinkCount === 0 &&
        contentFilterConfigKeys === 0 &&
        generatedOnly === true &&
        trackedWorktreeClean === true &&
        stagedClean === true,
      issues: Object.freeze([...new Set(issues)])
    });
  }

  function requireAuditCommand(entry, checkoutPath, args, label) {
    const result = auditCheckoutGit(run, paths, checkoutPath, entry.checkout.gitAdmin.path, args);
    if (result.status !== 0) fail("retirement-not-eligible", `${label} could not be proven.`);
    return result.stdout;
  }

  function captureSourceEntryReceipt(entry) {
    const expectedIdentity = verifyEntrySnapshot(entry);
    const source = readBoundedFile(
      entryPath(entry.slug, entry.generation),
      MAXIMUM_ENTRY_BYTES,
      `Managed checkout ${entry.slug}`,
      0o600n
    );
    if (!sameIdentity(source.identity, expectedIdentity)) {
      fail("registry-changed", "The cleanup-pending entry changed while retirement evidence was collected.");
    }
    return Object.freeze({
      generation: entry.generation,
      ownerTask: entry.ownerTask,
      revision: entry.revision,
      cleanupRequest: entry.cleanupRequest,
      entryIdentity: expectedIdentity,
      entryByteLength: Buffer.byteLength(source.text, "utf8"),
      entrySha256: sha256(source.text)
    });
  }

  function verifyCheckoutFilesystemReceipt(entry) {
    const checkoutPath = checkoutPathFor(entry.slug);
    revalidatePathIdentity(checkoutPath, entry.checkout.directory, "Managed checkout", "directory");
    const gitFile = readGitFile(checkoutPath);
    revalidatePathIdentity(entry.checkout.gitAdmin.path, entry.checkout.gitAdmin.identity, "Git admin", "directory");
    const backlink = readBoundedFile(join(entry.checkout.gitAdmin.path, "gitdir"), 8192, "Checkout Git admin backlink");
    if (
      !sameIdentity(gitFile.identity, entry.checkout.gitFile.identity) ||
      gitFile.text !== entry.checkout.gitFile.content ||
      !sameIdentity(backlink.identity, entry.checkout.gitAdmin.gitdir.identity) ||
      backlink.text !== entry.checkout.gitAdmin.gitdir.content
    ) {
      fail("retirement-not-eligible", "The checkout filesystem receipt no longer matches.");
    }
    return captureGitAdminCommondir(entry);
  }

  function captureGitAdminCommondir(entry) {
    const path = join(entry.checkout.gitAdmin.path, "commondir");
    const file = readBoundedFile(path, 8192, "Checkout Git admin common-directory link");
    const match = /^([^\0\r\n]+)\n$/u.exec(file.text);
    if (match === null) {
      fail("retirement-not-eligible", "The checkout Git common-directory link is malformed.");
    }
    const configuredTarget = resolve(entry.checkout.gitAdmin.path, match[1]);
    if (configuredTarget !== repository.commonGitDirectory) {
      fail("retirement-not-eligible", "The checkout Git common-directory link targets another repository.");
    }
    let target;
    try {
      target = realpathSync(configuredTarget);
    } catch {
      fail("retirement-not-eligible", "The checkout Git common directory cannot be resolved.");
    }
    revalidatePathIdentity(target, repository.identity, "Git common directory", "directory");
    return Object.freeze({ path, identity: file.identity, content: file.text, target });
  }

  function validateGitAdminCommondirReceipt(value, entry) {
    exactKeys(value, ["path", "identity", "content", "target"], "Checkout Git common-directory receipt");
    validateIdentity(value.identity, "Checkout Git common-directory file identity");
    const match = typeof value.content === "string" ? /^([^\0\r\n]+)\n$/u.exec(value.content) : null;
    if (
      value.path !== join(entry.checkout.gitAdmin.path, "commondir") ||
      value.target !== repository.commonGitDirectory ||
      match === null ||
      resolve(entry.checkout.gitAdmin.path, match[1]) !== repository.commonGitDirectory
    ) {
      fail("invalid-registry", "The checkout Git common-directory receipt is malformed.");
    }
  }

  function captureRetirementEvidence(entry) {
    if (entry.state !== "cleanup-pending") {
      fail("checkout-not-cleanup-pending", "Only a cleanup-pending checkout can be planned for retirement.");
    }
    const source = captureSourceEntryReceipt(entry);
    const commonDir = verifyCheckoutFilesystemReceipt(entry);
    const checkoutPath = checkoutPathFor(entry.slug);
    const registry = worktreeRegistry(true);
    const records = registry.records.filter((record) => record.path === checkoutPath);
    if (records.length !== 1) fail("retirement-not-eligible", "The checkout has no exact Git worktree record.");
    const record = records[0];
    if (Object.keys(record).sort().join("\0") !== ["HEAD", "branch", "path"].sort().join("\0")) {
      fail("retirement-not-eligible", "The checkout worktree record is detached, locked, or otherwise ambiguous.");
    }
    const nestedWorktrees = registry.records.filter(
      (candidate) => candidate.path !== checkoutPath && isContained(checkoutPath, candidate.path)
    );
    if (nestedWorktrees.length !== 0) {
      fail("retirement-not-eligible", "Another registered worktree is nested below the checkout.");
    }
    const branch = requireAuditCommand(
      entry,
      checkoutPath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "The checkout branch"
    ).trim();
    const head = requireAuditCommand(
      entry,
      checkoutPath,
      ["rev-parse", "--verify", "HEAD"],
      "The checkout head"
    ).trim();
    const headTree = requireAuditCommand(
      entry,
      checkoutPath,
      ["rev-parse", "--verify", "HEAD^{tree}"],
      "The checkout tree"
    ).trim();
    const configNames = requireAuditCommand(
      entry,
      checkoutPath,
      ["config", "--null", "--name-only", "--list"],
      "The checkout Git configuration"
    );
    const contentFilterConfigKeyCount = configuredContentFilterKeys(configNames).length;
    if (contentFilterConfigKeyCount !== 0) {
      fail("retirement-not-eligible", "The checkout configures an external Git content filter.");
    }
    const status = requireAuditCommand(
      entry,
      checkoutPath,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=all"],
      "The checkout status"
    );
    const flags = requireAuditCommand(entry, checkoutPath, ["ls-files", "-v", "-z"], "The checkout index flags");
    const stages = requireAuditCommand(entry, checkoutPath, ["ls-files", "--stage", "-z"], "The checkout index stages");
    const statusRecords = parseStatus(status);
    const unsafeIndexFlags = flags
      .split("\0")
      .filter(Boolean)
      .filter((item) => item[0] !== "H").length;
    const gitlinkCount = stages
      .split("\0")
      .filter(Boolean)
      .filter((item) => item.startsWith("160000 ")).length;
    const trackedWorktreeClean =
      auditCheckoutGit(run, paths, checkoutPath, entry.checkout.gitAdmin.path, [
        "diff-files",
        "--quiet",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "--"
      ]).status === 0 && unsafeIndexFlags === 0;
    const stagedClean =
      auditCheckoutGit(run, paths, checkoutPath, entry.checkout.gitAdmin.path, [
        "diff-index",
        "--cached",
        "--quiet",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "HEAD",
        "--"
      ]).status === 0;
    if (
      branch !== entry.branch ||
      record.branch !== `refs/heads/${entry.branch}` ||
      record.HEAD !== head ||
      !SHA_PATTERN.test(head) ||
      !SHA_PATTERN.test(headTree) ||
      statusRecords.length !== 0 ||
      unsafeIndexFlags !== 0 ||
      gitlinkCount !== 0 ||
      !trackedWorktreeClean ||
      !stagedClean
    ) {
      fail("retirement-not-eligible", "The checkout changed while retirement evidence was collected.");
    }
    const confirmedCommonDir = captureGitAdminCommondir(entry);
    if (!isDeepStrictEqual(confirmedCommonDir, commonDir)) {
      fail("registry-changed", "The checkout Git common-directory link changed during evidence collection.");
    }
    const evidence = {
      protocol: RETIREMENT_PLAN_PROTOCOL,
      slug: entry.slug,
      source,
      checkout: entry.checkout,
      git: {
        worktreeListSha256: sha256(registry.output),
        worktreeRecordCount: registry.records.length,
        nestedWorktreeCount: nestedWorktrees.length,
        checkoutPath,
        targetRecord: record,
        commonDir,
        branch,
        head,
        headTree,
        configNamesSha256: sha256(configNames),
        contentFilterConfigKeyCount,
        statusSha256: sha256(status),
        statusRecordCount: statusRecords.length,
        indexFlagsSha256: sha256(flags),
        unsafeIndexFlags,
        indexStagesSha256: sha256(stages),
        gitlinkCount,
        trackedWorktreeClean,
        stagedClean
      },
      deferredChecks: {
        protocol: RETIREMENT_CHECKS_PROTOCOL,
        recovery: "not-checked-recheck-required",
        processUse: "not-checked-recheck-required",
        mounts: "not-checked-recheck-required"
      },
      authorizesCleanup: false
    };
    validateRetirementEvidence(evidence, entry);
    return evidence;
  }

  function requestCleanup(entry, reason) {
    if (entry.state === "cleanup-pending") return entry;
    if (entry.state !== "active") fail("checkout-not-active", "Only an active checkout can request cleanup.");
    hooks?.beforeCleanupPendingWrite?.(entry);
    return appendEntry(entry, {
      ...entry,
      state: "cleanup-pending",
      cleanupRequest: {
        protocol: CLEANUP_REQUEST_PROTOCOL,
        requestedBy: entry.ownerTask,
        requestedRevision: entry.revision,
        reason
      }
    });
  }

  function requestAbandonedReview(entry) {
    if (entry.state === "abandoned-review-required") return entry;
    if (entry.state !== "creating") {
      fail("checkout-not-active", "Only an interrupted create can request absence review.");
    }
    hooks?.beforeAbandonPendingWrite?.(entry);
    return appendEntry(entry, {
      ...entry,
      state: "abandoned-review-required",
      cleanupRequest: {
        protocol: CLEANUP_REQUEST_PROTOCOL,
        requestedBy: entry.ownerTask,
        requestedRevision: entry.revision,
        reason: "abandon"
      }
    });
  }

  function listEntrySlugs(slug) {
    if (slug !== undefined) {
      readEntry(slug);
      return [slug];
    }
    const slugs = [...new Set(registryFiles().map((file) => file.slug))].sort();
    if (slugs.length > MAXIMUM_ENTRIES) fail("too-many-checkouts", "The checkout registry has too many checkouts.");
    return slugs;
  }

  return Object.freeze({
    paths,

    create({ slug, ownerTask, branch, base = "HEAD", remote = "origin", generatedRoots = [] }) {
      assertSlug(slug);
      assertOwner(ownerTask);
      assertRemote(remote);
      boundedPrintable(base, 512, "Base revision");
      const roots = normalizeGeneratedRoots(generatedRoots);
      return withLock(() => {
        const checkoutPath = checkoutPathFor(slug);
        if (registryFiles().some((file) => file.slug === slug) || existsSync(checkoutPath))
          fail("checkout-exists", `Checkout ${slug} exists.`);
        const selectedBranch = branch ?? `agent/${slug}-${tokenFactory().slice(0, 8)}`;
        if (
          run("git", ["check-ref-format", "--branch", selectedBranch], { cwd: paths.root, allowFailure: true })
            .status !== 0
        ) {
          fail("invalid-branch", "The managed branch name is invalid.");
        }
        const branchCheck = commonGit(
          run,
          paths,
          repository,
          ["show-ref", "--verify", "--quiet", `refs/heads/${selectedBranch}`],
          { allowFailure: true }
        );
        if (branchCheck.status === 0) fail("branch-exists", `Branch ${selectedBranch} already exists.`);
        if (branchCheck.status !== 1) fail("command-failed", `Git could not inspect branch ${selectedBranch}.`);
        commonGit(run, paths, repository, ["remote", "get-url", remote]);
        const baseCommit = checkoutGit(run, paths, repository.topLevel, [
          "rev-parse",
          "--verify",
          `${base}^{commit}`
        ]).stdout.trim();
        let entry = writeInitialEntry({
          protocol: ENTRY_PROTOCOL,
          slug,
          generation: 1,
          state: "creating",
          ownerTask,
          revision: 1,
          branch: selectedBranch,
          baseCommit,
          remote,
          generatedRoots: roots,
          repository: { path: repository.commonGitDirectory, identity: repository.identity }
        });
        hooks?.afterRegistryBeforeGit?.(entry);
        commonGit(run, paths, repository, ["worktree", "add", "-b", selectedBranch, checkoutPath, baseCommit]);
        hooks?.afterGitBeforeActive?.(entry);
        entry = reconcileCreating(entry);
        return Object.freeze({ slug, branch: entry.branch, ownerTask, revision: 1, checkoutPath });
      });
    },

    status(slug = undefined) {
      if (slug !== undefined) assertSlug(slug);
      return withLock(() =>
        Object.freeze(
          listEntrySlugs(slug).map((entrySlug) => {
            const entry = reconcileCreating(readEntry(entrySlug));
            const checkoutPath = checkoutPathFor(entry.slug);
            const record = worktreeRecord(checkoutPath);
            return Object.freeze({
              slug: entry.slug,
              state: entry.state,
              ownerTask: entry.ownerTask,
              revision: entry.revision,
              branch: entry.branch,
              checkoutPath,
              present: existsSync(checkoutPath),
              registered: record !== undefined,
              head: record?.HEAD ?? null,
              cleanupReviewRequired: ["cleanup-pending", "abandoned-review-required"].includes(entry.state)
            });
          })
        )
      );
    },

    audit(slug) {
      assertSlug(slug);
      initializeManager(false);
      for (const [path, identity] of managedIdentities) {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
      revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
      return auditEntry(readEntry(slug));
    },

    handoff({ slug, ownerTask, nextOwnerTask, expectedRevision }) {
      assertSlug(slug);
      assertOwner(nextOwnerTask, "next owner");
      return withLock(() => {
        const entry = reconcileCreating(readEntry(slug));
        assertOwnerRevision(entry, ownerTask, expectedRevision);
        if (entry.state === "creating") fail("checkout-not-active", "An incomplete create cannot be handed off.");
        const next = appendEntry(entry, { ...entry, ownerTask: nextOwnerTask, revision: entry.revision + 1 });
        return Object.freeze({
          slug,
          ownerTask: next.ownerTask,
          revision: next.revision,
          checkoutPath: checkoutPathFor(slug)
        });
      });
    },

    finish({ slug, ownerTask, expectedRevision }) {
      assertSlug(slug);
      return withLock(() => {
        let entry = reconcileCreating(readEntry(slug));
        assertOwnerRevision(entry, ownerTask, expectedRevision);
        if (entry.state !== "active" && entry.state !== "cleanup-pending") {
          fail("checkout-not-active", "An incomplete create cannot request cleanup.");
        }
        entry = requestCleanup(entry, "finish");
        return Object.freeze({ status: "cleanup-review-required", slug, audit: auditEntry(entry) });
      });
    },

    planRetirement({ slug, ownerTask, expectedRevision, expectedGeneration }) {
      assertSlug(slug);
      assertGeneration(expectedGeneration);
      return withLock(() => {
        const entry = readEntry(slug);
        assertOwnerRevision(entry, ownerTask, expectedRevision);
        if (entry.generation !== expectedGeneration) {
          fail("registry-changed", `Managed checkout ${slug} is no longer at the expected generation.`);
        }
        initializeRetirementJournal();
        const retirementJournalIdentity = managedIdentities.get(paths.retirements);
        if (retirementJournalIdentity === undefined) {
          fail("unsafe-manager", "The retirement journal was not initialized.");
        }
        const destination = retirementPath(slug, entry.generation);
        if (existsSync(destination)) {
          fail("retirement-evidence-exists", "Retirement evidence already exists for this checkout generation.");
        }
        const firstEvidence = captureRetirementEvidence(entry);
        hooks?.beforeRetirementEvidenceWrite?.(entry, firstEvidence);
        const secondEvidence = captureRetirementEvidence(entry);
        if (!isDeepStrictEqual(firstEvidence, secondEvidence)) {
          fail("checkout-changed", "The checkout changed while its retirement plan was prepared.");
        }
        hooks?.beforeRetirementEvidencePublish?.(entry, secondEvidence);
        revalidatePathIdentity(paths.retirements, retirementJournalIdentity, paths.retirements, "directory");
        try {
          writeJsonExclusive(destination, secondEvidence, retirementJournalIdentity);
        } catch (error) {
          if (error.code === "EEXIST") {
            fail("retirement-evidence-exists", "Retirement evidence appeared concurrently.");
          }
          throw error;
        }
        revalidatePathIdentity(paths.retirements, retirementJournalIdentity, paths.retirements, "directory");
        const written = readJson(destination, MAXIMUM_ENTRY_BYTES, `Retirement evidence for ${slug}`);
        validateRetirementEvidence(written.value, entry);
        if (
          !isDeepStrictEqual(written.value, secondEvidence) ||
          !isDeepStrictEqual(written.value.source, captureSourceEntryReceipt(entry))
        ) {
          fail("registry-changed", "The retirement evidence or its source changed while it was recorded.");
        }
        revalidatePathIdentity(destination, written.identity, `Retirement evidence for ${slug}`);
        return Object.freeze({
          status: "retirement-evidence-recorded",
          slug,
          ownerTask: entry.ownerTask,
          revision: entry.revision,
          generation: entry.generation,
          checkoutState: entry.state,
          authorizesCleanup: false,
          evidence: written.value
        });
      });
    },

    abandon({ slug, expectedOwnerTask, expectedHead, expectedRevision }) {
      assertSlug(slug);
      return withLock(() => {
        let entry = readEntry(slug);
        assertOwnerRevision(entry, expectedOwnerTask, expectedRevision);
        if (expectedHead === "absent") {
          entry = requestAbandonedReview(entry);
          return Object.freeze({ status: "abandoned-review-required", slug, audit: auditEntry(entry) });
        }
        if (typeof expectedHead !== "string" || !SHA_PATTERN.test(expectedHead)) {
          fail("invalid-head", "Abandon requires the exact observed head or absent.");
        }
        entry = reconcileCreating(entry);
        const audit = auditEntry(entry);
        if (audit.head !== expectedHead) fail("checkout-changed", "The observed head changed.");
        if (entry.state === "creating") fail("checkout-not-active", "An incomplete create cannot request cleanup.");
        entry = requestCleanup(entry, "abandon");
        return Object.freeze({ status: "cleanup-review-required", slug, audit: auditEntry(entry) });
      });
    }
  });
}

function parseRevision(value) {
  const revision = Number(value);
  assertRevision(revision);
  return revision;
}

function parseGeneration(value) {
  const generation = Number(value);
  assertGeneration(generation);
  return generation;
}

export function runCheckoutLifecycleCli(argv = process.argv.slice(2), options = {}) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      owner: { type: "string" },
      to: { type: "string" },
      revision: { type: "string" },
      generation: { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      remote: { type: "string" },
      "expect-owner": { type: "string" },
      "expect-head": { type: "string" },
      "generated-root": { type: "string", multiple: true }
    }
  });
  const [command, slug] = positionals;
  const manager = createCheckoutManager(options);
  let result;
  if (command === "create") {
    result = manager.create({
      slug,
      ownerTask: values.owner,
      branch: values.branch,
      base: values.base ?? "HEAD",
      remote: values.remote ?? "origin",
      generatedRoots: values["generated-root"] ?? []
    });
  } else if (command === "status") result = manager.status(slug);
  else if (command === "audit") result = manager.audit(slug);
  else if (command === "handoff") {
    result = manager.handoff({
      slug,
      ownerTask: values.owner,
      nextOwnerTask: values.to,
      expectedRevision: parseRevision(values.revision)
    });
  } else if (command === "finish") {
    result = manager.finish({ slug, ownerTask: values.owner, expectedRevision: parseRevision(values.revision) });
  } else if (command === "plan-retirement") {
    result = manager.planRetirement({
      slug,
      ownerTask: values.owner,
      expectedRevision: parseRevision(values.revision),
      expectedGeneration: parseGeneration(values.generation)
    });
  } else if (command === "abandon") {
    result = manager.abandon({
      slug,
      expectedOwnerTask: values["expect-owner"],
      expectedHead: values["expect-head"],
      expectedRevision: parseRevision(values.revision)
    });
  } else fail("invalid-cli", "Use create, status, audit, handoff, finish, plan-retirement, or abandon.");
  (options.stdout ?? process.stdout).write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCheckoutLifecycleCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof CheckoutLifecycleError ? error.code : "unexpected-error"}: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}
