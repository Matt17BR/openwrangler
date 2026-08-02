import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statfsSync,
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
const ARCHIVE_RECEIPT_PROTOCOL = "openwrangler-checkout-archive-v1";
const ARCHIVE_COMPLETION_PROTOCOL = "openwrangler-checkout-archive-completion-v1";
const MAXIMUM_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAXIMUM_BUNDLE_HEADER_BYTES = 4 * 1024 * 1024;
const ARCHIVE_SPACE_MULTIPLIER = 8n;
const ARCHIVE_SPACE_RESERVE_BYTES = 512n * 1024n * 1024n;
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
const MAXIMUM_ARCHIVE_ATTEMPTS = 8;
const MAXIMUM_ARCHIVE_DIRECTORIES = MAXIMUM_ENTRIES * MAXIMUM_ARCHIVE_ATTEMPTS;
const MAXIMUM_ARCHIVE_REFS = 32_768;
const MAXIMUM_ARCHIVE_PACK_FILES = 16_384;
const MAXIMUM_ARCHIVE_REFLOG_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ARCHIVE_REFLOG_ENTRIES = 262_144;
const MAXIMUM_VERIFICATION_FILES = 4096;
const MAXIMUM_VERIFICATION_DEPTH = 16;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const REMOTE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;
const GENERATED_ROOT_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,80}$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const IDENTITY_PATTERN = /^(?:0|[1-9][0-9]{0,39})$/u;
const ENTRY_FILE_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})\.json$/u;
const LOCK_FILE_PATTERN = /^([1-9][0-9]{0,8})\.(claim|release)\.json$/u;
const ARCHIVE_ATTEMPT_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})\.([1-8])$/u;

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

function validateOwnedRegularFile(metadata, label, privateMode = undefined) {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    !currentUserOwns(metadata) ||
    metadata.size < 1n ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    (privateMode !== undefined && typeof process.getuid === "function" && (metadata.mode & 0o777n) !== privateMode)
  ) {
    fail("unsafe-archive", `${label} is not one non-empty owned regular file.`);
  }
}

function hashDescriptor(descriptor, label, privateMode = undefined) {
  const before = fstatSync(descriptor, { bigint: true });
  validateOwnedRegularFile(before, label, privateMode);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const size = Number(before.size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (count === 0) fail("archive-changed", `${label} changed while it was hashed.`);
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (!sameIdentity(identityOf(before), identityOf(after)) || before.size !== after.size) {
    fail("archive-changed", `${label} changed while it was hashed.`);
  }
  return Object.freeze({ identity: identityOf(before), byteLength: size, sha256: hash.digest("hex") });
}

function captureArchiveFile(path, label) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const receipt = hashDescriptor(descriptor, label, 0o600n);
    revalidatePathIdentity(path, receipt.identity, label);
    return receipt;
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("unsafe-archive", `${label} could not be read safely: ${error.message}`);
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

function readJsonReceipt(path, maximumBytes, label) {
  const file = readBoundedFile(path, maximumBytes, label, 0o600n);
  try {
    rejectDuplicateJsonKeys(file.text, label);
    return Object.freeze({
      value: JSON.parse(file.text),
      identity: file.identity,
      byteLength: Buffer.byteLength(file.text, "utf8"),
      sha256: sha256(file.text)
    });
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
  const stdoutFd = options.stdoutFd;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    stdio: [options.input === undefined ? "ignore" : "pipe", stdoutFd === undefined ? "pipe" : stdoutFd, "pipe"]
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
    env: options.env,
    stdoutFd: options.stdoutFd,
    input: options.input
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

function parseRefList(output, objectFormat, label, options = {}) {
  if (typeof output !== "string" || !["sha1", "sha256"].includes(objectFormat)) {
    fail("invalid-archive", `${label} is malformed.`);
  }
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  const refs =
    output === ""
      ? []
      : output
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const space = line.indexOf(" ");
            const oid = space === -1 ? "" : line.slice(0, space);
            const ref = space === -1 ? "" : line.slice(space + 1);
            if (
              oid.length !== oidLength ||
              !/^[0-9a-f]+$/u.test(oid) ||
              !(
                ref.startsWith("refs/") ||
                (options.allowHead === true && ref === "HEAD") ||
                (options.allowWorktreeHeads === true && /^worktrees\/[A-Za-z0-9._-]{1,240}\/HEAD$/u.test(ref)) ||
                (options.allowArchivePseudorefs === true &&
                  (ref === "ORIG_HEAD" || /^worktrees\/[A-Za-z0-9._-]{1,240}\/ORIG_HEAD$/u.test(ref)))
              ) ||
              Buffer.byteLength(ref, "utf8") > 4096 ||
              [...ref].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
            ) {
              fail("invalid-archive", `${label} contains an invalid reference.`);
            }
            return Object.freeze({ oid, ref });
          });
  if (
    refs.length < 1 ||
    refs.length > MAXIMUM_ARCHIVE_REFS ||
    new Set(refs.map((item) => item.ref)).size !== refs.length
  ) {
    fail("invalid-archive", `${label} contains duplicate, missing, or too many references.`);
  }
  return Object.freeze([...refs].sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref))));
}

function refsReceipt(refs) {
  const canonical = refs.map(({ oid, ref }) => `${oid} ${ref}`).join("\n") + "\n";
  return Object.freeze({ count: refs.length, sha256: sha256(canonical) });
}

function parseBundleHeader(path, expectedObjectFormat) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const chunks = [];
    let length = 0;
    let headerEnd = -1;
    while (length < MAXIMUM_BUNDLE_HEADER_BYTES && (headerEnd === -1 || length < headerEnd + 6)) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAXIMUM_BUNDLE_HEADER_BYTES - length));
      const count = readSync(descriptor, buffer, 0, buffer.length, length);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      length += count;
      headerEnd = Buffer.concat(chunks).indexOf("\n\n");
    }
    const bytes = Buffer.concat(chunks);
    headerEnd = bytes.indexOf("\n\n");
    if (
      headerEnd === -1 ||
      bytes.length < headerEnd + 6 ||
      bytes.subarray(headerEnd + 2, headerEnd + 6).toString() !== "PACK"
    ) {
      fail("invalid-archive", "The Git bundle has no bounded complete header or pack payload.");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, headerEnd));
    } catch {
      fail("invalid-archive", "The Git bundle header is not valid UTF-8.");
    }
    const lines = text.split("\n");
    const signature = lines.shift();
    const version = signature === "# v2 git bundle" ? 2 : signature === "# v3 git bundle" ? 3 : 0;
    if (version === 0) fail("invalid-archive", "The Git bundle version is unsupported.");
    const capabilities = [];
    const referenceLines = [];
    let prerequisiteCount = 0;
    for (const line of lines) {
      if (line.startsWith("@")) capabilities.push(line.slice(1));
      else if (line.startsWith("-")) prerequisiteCount += 1;
      else referenceLines.push(line);
    }
    if (prerequisiteCount !== 0) fail("archive-not-self-contained", "The Git bundle has prerequisites.");
    const expectedCapability = `object-format=${expectedObjectFormat}`;
    if (
      (version === 2 && (expectedObjectFormat !== "sha1" || capabilities.length !== 0)) ||
      (version === 3 && (capabilities.length !== 1 || capabilities[0] !== expectedCapability))
    ) {
      fail("archive-not-self-contained", "The Git bundle has an unexpected object format or capability.");
    }
    const refs = parseRefList(`${referenceLines.join("\n")}\n`, expectedObjectFormat, "Git bundle header", {
      allowHead: true,
      allowWorktreeHeads: true,
      allowArchivePseudorefs: true
    });
    return Object.freeze({ version, objectFormat: expectedObjectFormat, capabilities, prerequisiteCount, refs });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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

function unsafeArchiveConfigKeys(output) {
  return Object.freeze(
    output
      .split("\0")
      .filter(Boolean)
      .map((key) => key.toLowerCase())
      .filter(
        (key) =>
          key === "extensions.partialclone" ||
          /^remote\..+\.(?:promisor|partialclonefilter)$/u.test(key) ||
          /^filter\..+\.(?:clean|process|required)$/u.test(key)
      )
  );
}

function entryExistsNoFollow(path, label) {
  try {
    lstatSync(path, { bigint: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    fail("archive-not-eligible", `${label} could not be inspected safely: ${error.message}`);
  }
}

function decimalBigInt(value, label) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9][0-9]{0,39})$/u.test(trimmed)) {
    fail("archive-not-eligible", `${label} is malformed.`);
  }
  return BigInt(trimmed);
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

function captureVerificationRepository(path, expectedIdentity) {
  revalidatePathIdentity(path, expectedIdentity, "Verification repository", "directory");
  const records = [];
  let fileCount = 0;
  let directoryCount = 0;
  let byteLength = 0n;

  function visit(directoryPath, relativePath, depth) {
    if (depth > MAXIMUM_VERIFICATION_DEPTH) {
      fail("unsafe-archive", "The verification repository is nested too deeply.");
    }
    const metadata = lstatSync(directoryPath, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      realpathSync(directoryPath) !== resolve(directoryPath)
    ) {
      fail("unsafe-archive", "The verification repository contains an unsafe directory.");
    }
    directoryCount += 1;
    if (directoryCount + fileCount > MAXIMUM_VERIFICATION_FILES) {
      fail("unsafe-archive", "The verification repository contains too many entries.");
    }
    const directoryIdentity = identityOf(metadata);
    records.push(`d\0${relativePath}\0${directoryIdentity.device}\0${directoryIdentity.inode}\n`);
    const entries = readDirectoryBounded(directoryPath, MAXIMUM_VERIFICATION_FILES, "The verification repository").sort(
      (left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    for (const item of entries) {
      if ([...item.name].some((character) => character.charCodeAt(0) === 0)) {
        fail("unsafe-archive", "The verification repository contains an invalid path.");
      }
      const childPath = join(directoryPath, item.name);
      const childRelative = relativePath === "" ? item.name : `${relativePath}/${item.name}`;
      if (item.isDirectory() && !item.isSymbolicLink()) {
        visit(childPath, childRelative, depth + 1);
        continue;
      }
      if (!item.isFile() || item.isSymbolicLink()) {
        fail("unsafe-archive", "The verification repository contains a symlink or special file.");
      }
      let descriptor;
      try {
        descriptor = openSync(childPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          fsyncSync(descriptor);
        } catch (error) {
          if (process.platform !== "win32" || !["EINVAL", "EPERM"].includes(error.code)) throw error;
        }
        const receipt = hashDescriptor(descriptor, `Verification repository file ${childRelative}`);
        revalidatePathIdentity(childPath, receipt.identity, `Verification repository file ${childRelative}`);
        fileCount += 1;
        byteLength += BigInt(receipt.byteLength);
        if (directoryCount + fileCount > MAXIMUM_VERIFICATION_FILES) {
          fail("unsafe-archive", "The verification repository contains too many entries.");
        }
        records.push(
          `f\0${childRelative}\0${receipt.identity.device}\0${receipt.identity.inode}\0${receipt.byteLength}\0${receipt.sha256}\n`
        );
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    fsyncDirectory(directoryPath);
    revalidatePathIdentity(directoryPath, directoryIdentity, "Verification repository directory", "directory");
  }

  visit(path, "", 0);
  revalidatePathIdentity(path, expectedIdentity, "Verification repository", "directory");
  return Object.freeze({
    path,
    identity: expectedIdentity,
    directoryCount,
    fileCount,
    byteLength: byteLength.toString(),
    sha256: sha256(records.join(""))
  });
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
    retirements: join(managerRoot, "retirements"),
    archives: join(managerRoot, "archives")
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

  function initializeArchiveJournal() {
    const identity = managedIdentities.get(paths.archives);
    if (identity === undefined) {
      managedIdentities.set(paths.archives, ensurePrivateDirectory(paths.archives));
      return;
    }
    assertPrivateDirectory(paths.archives, paths.archives);
    revalidatePathIdentity(paths.archives, identity, paths.archives, "directory");
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

  function archiveAttemptPath(slug, generation, attempt) {
    assertSlug(slug);
    assertGeneration(generation);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAXIMUM_ARCHIVE_ATTEMPTS) {
      fail("invalid-archive", "The archive attempt is out of range.");
    }
    return join(paths.archives, `${slug}.${generation}.${attempt}`);
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

  function readRetirementPlan(entry) {
    initializeRetirementJournal();
    const path = retirementPath(entry.slug, entry.generation);
    if (!existsSync(path)) fail("retirement-evidence-missing", "Retirement evidence must be recorded first.");
    const loaded = readJsonReceipt(path, MAXIMUM_ENTRY_BYTES, `Retirement evidence for ${entry.slug}`);
    validateRetirementEvidence(loaded.value, entry);
    return Object.freeze({
      path,
      identity: loaded.identity,
      byteLength: loaded.byteLength,
      sha256: loaded.sha256,
      value: loaded.value
    });
  }

  function revalidateRetirementPlan(plan, entry) {
    revalidatePathIdentity(plan.path, plan.identity, `Retirement evidence for ${entry.slug}`);
    const current = readRetirementPlan(entry);
    if (
      !sameIdentity(current.identity, plan.identity) ||
      current.byteLength !== plan.byteLength ||
      current.sha256 !== plan.sha256 ||
      !isDeepStrictEqual(current.value, plan.value)
    ) {
      fail("registry-changed", "The retirement evidence changed while the archive was prepared.");
    }
  }

  function requireCommonArchiveCommand(args, label, options = {}) {
    const result = commonGit(run, paths, repository, args, {
      allowFailure: true,
      env: auditGitEnvironment(),
      stdoutFd: options.stdoutFd,
      input: options.input
    });
    if (result.status !== 0) fail("archive-command-failed", `${label} failed.`);
    return result;
  }

  function requireArchiveGitCommand(gitDirectory, args, label, options = {}) {
    const result = run("git", ["--git-dir", gitDirectory, ...args], {
      cwd: options.cwd ?? paths.root,
      allowFailure: true,
      env: auditGitEnvironment(),
      input: options.input
    });
    if (result.status !== 0) fail("archive-command-failed", `${label} failed.`);
    return result;
  }

  function requireStandaloneArchiveGitCommand(args, cwd, label) {
    const result = run("git", args, {
      cwd,
      allowFailure: true,
      env: auditGitEnvironment()
    });
    if (result.status !== 0) fail("archive-command-failed", `${label} failed.`);
    return result;
  }

  function archiveFreeSpace(objectDiskBytes) {
    let filesystem;
    try {
      filesystem = statfsSync(paths.root, { bigint: true });
    } catch (error) {
      fail("archive-not-eligible", `Archive free space could not be inspected: ${error.message}`);
    }
    if (filesystem.bsize <= 0n || filesystem.bavail < 0n) {
      fail("archive-not-eligible", "Archive free space reporting is malformed.");
    }
    const availableBytes = filesystem.bsize * filesystem.bavail;
    const requiredBytes = objectDiskBytes * ARCHIVE_SPACE_MULTIPLIER + ARCHIVE_SPACE_RESERVE_BYTES;
    if (availableBytes < requiredBytes) {
      fail(
        "archive-space-insufficient",
        `The archive needs a conservative ${requiredBytes}-byte free-space budget; ${availableBytes} bytes are available.`
      );
    }
    return Object.freeze({
      objectDiskBytes: objectDiskBytes.toString(),
      multiplier: Number(ARCHIVE_SPACE_MULTIPLIER),
      reserveBytes: ARCHIVE_SPACE_RESERVE_BYTES.toString(),
      requiredBytes: requiredBytes.toString(),
      availableBytes: availableBytes.toString()
    });
  }

  function captureOrigHead(gitDirectory, ref, objectIdLength, label) {
    const path = join(gitDirectory, "ORIG_HEAD");
    if (!entryExistsNoFollow(path, `${label} ORIG_HEAD`)) return null;
    const file = readBoundedFile(path, 256, `${label} ORIG_HEAD`);
    const match = new RegExp(`^([0-9a-f]{${objectIdLength}})\\n?$`, "u").exec(file.text);
    if (match === null) fail("archive-not-eligible", `${label} ORIG_HEAD is malformed.`);
    return Object.freeze({
      oid: match[1],
      ref,
      state: Object.freeze({
        path,
        identity: file.identity,
        byteLength: Buffer.byteLength(file.text, "utf8"),
        sha256: sha256(file.text)
      })
    });
  }

  function captureTargetAdminState(entry, objectIdLength) {
    const adminPath = entry.checkout.gitAdmin.path;
    revalidatePathIdentity(adminPath, entry.checkout.gitAdmin.identity, "Target Git admin", "directory");
    const allowedFiles = new Set(["COMMIT_EDITMSG", "HEAD", "ORIG_HEAD", "commondir", "gitdir", "index"]);
    const allowedDirectories = new Set(["logs", "refs"]);
    const records = [];
    const entries = readDirectoryBounded(adminPath, 32, "The target Git admin directory").sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    for (const item of entries) {
      const path = join(adminPath, item.name);
      const metadata = lstatSync(path, { bigint: true });
      if (item.isSymbolicLink() || !currentUserOwns(metadata)) {
        fail("archive-not-eligible", "The target Git admin directory contains an unsafe entry.");
      }
      if (item.isFile() && allowedFiles.has(item.name)) {
        if (!metadata.isFile() || metadata.nlink !== 1n) {
          fail("archive-not-eligible", "The target Git admin directory contains an unsafe file.");
        }
        const identity = identityOf(metadata);
        records.push(
          `f\0${item.name}\0${identity.device}\0${identity.inode}\0${metadata.size}\0${metadata.mtimeNs}\0${metadata.ctimeNs}\n`
        );
        continue;
      }
      if (item.isDirectory() && allowedDirectories.has(item.name)) {
        if (!metadata.isDirectory() || realpathSync(path) !== resolve(path)) {
          fail("archive-not-eligible", "The target Git admin directory contains an unsafe directory.");
        }
        const identity = identityOf(metadata);
        records.push(`d\0${item.name}\0${identity.device}\0${identity.inode}\n`);
        continue;
      }
      fail(
        "archive-not-eligible",
        `Unsupported operation or private metadata exists in the target Git admin directory: ${item.name}.`
      );
    }

    const privateRefsPath = join(adminPath, "refs");
    if (
      entryExistsNoFollow(privateRefsPath, "The target private-ref directory") &&
      readDirectoryBounded(privateRefsPath, 1, "The target private-ref directory").length !== 0
    ) {
      fail("archive-not-eligible", "Private target-worktree refs would not survive cleanup.");
    }

    const logsPath = join(adminPath, "logs");
    const reflogObjectIds = [];
    let reflogEntryCount = 0;
    if (entryExistsNoFollow(logsPath, "The target reflog directory")) {
      const logEntries = readDirectoryBounded(logsPath, 2, "The target reflog directory");
      if (
        logEntries.length !== 1 ||
        logEntries[0].name !== "HEAD" ||
        !logEntries[0].isFile() ||
        logEntries[0].isSymbolicLink()
      ) {
        fail("archive-not-eligible", "The target reflog directory contains unsupported state.");
      }
      const reflog = readBoundedFile(join(logsPath, "HEAD"), MAXIMUM_ARCHIVE_REFLOG_BYTES, "Target HEAD reflog");
      const lines = reflog.text === "" ? [] : reflog.text.split("\n");
      if (lines.at(-1) !== "") fail("archive-not-eligible", "The target HEAD reflog is malformed.");
      lines.pop();
      if (lines.length > MAXIMUM_ARCHIVE_REFLOG_ENTRIES) {
        fail("archive-not-eligible", "The target HEAD reflog contains too many entries.");
      }
      const pattern = new RegExp(`^([0-9a-f]{${objectIdLength}}) ([0-9a-f]{${objectIdLength}}) .+$`, "u");
      const zero = "0".repeat(objectIdLength);
      for (const line of lines) {
        const match = pattern.exec(line);
        if (match === null) fail("archive-not-eligible", "The target HEAD reflog is malformed.");
        if (match[1] !== zero) reflogObjectIds.push(match[1]);
        if (match[2] !== zero) reflogObjectIds.push(match[2]);
      }
      reflogEntryCount = lines.length;
      records.push(
        `l\0logs/HEAD\0${reflog.identity.device}\0${reflog.identity.inode}\0${Buffer.byteLength(reflog.text, "utf8")}\0${sha256(reflog.text)}\n`
      );
    }
    revalidatePathIdentity(adminPath, entry.checkout.gitAdmin.identity, "Target Git admin", "directory");
    return Object.freeze({
      sha256: sha256(records.join("")),
      reflogEntryCount,
      reflogObjectIds: Object.freeze([...new Set(reflogObjectIds)].sort())
    });
  }

  function resolveArchiveCommitIds(objectIds, objectFormat, label, requireEveryObject) {
    const unique = [...new Set(objectIds)].sort();
    if (unique.length === 0) return Object.freeze([]);
    const resolved = requireCommonArchiveCommand(
      ["--no-pager", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      label,
      { input: `${unique.map((oid) => `${oid}^{commit}`).join("\n")}\n` }
    ).stdout.split("\n");
    resolved.pop();
    if (resolved.length !== unique.length) fail("archive-not-eligible", `${label} returned malformed output.`);
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    const commitIds = [];
    for (const line of resolved) {
      const match = /^([0-9a-f]+) commit (?:0|[1-9][0-9]*)$/u.exec(line);
      if (match === null || match[1].length !== expectedLength) {
        if (requireEveryObject) fail("archive-not-eligible", `${label} contains a missing or non-commit object.`);
        continue;
      }
      commitIds.push(match[1]);
    }
    return Object.freeze([...new Set(commitIds)].sort());
  }

  function assertTargetReflogReachable(reflogObjectIds, bundleHeads, objectFormat) {
    const reflogCommits = resolveArchiveCommitIds(
      reflogObjectIds,
      objectFormat,
      "Target HEAD reflog object inspection",
      true
    );
    if (reflogCommits.length === 0) return;
    const rootCommits = resolveArchiveCommitIds(
      bundleHeads.map(({ oid }) => oid),
      objectFormat,
      "Recovery-root commit inspection",
      false
    );
    if (rootCommits.length === 0) fail("archive-not-eligible", "The recovery archive has no commit root.");
    const unreachable = requireCommonArchiveCommand(
      ["--no-pager", "rev-list", "--max-count=1", "--stdin"],
      "Target HEAD reflog reachability inspection",
      { input: `${reflogCommits.join("\n")}\n${rootCommits.map((oid) => `^${oid}`).join("\n")}\n` }
    ).stdout.trim();
    if (unreachable !== "") {
      fail("archive-not-eligible", "The target HEAD reflog is the only recovery path to one or more commits.");
    }
  }

  function captureRepositoryArchiveState(entry, expectedGit) {
    if (!SHA_PATTERN.test(expectedGit?.head) || !SHA_PATTERN.test(expectedGit?.headTree)) {
      fail("archive-not-eligible", "The retirement plan has no valid Git head to archive.");
    }
    const objectFormat = requireCommonArchiveCommand(
      ["--no-pager", "rev-parse", "--show-object-format"],
      "Git object-format inspection"
    ).stdout.trim();
    if (!["sha1", "sha256"].includes(objectFormat)) {
      fail("archive-not-eligible", "The repository object format is unsupported.");
    }
    const shallow = requireCommonArchiveCommand(
      ["--no-pager", "rev-parse", "--is-shallow-repository"],
      "Git shallow-repository inspection"
    ).stdout.trim();
    if (shallow !== "false") fail("archive-not-eligible", "A shallow repository cannot produce this recovery archive.");
    const configNames = requireCommonArchiveCommand(
      ["--no-pager", "config", "--local", "--null", "--name-only", "--list"],
      "Git archive configuration inspection"
    ).stdout;
    const unsafeConfigKeys = unsafeArchiveConfigKeys(configNames);
    if (unsafeConfigKeys.length !== 0) {
      fail(
        "archive-not-eligible",
        "Partial-clone, promisor, or content-filter configuration cannot be archived safely."
      );
    }
    const config = requireCommonArchiveCommand(
      ["--no-pager", "config", "--local", "--null", "--list"],
      "Git archive configuration capture"
    ).stdout;
    const prohibitedObjectMetadata = [
      [join(repository.commonGitDirectory, "info", "grafts"), "Git grafts"],
      [join(repository.commonGitDirectory, "objects", "info", "alternates"), "Git object alternates"],
      [join(repository.commonGitDirectory, "objects", "info", "http-alternates"), "Git HTTP object alternates"]
    ];
    for (const [path, label] of prohibitedObjectMetadata) {
      if (entryExistsNoFollow(path, label)) {
        fail("archive-not-eligible", `${label} are unsupported by the recovery archive.`);
      }
    }
    const packDirectory = join(repository.commonGitDirectory, "objects", "pack");
    let packStateSha256 = sha256("");
    let promisorMarkerCount = 0;
    if (entryExistsNoFollow(packDirectory, "The Git pack directory")) {
      const packMetadata = lstatSync(packDirectory, { bigint: true });
      if (
        !packMetadata.isDirectory() ||
        packMetadata.isSymbolicLink() ||
        !currentUserOwns(packMetadata) ||
        realpathSync(packDirectory) !== resolve(packDirectory)
      ) {
        fail("archive-not-eligible", "The Git pack directory is unsafe.");
      }
      const packRecords = [];
      const packEntries = readDirectoryBounded(
        packDirectory,
        MAXIMUM_ARCHIVE_PACK_FILES,
        "The Git pack directory"
      ).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      for (const item of packEntries) {
        const path = join(packDirectory, item.name);
        const metadata = lstatSync(path, { bigint: true });
        if (!metadata.isFile() || metadata.isSymbolicLink() || !currentUserOwns(metadata)) {
          fail("archive-not-eligible", "The Git pack directory contains an unsafe entry.");
        }
        if (item.name.toLowerCase().endsWith(".promisor")) promisorMarkerCount += 1;
        const identity = identityOf(metadata);
        packRecords.push(`${item.name}\0${identity.device}\0${identity.inode}\0${metadata.size}\n`);
      }
      packStateSha256 = sha256(packRecords.join(""));
    }
    if (promisorMarkerCount !== 0) {
      fail("archive-not-eligible", "A promisor pack cannot be used for a self-contained recovery archive.");
    }
    const refs = parseRefList(
      requireCommonArchiveCommand(
        ["--no-pager", "for-each-ref", "--sort=refname", "--format=%(objectname) %(refname)", "refs/"],
        "Git reference inspection"
      ).stdout,
      objectFormat,
      "Repository references"
    );
    const branchRef = `refs/heads/${entry.branch}`;
    const branch = refs.find((item) => item.ref === branchRef);
    if (branch?.oid !== expectedGit.head) {
      fail("archive-not-eligible", "The checkout branch no longer points to the head recorded for retirement.");
    }
    const commonHead = requireCommonArchiveCommand(
      ["--no-pager", "rev-parse", "--verify", "HEAD"],
      "Git common HEAD inspection"
    ).stdout.trim();
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    if (commonHead.length !== expectedLength || !/^[0-9a-f]+$/u.test(commonHead)) {
      fail("archive-not-eligible", "The Git common HEAD is malformed.");
    }
    const symbolic = commonGit(run, paths, repository, ["--no-pager", "symbolic-ref", "--quiet", "HEAD"], {
      allowFailure: true,
      env: auditGitEnvironment()
    });
    if (![0, 1].includes(symbolic.status)) fail("archive-command-failed", "Git common HEAD inspection failed.");
    const commonHeadTarget = symbolic.status === 0 ? symbolic.stdout.trim() : null;
    if (commonHeadTarget !== null && !commonHeadTarget.startsWith("refs/")) {
      fail("archive-not-eligible", "The Git common HEAD target is malformed.");
    }
    const linkedHeads = [];
    const worktreeGitDirectories = [
      { path: repository.commonGitDirectory, label: "main worktree", refPrefix: "", target: false }
    ];
    const worktreeAdminRoot = join(repository.commonGitDirectory, "worktrees");
    if (existsSync(worktreeAdminRoot)) {
      const rootMetadata = lstatSync(worktreeAdminRoot, { bigint: true });
      if (
        !rootMetadata.isDirectory() ||
        rootMetadata.isSymbolicLink() ||
        !currentUserOwns(rootMetadata) ||
        realpathSync(worktreeAdminRoot) !== worktreeAdminRoot
      ) {
        fail("archive-not-eligible", "The Git linked-worktree registry is unsafe.");
      }
      for (const item of readDirectoryBounded(
        worktreeAdminRoot,
        MAXIMUM_WORKTREE_RECORDS,
        "The Git worktree registry"
      )) {
        if (!item.isDirectory() || item.isSymbolicLink() || !/^[A-Za-z0-9._-]{1,240}$/u.test(item.name)) {
          fail("archive-not-eligible", "The Git linked-worktree registry is malformed.");
        }
        const adminPath = join(worktreeAdminRoot, item.name);
        const adminMetadata = lstatSync(adminPath, { bigint: true });
        if (
          !adminMetadata.isDirectory() ||
          adminMetadata.isSymbolicLink() ||
          !currentUserOwns(adminMetadata) ||
          realpathSync(adminPath) !== adminPath
        ) {
          fail("archive-not-eligible", "A Git linked-worktree entry is unsafe.");
        }
        worktreeGitDirectories.push({
          path: adminPath,
          label: `linked worktree ${item.name}`,
          refPrefix: `worktrees/${item.name}/`,
          target: adminPath === entry.checkout.gitAdmin.path
        });
        const ref = `worktrees/${item.name}/HEAD`;
        const oid = requireCommonArchiveCommand(
          ["--no-pager", "rev-parse", "--verify", ref],
          "Git linked-worktree HEAD inspection"
        ).stdout.trim();
        if (oid.length !== expectedLength || !/^[0-9a-f]+$/u.test(oid)) {
          fail("archive-not-eligible", "A Git linked-worktree HEAD is malformed.");
        }
        linkedHeads.push(Object.freeze({ oid, ref }));
      }
    }
    if (worktreeGitDirectories.filter(({ target }) => target).length !== 1) {
      fail("archive-not-eligible", "The target Git admin directory is not registered exactly once.");
    }
    const pseudorefs = [];
    for (const gitDirectory of worktreeGitDirectories) {
      const origHead = captureOrigHead(
        gitDirectory.path,
        `${gitDirectory.refPrefix}ORIG_HEAD`,
        expectedLength,
        gitDirectory.label
      );
      if (origHead !== null) pseudorefs.push(origHead);
      const privateRefsOutput = requireArchiveGitCommand(
        gitDirectory.path,
        [
          "--no-pager",
          "for-each-ref",
          "--sort=refname",
          "--format=%(objectname) %(refname)",
          "refs/worktree/",
          "refs/bisect/",
          "refs/rewritten/"
        ],
        `Private ref inspection for ${gitDirectory.label}`
      ).stdout;
      if (privateRefsOutput !== "") {
        parseRefList(privateRefsOutput, objectFormat, `Private refs for ${gitDirectory.label}`);
        fail("archive-not-eligible", `Private refs exist for ${gitDirectory.label} and would not survive cleanup.`);
      }
    }
    linkedHeads.sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)));
    pseudorefs.sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)));
    const targetAdminState = captureTargetAdminState(entry, expectedLength);
    const bundleHeads = Object.freeze(
      [
        ...refs,
        Object.freeze({ oid: commonHead, ref: "HEAD" }),
        ...linkedHeads,
        ...pseudorefs.map(({ oid, ref }) => Object.freeze({ oid, ref }))
      ].sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)))
    );
    if (new Set(bundleHeads.map(({ ref }) => ref)).size !== bundleHeads.length) {
      fail("archive-not-eligible", "Recovery roots contain duplicate names.");
    }
    assertTargetReflogReachable(targetAdminState.reflogObjectIds, bundleHeads, objectFormat);
    const objectDiskBytes = decimalBigInt(
      requireCommonArchiveCommand(
        ["--no-pager", "rev-list", "--disk-usage", "--objects", "--all", ...pseudorefs.map(({ ref }) => ref)],
        "Reachable Git object-size inspection"
      ).stdout,
      "Reachable Git object size"
    );
    return Object.freeze({
      objectFormat,
      shallow: false,
      branchRef,
      refs,
      refsReceipt: refsReceipt(refs),
      commonHead: Object.freeze({ oid: commonHead, symbolicTarget: commonHeadTarget }),
      linkedHeads: Object.freeze(linkedHeads),
      pseudorefs: Object.freeze(pseudorefs),
      pseudorefsReceipt: refsReceipt(pseudorefs),
      bundleHeads,
      bundleHeadsReceipt: refsReceipt(bundleHeads),
      safety: Object.freeze({
        configSha256: sha256(config),
        configNamesSha256: sha256(configNames),
        unsafeConfigKeyCount: unsafeConfigKeys.length,
        graftsPresent: false,
        alternatesPresent: false,
        httpAlternatesPresent: false,
        promisorMarkerCount,
        packStateSha256,
        privateRefCount: 0,
        targetAdminStateSha256: targetAdminState.sha256,
        targetReflogEntryCount: targetAdminState.reflogEntryCount,
        unreachableTargetReflogCommitCount: 0
      }),
      objectDiskBytes
    });
  }

  function archiveAttempts(slug, generation) {
    const entries = readDirectoryBounded(paths.archives, MAXIMUM_ARCHIVE_DIRECTORIES, "The archive journal");
    const attempts = [];
    for (const item of entries) {
      const match = ARCHIVE_ATTEMPT_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-archive", "The archive journal contains an unknown entry.");
      }
      if (match[1] === slug && Number(match[2]) === generation) {
        const attempt = Number(match[3]);
        if (attempt < 1 || attempt > MAXIMUM_ARCHIVE_ATTEMPTS) {
          fail("invalid-archive", "The archive journal contains an invalid attempt.");
        }
        attempts.push(attempt);
        if (existsSync(join(paths.archives, item.name, "complete.json"))) {
          fail("archive-evidence-exists", "A completed recovery archive already exists.");
        }
      }
    }
    if (new Set(attempts).size !== attempts.length) fail("invalid-archive", "The archive journal is ambiguous.");
    return attempts.sort((left, right) => left - right);
  }

  function createArchiveAttempt(slug, generation) {
    const prior = archiveAttempts(slug, generation);
    const attempt = (prior.at(-1) ?? 0) + 1;
    if (attempt > MAXIMUM_ARCHIVE_ATTEMPTS) fail("archive-attempts-exhausted", "Too many archive attempts exist.");
    const path = archiveAttemptPath(slug, generation, attempt);
    const archiveRootIdentity = managedIdentities.get(paths.archives);
    if (archiveRootIdentity === undefined) fail("unsafe-manager", "The archive journal was not initialized.");
    revalidatePathIdentity(paths.archives, archiveRootIdentity, paths.archives, "directory");
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    } catch (error) {
      if (error.code === "EEXIST") fail("archive-changed", "The next archive attempt appeared concurrently.");
      throw error;
    }
    fsyncDirectory(paths.archives);
    const identity = assertPrivateDirectory(path, "Archive attempt directory");
    revalidatePathIdentity(paths.archives, archiveRootIdentity, paths.archives, "directory");
    return Object.freeze({ attempt, path, identity });
  }

  function createBundle(attempt, pseudorefs) {
    const path = join(attempt.path, "archive.bundle");
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    let descriptor;
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      if (typeof process.getuid === "function") fchmodSync(descriptor, 0o600);
      const empty = fstatSync(descriptor, { bigint: true });
      if (
        !empty.isFile() ||
        empty.isSymbolicLink() ||
        empty.nlink !== 1n ||
        empty.size !== 0n ||
        !currentUserOwns(empty) ||
        (typeof process.getuid === "function" && (empty.mode & 0o777n) !== 0o600n)
      ) {
        fail("unsafe-archive", "The new bundle file is unsafe.");
      }
      const result = commonGit(
        run,
        paths,
        repository,
        [
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "-c",
          `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
          "-c",
          "submodule.recurse=false",
          "-c",
          "pack.threads=1",
          "-c",
          "pack.window=4",
          "-c",
          "pack.depth=10",
          "-c",
          "pack.windowMemory=32m",
          "-c",
          "pack.deltaCacheSize=16m",
          "-c",
          "core.bigFileThreshold=16m",
          "bundle",
          "create",
          "-q",
          "-",
          "--all",
          ...pseudorefs.map(({ ref }) => ref)
        ],
        {
          allowFailure: true,
          env: auditGitEnvironment(),
          stdoutFd: descriptor
        }
      );
      fsyncSync(descriptor);
      if (result.status !== 0) fail("archive-command-failed", "Git bundle creation failed.");
      const receipt = hashDescriptor(descriptor, "Recovery bundle", 0o600n);
      revalidatePathIdentity(path, receipt.identity, "Recovery bundle");
      revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
      return Object.freeze({ path, ...receipt });
    } catch (error) {
      if (error instanceof CheckoutLifecycleError) throw error;
      fail("archive-command-failed", `The recovery bundle could not be created safely: ${error.message}`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      fsyncDirectory(attempt.path);
    }
  }

  function createPrivateAttemptDirectory(attempt, name, label) {
    const path = join(attempt.path, name);
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    } catch (error) {
      if (error.code === "EEXIST") fail("archive-changed", `${label} appeared concurrently.`);
      throw error;
    }
    fsyncDirectory(attempt.path);
    const identity = assertPrivateDirectory(path, label);
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    return Object.freeze({ path, identity });
  }

  function proveBundleRecovery(attempt, bundle, expectedHeads, objectFormat) {
    const template = createPrivateAttemptDirectory(attempt, "verification-template", "Verification template");
    const verification = createPrivateAttemptDirectory(attempt, "verification.git", "Verification repository");
    requireStandaloneArchiveGitCommand(
      [
        "init",
        "--bare",
        "--quiet",
        `--object-format=${objectFormat}`,
        `--template=${template.path}`,
        verification.path
      ],
      attempt.path,
      "Verification repository initialization"
    );
    revalidatePathIdentity(template.path, template.identity, "Verification template", "directory");
    if (readDirectoryBounded(template.path, 1, "The verification template").length !== 0) {
      fail("archive-changed", "The empty verification template changed during initialization.");
    }
    revalidatePathIdentity(verification.path, verification.identity, "Verification repository", "directory");
    const isBare = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "rev-parse", "--is-bare-repository"],
      "Verification repository bare-state inspection"
    ).stdout.trim();
    const verifiedObjectFormat = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "rev-parse", "--show-object-format"],
      "Verification repository object-format inspection"
    ).stdout.trim();
    if (isBare !== "true" || verifiedObjectFormat !== objectFormat) {
      fail("invalid-archive", "The verification repository has the wrong format.");
    }
    const unbundle = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "bundle", "unbundle", bundle.path],
      "Recovery bundle unbundle"
    );
    const unbundledHeads = parseRefList(unbundle.stdout, objectFormat, "Recovery bundle unbundle", {
      allowHead: true,
      allowWorktreeHeads: true,
      allowArchivePseudorefs: true
    });
    if (!isDeepStrictEqual(unbundledHeads, expectedHeads)) {
      fail("archive-ref-mismatch", "The recovery repository did not receive every advertised bundle head.");
    }
    const uniqueObjectIds = [...new Set(expectedHeads.map((head) => head.oid))].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    );
    const resolved = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      "Recovery head resolution",
      { input: `${uniqueObjectIds.join("\n")}\n` }
    ).stdout;
    const resolvedLines = resolved.split("\n").filter(Boolean);
    const expectedObjectIdLength = objectFormat === "sha1" ? 40 : 64;
    if (
      resolvedLines.length !== uniqueObjectIds.length ||
      resolvedLines.some((line, index) => {
        const match = /^([0-9a-f]+) (blob|commit|tag|tree) (0|[1-9][0-9]*)$/u.exec(line);
        return match === null || match[1].length !== expectedObjectIdLength || match[1] !== uniqueObjectIds[index];
      })
    ) {
      fail("invalid-archive", "An advertised recovery head cannot be resolved in the verification repository.");
    }
    const rootRefs = Object.freeze(
      uniqueObjectIds.map((oid, index) =>
        Object.freeze({ oid, ref: `refs/openwrangler-recovery/${String(index).padStart(8, "0")}` })
      )
    );
    requireArchiveGitCommand(verification.path, ["--no-pager", "update-ref", "--stdin"], "Recovery root publication", {
      input: `${rootRefs.map(({ oid, ref }) => `create ${ref} ${oid}`).join("\n")}\n`
    });
    const publishedRoots = parseRefList(
      requireArchiveGitCommand(
        verification.path,
        [
          "--no-pager",
          "for-each-ref",
          "--sort=refname",
          "--format=%(objectname) %(refname)",
          "refs/openwrangler-recovery/"
        ],
        "Recovery root verification"
      ).stdout,
      objectFormat,
      "Recovery roots"
    );
    if (!isDeepStrictEqual(publishedRoots, rootRefs)) {
      fail("invalid-archive", "The verification repository did not retain every recovery root.");
    }
    requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "pack-refs", "--all", "--prune"],
      "Recovery root packing"
    );
    const packedRoots = parseRefList(
      requireArchiveGitCommand(
        verification.path,
        [
          "--no-pager",
          "for-each-ref",
          "--sort=refname",
          "--format=%(objectname) %(refname)",
          "refs/openwrangler-recovery/"
        ],
        "Packed recovery root verification"
      ).stdout,
      objectFormat,
      "Packed recovery roots"
    );
    if (!isDeepStrictEqual(packedRoots, rootRefs)) {
      fail("invalid-archive", "Packing changed the retained recovery roots.");
    }
    const fsck = requireArchiveGitCommand(
      verification.path,
      [
        "--no-pager",
        "fsck",
        "--full",
        "--strict",
        "--no-reflogs",
        "--no-progress",
        "--no-dangling",
        "--no-name-objects"
      ],
      "Recovery repository integrity check"
    );
    const repositoryReceipt = captureVerificationRepository(verification.path, verification.identity);
    revalidatePathIdentity(template.path, template.identity, "Verification template", "directory");
    if (readDirectoryBounded(template.path, 1, "The verification template").length !== 0) {
      fail("archive-changed", "The verification template is no longer empty.");
    }
    return Object.freeze({
      template,
      repository: repositoryReceipt,
      objectFormat,
      advertisedHeads: refsReceipt(unbundledHeads),
      resolvedObjects: Object.freeze({ count: uniqueObjectIds.length, sha256: sha256(resolved) }),
      rootRefs: refsReceipt(rootRefs),
      unbundle: Object.freeze({ stdoutSha256: sha256(unbundle.stdout), stderrSha256: sha256(unbundle.stderr) }),
      fsck: Object.freeze({ stdoutSha256: sha256(fsck.stdout), stderrSha256: sha256(fsck.stderr) })
    });
  }

  function validateArchiveFileReceipt(value, expectedPath, label) {
    exactKeys(value, ["path", "identity", "byteLength", "sha256"], label);
    validateIdentity(value.identity, `${label} identity`);
    if (
      value.path !== expectedPath ||
      !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 1 ||
      !/^[0-9a-f]{64}$/u.test(value.sha256)
    ) {
      fail("invalid-archive", `${label} is malformed.`);
    }
  }

  function validateArchiveReceipt(value, entry, attempt, plan) {
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "generation",
        "attempt",
        "source",
        "archive",
        "storage",
        "git",
        "verification",
        "deferredChecks",
        "authorizesCleanup"
      ],
      "Archive receipt"
    );
    if (
      value.protocol !== ARCHIVE_RECEIPT_PROTOCOL ||
      value.slug !== entry.slug ||
      value.generation !== entry.generation ||
      value.attempt !== attempt.attempt ||
      value.authorizesCleanup !== false
    ) {
      fail("invalid-archive", "The archive receipt is malformed.");
    }
    exactKeys(value.source, ["entry", "retirementPlan"], "Archive source receipt");
    if (!isDeepStrictEqual(value.source.entry, plan.value.source)) {
      fail("invalid-archive", "The archive source entry does not match its retirement plan.");
    }
    validateArchiveFileReceipt(value.source.retirementPlan, plan.path, "Retirement plan file receipt");
    if (
      !sameIdentity(value.source.retirementPlan.identity, plan.identity) ||
      value.source.retirementPlan.byteLength !== plan.byteLength ||
      value.source.retirementPlan.sha256 !== plan.sha256
    ) {
      fail("invalid-archive", "The retirement plan file receipt changed.");
    }
    exactKeys(value.archive, ["directory", "bundle", "verification"], "Archive artifact receipt");
    exactKeys(value.archive.directory, ["path", "identity"], "Archive directory receipt");
    validateIdentity(value.archive.directory.identity, "Archive directory identity");
    if (
      value.archive.directory.path !== attempt.path ||
      !sameIdentity(value.archive.directory.identity, attempt.identity)
    ) {
      fail("invalid-archive", "The archive directory receipt changed.");
    }
    validateArchiveFileReceipt(value.archive.bundle, join(attempt.path, "archive.bundle"), "Bundle file receipt");
    exactKeys(value.archive.verification, ["template", "repository"], "Archive recovery repository receipt");
    exactKeys(value.archive.verification.template, ["path", "identity"], "Archive verification template receipt");
    validateIdentity(value.archive.verification.template.identity, "Archive verification template identity");
    exactKeys(
      value.archive.verification.repository,
      ["path", "identity", "directoryCount", "fileCount", "byteLength", "sha256"],
      "Archive verification repository receipt"
    );
    validateIdentity(value.archive.verification.repository.identity, "Archive verification repository identity");
    if (
      value.archive.verification.template.path !== join(attempt.path, "verification-template") ||
      value.archive.verification.repository.path !== join(attempt.path, "verification.git") ||
      !Number.isSafeInteger(value.archive.verification.repository.directoryCount) ||
      value.archive.verification.repository.directoryCount < 1 ||
      !Number.isSafeInteger(value.archive.verification.repository.fileCount) ||
      value.archive.verification.repository.fileCount < 1 ||
      typeof value.archive.verification.repository.byteLength !== "string" ||
      !/^(?:0|[1-9][0-9]{0,39})$/u.test(value.archive.verification.repository.byteLength) ||
      !/^[0-9a-f]{64}$/u.test(value.archive.verification.repository.sha256)
    ) {
      fail("invalid-archive", "The verification repository receipt is malformed.");
    }
    exactKeys(
      value.storage,
      ["objectDiskBytes", "multiplier", "reserveBytes", "requiredBytes", "availableBytes"],
      "Archive storage receipt"
    );
    const storageFields = [
      value.storage.objectDiskBytes,
      value.storage.reserveBytes,
      value.storage.requiredBytes,
      value.storage.availableBytes
    ];
    if (
      storageFields.some((field) => typeof field !== "string" || !/^(?:0|[1-9][0-9]{0,39})$/u.test(field)) ||
      value.storage.multiplier !== Number(ARCHIVE_SPACE_MULTIPLIER) ||
      BigInt(value.storage.requiredBytes) !==
        BigInt(value.storage.objectDiskBytes) * ARCHIVE_SPACE_MULTIPLIER + BigInt(value.storage.reserveBytes) ||
      BigInt(value.storage.reserveBytes) !== ARCHIVE_SPACE_RESERVE_BYTES ||
      BigInt(value.storage.availableBytes) < BigInt(value.storage.requiredBytes)
    ) {
      fail("invalid-archive", "The archive storage receipt is malformed.");
    }
    exactKeys(
      value.git,
      [
        "repository",
        "objectFormat",
        "shallow",
        "branchRef",
        "head",
        "headTree",
        "commonHead",
        "refs",
        "linkedHeads",
        "pseudorefs",
        "bundleHeads",
        "safety"
      ],
      "Archive Git receipt"
    );
    exactKeys(value.git.repository, ["path", "identity"], "Archive repository receipt");
    validateIdentity(value.git.repository.identity, "Archive repository identity");
    exactKeys(value.git.commonHead, ["oid", "symbolicTarget"], "Archive common HEAD receipt");
    exactKeys(value.git.refs, ["count", "sha256"], "Archive reference receipt");
    exactKeys(value.git.linkedHeads, ["count", "sha256"], "Archive linked-worktree-head receipt");
    exactKeys(value.git.pseudorefs, ["count", "sha256"], "Archive pseudoref receipt");
    exactKeys(value.git.bundleHeads, ["count", "sha256"], "Archive bundle-head receipt");
    exactKeys(
      value.git.safety,
      [
        "configSha256",
        "configNamesSha256",
        "unsafeConfigKeyCount",
        "graftsPresent",
        "alternatesPresent",
        "httpAlternatesPresent",
        "promisorMarkerCount",
        "packStateSha256",
        "privateRefCount",
        "targetAdminStateSha256",
        "targetReflogEntryCount",
        "unreachableTargetReflogCommitCount"
      ],
      "Archive repository safety receipt"
    );
    const objectIdLength = value.git.objectFormat === "sha256" ? 64 : 40;
    if (
      value.git.repository.path !== repository.commonGitDirectory ||
      !sameIdentity(value.git.repository.identity, repository.identity) ||
      !["sha1", "sha256"].includes(value.git.objectFormat) ||
      value.git.shallow !== false ||
      value.git.branchRef !== `refs/heads/${entry.branch}` ||
      value.git.head !== plan.value.git.head ||
      value.git.headTree !== plan.value.git.headTree ||
      typeof value.git.commonHead.oid !== "string" ||
      value.git.commonHead.oid.length !== objectIdLength ||
      !/^[0-9a-f]+$/u.test(value.git.commonHead.oid) ||
      !(
        value.git.commonHead.symbolicTarget === null ||
        (typeof value.git.commonHead.symbolicTarget === "string" &&
          value.git.commonHead.symbolicTarget.startsWith("refs/"))
      ) ||
      !Number.isSafeInteger(value.git.refs.count) ||
      value.git.refs.count < 1 ||
      !/^[0-9a-f]{64}$/u.test(value.git.refs.sha256) ||
      !Number.isSafeInteger(value.git.linkedHeads.count) ||
      value.git.linkedHeads.count < 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.linkedHeads.sha256) ||
      !Number.isSafeInteger(value.git.pseudorefs.count) ||
      value.git.pseudorefs.count < 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.pseudorefs.sha256) ||
      !Number.isSafeInteger(value.git.bundleHeads.count) ||
      value.git.bundleHeads.count !==
        value.git.refs.count + value.git.linkedHeads.count + value.git.pseudorefs.count + 1 ||
      !/^[0-9a-f]{64}$/u.test(value.git.bundleHeads.sha256) ||
      !/^[0-9a-f]{64}$/u.test(value.git.safety.configSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.git.safety.configNamesSha256) ||
      value.git.safety.unsafeConfigKeyCount !== 0 ||
      value.git.safety.graftsPresent !== false ||
      value.git.safety.alternatesPresent !== false ||
      value.git.safety.httpAlternatesPresent !== false ||
      value.git.safety.promisorMarkerCount !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.safety.packStateSha256) ||
      value.git.safety.privateRefCount !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.safety.targetAdminStateSha256) ||
      !Number.isSafeInteger(value.git.safety.targetReflogEntryCount) ||
      value.git.safety.targetReflogEntryCount < 0 ||
      value.git.safety.targetReflogEntryCount > MAXIMUM_ARCHIVE_REFLOG_ENTRIES ||
      value.git.safety.unreachableTargetReflogCommitCount !== 0
    ) {
      fail("invalid-archive", "The archive Git receipt is malformed.");
    }
    exactKeys(
      value.verification,
      ["header", "bundleVerify", "listHeads", "recovery", "eligibilitySha256"],
      "Archive verification receipt"
    );
    exactKeys(
      value.verification.header,
      ["version", "objectFormat", "capabilities", "prerequisiteCount", "heads"],
      "Bundle header receipt"
    );
    exactKeys(value.verification.header.heads, ["count", "sha256"], "Bundle header heads receipt");
    exactKeys(value.verification.bundleVerify, ["stdoutSha256", "stderrSha256"], "Bundle verification command receipt");
    exactKeys(value.verification.listHeads, ["count", "sha256"], "Bundle list-heads receipt");
    exactKeys(
      value.verification.recovery,
      ["objectFormat", "advertisedHeads", "resolvedObjects", "rootRefs", "unbundle", "fsck"],
      "Bundle recovery proof"
    );
    exactKeys(value.verification.recovery.advertisedHeads, ["count", "sha256"], "Recovered bundle heads");
    exactKeys(value.verification.recovery.resolvedObjects, ["count", "sha256"], "Resolved recovery objects");
    exactKeys(value.verification.recovery.rootRefs, ["count", "sha256"], "Published recovery roots");
    exactKeys(value.verification.recovery.unbundle, ["stdoutSha256", "stderrSha256"], "Unbundle proof");
    exactKeys(value.verification.recovery.fsck, ["stdoutSha256", "stderrSha256"], "Recovery fsck proof");
    const expectedCapabilities =
      value.verification.header.version === 2 ? [] : [`object-format=${value.git.objectFormat}`];
    if (
      ![2, 3].includes(value.verification.header.version) ||
      value.verification.header.objectFormat !== value.git.objectFormat ||
      !isDeepStrictEqual(value.verification.header.capabilities, expectedCapabilities) ||
      value.verification.header.prerequisiteCount !== 0 ||
      !isDeepStrictEqual(value.verification.header.heads, value.git.bundleHeads) ||
      !isDeepStrictEqual(value.verification.listHeads, value.git.bundleHeads) ||
      value.verification.recovery.objectFormat !== value.git.objectFormat ||
      !isDeepStrictEqual(value.verification.recovery.advertisedHeads, value.git.bundleHeads) ||
      !Number.isSafeInteger(value.verification.recovery.resolvedObjects.count) ||
      value.verification.recovery.resolvedObjects.count < 1 ||
      value.verification.recovery.resolvedObjects.count > value.git.bundleHeads.count ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.resolvedObjects.sha256) ||
      !Number.isSafeInteger(value.verification.recovery.rootRefs.count) ||
      value.verification.recovery.rootRefs.count !== value.verification.recovery.resolvedObjects.count ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.rootRefs.sha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.unbundle.stdoutSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.unbundle.stderrSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.fsck.stdoutSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.fsck.stderrSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.bundleVerify.stdoutSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.bundleVerify.stderrSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.eligibilitySha256)
    ) {
      fail("invalid-archive", "The archive verification receipt is malformed.");
    }
    exactKeys(value.deferredChecks, ["recovery", "processUse", "mounts"], "Archive deferred checks");
    if (
      value.deferredChecks.recovery !== "bundle-unbundled-and-fsck-verified" ||
      value.deferredChecks.processUse !== "not-checked-recheck-required" ||
      value.deferredChecks.mounts !== "not-checked-recheck-required"
    ) {
      fail("invalid-archive", "The archive deferred checks are malformed.");
    }
  }

  function validateCompletion(value, entry, attempt, bundle, receipt, verification) {
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "generation",
        "attempt",
        "directory",
        "bundle",
        "receipt",
        "verification",
        "authorizesCleanup"
      ],
      "Archive completion"
    );
    if (
      value.protocol !== ARCHIVE_COMPLETION_PROTOCOL ||
      value.slug !== entry.slug ||
      value.generation !== entry.generation ||
      value.attempt !== attempt.attempt ||
      value.authorizesCleanup !== false
    ) {
      fail("invalid-archive", "The archive completion marker is malformed.");
    }
    exactKeys(value.directory, ["path", "identity"], "Completed archive directory");
    validateIdentity(value.directory.identity, "Completed archive directory identity");
    if (value.directory.path !== attempt.path || !sameIdentity(value.directory.identity, attempt.identity)) {
      fail("invalid-archive", "The completed archive directory changed.");
    }
    validateArchiveFileReceipt(value.bundle, bundle.path, "Completed bundle receipt");
    validateArchiveFileReceipt(value.receipt, receipt.path, "Completed receipt file");
    exactKeys(value.verification, ["template", "repository"], "Completed verification repository receipt");
    if (
      !isDeepStrictEqual(value.bundle, bundle) ||
      !isDeepStrictEqual(value.receipt, receipt) ||
      !isDeepStrictEqual(value.verification, verification)
    ) {
      fail("invalid-archive", "The completed archive files changed.");
    }
  }

  function assertArchiveAttemptContents(attempt, expectedFiles, expectedDirectories = []) {
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    const entries = readDirectoryBounded(attempt.path, 8, "The archive attempt");
    const actualFiles = entries
      .filter((item) => item.isFile() && !item.isSymbolicLink())
      .map((item) => item.name)
      .sort();
    const actualDirectories = entries
      .filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .map((item) => item.name)
      .sort();
    if (
      entries.some((item) => item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) ||
      !isDeepStrictEqual(actualFiles, [...expectedFiles].sort()) ||
      !isDeepStrictEqual(actualDirectories, [...expectedDirectories].sort())
    ) {
      fail("archive-changed", "The archive attempt contains unexpected files.");
    }
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

    archiveRetirement({ slug, ownerTask, expectedRevision, expectedGeneration }) {
      assertSlug(slug);
      assertGeneration(expectedGeneration);
      return withLock(() => {
        const entry = readEntry(slug);
        assertOwnerRevision(entry, ownerTask, expectedRevision);
        if (entry.generation !== expectedGeneration) {
          fail("registry-changed", `Managed checkout ${slug} is no longer at the expected generation.`);
        }
        if (entry.state !== "cleanup-pending") {
          fail("checkout-not-cleanup-pending", "Only a cleanup-pending checkout can be archived.");
        }
        const plan = readRetirementPlan(entry);
        const firstEligibility = captureRetirementEvidence(entry);
        if (!isDeepStrictEqual(firstEligibility, plan.value)) {
          fail("retirement-evidence-stale", "The checkout no longer matches its retirement evidence.");
        }
        const firstGit = captureRepositoryArchiveState(entry, plan.value.git);
        const storage = archiveFreeSpace(firstGit.objectDiskBytes);
        initializeArchiveJournal();
        const archiveRootIdentity = managedIdentities.get(paths.archives);
        if (archiveRootIdentity === undefined) fail("unsafe-manager", "The archive journal was not initialized.");
        const attempt = createArchiveAttempt(slug, entry.generation);
        const bundle = createBundle(attempt, firstGit.pseudorefs);
        hooks?.afterArchiveBundleWrite?.(entry, attempt, bundle);
        const namedBundle = captureArchiveFile(bundle.path, "Recovery bundle");
        if (
          !isDeepStrictEqual(namedBundle, {
            identity: bundle.identity,
            byteLength: bundle.byteLength,
            sha256: bundle.sha256
          })
        ) {
          fail("archive-changed", "The recovery bundle changed after Git finished.");
        }
        hooks?.beforeArchiveHeaderParse?.(entry, attempt, bundle);
        const header = parseBundleHeader(bundle.path, firstGit.objectFormat);
        const headerHeads = refsReceipt(header.refs);
        if (
          !isDeepStrictEqual(headerHeads, firstGit.bundleHeadsReceipt) ||
          !isDeepStrictEqual(header.refs, firstGit.bundleHeads)
        ) {
          fail("archive-ref-mismatch", "The Git bundle header does not contain the exact repository refs.");
        }
        const verification = requireCommonArchiveCommand(
          ["--no-pager", "bundle", "verify", "-q", bundle.path],
          "Git bundle verification"
        );
        const listHeadsOutput = requireCommonArchiveCommand(
          ["--no-pager", "bundle", "list-heads", bundle.path],
          "Git bundle head inspection"
        ).stdout;
        const listedRefs = parseRefList(listHeadsOutput, firstGit.objectFormat, "Git bundle list-heads", {
          allowHead: true,
          allowWorktreeHeads: true,
          allowArchivePseudorefs: true
        });
        const listedHeads = refsReceipt(listedRefs);
        if (
          !isDeepStrictEqual(listedRefs, firstGit.bundleHeads) ||
          !isDeepStrictEqual(listedHeads, firstGit.bundleHeadsReceipt)
        ) {
          fail("archive-ref-mismatch", "The verified Git bundle does not contain the exact repository refs.");
        }
        hooks?.beforeArchiveRecoveryProof?.(entry, attempt, bundle);
        const recovery = proveBundleRecovery(attempt, bundle, firstGit.bundleHeads, firstGit.objectFormat);
        const secondEligibility = captureRetirementEvidence(entry);
        const secondGit = captureRepositoryArchiveState(entry, plan.value.git);
        if (!isDeepStrictEqual(secondEligibility, firstEligibility) || !isDeepStrictEqual(secondGit, firstGit)) {
          fail("checkout-changed", "The checkout or repository refs changed while the bundle was created.");
        }
        revalidateRetirementPlan(plan, entry);
        const confirmedBundle = captureArchiveFile(bundle.path, "Recovery bundle");
        if (!isDeepStrictEqual(confirmedBundle, namedBundle)) {
          fail("archive-changed", "The recovery bundle changed while it was verified.");
        }
        assertArchiveAttemptContents(attempt, ["archive.bundle"], ["verification-template", "verification.git"]);
        const eligibilitySha256 = sha256(JSON.stringify(firstEligibility));
        const receiptValue = {
          protocol: ARCHIVE_RECEIPT_PROTOCOL,
          slug,
          generation: entry.generation,
          attempt: attempt.attempt,
          source: {
            entry: plan.value.source,
            retirementPlan: {
              path: plan.path,
              identity: plan.identity,
              byteLength: plan.byteLength,
              sha256: plan.sha256
            }
          },
          archive: {
            directory: { path: attempt.path, identity: attempt.identity },
            bundle: { path: bundle.path, ...confirmedBundle },
            verification: {
              template: recovery.template,
              repository: recovery.repository
            }
          },
          storage,
          git: {
            repository: { path: repository.commonGitDirectory, identity: repository.identity },
            objectFormat: firstGit.objectFormat,
            shallow: firstGit.shallow,
            branchRef: firstGit.branchRef,
            head: plan.value.git.head,
            headTree: plan.value.git.headTree,
            commonHead: firstGit.commonHead,
            refs: firstGit.refsReceipt,
            linkedHeads: refsReceipt(firstGit.linkedHeads),
            pseudorefs: firstGit.pseudorefsReceipt,
            bundleHeads: firstGit.bundleHeadsReceipt,
            safety: firstGit.safety
          },
          verification: {
            header: {
              version: header.version,
              objectFormat: header.objectFormat,
              capabilities: header.capabilities,
              prerequisiteCount: header.prerequisiteCount,
              heads: headerHeads
            },
            bundleVerify: {
              stdoutSha256: sha256(verification.stdout),
              stderrSha256: sha256(verification.stderr)
            },
            listHeads: listedHeads,
            recovery: {
              objectFormat: recovery.objectFormat,
              advertisedHeads: recovery.advertisedHeads,
              resolvedObjects: recovery.resolvedObjects,
              rootRefs: recovery.rootRefs,
              unbundle: recovery.unbundle,
              fsck: recovery.fsck
            },
            eligibilitySha256
          },
          deferredChecks: {
            recovery: "bundle-unbundled-and-fsck-verified",
            processUse: "not-checked-recheck-required",
            mounts: "not-checked-recheck-required"
          },
          authorizesCleanup: false
        };
        validateArchiveReceipt(receiptValue, entry, attempt, plan);
        hooks?.beforeArchiveReceiptWrite?.(entry, attempt, receiptValue);
        const receiptPath = join(attempt.path, "receipt.json");
        try {
          writeJsonExclusive(receiptPath, receiptValue, attempt.identity);
        } catch (error) {
          if (error.code === "EEXIST") fail("archive-changed", "The archive receipt appeared concurrently.");
          throw error;
        }
        const receiptFile = captureArchiveFile(receiptPath, "Archive receipt file");
        const writtenReceipt = readJsonReceipt(receiptPath, MAXIMUM_ENTRY_BYTES, "Archive receipt");
        validateArchiveReceipt(writtenReceipt.value, entry, attempt, plan);
        if (!isDeepStrictEqual(writtenReceipt.value, receiptValue)) {
          fail("archive-changed", "The archive receipt changed while it was recorded.");
        }
        assertArchiveAttemptContents(
          attempt,
          ["archive.bundle", "receipt.json"],
          ["verification-template", "verification.git"]
        );
        hooks?.beforeArchiveCompletionWrite?.(entry, attempt, receiptValue);
        const finalEligibility = captureRetirementEvidence(entry);
        const finalGit = captureRepositoryArchiveState(entry, plan.value.git);
        revalidateRetirementPlan(plan, entry);
        if (!isDeepStrictEqual(finalEligibility, firstEligibility) || !isDeepStrictEqual(finalGit, firstGit)) {
          fail("checkout-changed", "The checkout or repository refs changed before archive completion.");
        }
        const finalBundle = captureArchiveFile(bundle.path, "Recovery bundle");
        const finalReceipt = captureArchiveFile(receiptPath, "Archive receipt file");
        const finalVerificationRepository = captureVerificationRepository(
          recovery.repository.path,
          recovery.repository.identity
        );
        revalidatePathIdentity(
          recovery.template.path,
          recovery.template.identity,
          "Verification template",
          "directory"
        );
        if (
          readDirectoryBounded(recovery.template.path, 1, "The verification template").length !== 0 ||
          !isDeepStrictEqual(finalBundle, confirmedBundle) ||
          !isDeepStrictEqual(finalReceipt, receiptFile) ||
          !isDeepStrictEqual(finalVerificationRepository, recovery.repository)
        ) {
          fail("archive-changed", "The archive files changed before completion.");
        }
        const completionVerification = {
          template: recovery.template,
          repository: finalVerificationRepository
        };
        const completionValue = {
          protocol: ARCHIVE_COMPLETION_PROTOCOL,
          slug,
          generation: entry.generation,
          attempt: attempt.attempt,
          directory: { path: attempt.path, identity: attempt.identity },
          bundle: { path: bundle.path, ...finalBundle },
          receipt: { path: receiptPath, ...finalReceipt },
          verification: completionVerification,
          authorizesCleanup: false
        };
        validateCompletion(
          completionValue,
          entry,
          attempt,
          completionValue.bundle,
          completionValue.receipt,
          completionVerification
        );
        const completionPath = join(attempt.path, "complete.json");
        try {
          writeJsonExclusive(completionPath, completionValue, attempt.identity);
        } catch (error) {
          if (error.code === "EEXIST") fail("archive-changed", "The completion marker appeared concurrently.");
          throw error;
        }
        fsyncDirectory(attempt.path);
        fsyncDirectory(paths.archives);
        revalidatePathIdentity(paths.archives, archiveRootIdentity, paths.archives, "directory");
        assertArchiveAttemptContents(
          attempt,
          ["archive.bundle", "receipt.json", "complete.json"],
          ["verification-template", "verification.git"]
        );
        const completed = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Archive completion");
        validateCompletion(
          completed.value,
          entry,
          attempt,
          completionValue.bundle,
          completionValue.receipt,
          completionVerification
        );
        if (!isDeepStrictEqual(completed.value, completionValue)) {
          fail("archive-changed", "The completion marker changed while it was recorded.");
        }
        revalidatePathIdentity(completionPath, completed.identity, "Archive completion");
        const completedBundle = captureArchiveFile(bundle.path, "Recovery bundle");
        const completedReceipt = captureArchiveFile(receiptPath, "Archive receipt file");
        const completedVerificationRepository = captureVerificationRepository(
          recovery.repository.path,
          recovery.repository.identity
        );
        revalidatePathIdentity(
          recovery.template.path,
          recovery.template.identity,
          "Verification template",
          "directory"
        );
        revalidateRetirementPlan(plan, entry);
        if (
          readDirectoryBounded(recovery.template.path, 1, "The verification template").length !== 0 ||
          !isDeepStrictEqual(completedBundle, finalBundle) ||
          !isDeepStrictEqual(completedReceipt, finalReceipt) ||
          !isDeepStrictEqual(completedVerificationRepository, finalVerificationRepository)
        ) {
          fail("archive-changed", "The retained recovery proof changed after completion was recorded.");
        }
        return Object.freeze({
          status: "recovery-archive-recorded",
          slug,
          ownerTask: entry.ownerTask,
          revision: entry.revision,
          generation: entry.generation,
          attempt: attempt.attempt,
          archivePath: bundle.path,
          bundleSha256: bundle.sha256,
          authorizesCleanup: false
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
  } else if (command === "archive-retirement") {
    result = manager.archiveRetirement({
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
  } else {
    fail("invalid-cli", "Use create, status, audit, handoff, finish, plan-retirement, archive-retirement, or abandon.");
  }
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
