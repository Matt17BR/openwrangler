import MarkdownIt from "markdown-it";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { promisify, TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const EXPECTED_INVARIANT_COUNT = 58;
const SOURCE_PATH = "AGENTS.md";
const ARCHIVE_PATH = "docs/contracts/invariants-v1.md";
const EVIDENCE_PATH = "docs/evidence/invariant-crosswalk.json";
const SCANNED_DOCUMENTS = ["docs/architecture.md", "docs/feature-parity.md", "docs/releasing.md", "docs/testing.md"];
const CLEANING_HISTORY_MODEL_PATH = "fixtures/cleaning-history-capabilities.json";
const CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH = "src/shared/cleaningHistoryCapabilities.ts";
const CLEANING_HISTORY_DOCUMENTS = ["README.md", "docs/product-roadmap.md"];
const CLEANING_HISTORY_CAPABILITY_IDS = ["inspect", "edit", "delete", "undo", "reorder"];
const CLEANING_HISTORY_MODEL_MAX_BYTES = 8 * 1024;
const CLEANING_HISTORY_PRODUCTION_AUTHORITY_MAX_BYTES = 32 * 1024;
const CLEANING_HISTORY_DOCUMENT_MAX_BYTES = 1024 * 1024;
const CLEANING_HISTORY_SECTION_MAX_BYTES = 128 * 1024;
const CLEANING_HISTORY_INLINE_TOKEN_MAX = 4096;
const CLEANING_HISTORY_JSON_MAX_DEPTH = 8;
const CLEANING_HISTORY_JSON_MAX_CONTAINER_ENTRIES = 64;
const CLEANING_HISTORY_JSON_MAX_TOTAL_ENTRIES = 128;
const CLEANING_HISTORY_JSON_MAX_STRING_SOURCE_UNITS = 1024;
const CLEANING_HISTORY_JSON_MAX_STRING_BYTES = 512;
const CLEANING_HISTORY_AUTHORITY_START = "// cleaning-history-capability-authority:start";
const CLEANING_HISTORY_AUTHORITY_END = "// cleaning-history-capability-authority:end";
const cleaningHistoryClaimSurfaces = [
  {
    path: "README.md",
    heading: "## Transformations",
    marker: "readme-transformations",
    claimKind: "readme"
  },
  {
    path: "README.md",
    heading: "## Notebook workflows",
    marker: "readme-native-r",
    claimKind: "readme"
  },
  {
    path: "docs/product-roadmap.md",
    heading: "### P1: fidelity and daily use",
    marker: "roadmap-p1",
    claimKind: "roadmap"
  },
  {
    path: "docs/product-roadmap.md",
    heading: "## Audit disposition",
    marker: "roadmap-audit",
    claimKind: "roadmap"
  }
];

const cleaningHistoryScopes = new Map([
  ["inspect", new Set(["any_committed_step", "latest_committed_step"])],
  ["edit", new Set(["any_committed_step", "latest_committed_step"])],
  ["delete", new Set(["any_committed_step", "latest_committed_step"])],
  ["undo", new Set(["most_recent_committed_step", "any_committed_step"])],
  ["reorder", new Set(["committed_steps"])]
]);

const cleaningHistoryActions = new Map([
  ["inspect", { passive: "inspected", unsupported: "Inspecting" }],
  ["edit", { passive: "edited", unsupported: "Editing" }],
  ["delete", { passive: "deleted", unsupported: "Deleting" }]
]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const boundedRepositoryInputs = new Set([
  SOURCE_PATH,
  ARCHIVE_PATH,
  EVIDENCE_PATH,
  ...SCANNED_DOCUMENTS,
  CLEANING_HISTORY_MODEL_PATH,
  CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH,
  ...CLEANING_HISTORY_DOCUMENTS
]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function assertBoundedUtf8(value, maximumBytes, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be UTF-8 text.`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte validation limit.`);
  }
}

function ancestorDirectories(path) {
  const absolute = resolve(path);
  const rootDirectory = parse(absolute).root;
  const result = [];
  let current = dirname(absolute);
  while (true) {
    result.unshift(current);
    if (current === rootDirectory) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { absolute, directories: result };
}

function assertSameDirectoryIdentity(expected, actual, label) {
  if (!expected.isDirectory() || !actual.isDirectory()) {
    throw new Error(`${label} must have only regular, non-symbolic-link ancestor directories.`);
  }
  for (const field of ["dev", "ino", "mode", "uid", "gid"]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${label} ancestor changed identity while it was being read.`);
    }
  }
}

async function closeBoundedReadHandles(handles, label) {
  const results = await Promise.allSettled(handles.map((handle) => handle.close()));
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} file-identity descriptors did not close cleanly.`);
  }
}

async function openBoundedAncestorChain(path, label, testHooks = undefined) {
  const { absolute, directories } = ancestorDirectories(path);
  const records = [];
  try {
    for (const [index, directory] of directories.entries()) {
      const expected = await lstat(directory, { bigint: true });
      if (!expected.isDirectory()) {
        throw new Error(`${label} must have only regular, non-symbolic-link ancestor directories.`);
      }
      const parent = records.at(-1);
      const descriptorPath = parent ? `/proc/self/fd/${parent.handle.fd}/${basename(directory)}` : directory;
      let handle;
      try {
        handle = await open(
          descriptorPath,
          fileConstants.O_RDONLY |
            (fileConstants.O_DIRECTORY ?? 0) |
            (fileConstants.O_NOFOLLOW ?? 0) |
            (fileConstants.O_NONBLOCK ?? 0)
        );
        await testHooks?.afterAncestorOpenBeforeIdentity?.({ directory, index });
        const [opened, current] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(directory, { bigint: true })
        ]);
        assertSameDirectoryIdentity(expected, opened, label);
        assertSameDirectoryIdentity(expected, current, label);
        records.push({ path: directory, expected: opened, handle });
        handle = undefined;
      } catch (error) {
        if (handle) {
          try {
            await handle.close();
          } catch (closeError) {
            throw new AggregateError([error, closeError], `${label} ancestor descriptor did not close cleanly.`);
          }
        }
        throw error;
      }
    }
    return { absolute, records };
  } catch (error) {
    await closeBoundedReadHandles(
      records.reverse().map(({ handle }) => handle),
      label
    );
    throw error;
  }
}

function repositoryRelativeInput(path, label) {
  const absolute = resolve(path);
  const repositoryPath = relative(root, absolute).split(sep).join("/");
  if (
    repositoryPath.length === 0 ||
    repositoryPath === ".." ||
    repositoryPath.startsWith("../") ||
    isAbsolute(repositoryPath) ||
    !boundedRepositoryInputs.has(repositoryPath)
  ) {
    throw new Error(`${label} is outside the bounded repository input inventory.`);
  }
  return repositoryPath;
}

function boundedGitEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_") && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C"
  };
}

async function boundedGit(args, maximumBytes, label) {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      encoding: "buffer",
      env: boundedGitEnvironment(),
      maxBuffer: maximumBytes + 1,
      timeout: 10_000,
      windowsHide: true
    });
    return stdout;
  } catch (error) {
    throw new Error(`${label} could not be verified through the bounded repository object boundary.`, {
      cause: error
    });
  }
}

async function committedInputIdentity(repositoryPath, label) {
  const status = await boundedGit(
    ["status", "--porcelain=v1", "--untracked-files=all", "--", repositoryPath],
    32 * 1024,
    label
  );
  if (status.length !== 0) {
    throw new Error(`${label} must match its committed repository object on this platform.`);
  }
  const staged = await boundedGit(["ls-files", "--stage", "-z", "--", repositoryPath], 32 * 1024, label);
  const entries = staged.toString("utf8").split("\0").filter(Boolean);
  if (entries.length !== 1) {
    throw new Error(`${label} must resolve to exactly one tracked repository object.`);
  }
  const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t([^\0]+)$/u.exec(entries[0]);
  if (!match || match[3] !== repositoryPath) {
    throw new Error(`${label} must resolve to one ordinary tracked file.`);
  }
  const head = (await boundedGit(["rev-parse", "--verify", `HEAD:${repositoryPath}`], 1024, label))
    .toString("ascii")
    .trim();
  if (head !== match[2]) {
    throw new Error(`${label} index and committed object identities differ.`);
  }
  return { objectId: head, mode: match[1] };
}

async function readBoundedCommittedUtf8File(path, maximumBytes, label, testHooks) {
  const repositoryPath = repositoryRelativeInput(path, label);
  const before = await committedInputIdentity(repositoryPath, label);
  await testHooks?.afterPortableIdentity?.({ repositoryPath, ...before });
  const sizeText = (await boundedGit(["cat-file", "-s", before.objectId], 1024, label)).toString("ascii").trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(sizeText) || BigInt(sizeText) > BigInt(maximumBytes)) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte validation limit.`);
  }
  const contents = await boundedGit(["cat-file", "blob", before.objectId], maximumBytes, label);
  if (contents.length !== Number(sizeText)) {
    throw new Error(`${label} changed identity or contents while it was being read.`);
  }
  await testHooks?.afterPortableRead?.({ repositoryPath, ...before });
  const after = await committedInputIdentity(repositoryPath, label);
  if (after.objectId !== before.objectId || after.mode !== before.mode) {
    throw new Error(`${label} changed identity or contents while it was being read.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`${label} must be valid UTF-8 text.`);
  }
}

async function assertAncestorChainCurrent(records, label) {
  for (const record of records) {
    const [opened, current] = await Promise.all([
      record.handle.stat({ bigint: true }),
      lstat(record.path, { bigint: true })
    ]);
    assertSameDirectoryIdentity(record.expected, opened, label);
    assertSameDirectoryIdentity(record.expected, current, label);
  }
}

export async function readBoundedUtf8File(path, maximumBytes, label = path, testHooks = undefined) {
  const platform = process.platform;
  if (platform === "darwin" || platform === "win32") {
    return await readBoundedCommittedUtf8File(path, maximumBytes, label, testHooks);
  }
  if (platform !== "linux") {
    throw new Error(`${label} requires a supported bounded repository file boundary.`);
  }
  const ancestorChain = await openBoundedAncestorChain(path, label, testHooks);
  let handle;
  try {
    const expected = await lstat(ancestorChain.absolute, { bigint: true });
    if (!expected.isFile()) {
      throw new Error(`${label} must be a regular file, not a symbolic link or special file.`);
    }
    if (expected.nlink !== 1n) {
      throw new Error(`${label} must have exactly one hard link.`);
    }
    if (expected.size > BigInt(maximumBytes)) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte validation limit.`);
    }
    await testHooks?.afterInitialLeafIdentity?.();
    const parent = ancestorChain.records.at(-1);
    const descriptorPath = `/proc/self/fd/${parent.handle.fd}/${basename(ancestorChain.absolute)}`;
    handle = await open(
      descriptorPath,
      fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0) | (fileConstants.O_NONBLOCK ?? 0)
    );
    const opened = await handle.stat({ bigint: true });
    assertSameRegularFile(expected, opened, label);

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= maximumBytes) {
      const remaining = maximumBytes + 1 - totalBytes;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      await testHooks?.afterReadChunk?.({ bytesRead, totalBytes });
    }
    if (totalBytes > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte validation limit.`);
    }

    const completed = await handle.stat({ bigint: true });
    const current = await lstat(ancestorChain.absolute, { bigint: true });
    assertSameRegularFile(opened, completed, label);
    assertSameRegularFile(opened, current, label);
    await assertAncestorChainCurrent(ancestorChain.records, label);
    if (completed.size !== BigInt(totalBytes)) {
      throw new Error(`${label} changed while it was being read.`);
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
    } catch {
      throw new Error(`${label} must be valid UTF-8 text.`);
    }
  } finally {
    await closeBoundedReadHandles(
      [...(handle ? [handle] : []), ...ancestorChain.records.reverse().map(({ handle: ancestor }) => ancestor)],
      label
    );
  }
}

function assertSameRegularFile(expected, actual, label) {
  if (!actual.isFile() || actual.nlink !== 1n) {
    throw new Error(`${label} must remain one regular file with exactly one hard link.`);
  }
  for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${label} changed identity or contents while it was being read.`);
    }
  }
}

function inspectBoundedJson(source, label) {
  let offset = 0;
  let totalEntries = 0;

  const fail = (message) => {
    throw new Error(`${label} ${message} at byte ${Buffer.byteLength(source.slice(0, offset), "utf8")}.`);
  };
  const skipWhitespace = () => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };

  const parseString = () => {
    if (source[offset] !== '"') fail("contains an invalid JSON string");
    const start = offset;
    offset += 1;
    let sourceUnits = 0;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        const token = source.slice(start, offset);
        let value;
        try {
          value = JSON.parse(token);
        } catch {
          fail("contains an invalid JSON string");
        }
        if (Buffer.byteLength(value, "utf8") > CLEANING_HISTORY_JSON_MAX_STRING_BYTES) {
          fail(`contains a string over ${CLEANING_HISTORY_JSON_MAX_STRING_BYTES} UTF-8 bytes`);
        }
        return value;
      }
      if (character === "\\") {
        offset += 1;
        const escape = source[offset];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(offset + 1, offset + 5))) {
            fail("contains an invalid Unicode escape");
          }
          offset += 5;
          sourceUnits += 6;
        } else if ('"\\/bfnrt'.includes(escape ?? "")) {
          offset += 1;
          sourceUnits += 2;
        } else {
          fail("contains an invalid escape");
        }
      } else {
        if (character.charCodeAt(0) < 0x20) fail("contains an unescaped control character");
        offset += 1;
        sourceUnits += 1;
      }
      if (sourceUnits > CLEANING_HISTORY_JSON_MAX_STRING_SOURCE_UNITS) {
        fail(`contains a string token over ${CLEANING_HISTORY_JSON_MAX_STRING_SOURCE_UNITS} source units`);
      }
    }
    fail("contains an unterminated JSON string");
  };

  const recordEntry = () => {
    totalEntries += 1;
    if (totalEntries > CLEANING_HISTORY_JSON_MAX_TOTAL_ENTRIES) {
      fail(`contains more than ${CLEANING_HISTORY_JSON_MAX_TOTAL_ENTRIES} total entries`);
    }
  };

  const parseValue = (depth) => {
    if (depth > CLEANING_HISTORY_JSON_MAX_DEPTH) {
      fail(`exceeds the maximum JSON depth of ${CLEANING_HISTORY_JSON_MAX_DEPTH}`);
    }
    skipWhitespace();
    const character = source[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      let entries = 0;
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        const key = parseString();
        if (keys.has(key)) fail(`contains duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        entries += 1;
        recordEntry();
        if (entries > CLEANING_HISTORY_JSON_MAX_CONTAINER_ENTRIES) {
          fail(`contains an object with more than ${CLEANING_HISTORY_JSON_MAX_CONTAINER_ENTRIES} entries`);
        }
        skipWhitespace();
        if (source[offset] !== ":") fail("contains an object key without a value");
        offset += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") fail("contains an invalid object separator");
        offset += 1;
        skipWhitespace();
      }
      fail("contains an unterminated object");
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      let entries = 0;
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        entries += 1;
        recordEntry();
        if (entries > CLEANING_HISTORY_JSON_MAX_CONTAINER_ENTRIES) {
          fail(`contains an array with more than ${CLEANING_HISTORY_JSON_MAX_CONTAINER_ENTRIES} entries`);
        }
        parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") fail("contains an invalid array separator");
        offset += 1;
      }
      fail("contains an unterminated array");
    }
    if (character === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(offset));
    if (number !== null) {
      if (number[0].length > 64) fail("contains an overlong number token");
      offset += number[0].length;
      return;
    }
    fail("contains an invalid JSON value");
  };

  skipWhitespace();
  parseValue(1);
  skipWhitespace();
  if (offset !== source.length) fail("contains trailing JSON content");
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

export function parseCleaningHistoryCapabilityModel(source) {
  assertBoundedUtf8(source, CLEANING_HISTORY_MODEL_MAX_BYTES, CLEANING_HISTORY_MODEL_PATH);
  inspectBoundedJson(source, CLEANING_HISTORY_MODEL_PATH);

  let model;
  try {
    model = JSON.parse(source);
  } catch (error) {
    throw new Error(`${CLEANING_HISTORY_MODEL_PATH} is not valid JSON: ${error.message}`);
  }

  assertPlainObject(model, CLEANING_HISTORY_MODEL_PATH);
  assertExactKeys(model, ["schemaVersion", "capabilities"], CLEANING_HISTORY_MODEL_PATH);
  if (model.schemaVersion !== 1) {
    throw new Error(`${CLEANING_HISTORY_MODEL_PATH} must use schemaVersion 1.`);
  }
  if (!Array.isArray(model.capabilities) || model.capabilities.length !== CLEANING_HISTORY_CAPABILITY_IDS.length) {
    throw new Error(
      `${CLEANING_HISTORY_MODEL_PATH} must define exactly ${CLEANING_HISTORY_CAPABILITY_IDS.length} capabilities.`
    );
  }

  model.capabilities.forEach((capability, index) => {
    const label = `${CLEANING_HISTORY_MODEL_PATH} capability ${index + 1}`;
    assertPlainObject(capability, label);
    assertExactKeys(capability, ["id", "status", "scope"], label);
    const expectedId = CLEANING_HISTORY_CAPABILITY_IDS[index];
    if (capability.id !== expectedId) {
      throw new Error(`${label} must be ${expectedId}, found ${String(capability.id)}.`);
    }
    if (!new Set(["implemented", "not_committed"]).has(capability.status)) {
      throw new Error(`${label} has unsupported status ${String(capability.status)}.`);
    }
    if (!cleaningHistoryScopes.get(expectedId).has(capability.scope)) {
      throw new Error(`${label} has unsupported scope ${String(capability.scope)}.`);
    }
  });

  return model;
}

export function parseCleaningHistoryProductionAuthority(source) {
  assertBoundedUtf8(
    source,
    CLEANING_HISTORY_PRODUCTION_AUTHORITY_MAX_BYTES,
    CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH
  );
  const startCount = countOccurrences(source, CLEANING_HISTORY_AUTHORITY_START);
  const endCount = countOccurrences(source, CLEANING_HISTORY_AUTHORITY_END);
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`${CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH} must contain one exact capability authority block.`);
  }

  const start = source.indexOf(CLEANING_HISTORY_AUTHORITY_START) + CLEANING_HISTORY_AUTHORITY_START.length;
  const end = source.indexOf(CLEANING_HISTORY_AUTHORITY_END, start);
  const lines = source
    .slice(start, end)
    .trim()
    .split("\n")
    .map((line) => line.trimEnd());
  if (lines[0] !== "export const CLEANING_HISTORY_CAPABILITY_AUTHORITY = Object.freeze({" || lines.at(-1) !== "});") {
    throw new Error(`${CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH} capability authority block has invalid framing.`);
  }

  const entryPattern =
    /^ {2}(?<id>inspect|edit|delete|undo|reorder): Object\.freeze\(\{ status: "(?<status>implemented|not_committed)", scope: "(?<scope>any_committed_step|latest_committed_step|most_recent_committed_step|committed_steps)" \}\)(?<comma>,?)$/u;
  const capabilities = lines.slice(1, -1).map((line, index, entries) => {
    const match = entryPattern.exec(line);
    if (match === null) {
      throw new Error(`${CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH} authority entry ${index + 1} is invalid.`);
    }
    const expectedId = CLEANING_HISTORY_CAPABILITY_IDS[index];
    if (
      match.groups.id !== expectedId ||
      (index < entries.length - 1 ? match.groups.comma !== "," : match.groups.comma)
    ) {
      throw new Error(
        `${CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH} authority entry ${index + 1} must be ${expectedId}.`
      );
    }
    return { id: match.groups.id, status: match.groups.status, scope: match.groups.scope };
  });
  if (capabilities.length !== CLEANING_HISTORY_CAPABILITY_IDS.length) {
    throw new Error(
      `${CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH} must define exactly ${CLEANING_HISTORY_CAPABILITY_IDS.length} capabilities.`
    );
  }
  return { schemaVersion: 1, capabilities };
}

function assertCleaningHistoryModelMatchesProduction(model, productionAuthority) {
  model.capabilities.forEach((capability, index) => {
    const expected = productionAuthority.capabilities[index];
    if (
      capability.id !== expected?.id ||
      capability.status !== expected.status ||
      capability.scope !== expected.scope
    ) {
      throw new Error(
        `${CLEANING_HISTORY_MODEL_PATH} capability ${capability.id} must match the production authority ` +
          `${expected?.status ?? "missing"}/${expected?.scope ?? "missing"}.`
      );
    }
  });
}

function formatPassiveList(values) {
  if (values.length === 1) {
    return values[0];
  }
  if (values.length === 2) {
    return `${values[0]} or ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

function renderStepCapabilityClaims(capabilities, stepNoun) {
  const claims = [];
  const shared = capabilities.filter(
    (capability) => capability.status === "implemented" && capability.scope === "any_committed_step"
  );
  if (shared.length > 0) {
    claims.push(
      `Any ${stepNoun} can be ${formatPassiveList(
        shared.map((capability) => cleaningHistoryActions.get(capability.id).passive)
      )}.`
    );
  }

  for (const capability of capabilities.filter((entry) => !shared.includes(entry))) {
    const action = cleaningHistoryActions.get(capability.id);
    if (capability.status === "not_committed") {
      claims.push(`${action.unsupported} ${stepNoun}s is not supported.`);
    } else {
      claims.push(`Only the most recent ${stepNoun} can be ${action.passive}.`);
    }
  }
  return claims;
}

export function renderCleaningHistoryClaims(model) {
  const capabilities = new Map(model.capabilities.map((capability) => [capability.id, capability]));
  const access = CLEANING_HISTORY_CAPABILITY_IDS.slice(0, 3).map((id) => capabilities.get(id));
  const undo = capabilities.get("undo");
  const reorder = capabilities.get("reorder");

  const undoClaim =
    undo.status === "not_committed"
      ? "Cleaning Undo is not supported."
      : undo.scope === "most_recent_committed_step"
        ? "Cleaning Undo removes the most recent committed step."
        : "Cleaning Undo can remove any committed step.";
  const readmeReorderClaim =
    reorder.status === "implemented"
      ? "Committed steps can be reordered."
      : "Reordering committed steps is not supported.";
  const roadmapReorderClaim =
    reorder.status === "implemented"
      ? "Committed steps can be reordered."
      : "Reordering committed steps has no product commitment.";

  return {
    readme: [...renderStepCapabilityClaims(access, "applied step"), undoClaim, readmeReorderClaim],
    roadmap: [...renderStepCapabilityClaims(access, "committed step"), undoClaim, roadmapReorderClaim]
  };
}

const cleaningHistoryMarkdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const unresolvedVisibleNamedEntity = /&[a-z][a-z0-9]*;/iu;
const markdownClauseBoundary = /(?:[.!?;,\n]|\b(?:and|or|but|however|whereas|while|although|though|yet)\b)/iu;
const cleaningHistoryStatementBoundary = /[.!?;\n]+/u;
const cleaningHistorySemanticClauseBoundary = /\b(?:and|or|but|however|whereas|while|although|though|yet)\b/iu;

function maskMarkdownComments(source) {
  return source.replace(/<!--[^]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function parseCleaningHistoryMarkdown(source, label) {
  try {
    return cleaningHistoryMarkdown.parse(maskMarkdownComments(source.replace(/\r\n?/gu, "\n")), {});
  } catch (error) {
    throw new Error(`${label} is not valid bounded Markdown.`, { cause: error });
  }
}

function normalizeVisibleMarkdownText(value, label) {
  const normalized = value
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[\u02bc\u2018\u2019\uff07]/gu, "'")
    .replace(/[\u2010\u2011\ufe63\uff0d]/gu, "-")
    .replace(/[\u2012-\u2015\u2212\u2e3a\u2e3b\ufe58]/gu, " ");
  if (unresolvedVisibleNamedEntity.test(normalized)) {
    throw new Error(`${label} contains an unresolved visible named Markdown entity.`);
  }
  return normalized;
}

function flattenVisibleInlineChildren(children, label) {
  const fragments = [];
  let tokenCount = 0;
  const visit = (childTokens) => {
    for (const child of childTokens) {
      tokenCount += 1;
      if (tokenCount > CLEANING_HISTORY_INLINE_TOKEN_MAX) {
        throw new Error(
          `${label} contains more than ${CLEANING_HISTORY_INLINE_TOKEN_MAX} visible inline Markdown tokens.`
        );
      }
      if (child.type === "image" && Array.isArray(child.children)) {
        visit(child.children);
      } else if (child.type === "text" || child.type === "code_inline" || child.type === "image") {
        fragments.push({ type: child.type, text: normalizeVisibleMarkdownText(child.content, label) });
      } else if (child.type === "softbreak" || child.type === "hardbreak") {
        fragments.push({ type: "text", text: "\n" });
      }
    }
  };
  visit(children);
  return fragments;
}

function adjacentClause(value, side) {
  const clauses = value.split(markdownClauseBoundary);
  return side === "before" ? (clauses.at(-1) ?? "") : (clauses[0] ?? "");
}

function exampleCodeSpanIndexes(fragments) {
  const before = new Map();
  let context = "";
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    if (fragment.type === "code_inline") {
      before.set(index, context);
      context = "";
    } else {
      context = adjacentClause(`${context}${fragment.text}`, "before");
    }
  }

  const after = new Map();
  context = "";
  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index];
    if (fragment.type === "code_inline") {
      after.set(index, context);
      context = "";
    } else {
      context = adjacentClause(`${fragment.text}${context}`, "after");
    }
  }

  const exampleNoun = /\b(?:example|literal|sample|snippet|rejected[ -]?input)\b/iu;
  const presentationVerb =
    /\b(?:use|uses|used|show|shows|shown|write|writes|written|quote|quotes|quoted|present|presents|presented|label|labels|labeled|call|calls|called|read|reads|say|says)\b/iu;
  const designation =
    /^\s*(?:(?:only\s+)?as|is|was|serves?\s+as)\b[^.!?;,\n]{0,256}\b(?:example|literal|sample|snippet|rejected[ -]?input)\b/iu;
  return new Set(
    [...before.keys()].filter((index) => {
      const preceding = before.get(index) ?? "";
      const following = after.get(index) ?? "";
      return (exampleNoun.test(preceding) && presentationVerb.test(preceding)) || designation.test(following);
    })
  );
}

function renderedInlineText(token, label, { excludeExampleCode = false } = {}) {
  if (token?.type !== "inline" || !Array.isArray(token.children)) return "";
  const fragments = flattenVisibleInlineChildren(token.children, label);
  const excluded = excludeExampleCode ? exampleCodeSpanIndexes(fragments) : new Set();
  return fragments.map((fragment, index) => (excluded.has(index) ? " " : fragment.text)).join("");
}

function markdownHeadingRecords(tokens, label) {
  return tokens.flatMap((token, index) => {
    if (token.type !== "heading_open" || !Array.isArray(token.map) || !/^h[1-6]$/u.test(token.tag)) return [];
    return [
      {
        index,
        level: Number.parseInt(token.tag.slice(1), 10),
        map: token.map,
        text: renderedInlineText(tokens[index + 1], `${label} heading`)
          .replace(/\s+/gu, " ")
          .trim()
      }
    ];
  });
}

function extractMarkdownSection(document, path, heading) {
  assertBoundedUtf8(document, CLEANING_HISTORY_DOCUMENT_MAX_BYTES, path);
  const normalizedDocument = document.replace(/\r\n?/gu, "\n");
  const tokens = parseCleaningHistoryMarkdown(normalizedDocument, path);
  const headings = markdownHeadingRecords(tokens, path);
  const requestedHeadings = markdownHeadingRecords(
    parseCleaningHistoryMarkdown(heading, "claim-section heading"),
    "claim-section heading"
  );
  if (requestedHeadings.length !== 1) {
    throw new Error(`Invalid claim-section heading ${heading}.`);
  }
  const requestedHeading = requestedHeadings[0];
  const matches = headings.filter(
    (candidate) => candidate.level === requestedHeading.level && candidate.text === requestedHeading.text
  );
  if (matches.length !== 1) {
    throw new Error(`${path} must contain exactly one ${heading} heading.`);
  }
  const selected = matches[0];
  const next = headings.find((candidate) => candidate.index > selected.index && candidate.level <= selected.level);
  const lines = normalizedDocument.split("\n");
  const section = lines.slice(selected.map[1], next?.map[0] ?? lines.length).join("\n");
  assertBoundedUtf8(section, CLEANING_HISTORY_SECTION_MAX_BYTES, `${path} ${heading} section`);
  return section;
}

function countOccurrences(source, value) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(value, offset)) >= 0) {
    count += 1;
    offset += value.length;
  }
  return count;
}

export function renderCleaningHistoryClaimBlock(marker, claims) {
  return [
    `<!-- cleaning-history-capabilities:${marker}:start -->`,
    claims.join(" "),
    `<!-- cleaning-history-capabilities:${marker}:end -->`
  ].join("\n");
}

function assertExclusiveClaimBlock(document, path, heading, marker, claims) {
  const section = extractMarkdownSection(document, path, heading);
  const startMarker = `<!-- cleaning-history-capabilities:${marker}:start -->`;
  const endMarker = `<!-- cleaning-history-capabilities:${marker}:end -->`;
  if (countOccurrences(section, startMarker) !== 1 || countOccurrences(section, endMarker) !== 1) {
    throw new Error(`${path} ${heading} must contain one exclusive ${marker} claim block.`);
  }
  const start = section.indexOf(startMarker) + startMarker.length;
  const end = section.indexOf(endMarker, start);
  if (end < start) {
    throw new Error(`${path} ${heading} has an invalid ${marker} claim block.`);
  }
  const actual = section.slice(start, end).replace(/\s+/gu, " ").trim();
  const expected = claims.join(" ").replace(/\s+/gu, " ").trim();
  assertBoundedUtf8(actual, CLEANING_HISTORY_SECTION_MAX_BYTES, `${path} ${marker} claim block`);
  if (actual !== expected) {
    throw new Error(
      `${path} ${heading} ${marker} claim block must exclusively match the production capability claims.`
    );
  }
  const outside = `${section.slice(0, section.indexOf(startMarker))}${section.slice(end + endMarker.length)}`;
  if (containsContradictoryCleaningHistoryClaim(outside)) {
    throw new Error(
      `${path} ${heading} contains a contradictory cleaning-history capability claim outside its exclusive claim block.`
    );
  }
}

function tokenMatches(token, stems) {
  return stems.some((stem) => token === stem || token.startsWith(stem));
}

function cleaningHistoryClaimClauses(rendered) {
  const tokenize = (value) =>
    value
      .replace(/([\p{L}])-([\p{L}])/gu, "$1$2")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}']+/gu, " ")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);

  return rendered.split(cleaningHistoryStatementBoundary).flatMap((statement) => {
    const contextTokens = tokenize(statement);
    return statement
      .split(cleaningHistorySemanticClauseBoundary)
      .map(tokenize)
      .filter((tokens) => tokens.length > 0)
      .map((tokens) => ({ tokens, contextTokens }));
  });
}

function containsContradictoryCleaningHistoryClaim(source) {
  const rendered = parseCleaningHistoryMarkdown(source, "cleaning-history claim prose")
    .filter((token) => token.type === "inline")
    .map((token) => renderedInlineText(token, "cleaning-history claim prose", { excludeExampleCode: true }))
    .join("\n");
  const clauses = cleaningHistoryClaimClauses(rendered);

  const has = (tokens, words) => tokens.some((token) => words.includes(token));
  const hasStem = (tokens, stems) => tokens.some((token) => tokenMatches(token, stems));
  const directSubjectWords = ["step", "steps", "transformation", "transformations", "plan"];
  const ambiguousSubjectWords = ["operation", "operations", "entry", "entries", "history"];
  const negativeWords = [
    "no",
    "cannot",
    "can't",
    "never",
    "not",
    "unavailable",
    "unsupported",
    "disabled",
    "forbidden",
    "disallowed",
    "impossible",
    "prohibited",
    "blocked",
    "readonly"
  ];
  const unavailableWords = [
    "unavailable",
    "unsupported",
    "disabled",
    "forbidden",
    "disallowed",
    "impossible",
    "prohibited",
    "blocked",
    "readonly"
  ];

  return clauses.some(({ tokens, contextTokens }) => {
    const hasExplicitCleaningContext = has(tokens, ["applied", "cleaning", "committed"]);
    const hasLocalSubject =
      has(tokens, directSubjectWords) ||
      (has(tokens, ambiguousSubjectWords) && hasExplicitCleaningContext) ||
      (tokens.includes("workflow") && hasExplicitCleaningContext);
    const hasContextCleaning = has(contextTokens, ["applied", "cleaning", "committed"]);
    const hasContextSubject =
      has(contextTokens, directSubjectWords) ||
      (has(contextTokens, ambiguousSubjectWords) && hasContextCleaning) ||
      (contextTokens.includes("workflow") && hasContextCleaning);
    const inheritsSubject = !hasLocalSubject && hasContextSubject;
    const hasSubject = hasLocalSubject || inheritsSubject;
    const hasCleaningContext =
      hasStem(tokens, ["cleaning"]) || (inheritsSubject && hasStem(contextTokens, ["cleaning"]));
    const inspectEditDelete = hasStem(tokens, [
      "inspect",
      "edit",
      "delet",
      "modif",
      "revis",
      "amend",
      "alter",
      "remov",
      "eras"
    ]);
    const hasLatest = (candidate) =>
      has(candidate, ["latest", "newest", "last", "final"]) ||
      (candidate.includes("most") && candidate.includes("recent"));
    const hasExclusivity = (candidate) =>
      has(candidate, ["only", "sole", "solely", "exclusively", "limited", "restricted", "confined", "reserved"]);
    const hasPrior = (candidate) =>
      has(candidate, ["earlier", "older", "prior", "previous", "preceding", "nonlatest", "noncurrent"]);
    const latest = hasLatest(tokens) || (inheritsSubject && hasLatest(contextTokens));
    const exclusivity = hasExclusivity(tokens) || (inheritsSubject && hasExclusivity(contextTokens));
    const prior = hasPrior(tokens) || (inheritsSubject && hasPrior(contextTokens));
    const negative = has(tokens, negativeWords);
    const unavailable =
      has(tokens, unavailableWords) ||
      (tokens.includes("not") && has(tokens, ["supported", "available", "implemented", "enabled", "allowed"]));
    const latestOnly = hasSubject && inspectEditDelete && latest && exclusivity && !tokens.includes("not");
    const priorDenied = hasSubject && inspectEditDelete && prior && negative;
    const implementedActionDenied = (hasSubject || hasCleaningContext) && inspectEditDelete && unavailable;

    const undo = hasStem(tokens, ["undo", "rollback", "revert", "revers", "restor"]);
    const arbitraryTarget =
      has(tokens, [
        "any",
        "every",
        "each",
        "earlier",
        "older",
        "prior",
        "another",
        "other",
        "changed",
        "selected",
        "chosen",
        "choice",
        "pick",
        "which",
        "arbitrary",
        "individual",
        "whichever"
      ]) || hasStem(tokens, ["choos", "pick", "select", "specif"]);
    const hasAnaphoricTarget = has(tokens, ["it", "one", "ones", "them", "these", "those"]);
    const arbitraryUndo = (hasSubject || hasAnaphoricTarget) && undo && arbitraryTarget && !negative;
    const unrelatedUndoSurface = has(tokens, [
      "button",
      "buttons",
      "field",
      "fields",
      "input",
      "inputs",
      "keyboard",
      "shortcut",
      "shortcuts"
    ]);
    const standaloneUndoClaim = undo && tokens.length <= 5 && !unrelatedUndoSurface;
    const undoDenied =
      undo && unavailable && !unrelatedUndoSurface && (hasSubject || hasCleaningContext || standaloneUndoClaim);
    const undoLatestDenied = undo && latest && exclusivity && negative;

    const explicitReorder = hasStem(tokens, ["reorder", "rearrang", "shuffl", "permut"]);
    const reorder =
      explicitReorder ||
      (hasSubject &&
        (hasStem(tokens, ["ordering", "sequenc"]) ||
          (tokens.includes("order") && hasStem(tokens, ["chang", "edit", "mutab"]))));
    const standaloneReorderClaim = explicitReorder && tokens.length <= 5;
    const positiveReorder =
      (hasSubject || hasCleaningContext || standaloneReorderClaim) &&
      reorder &&
      !negative &&
      hasStem(tokens, [
        "can",
        "may",
        "support",
        "availab",
        "implement",
        "enabl",
        "allow",
        "possib",
        "offer",
        "mutab",
        "chang",
        "edit"
      ]);

    return (
      latestOnly ||
      priorDenied ||
      implementedActionDenied ||
      arbitraryUndo ||
      undoDenied ||
      undoLatestDenied ||
      positiveReorder
    );
  });
}

export function assertCleaningHistoryClaimsCurrent({ modelSource, productionAuthoritySource, documents }) {
  const model = parseCleaningHistoryCapabilityModel(modelSource);
  const productionAuthority = parseCleaningHistoryProductionAuthority(productionAuthoritySource);
  assertCleaningHistoryModelMatchesProduction(model, productionAuthority);
  const claims = renderCleaningHistoryClaims(model);
  for (const surface of cleaningHistoryClaimSurfaces) {
    assertExclusiveClaimBlock(
      documents[surface.path],
      surface.path,
      surface.heading,
      surface.marker,
      claims[surface.claimKind]
    );
  }
}

async function readCleaningHistoryInputs() {
  const [modelSource, productionAuthoritySource, ...contents] = await Promise.all([
    readBoundedUtf8File(
      resolve(root, CLEANING_HISTORY_MODEL_PATH),
      CLEANING_HISTORY_MODEL_MAX_BYTES,
      CLEANING_HISTORY_MODEL_PATH
    ),
    readBoundedUtf8File(
      resolve(root, CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH),
      CLEANING_HISTORY_PRODUCTION_AUTHORITY_MAX_BYTES,
      CLEANING_HISTORY_PRODUCTION_AUTHORITY_PATH
    ),
    ...CLEANING_HISTORY_DOCUMENTS.map((path) =>
      readBoundedUtf8File(resolve(root, path), CLEANING_HISTORY_DOCUMENT_MAX_BYTES, path)
    )
  ]);
  return {
    modelSource,
    productionAuthoritySource,
    documents: Object.fromEntries(CLEANING_HISTORY_DOCUMENTS.map((path, index) => [path, contents[index]]))
  };
}

export async function checkCleaningHistoryClaims() {
  assertCleaningHistoryClaimsCurrent(await readCleaningHistoryInputs());
}

export function extractInvariantSection(source) {
  const heading = /^## Non-negotiable invariants$/mu.exec(source);
  if (heading === null) {
    throw new Error("AGENTS.md is missing the Non-negotiable invariants section.");
  }

  const followingHeading = /^## /gmu;
  followingHeading.lastIndex = heading.index + heading[0].length;
  const next = followingHeading.exec(source);
  if (next === null) {
    throw new Error("AGENTS.md is missing a section after Non-negotiable invariants.");
  }

  const rawSection = source.slice(heading.index, next.index);
  return `${rawSection.replace(/\n+$/u, "")}\n`;
}

export function parseInvariantEntries(section, firstLine = 1) {
  const starts = [...section.matchAll(/^(?<id>[1-9]\d*)\. /gmu)];
  if (starts.length !== EXPECTED_INVARIANT_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_INVARIANT_COUNT} invariants, found ${starts.length}. Invariant removal requires a reviewed contract migration.`
    );
  }

  const entries = starts.map((match, index) => {
    const id = Number(match.groups.id);
    const expectedId = index + 1;
    if (id !== expectedId) {
      throw new Error(`Invariant IDs must be contiguous: expected ${expectedId}, found ${id}.`);
    }

    const nextOffset = starts[index + 1]?.index ?? section.length;
    const text = section.slice(match.index, nextOffset).replace(/\n+$/u, "");
    const startLine = firstLine + lineNumberAt(section, match.index) - 1;
    const endLine = startLine + text.split("\n").length - 1;
    return { id, text, startLine, endLine, sha256: sha256(text) };
  });

  return entries;
}

function referencedInvariantIds(line) {
  const ids = [];
  for (const match of line.matchAll(/\binvariants?\s+(?<id>[1-9]\d*)\b/giu)) {
    const id = Number(match.groups.id);
    if (id < 1 || id > EXPECTED_INVARIANT_COUNT) {
      throw new Error(`Explicit reference points to unknown invariant ${id}.`);
    }
    ids.push(id);
  }
  return ids;
}

export function scanExplicitReferences(documents) {
  const references = new Map(Array.from({ length: EXPECTED_INVARIANT_COUNT }, (_, index) => [index + 1, []]));

  for (const path of Object.keys(documents).sort()) {
    const lines = documents[path].split("\n");
    lines.forEach((line, index) => {
      for (const id of referencedInvariantIds(line)) {
        const reference = { path, line: index + 1 };
        const current = references.get(id);
        if (!current.some((item) => item.path === reference.path && item.line === reference.line)) {
          current.push(reference);
        }
      }
    });
  }

  return references;
}

export function buildCrosswalk({ source, archive, documents }) {
  const section = extractInvariantSection(source);
  if (archive !== section) {
    throw new Error(`${ARCHIVE_PATH} is not a lossless copy of the current invariant block.`);
  }

  const sourceSectionOffset = source.indexOf(section);
  if (sourceSectionOffset < 0) {
    throw new Error("The extracted invariant block could not be located in AGENTS.md.");
  }
  const sourceFirstLine = lineNumberAt(source, sourceSectionOffset);
  const sourceEntries = parseInvariantEntries(section, sourceFirstLine);
  const archiveEntries = parseInvariantEntries(archive);
  const references = scanExplicitReferences(documents);

  const invariants = sourceEntries.map((entry, index) => {
    const archived = archiveEntries[index];
    if (archived.id !== entry.id || archived.sha256 !== entry.sha256) {
      throw new Error(`Invariant ${entry.id} differs between AGENTS.md and the archive.`);
    }
    return {
      id: entry.id,
      sha256: entry.sha256,
      sourceLines: { start: entry.startLine, end: entry.endLine },
      archiveLines: { start: archived.startLine, end: archived.endLine },
      explicitReferences: references.get(entry.id)
    };
  });

  return {
    schemaVersion: 1,
    generatedBy: "scripts/spec-invariants.mjs",
    authority: {
      path: SOURCE_PATH,
      section: "Non-negotiable invariants",
      sha256: sha256(section)
    },
    archive: { path: ARCHIVE_PATH, sha256: sha256(archive) },
    scannedDocuments: Object.keys(documents).sort(),
    invariantCount: invariants.length,
    invariants
  };
}

export function renderCrosswalk(crosswalk) {
  const placeholder = "__OPEN_WRANGLER_SCANNED_DOCUMENTS__";
  const rendered = JSON.stringify({ ...crosswalk, scannedDocuments: placeholder }, null, 2);
  const documents = `[${crosswalk.scannedDocuments.map((path) => JSON.stringify(path)).join(", ")}]`;
  return `${rendered.replace(`"${placeholder}"`, documents)}\n`;
}

async function readDocuments() {
  return Object.fromEntries(
    await Promise.all(SCANNED_DOCUMENTS.map(async (path) => [path, await readFile(resolve(root, path), "utf8")]))
  );
}

async function writeGeneratedFiles() {
  await checkCleaningHistoryClaims();
  const source = await readFile(resolve(root, SOURCE_PATH), "utf8");
  const archive = extractInvariantSection(source);
  const documents = await readDocuments();
  const crosswalk = buildCrosswalk({ source, archive, documents });

  await mkdir(resolve(root, dirname(ARCHIVE_PATH)), { recursive: true });
  await mkdir(resolve(root, dirname(EVIDENCE_PATH)), { recursive: true });
  await writeFile(resolve(root, ARCHIVE_PATH), archive, "utf8");
  await writeFile(resolve(root, EVIDENCE_PATH), renderCrosswalk(crosswalk), "utf8");
}

export function assertGeneratedFilesCurrent({ source, archive, evidence, documents }) {
  const expected = renderCrosswalk(buildCrosswalk({ source, archive, documents }));
  if (evidence !== expected) {
    throw new Error(`${EVIDENCE_PATH} is stale. Run node scripts/spec-invariants.mjs --write.`);
  }
}

export async function checkGeneratedFiles() {
  const [source, archive, evidence, documents, cleaningHistoryInputs] = await Promise.all([
    readFile(resolve(root, SOURCE_PATH), "utf8"),
    readFile(resolve(root, ARCHIVE_PATH), "utf8"),
    readFile(resolve(root, EVIDENCE_PATH), "utf8"),
    readDocuments(),
    readCleaningHistoryInputs()
  ]);
  assertGeneratedFilesCurrent({ source, archive, evidence, documents });
  assertCleaningHistoryClaimsCurrent(cleaningHistoryInputs);
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_[0] !== undefined && !["--check", "--write"].includes(arguments_[0]))) {
    throw new Error("Usage: node scripts/spec-invariants.mjs [--check|--write]");
  }
  if (arguments_[0] === "--write") {
    await writeGeneratedFiles();
    return;
  }
  await checkGeneratedFiles();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
