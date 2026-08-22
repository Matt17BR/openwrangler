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
const CLEANING_HISTORY_WORD_TOKEN_MAX = 4096;
const CLEANING_HISTORY_PREDICATE_TOKEN_MAX = 512;
const CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX = 34;
const CLEANING_HISTORY_CAPABILITY_OWNERSHIP_WINDOW = 12;
const CLEANING_HISTORY_COORDINATED_CAPABILITY_MAX = 3;
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
const visibleEntityShape = /&[^\s&<>;]*;/gu;
const validNumericEntity = /^&#(?:[0-9]+|x[0-9a-f]+);$/iu;
const validNamedEntityShape = /^&[a-z][a-z0-9]*;$/iu;
const cleaningHistoryDecodedWhitespaceSentinel = "\u{10fffc}";
const cleaningHistoryDecodedWhitespaceSentinelCodePoint = cleaningHistoryDecodedWhitespaceSentinel.codePointAt(0);
const cleaningHistoryDecodedBoundarySentinel = "\u{10fffd}";
const cleaningHistoryDecodedBoundarySentinelCodePoint = cleaningHistoryDecodedBoundarySentinel.codePointAt(0);
const cleaningHistorySentenceTerminal = /\p{Sentence_Terminal}/u;
const cleaningHistoryRenderedWhitespaceEntityCodePoints = new Set([0x0a, 0x0d]);
const cleaningHistoryRenderedBoundaryCodePoints = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x0589, 0x061b, 0x061f, 0x06d4, 0x0964, 0x0965, 0x1362, 0x1367, 0x1368, 0x2028, 0x2029,
  0x3002
]);
const cleaningHistoryClauseBoundaryGrammar = Object.freeze({
  connectorRoles: Object.freeze({
    although: "subordinate",
    and: "coordinate",
    as: "designation-sensitive",
    because: "subordinate",
    but: "coordinate",
    however: "coordinate",
    if: "subordinate",
    or: "coordinate",
    plus: "coordinate",
    since: "subordinate",
    so: "coordinate",
    therefore: "coordinate",
    though: "subordinate",
    unless: "exception-sensitive",
    whenever: "subordinate",
    when: "exception-sensitive",
    whereas: "subordinate",
    where: "subordinate",
    while: "subordinate",
    yet: "coordinate"
  }),
  punctuationRoles: Object.freeze({
    ".": "statement",
    "!": "statement",
    "?": "statement",
    ";": "statement",
    "\n": "statement",
    ",": "segment",
    ":": "segment",
    "—": "segment"
  })
});
const cleaningHistoryClauseConnectorRoles = cleaningHistoryClauseBoundaryGrammar.connectorRoles;
const cleaningHistoryClausePunctuationRoles = cleaningHistoryClauseBoundaryGrammar.punctuationRoles;
const cleaningHistoryCoordinateConnectors = new Set(
  Object.entries(cleaningHistoryClauseConnectorRoles)
    .filter(([, role]) => role === "coordinate")
    .map(([connector]) => connector)
);
const cleaningHistoryPassiveCapabilityAuxiliaries = new Set(["am", "are", "be", "been", "being", "is", "was", "were"]);
const cleaningHistoryBarePassiveCapabilities = new Set([
  "amended",
  "altered",
  "deleted",
  "edited",
  "erased",
  "inspected",
  "modified",
  "permuted",
  "rearranged",
  "removed",
  "reordered",
  "restored",
  "reverted",
  "reversed",
  "revised",
  "shuffled",
  "undone"
]);
const cleaningHistoryNominalizedCapabilities = new Set([
  "deletion",
  "deletions",
  "edit",
  "editing",
  "edits",
  "inspection",
  "inspections",
  "modification",
  "modifications"
]);
const cleaningHistoryPostPredicateAnaphors = new Set(["it", "them", "these", "they", "this", "those"]);
const cleaningHistoryCapabilityContextPrepositions = new Set([
  "at",
  "from",
  "in",
  "inside",
  "on",
  "through",
  "via",
  "within"
]);
const cleaningHistoryCapabilityStatus =
  /^(?:available|blocked|disabled|disallowed|enabled|forbidden|impossible|limited|offered|prohibited|reserved|restricted|supported|unavailable|unsupported)$/u;
const cleaningHistoryConditionalJoinerSource = String.raw`(?:[ -]|\p{Default_Ignorable_Code_Point})+`;
const cleaningHistoryIfAndOnlyIfSpelling = new RegExp(
  `\\bif${cleaningHistoryConditionalJoinerSource}and${cleaningHistoryConditionalJoinerSource}only${cleaningHistoryConditionalJoinerSource}if\\b`,
  "giu"
);
const cleaningHistoryOnlyConditionSpelling = new RegExp(
  `\\bonly${cleaningHistoryConditionalJoinerSource}(if|when)\\b`,
  "giu"
);
const cleaningHistoryStatementPunctuationSource = Object.entries(cleaningHistoryClausePunctuationRoles)
  .filter(([, role]) => role === "statement")
  .map(([punctuation]) => (punctuation === "\n" ? "\\n" : punctuation))
  .join("");
const cleaningHistoryStatementBoundary = new RegExp(`[${cleaningHistoryStatementPunctuationSource}]+`, "gu");
const cleaningHistoryClausePunctuationSource = Object.keys(cleaningHistoryClausePunctuationRoles)
  .map((punctuation) => (punctuation === "\n" ? "\\n" : punctuation))
  .join("");
const cleaningHistoryClauseLexemePattern = new RegExp(
  `[\\p{L}\\p{N}']+|[${cleaningHistoryClausePunctuationSource}]`,
  "gu"
);
const cleaningHistoryExampleNounTokens = new Set(["example", "literal", "sample", "snippet"]);
const cleaningHistoryPredicatePhraseAuxiliaries = new Set([
  "are",
  "can",
  "could",
  "did",
  "do",
  "does",
  "is",
  "may",
  "might",
  "must",
  "should",
  "was",
  "were",
  "will",
  "would"
]);
const cleaningHistoryPriorWords = Object.freeze([
  "earlier",
  "older",
  "prior",
  "previous",
  "preceding",
  "nonlatest",
  "noncurrent"
]);
const cleaningHistorySetCardinalityWords = Object.freeze([
  "all",
  "both",
  "multiple",
  "every",
  "each",
  "some",
  "several",
  "few",
  "none",
  "neither"
]);

function maskMarkdownComments(source) {
  return source.replace(/<!--[^]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function assertValidVisibleEntityShapes(source, label) {
  for (const match of source.matchAll(/&#/gu)) {
    const remainder = source.slice(match.index, match.index + 32);
    const entity = /^&#(?:[0-9]+|x[0-9a-f]+);/iu.exec(remainder)?.[0];
    if (entity === undefined) {
      throw new Error(`${label} contains a malformed visible numeric Markdown entity.`);
    }
  }
  for (const match of source.matchAll(visibleEntityShape)) {
    const entity = match[0];
    if (!entity.startsWith("&#")) {
      if (!validNamedEntityShape.test(entity)) {
        throw new Error(`${label} contains a malformed visible named Markdown entity.`);
      }
      continue;
    }
    if (!validNumericEntity.test(entity)) {
      throw new Error(`${label} contains a malformed visible numeric Markdown entity.`);
    }
    const digits = entity.slice(entity[2]?.toLowerCase() === "x" ? 3 : 2, -1);
    const radix = entity[2]?.toLowerCase() === "x" ? 16 : 10;
    const codePoint = Number.parseInt(digits, radix);
    if (
      codePoint === 0 ||
      codePoint === cleaningHistoryDecodedWhitespaceSentinelCodePoint ||
      codePoint === cleaningHistoryDecodedBoundarySentinelCodePoint ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new Error(`${label} contains a malformed visible numeric Markdown entity.`);
    }
  }
}

function visibleInlineMarkdownSource(source) {
  let visible = "";
  for (let index = 0; index < source.length;) {
    if (source[index] === "`") {
      let end = index + 1;
      while (source[end] === "`") end += 1;
      const fence = source.slice(index, end);
      const close = source.indexOf(fence, end);
      index = close < 0 ? end : close + fence.length;
      continue;
    }
    if (source[index] === "]" && source[index + 1] === "(") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "(") depth += 1;
        if (source[index] === ")") depth -= 1;
        index += 1;
      }
      continue;
    }
    visible += source[index];
    index += 1;
  }
  return visible;
}

function normalizeVisibleBoundaryEntitySource(source) {
  let normalized = "";
  for (let index = 0; index < source.length;) {
    if (source[index] === "`") {
      let end = index + 1;
      while (source[end] === "`") end += 1;
      const fence = source.slice(index, end);
      const close = source.indexOf(fence, end);
      const next = close < 0 ? end : close + fence.length;
      normalized += source.slice(index, next);
      index = next;
      continue;
    }
    if (source[index] === "]" && source[index + 1] === "(") {
      let depth = 1;
      const start = index;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "(") depth += 1;
        if (source[index] === ")") depth -= 1;
        index += 1;
      }
      normalized += source.slice(start, index);
      continue;
    }
    const remainder = source.slice(index, index + 32);
    if (remainder.startsWith("&NewLine;")) {
      normalized += cleaningHistoryDecodedWhitespaceSentinel;
      index += "&NewLine;".length;
      continue;
    }
    const numericEntity = /^&#(?:[0-9]+|x[0-9a-f]+);/iu.exec(remainder)?.[0];
    if (numericEntity !== undefined) {
      const hexadecimal = numericEntity[2]?.toLowerCase() === "x";
      const digits = numericEntity.slice(hexadecimal ? 3 : 2, -1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (cleaningHistoryRenderedWhitespaceEntityCodePoints.has(codePoint)) {
        normalized += cleaningHistoryDecodedWhitespaceSentinel;
        index += numericEntity.length;
        continue;
      }
      if (cleaningHistoryRenderedBoundaryCodePoints.has(codePoint)) {
        normalized += cleaningHistoryDecodedBoundarySentinel;
        index += numericEntity.length;
        continue;
      }
    }
    normalized += source[index];
    index += 1;
  }
  return normalized;
}

function normalizeCleaningHistoryRenderedBoundaries(value) {
  let normalized = value;
  for (const codePoint of cleaningHistoryRenderedBoundaryCodePoints) {
    normalized = normalized.replaceAll(String.fromCodePoint(codePoint), "\n");
  }
  return normalized;
}

function parseCleaningHistoryMarkdown(source, label) {
  try {
    if (
      source.includes(cleaningHistoryDecodedWhitespaceSentinel) ||
      source.includes(cleaningHistoryDecodedBoundarySentinel)
    ) {
      throw new Error(`${label} contains a reserved rendered-boundary marker.`);
    }
    const parsed = cleaningHistoryMarkdown.parse(maskMarkdownComments(source.replace(/\r\n?/gu, "\n")), {});
    for (const token of parsed) {
      if (token.type === "inline") {
        assertValidVisibleEntityShapes(visibleInlineMarkdownSource(token.content), label);
        const normalizedContent = normalizeVisibleBoundaryEntitySource(token.content);
        if (normalizedContent !== token.content) {
          const normalizedInline = cleaningHistoryMarkdown.parseInline(normalizedContent, {});
          if (
            normalizedInline.length !== 1 ||
            normalizedInline[0]?.type !== "inline" ||
            !Array.isArray(normalizedInline[0].children)
          ) {
            throw new Error(`${label} has an invalid rendered boundary structure.`);
          }
          token.content = normalizedContent;
          token.children = normalizedInline[0].children;
        }
      }
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && /malformed visible/u.test(error.message)) throw error;
    throw new Error(`${label} is not valid bounded Markdown.`, { cause: error });
  }
}

function normalizeCleaningHistoryConditionalSpellings(value) {
  return value
    .replace(cleaningHistoryIfAndOnlyIfSpelling, "only if")
    .replace(cleaningHistoryOnlyConditionSpelling, "only $1");
}

function normalizeVisibleMarkdownText(value, label, { validateEntities = true } = {}) {
  if (validateEntities) assertValidVisibleEntityShapes(value, label);
  const normalized = normalizeCleaningHistoryRenderedBoundaries(
    normalizeCleaningHistoryConditionalSpellings(value.normalize("NFKC"))
      .replaceAll(cleaningHistoryDecodedWhitespaceSentinel, " ")
      .replaceAll(cleaningHistoryDecodedBoundarySentinel, "\n")
      .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
  )
    .replace(/[\u02bc\u2018\u2019\uff07]/gu, "'")
    .replace(/[\u2010\u2011\ufe63\uff0d]/gu, "-")
    .replace(/[\u2012\u2013\u2015\u2212\u2e3a\u2e3b\ufe58]/gu, " ");
  if (validateEntities) {
    for (const character of normalized) {
      if (
        cleaningHistorySentenceTerminal.test(character) &&
        cleaningHistoryClausePunctuationRoles[character] === undefined
      ) {
        throw new Error(`${label} contains an unsupported visible sentence terminal.`);
      }
    }
  }
  if (validateEntities && unresolvedVisibleNamedEntity.test(normalized)) {
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
      } else if (child.type === "text" || child.type === "image") {
        fragments.push({ type: child.type, text: normalizeVisibleMarkdownText(child.content, label) });
      } else if (child.type === "code_inline") {
        fragments.push({
          type: child.type,
          text: normalizeVisibleMarkdownText(child.content, label, { validateEntities: false })
        });
      } else if (child.type === "softbreak" || child.type === "hardbreak") {
        fragments.push({ type: "text", text: " " });
      }
    }
  };
  visit(children);
  return fragments;
}

function cleaningHistoryConnectorRole(token) {
  return Object.hasOwn(cleaningHistoryClauseConnectorRoles, token)
    ? cleaningHistoryClauseConnectorRoles[token]
    : undefined;
}

function cleaningHistoryAsIntroducesExampleDesignation(tokens, index, operationCounter) {
  if (["same", "such"].includes(tokens[index - 1])) return true;
  const maximum = Math.min(tokens.length, index + 33);
  let designation = false;
  for (let cursor = index + 1; cursor < maximum; cursor += 1) {
    if (operationCounter !== undefined) {
      operationCounter.value += 1;
      operationCounter.designationLookaheadOperations += 1;
    }
    const token = tokens[cursor];
    if (
      cleaningHistoryClausePunctuationRoles[token] !== undefined ||
      cleaningHistoryConnectorRole(token) !== undefined
    ) {
      return designation;
    }
    if (
      cleaningHistoryExampleNounTokens.has(token) ||
      token === "rejectedinput" ||
      (token === "rejected" && tokens[cursor + 1] === "input")
    ) {
      designation = true;
    }
    if (cleaningHistoryPredicateKind(token) !== undefined || isCleaningHistoryNoun(tokens, cursor)) return false;
  }
  return designation;
}

function cleaningHistoryEmDashJoinsPredicatePhrase(tokens, index) {
  return (
    cleaningHistoryPredicateKind(tokens[index - 1]) !== undefined &&
    cleaningHistoryPredicatePhraseAuxiliaries.has(tokens[index + 1])
  );
}

function cleaningHistoryConnectorContinuesUndoException(tokens, index, operationCounter) {
  const token = tokens[index];
  const start =
    token === "when" && tokens[index - 1] === "except" ? index - 2 : token === "unless" ? index - 1 : undefined;
  if (start === undefined) return false;
  const minimum = Math.max(0, index - 34);
  let hasUndo = false;
  let hasCleaningNoun = false;
  for (let cursor = start; cursor >= minimum; cursor -= 1) {
    if (operationCounter !== undefined) {
      operationCounter.value += 1;
      operationCounter.exceptionLookbehindOperations += 1;
    }
    const candidate = tokens[cursor];
    if (
      cleaningHistoryClausePunctuationRoles[candidate] !== undefined ||
      cleaningHistoryConnectorRole(candidate) !== undefined
    ) {
      break;
    }
    hasUndo ||= cleaningHistoryPredicateKind(candidate) === "undo";
    hasCleaningNoun ||= isCleaningHistoryNoun(tokens, cursor);
  }
  return hasUndo && hasCleaningNoun;
}

function cleaningHistoryHasExclusiveConditionAt(tokens, index) {
  return ["if", "when"].includes(tokens[index]) && tokens[index - 1] === "only" && tokens[index - 2] !== "not";
}

function cleaningHistoryClauseBoundaryKind(
  tokens,
  index,
  operationCounter = undefined,
  preserveExclusiveCondition = true
) {
  if (operationCounter !== undefined) operationCounter.value += 1;
  const token = tokens[index];
  const punctuationRole = cleaningHistoryClausePunctuationRoles[token];
  if (punctuationRole !== undefined) {
    return token === "—" && cleaningHistoryEmDashJoinsPredicatePhrase(tokens, index) ? undefined : punctuationRole;
  }
  const connectorRole = cleaningHistoryConnectorRole(token);
  if (connectorRole === undefined) return undefined;
  if (preserveExclusiveCondition && cleaningHistoryHasExclusiveConditionAt(tokens, index)) return undefined;
  if (
    connectorRole === "designation-sensitive" &&
    cleaningHistoryAsIntroducesExampleDesignation(tokens, index, operationCounter)
  ) {
    return undefined;
  }
  if (
    connectorRole === "exception-sensitive" &&
    cleaningHistoryConnectorContinuesUndoException(tokens, index, operationCounter)
  ) {
    return undefined;
  }
  return "connector";
}

function cleaningHistoryClauseBoundaryRecords(value) {
  const lexemes = [...value.matchAll(cleaningHistoryClauseLexemePattern)].map((match) => ({
    end: match.index + match[0].length,
    start: match.index,
    token: match[0].toLowerCase()
  }));
  const tokens = lexemes.map(({ token }) => token);
  const operationCounter = {
    designationLookaheadOperations: 0,
    exceptionLookbehindOperations: 0,
    value: 0
  };
  const boundaries = [];
  for (let index = 0; index < lexemes.length; index += 1) {
    if (cleaningHistoryClauseBoundaryKind(tokens, index, operationCounter, false) !== undefined) {
      boundaries.push({ end: lexemes[index].end, start: lexemes[index].start });
    }
  }
  return {
    boundaries,
    designationLookaheadOperations: operationCounter.designationLookaheadOperations,
    exceptionLookbehindOperations: operationCounter.exceptionLookbehindOperations,
    grammarOperations: operationCounter.value
  };
}

function exampleCodeSpanIndexes(fragments, testHooks = undefined) {
  let operations = fragments.length;
  const chunks = [];
  const codeSpans = [];
  let offset = 0;
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    const start = offset;
    offset += fragment.text.length;
    if (fragment.type === "code_inline") {
      codeSpans.push({ end: offset, index, start });
      chunks.push(" ".repeat(fragment.text.length));
    } else {
      chunks.push(fragment.text);
    }
  }
  if (codeSpans.length === 0) {
    testHooks?.recordInlineFragmentContextOperations?.(operations, {
      codeSpanCount: 0,
      designationLookaheadOperations: 0,
      exceptionLookbehindOperations: 0,
      fragmentCount: fragments.length,
      grammarOperations: 0,
      visibleCodeUnits: offset
    });
    return new Set();
  }

  const visible = chunks.join("");
  operations += visible.length;
  const boundaryRecords = cleaningHistoryClauseBoundaryRecords(visible);
  const { boundaries } = boundaryRecords;
  operations += visible.length + boundaryRecords.grammarOperations;

  const before = new Map();
  let boundaryIndex = 0;
  let previousBarrierEnd = 0;
  let previousCodeEnd = 0;
  for (const codeSpan of codeSpans) {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex].end <= codeSpan.start) {
      previousBarrierEnd = boundaries[boundaryIndex].end;
      boundaryIndex += 1;
      operations += 1;
    }
    const start = Math.max(previousBarrierEnd, previousCodeEnd);
    before.set(codeSpan.index, visible.slice(start, codeSpan.start));
    operations += codeSpan.start - start + 1;
    previousCodeEnd = codeSpan.end;
  }

  const after = new Map();
  boundaryIndex = boundaries.length - 1;
  let nextBarrierStart = visible.length;
  let nextCodeStart = visible.length;
  for (let index = codeSpans.length - 1; index >= 0; index -= 1) {
    const codeSpan = codeSpans[index];
    while (boundaryIndex >= 0 && boundaries[boundaryIndex].start >= codeSpan.end) {
      nextBarrierStart = boundaries[boundaryIndex].start;
      boundaryIndex -= 1;
      operations += 1;
    }
    const end = Math.min(nextBarrierStart, nextCodeStart);
    after.set(codeSpan.index, visible.slice(codeSpan.end, end));
    operations += end - codeSpan.end + 1;
    nextCodeStart = codeSpan.start;
  }

  const exampleNoun = /\b(?:example|literal|sample|snippet|rejected[ -]?input)\b/iu;
  const presentationVerb =
    /\b(?:use|uses|used|show|shows|shown|write|writes|written|quote|quotes|quoted|present|presents|presented|label|labels|labeled|call|calls|called|read|reads|say|says)\b/iu;
  const designation =
    /^\s*(?:(?:only\s+)?as|is|was|serves?\s+as)\b[^.!?;,\n]{0,256}\b(?:example|literal|sample|snippet|rejected[ -]?input)\b/iu;
  const examples = new Set();
  for (const { index } of codeSpans) {
    const preceding = before.get(index) ?? "";
    const following = after.get(index) ?? "";
    operations += preceding.length * 2 + following.length + 1;
    if ((exampleNoun.test(preceding) && presentationVerb.test(preceding)) || designation.test(following)) {
      examples.add(index);
    }
  }
  testHooks?.recordInlineFragmentContextOperations?.(operations, {
    codeSpanCount: codeSpans.length,
    designationLookaheadOperations: boundaryRecords.designationLookaheadOperations,
    exceptionLookbehindOperations: boundaryRecords.exceptionLookbehindOperations,
    fragmentCount: fragments.length,
    grammarOperations: boundaryRecords.grammarOperations,
    visibleCodeUnits: visible.length
  });
  return examples;
}

function renderedInlineText(token, label, { excludeExampleCode = false, testHooks = undefined } = {}) {
  if (token?.type !== "inline" || !Array.isArray(token.children)) return "";
  const fragments = flattenVisibleInlineChildren(token.children, label);
  const excluded = excludeExampleCode ? exampleCodeSpanIndexes(fragments, testHooks) : new Set();
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

function assertExclusiveClaimBlock(document, path, heading, marker, claims, testHooks = undefined) {
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
  if (containsContradictoryCleaningHistoryClaim(outside, testHooks)) {
    throw new Error(
      `${path} ${heading} contains a contradictory cleaning-history capability claim outside its exclusive claim block.`
    );
  }
}

const cleaningHistoryAnaphors = new Set([
  "another",
  "all",
  "both",
  "each",
  "every",
  "few",
  "it",
  "neither",
  "none",
  "one",
  "ones",
  "other",
  "others",
  "several",
  "some",
  "that",
  "them",
  "these",
  "they",
  "this",
  "those"
]);
const cleaningHistoryBareHistoryNouns = new Set([
  "entries",
  "entry",
  "operation",
  "operations",
  "step",
  "steps",
  "transformation",
  "transformations"
]);
const cleaningHistoryLatestWords = new Set(["latest", "newest", "last", "final"]);
const cleaningHistoryMultiWords = new Set([
  "additional",
  "another",
  "both",
  "couple",
  "dozen",
  "eight",
  "eleven",
  "every",
  "few",
  "five",
  "four",
  "many",
  "multiple",
  "nine",
  "pair",
  "quartet",
  "seven",
  "several",
  "six",
  "ten",
  "three",
  "twelve",
  "two"
]);
const cleaningHistoryIntrinsicNegativeWords = new Set([
  "blocked",
  "disabled",
  "disallowed",
  "forbidden",
  "impossible",
  "nondeletable",
  "noneditable",
  "noninspectable",
  "nonmodifiable",
  "prohibited",
  "readonly",
  "unable",
  "unavailable",
  "undeletable",
  "uneditable",
  "uninspectable",
  "unmodifiable",
  "unsupported"
]);
const cleaningHistoryActorWords = new Set(["anyone", "people", "person", "someone", "user", "users"]);
const cleaningHistoryGrammarWords = new Set([
  "a",
  "about",
  "additional",
  "after",
  "already",
  "all",
  "an",
  "and",
  "another",
  "any",
  "apart",
  "applied",
  "are",
  "as",
  "at",
  "available",
  "be",
  "been",
  "before",
  "being",
  "both",
  "but",
  "by",
  "can",
  "cannot",
  "certain",
  "changed",
  "chosen",
  "cleaning",
  "committed",
  "could",
  "current",
  "did",
  "do",
  "does",
  "each",
  "earlier",
  "every",
  "except",
  "exist",
  "exists",
  "few",
  "final",
  "for",
  "from",
  "generated",
  "had",
  "has",
  "have",
  "in",
  "individually",
  "inside",
  "is",
  "it",
  "just",
  "last",
  "latest",
  "least",
  "limited",
  "listed",
  "many",
  "may",
  "might",
  "more",
  "most",
  "multiple",
  "must",
  "native",
  "neither",
  "never",
  "newest",
  "no",
  "none",
  "noncurrent",
  "nonlatest",
  "not",
  "of",
  "older",
  "one",
  "ones",
  "only",
  "open",
  "or",
  "other",
  "others",
  "part",
  "per",
  "plus",
  "preceding",
  "previous",
  "prior",
  "read",
  "recent",
  "recently",
  "remain",
  "remains",
  "same",
  "save",
  "selected",
  "several",
  "should",
  "single",
  "so",
  "sole",
  "solely",
  "some",
  "supported",
  "than",
  "that",
  "the",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "time",
  "to",
  "unless",
  "via",
  "visible",
  "was",
  "we",
  "were",
  "which",
  "while",
  "whichever",
  "will",
  "with",
  "within",
  "would",
  "you",
  "your",
  ...cleaningHistoryPriorWords,
  ...Object.keys(cleaningHistoryClauseConnectorRoles),
  ...cleaningHistorySetCardinalityWords,
  ...cleaningHistoryMultiWords
]);

function cleaningHistoryTokens(value, remainingTokenBudget, remainingPredicateBudget) {
  const normalized = normalizeCleaningHistoryConditionalSpellings(value)
    .replace(/\bcan't\b/giu, "cannot")
    .replace(/\b(are|could|did|do|does|had|has|have|is|might|must|should|was|were|will|would)n't\b/giu, "$1 not")
    .replace(/\bcleaning-(plan|steps?|operations?|history|workflow)\b/giu, "cleaning $1")
    .replace(/([\p{L}])-([\p{L}])/gu, "$1$2")
    .toLowerCase();
  const tokens = [];
  let predicateCount = 0;
  for (const match of normalized.matchAll(/[\p{L}\p{N}']+|[,:—]/gu)) {
    if (tokens.length >= remainingTokenBudget) {
      throw new Error(
        `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_WORD_TOKEN_MAX}-word-token work limit.`
      );
    }
    const token = match[0];
    if (cleaningHistoryPredicateKind(token) !== undefined || ["order", "ordering", "sequence"].includes(token)) {
      if (predicateCount >= remainingPredicateBudget) {
        throw new Error(
          `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_PREDICATE_TOKEN_MAX}-predicate-token work limit.`
        );
      }
      predicateCount += 1;
    }
    tokens.push(token);
  }
  return { predicateCount, tokens };
}

function cleaningHistoryStatements(rendered) {
  const statements = [];
  let predicateCount = 0;
  let tokenCount = 0;
  for (const value of rendered.split(cleaningHistoryStatementBoundary)) {
    const result = cleaningHistoryTokens(
      value,
      CLEANING_HISTORY_WORD_TOKEN_MAX - tokenCount,
      CLEANING_HISTORY_PREDICATE_TOKEN_MAX - predicateCount
    );
    const { tokens } = result;
    predicateCount += result.predicateCount;
    tokenCount += tokens.length;
    if (tokens.length > 0) statements.push(tokens);
  }
  return statements;
}

function cleaningHistorySegments(tokens) {
  const segments = [];
  let current = [];
  let separatorBefore;
  let separatorsBefore = [];
  let startIndex = 0;
  const finish = () => {
    if (current.length > 0) {
      segments.push({ tokens: current, separatorBefore, separatorsBefore, startIndex });
      separatorsBefore = [];
    }
    current = [];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const boundaryKind = cleaningHistoryClauseBoundaryKind(tokens, index);
    if (boundaryKind !== undefined) {
      finish();
      separatorBefore = token;
      separatorsBefore.push(token);
      startIndex = index + 1;
    } else if (cleaningHistoryClausePunctuationRoles[token] === undefined) {
      if (current.length === 0) startIndex = index;
      current.push(token);
    }
  }
  finish();
  return segments;
}

function isCleaningHistoryNoun(tokens, index) {
  const token = tokens[index];
  const nearby = tokens.slice(Math.max(0, index - 4), index + 1);
  const following = tokens.slice(index + 1, index + 4);
  const followingQualifier = following.findIndex((candidate) =>
    ["applied", "cleaning", "committed"].includes(candidate)
  );
  const postQualified =
    followingQualifier >= 0 &&
    following.slice(0, followingQualifier).every((candidate) => ["already", "once", "previously"].includes(candidate));
  const qualified =
    nearby.some((candidate) => ["applied", "cleaning", "committed"].includes(candidate)) || postQualified;
  if (token === "transformation" || token === "transformations") return true;
  if (token === "step" || token === "steps") return qualified;
  if (token === "operation" || token === "operations") return qualified;
  if (token === "workflow" || token === "history") return qualified;
  if (token === "entry" || token === "entries") return qualified || nearby.includes("plan");
  if (token === "plan") return qualified || ["entry", "entries"].includes(tokens[index + 1]);
  return false;
}

function cleaningHistoryScope(tokens) {
  const latest =
    tokens.some((token) => cleaningHistoryLatestWords.has(token)) ||
    (tokens.includes("most") && tokens.some((token) => ["recent", "recently"].includes(token)));
  if (latest) return "latest";
  if (tokens.some((token) => cleaningHistoryPriorWords.includes(token))) return "prior";
  if (
    tokens.some((token) => cleaningHistoryMultiWords.has(token) || /^(?:[2-9]|[1-9][0-9]+)$/u.test(token)) ||
    tokens.some((token) => ["steps", "transformations", "operations", "entries"].includes(token))
  ) {
    return "set";
  }
  return "single";
}

function cleaningHistoryPredicateKind(token) {
  if (
    /^(?:inspect|inspects|inspected|inspecting|inspection|inspections|inspectable|uninspectable|noninspectable)$/u.test(
      token
    )
  ) {
    return "inspect";
  }
  if (
    /^(?:edit|edits|edited|editing|editable|uneditable|noneditable|modify|modifies|modified|modifying|modification|modifications|modifiable|unmodifiable|nonmodifiable|revise|revises|revised|revising|revision|revisions|amend|amends|amended|amending|amendment|amendments|alter|alters|altered|altering)$/u.test(
      token
    )
  ) {
    return "edit";
  }
  if (
    /^(?:delete|deletes|deleted|deleting|deletion|deletions|deletable|undeletable|nondeletable|erase|erases|erased|erasing|remove|removes|removed|removing)$/u.test(
      token
    )
  ) {
    return "delete";
  }
  if (
    /^(?:undo|undoes|undone|undoing|rollback|rollbacks|revert|reverts|reverted|reverting|reverse|reverses|reversed|reversing|reversible|restore|restores|restored|restoring)$/u.test(
      token
    )
  ) {
    return "undo";
  }
  if (
    /^(?:reorder|reorders|reordered|reordering|rearrange|rearranges|rearranged|rearranging|shuffle|shuffles|shuffled|shuffling|permute|permutes|permuted|permuting)$/u.test(
      token
    )
  ) {
    return "reorder";
  }
  if (["readonly", "unable"].includes(token)) return "edit";
  return undefined;
}

function cleaningHistoryPredicateCandidate(tokens, index) {
  const kind = cleaningHistoryPredicateKind(tokens[index]);
  if (kind !== undefined) return kind;
  if (
    ["order", "ordering"].includes(tokens[index]) &&
    tokens.some((token) => /^(?:change|changed|changes|changing|mutable|reorder|reordered|reordering)$/u.test(token))
  ) {
    return "reorder";
  }
  if (tokens[index] === "sequence" && tokens.includes("mutable")) return "reorder";
  return undefined;
}

function isCleaningHistoryGrammarToken(token) {
  return (
    cleaningHistoryGrammarWords.has(token) ||
    cleaningHistoryIntrinsicNegativeWords.has(token) ||
    cleaningHistoryPredicateKind(token) !== undefined ||
    /^(?:allow|allows|allowed|allowing|apply|applies|applied|applying|available|affect|affects|affected|affecting|change|changes|changed|changing|choose|chooses|chosen|choosing|confined|enabled|expose|exposes|exposed|exposing|implement|implemented|impossible|limit|limited|mutable|offer|offered|pick|picked|possible|remove|removes|removed|removing|reserved|restrict|restricted|select|selected|specify|specified|support|supports|supported|target|targets|targeted|targeting)$/u.test(
      token
    )
  );
}

function cleaningHistorySubject(tokens, predicateIndex = tokens.length, candidateIndex = predicateIndex) {
  const before = tokens.slice(0, predicateIndex);
  const after = tokens.slice(predicateIndex + 1);
  const cleaningBefore = before.findIndex((_, index) => isCleaningHistoryNoun(before, index));
  const cleaningAfter = after.findIndex((_, index) => isCleaningHistoryNoun(after, index));
  const unrelatedBefore = before.findIndex(
    (token, index) =>
      !isCleaningHistoryGrammarToken(token) &&
      !isCleaningHistoryNoun(before, index) &&
      !(["step", "steps"].includes(token) && before.some((candidate) => ["this", "that"].includes(candidate)))
  );
  let completedOwnerDescription = false;
  let introducedLaterOwner = false;
  let laterExplicitOwner = false;
  for (let index = cleaningBefore + 1; index < before.length; index += 1) {
    const token = before[index];
    if (["listed", "remain", "remains", "visible"].includes(token)) {
      completedOwnerDescription = true;
      continue;
    }
    if (
      completedOwnerDescription &&
      ["a", "an", "any", "every", "neither", "no", "some", "the", "this", "that", "these", "those"].includes(token)
    ) {
      introducedLaterOwner = true;
      continue;
    }
    if (!isCleaningHistoryGrammarToken(token) && !isCleaningHistoryNoun(before, index)) {
      laterExplicitOwner = introducedLaterOwner;
      break;
    }
  }
  const personalActorOnly = unrelatedBefore < 0 && before.some((token) => ["i", "we", "you"].includes(token));
  const actorFirst =
    before.some((token) => cleaningHistoryActorWords.has(token) || ["i", "we", "you"].includes(token)) &&
    before.every(
      (token) =>
        isCleaningHistoryGrammarToken(token) ||
        cleaningHistoryActorWords.has(token) ||
        ["i", "we", "you"].includes(token)
    );
  const directCleaningObject =
    cleaningAfter >= 0 &&
    after.slice(0, cleaningAfter).every((token) => isCleaningHistoryGrammarToken(token)) &&
    actorFirst;
  const nominalizedCleaningSubject =
    cleaningAfter >= 0 &&
    candidateIndex < predicateIndex &&
    cleaningHistoryNominalizedCapabilities.has(tokens[candidateIndex]) &&
    after.slice(0, cleaningAfter).every((token) => isCleaningHistoryGrammarToken(token));
  const candidateSuffix = tokens.slice(candidateIndex + 1, predicateIndex);
  const candidateCleaningObject = candidateSuffix.findIndex((_, index) =>
    isCleaningHistoryNoun(candidateSuffix, index)
  );
  const nominalizedCandidateSubject =
    candidateCleaningObject >= 0 &&
    cleaningHistoryNominalizedCapabilities.has(tokens[candidateIndex]) &&
    candidateSuffix.slice(0, candidateCleaningObject).every((token) => isCleaningHistoryGrammarToken(token));
  const statusModifier = ["readonly", "unable", "unavailable", "unsupported"].includes(tokens[predicateIndex]);
  if (statusModifier) {
    const unrelatedAfter = after.findIndex(
      (token, index) => !isCleaningHistoryGrammarToken(token) && !isCleaningHistoryNoun(after, index)
    );
    if (unrelatedAfter >= 0 && (cleaningAfter < 0 || unrelatedAfter < cleaningAfter)) {
      return { owner: "unrelated", scope: "unknown", explicit: true };
    }
  }
  if (laterExplicitOwner) return { owner: "unrelated", scope: "unknown", explicit: true };
  if (cleaningBefore >= 0 && (unrelatedBefore < 0 || unrelatedBefore > cleaningBefore)) {
    return { owner: "cleaning", scope: cleaningHistoryScope(before), explicit: true };
  }
  if (directCleaningObject || nominalizedCleaningSubject || nominalizedCandidateSubject) {
    return { owner: "cleaning", scope: cleaningHistoryScope(after), explicit: true };
  }
  if (unrelatedBefore >= 0) return { owner: "unrelated", scope: "unknown", explicit: true };
  if (cleaningAfter >= 0 && (before.length === 0 || personalActorOnly)) {
    return { owner: "cleaning", scope: cleaningHistoryScope(after), explicit: true };
  }
  const anaphoric = before.some((token) => cleaningHistoryAnaphors.has(token));
  const genericDemonstrativeStep =
    before.some((token) => ["this", "that"].includes(token)) &&
    before.some((token) => ["step", "steps"].includes(token));
  if (anaphoric || genericDemonstrativeStep) {
    return { owner: "anaphor", scope: cleaningHistoryScope(before), explicit: false };
  }
  return { owner: "none", scope: "unknown", explicit: false };
}

function cleaningHistoryPassiveCapabilityContinuation(tokens, predicateIndex) {
  if (predicateIndex <= 0 || cleaningHistoryPredicateCandidate(tokens, predicateIndex) === undefined) return false;
  const prefix = tokens.slice(0, predicateIndex);
  return (
    prefix.some((token) => cleaningHistoryPassiveCapabilityAuxiliaries.has(token)) &&
    prefix.every((token) => isCleaningHistoryGrammarToken(token))
  );
}

function cleaningHistoryCoordinatedBarePassiveContinuation(tokens, predicateIndex, separatorBefore) {
  if (
    predicateIndex !== 0 ||
    !cleaningHistoryBarePassiveCapabilities.has(tokens[predicateIndex]) ||
    !(separatorBefore === "," || cleaningHistoryCoordinateConnectors.has(separatorBefore))
  ) {
    return false;
  }
  const suffix = tokens.slice(predicateIndex + 1);
  return (
    suffix.length <= CLEANING_HISTORY_CAPABILITY_OWNERSHIP_WINDOW &&
    suffix.every(
      (token, index) =>
        isCleaningHistoryGrammarToken(token) ||
        isCleaningHistoryNoun(suffix, index) ||
        cleaningHistoryHasExclusiveConditionAt(suffix, index)
    )
  );
}

function cleaningHistoryCurrentAntecedent(currentSubject, previousStatementSubject) {
  return currentSubject ?? previousStatementSubject;
}

function cleaningHistoryPostPredicateCapabilitySubject(tokens, predicateIndex, antecedent) {
  const predicate = tokens[predicateIndex];
  const nominalized = cleaningHistoryNominalizedCapabilities.has(predicate);
  const infinitive = tokens[predicateIndex - 1] === "to";
  if (!nominalized && !infinitive) return undefined;
  const suffix = tokens.slice(predicateIndex + 1);
  const anaphorIndex = suffix.findIndex((token) => cleaningHistoryPostPredicateAnaphors.has(token));
  const statusIndex = suffix.findIndex((token) => cleaningHistoryCapabilityStatus.test(token));
  if (anaphorIndex < 0 && statusIndex < 0) return undefined;
  const evidenceIndex = anaphorIndex >= 0 ? anaphorIndex : statusIndex;
  const ownershipPrefix = suffix.slice(0, evidenceIndex + 1);
  if (
    ownershipPrefix.some(
      (token, index) =>
        !isCleaningHistoryGrammarToken(token) &&
        !isCleaningHistoryNoun(ownershipPrefix, index) &&
        !cleaningHistoryPostPredicateAnaphors.has(token) &&
        !cleaningHistoryHasExclusiveConditionAt(ownershipPrefix, index)
    )
  ) {
    return undefined;
  }
  if (suffix.length > CLEANING_HISTORY_CAPABILITY_OWNERSHIP_WINDOW) {
    throw new Error(
      `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_CAPABILITY_OWNERSHIP_WINDOW}-token capability ownership window.`
    );
  }
  if (anaphorIndex >= 0) {
    return antecedent?.owner === "cleaning"
      ? { ...antecedent, capabilityObjectEstablished: true, explicit: false }
      : undefined;
  }
  if (statusIndex < 0) return undefined;
  if (antecedent?.owner === "unrelated") return undefined;
  return antecedent?.owner === "cleaning"
    ? { ...antecedent, explicit: false }
    : { owner: "cleaning", scope: "single", explicit: false };
}

function cleaningHistoryPostPredicateHasExplicitUnrelatedOwner(tokens, predicateIndex) {
  let anaphorIndex = -1;
  for (let index = 0; index < predicateIndex; index += 1) {
    if (cleaningHistoryPostPredicateAnaphors.has(tokens[index])) anaphorIndex = index;
  }
  if (anaphorIndex < 0) return true;
  const between = tokens.slice(anaphorIndex + 1, predicateIndex);
  if (between.length > CLEANING_HISTORY_CAPABILITY_OWNERSHIP_WINDOW) {
    throw new Error(
      `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_CAPABILITY_OWNERSHIP_WINDOW}-token capability ownership window.`
    );
  }
  let latestCleaningOwner = -1;
  let latestUnrelatedOwner = -1;
  let contextOwned = false;
  let contextObjectSeen = false;
  let ownerDeterminerPending = false;
  for (let index = 0; index < between.length; index += 1) {
    const token = between[index];
    if (isCleaningHistoryNoun(between, index) || cleaningHistoryNominalizedCapabilities.has(token)) {
      latestCleaningOwner = index;
      contextOwned = false;
      contextObjectSeen = false;
      ownerDeterminerPending = false;
      continue;
    }
    if (cleaningHistoryCapabilityContextPrepositions.has(token)) {
      contextOwned = true;
      contextObjectSeen = false;
      ownerDeterminerPending = false;
      continue;
    }
    if (["a", "an", "any", "the", "this", "that", "these", "those"].includes(token)) {
      if (contextOwned && !contextObjectSeen) continue;
      contextOwned = false;
      contextObjectSeen = false;
      ownerDeterminerPending = true;
      continue;
    }
    if (isCleaningHistoryGrammarToken(token) || cleaningHistoryPostPredicateAnaphors.has(token)) {
      if (contextOwned && contextObjectSeen) {
        contextOwned = false;
        contextObjectSeen = false;
      }
      continue;
    }
    if (contextOwned) {
      contextObjectSeen = true;
      continue;
    }
    if (ownerDeterminerPending) {
      latestUnrelatedOwner = index;
      ownerDeterminerPending = false;
    }
  }
  return latestUnrelatedOwner > latestCleaningOwner;
}

function cleaningHistorySemanticPredicateIndex(kind, tokens, initialIndex) {
  const undoAction =
    /^(?:affect|affects|affected|apply|applies|available|blocked|disabled|disallowed|enabled|expose|exposes|forbidden|impossible|limit|limited|offer|offered|prohibited|remove|removes|removed|restore|restores|restored|restrict|restricted|support|supports|supported|target|targets|targeted|unavailable|unsupported)$/u;
  const postPredicateCapability =
    cleaningHistoryNominalizedCapabilities.has(tokens[initialIndex]) || tokens[initialIndex - 1] === "to";
  if (kind === "undo" || initialIndex === 0 || postPredicateCapability) {
    const later = tokens.findIndex(
      (token, index) =>
        index > initialIndex && (kind === "undo" ? undoAction : cleaningHistoryCapabilityStatus).test(token)
    );
    if (later >= 0) return later;
  }
  return initialIndex;
}

function cleaningHistoryPredicatePolarity(record) {
  const before = record.segmentTokens.slice(0, record.predicateIndex + 1);
  const clause = record.clauseTokens;
  let negatives = before.filter((token) => ["cannot", "never", "not"].includes(token)).length;
  negatives += before.filter((token) => cleaningHistoryIntrinsicNegativeWords.has(token)).length;
  const noOtherLatest =
    clause.includes("no") &&
    clause.some((token) => ["other", "others"].includes(token)) &&
    cleaningHistoryScope(clause) === "latest";
  if (!noOtherLatest && before.some((token) => ["no", "none", "neither"].includes(token))) negatives += 1;
  const exceptionIndex = cleaningHistoryExceptionIndex(clause);
  const targetTokens = clause.slice(record.clausePredicateIndex + 1, exceptionIndex < 0 ? undefined : exceptionIndex);
  if (
    !noOtherLatest &&
    targetTokens.some(
      (token, index) =>
        ["none", "neither"].includes(token) ||
        (token === "no" && !["exception", "exceptions"].includes(targetTokens[index + 1]))
    )
  ) {
    negatives += 1;
  }
  return negatives % 2 === 1 ? "negative" : "positive";
}

function cleaningHistoryExceptionIndex(tokens) {
  let universalSeen = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["all", "every"].includes(token)) universalSeen = true;
    if (
      ["except", "unless", "apart", "save"].includes(token) ||
      cleaningHistoryHasExclusiveConditionAt(tokens, index) ||
      (token === "than" && ["other", "others"].includes(tokens[index - 1])) ||
      (token === "but" && universalSeen) ||
      (token === "exception" &&
        (tokens[index - 1] === "with" || (tokens[index - 1] === "the" && tokens[index - 2] === "with")))
    ) {
      return index;
    }
  }
  return -1;
}

function cleaningHistoryException(record) {
  const sourceTokens = record.exceptionTokens ?? record.clauseTokens;
  const index = cleaningHistoryExceptionIndex(sourceTokens);
  if (index < 0) return { exclusiveCondition: false, present: false, validLatest: false };
  const tokens = sourceTokens.slice(index + 1);
  const exclusiveCondition = cleaningHistoryHasExclusiveConditionAt(sourceTokens, index);
  const exclusiveConditionBounded =
    !exclusiveCondition || sourceTokens.length - (index - 1) <= CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX;
  const antecedent = record.antecedent?.owner === "cleaning" ? record.antecedent : record.subject;
  const hasLatest =
    cleaningHistoryScope(tokens) === "latest" ||
    (tokens.includes("it") && antecedent?.scope === "latest") ||
    (tokens.some((token) => ["latest", "newest", "last", "final"].includes(token)) && antecedent?.owner === "cleaning");
  const hasPrior = tokens.some(
    (token) => cleaningHistoryPriorWords.includes(token) || ["another", "other", "others"].includes(token)
  );
  const hasMulti = cleaningHistoryHasMultiTarget(tokens);
  const hasCleaningNoun = tokens.some((_, tokenIndex) => isCleaningHistoryNoun(tokens, tokenIndex));
  const hasResolvablePronoun =
    tokens.some((token) => ["it", "one", "ones"].includes(token)) && antecedent?.owner === "cleaning";
  const unrelated = tokens.some(
    (token, tokenIndex) =>
      cleaningHistoryClausePunctuationRoles[token] === undefined &&
      !isCleaningHistoryGrammarToken(token) &&
      !isCleaningHistoryNoun(tokens, tokenIndex) &&
      !/^(?:exception|exceptions)$/u.test(token)
  );
  const conditionBranches = [];
  let conditionBranch = [];
  for (const token of tokens) {
    if (cleaningHistoryCoordinateConnectors.has(token)) {
      conditionBranches.push(conditionBranch);
      conditionBranch = [];
    } else {
      conditionBranch.push(token);
    }
  }
  conditionBranches.push(conditionBranch);
  const validExclusiveCondition =
    exclusiveCondition &&
    conditionBranches.every((branch) => {
      const branchHasLatest =
        cleaningHistoryScope(branch) === "latest" ||
        (branch.includes("it") && antecedent?.scope === "latest") ||
        (branch.some((token) => cleaningHistoryLatestWords.has(token)) && antecedent?.owner === "cleaning");
      const branchHasPrior = branch.some(
        (token) => cleaningHistoryPriorWords.includes(token) || ["another", "other", "others"].includes(token)
      );
      const branchHasCleaningNoun = branch.some((_, tokenIndex) => isCleaningHistoryNoun(branch, tokenIndex));
      const branchHasResolvablePronoun =
        branch.some((token) => ["it", "one", "ones"].includes(token)) && antecedent?.owner === "cleaning";
      const branchHasPositiveSelection =
        branch.some((token) => ["chosen", "selected"].includes(token)) &&
        !branch.some((token) => ["cannot", "never", "not"].includes(token));
      const branchHasUnrelated = branch.some(
        (token, tokenIndex) =>
          cleaningHistoryClausePunctuationRoles[token] === undefined &&
          !isCleaningHistoryGrammarToken(token) &&
          !isCleaningHistoryNoun(branch, tokenIndex)
      );
      return (
        branch.length > 0 &&
        branchHasLatest &&
        !branchHasPrior &&
        !cleaningHistoryHasMultiTarget(branch) &&
        branchHasPositiveSelection &&
        !branchHasUnrelated &&
        (branchHasCleaningNoun || branchHasResolvablePronoun || antecedent?.owner === "cleaning")
      );
    });
  return {
    exclusiveCondition,
    present: true,
    validLatest:
      (exclusiveCondition ? validExclusiveCondition : hasLatest) &&
      exclusiveConditionBounded &&
      !hasPrior &&
      !hasMulti &&
      !unrelated &&
      (hasCleaningNoun || hasResolvablePronoun || antecedent?.owner === "cleaning")
  };
}

function cleaningHistoryHasMultiTarget(tokens) {
  if (tokens.some((token) => ["entries", "operations", "steps", "transformations"].includes(token))) return true;
  const cardinalityTargetsCleaning = (index) => {
    for (let candidateIndex = index + 1; candidateIndex < tokens.length; candidateIndex += 1) {
      const token = tokens[candidateIndex];
      if (isCleaningHistoryNoun(tokens, candidateIndex) || ["one", "ones"].includes(token)) return true;
      if (!isCleaningHistoryGrammarToken(token)) return false;
    }
    return true;
  };
  return tokens.some((token, index) => {
    const explicitMulti = cleaningHistoryMultiWords.has(token) || /^(?:[2-9]|[1-9][0-9]+)$/u.test(token);
    const compoundMulti =
      token === "one" &&
      ((tokens[index - 1] === "than" && tokens[index - 2] === "more") ||
        (tokens[index + 1] === "or" && tokens[index + 2] === "more"));
    return (explicitMulti || compoundMulti) && cardinalityTargetsCleaning(index);
  });
}

function cleaningHistoryInvocationScoped(tokens) {
  return (
    (tokens.includes("per") &&
      tokens.some((token) => ["action", "command", "invocation", "request"].includes(token))) ||
    (tokens.includes("at") && tokens.includes("time")) ||
    (tokens.some((token) => ["action", "command", "invocation", "request"].includes(token)) &&
      tokens.some((token) => ["each", "same", "single"].includes(token)))
  );
}

function isCleaningHistoryBareUndoContinuation(record, tokens) {
  if (record?.kind !== "undo" || record.subject.owner !== "cleaning") return false;
  const hasExplicitHistoryNoun = tokens.some((_, index) => isCleaningHistoryNoun(tokens, index));
  const hasHistoryReference =
    hasExplicitHistoryNoun ||
    tokens.some((token) => cleaningHistoryBareHistoryNouns.has(token) || cleaningHistoryAnaphors.has(token));
  const hasBoundedReference =
    (tokens.includes("most") && tokens.some((token) => ["recent", "recently"].includes(token))) ||
    cleaningHistoryHasMultiTarget(tokens) ||
    tokens.some(
      (token) =>
        cleaningHistoryLatestWords.has(token) ||
        cleaningHistoryPriorWords.includes(token) ||
        cleaningHistoryAnaphors.has(token) ||
        cleaningHistoryMultiWords.has(token) ||
        /^(?:[2-9]|[1-9][0-9]+)$/u.test(token)
    );
  return (
    (record.subject.explicit || hasExplicitHistoryNoun) &&
    hasHistoryReference &&
    hasBoundedReference &&
    tokens.every(
      (token) =>
        cleaningHistoryBareHistoryNouns.has(token) ||
        isCleaningHistoryGrammarToken(token) ||
        /^(?:[1-9][0-9]*)$/u.test(token)
    )
  );
}

function cleaningHistoryAtomicExceptionIndex(tokens) {
  const index = cleaningHistoryExceptionIndex(tokens);
  const atomic =
    index === 0 ||
    (index === 1 && cleaningHistoryHasExclusiveConditionAt(tokens, index)) ||
    (index === 1 && tokens[0] === "other" && tokens[index] === "than") ||
    (index === 1 && ["all", "every"].includes(tokens[0]) && tokens[index] === "but") ||
    (tokens[index] === "exception" &&
      ((index === 1 && tokens[0] === "with") || (index === 2 && tokens[0] === "with" && tokens[1] === "the")));
  if (!atomic) return -1;
  if (tokens.length > CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX) {
    throw new Error(
      `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX}-token atomic condition or exception bound.`
    );
  }
  return index;
}

function cleaningHistoryInlineExclusiveConditionTokens(tokens) {
  const conditionIndex = tokens.findIndex((_, index) => cleaningHistoryHasExclusiveConditionAt(tokens, index));
  if (conditionIndex <= 0) return undefined;
  const candidate = tokens.slice(conditionIndex - 1);
  if (candidate.length > CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX) {
    throw new Error(
      `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX}-token atomic condition or exception bound.`
    );
  }
  return candidate;
}

function cleaningHistoryAtomicExceptionNeedsTarget(tokens) {
  const index = cleaningHistoryAtomicExceptionIndex(tokens);
  if (index < 0) return false;
  return tokens.slice(index + 1).every((token) => ["for", "from", "of", "the", "when"].includes(token));
}

function cleaningHistoryConditionContinuation(segment) {
  const boundaryWords = segment.separatorsBefore.filter(
    (token) => cleaningHistoryClausePunctuationRoles[token] === undefined
  );
  const repeatedCondition = boundaryWords.some((token) => ["if", "when"].includes(token));
  const unlessAlternative = boundaryWords.includes("unless");
  const coordinated = boundaryWords.some((token) => cleaningHistoryCoordinateConnectors.has(token));
  return {
    continues:
      repeatedCondition || coordinated || cleaningHistoryClausePunctuationRoles[segment.separatorBefore] === "segment",
    repeatedCondition,
    tokens: [...boundaryWords, ...segment.tokens],
    unlessAlternative
  };
}

function rejectCleaningHistoryConditionBranch() {
  throw new Error("cleaning-history claim prose contains an unsupported repeated or unless condition branch.");
}

function cleaningHistoryPredicateRecords(rendered) {
  const records = [];
  let previousStatementSubject;
  let immediatelyPriorRecord;
  for (const statementTokens of cleaningHistoryStatements(rendered)) {
    let currentSubject;
    let pendingAtomicException;
    let pendingClausePrefix;
    const statementRecords = [];
    for (const segment of cleaningHistorySegments(statementTokens)) {
      const priorRecord = immediatelyPriorRecord;
      immediatelyPriorRecord = undefined;
      const clausePrefix =
        pendingClausePrefix !== undefined && segment.separatorBefore === "but"
          ? [...pendingClausePrefix.tokens, segment.separatorBefore]
          : [];
      pendingClausePrefix = undefined;
      const initialPredicates = segment.tokens.flatMap((token, index) => {
        const kind = cleaningHistoryPredicateCandidate(segment.tokens, index);
        return kind === undefined ? [] : [{ kind, index }];
      });
      const containsUndo = initialPredicates.some(({ kind }) => kind === "undo");
      const predicates = containsUndo ? [initialPredicates.find(({ kind }) => kind === "undo")] : initialPredicates;
      const conditionContinuation = cleaningHistoryConditionContinuation(segment);
      const priorExceptionIndex =
        priorRecord?.exceptionTokens === undefined ? -1 : cleaningHistoryExceptionIndex(priorRecord.exceptionTokens);
      const priorHasExclusiveCondition =
        priorRecord?.exceptionTokens !== undefined &&
        cleaningHistoryHasExclusiveConditionAt(priorRecord.exceptionTokens, priorExceptionIndex);
      if (priorHasExclusiveCondition && conditionContinuation.unlessAlternative) {
        rejectCleaningHistoryConditionBranch();
      }
      if (priorHasExclusiveCondition && conditionContinuation.repeatedCondition && predicates.length > 0) {
        rejectCleaningHistoryConditionBranch();
      }
      let atomicExceptionForPredicate;
      if (pendingAtomicException !== undefined) {
        const pendingExceptionIndex = cleaningHistoryExceptionIndex(pendingAtomicException.tokens);
        const pendingExclusiveCondition =
          pendingAtomicException.position === "prefix" &&
          cleaningHistoryHasExclusiveConditionAt(pendingAtomicException.tokens, pendingExceptionIndex);
        if (pendingExclusiveCondition && conditionContinuation.unlessAlternative) {
          rejectCleaningHistoryConditionBranch();
        }
        if (pendingExclusiveCondition && conditionContinuation.repeatedCondition && predicates.length > 0) {
          rejectCleaningHistoryConditionBranch();
        }
        const extendsPrefixCondition =
          predicates.length === 0 && pendingExclusiveCondition && conditionContinuation.continues;
        if (extendsPrefixCondition) {
          const extendedTokens = [...pendingAtomicException.tokens, ...conditionContinuation.tokens];
          if (extendedTokens.length > CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX) {
            throw new Error(
              `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX}-token atomic condition or exception bound.`
            );
          }
          pendingAtomicException.tokens = extendedTokens;
          continue;
        }
        if (predicates.length === 0 && cleaningHistoryAtomicExceptionNeedsTarget(pendingAtomicException.tokens)) {
          if (
            pendingAtomicException.tokens.length + segment.tokens.length >
            CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX
          ) {
            if (pendingExclusiveCondition) {
              throw new Error(
                `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX}-token atomic condition or exception bound.`
              );
            }
            pendingAtomicException = undefined;
          } else {
            pendingAtomicException.tokens.push(...segment.tokens);
            if (pendingAtomicException.position === "suffix") {
              for (const record of pendingAtomicException.records) {
                record.exceptionTokens = [...pendingAtomicException.tokens];
              }
              if (!cleaningHistoryAtomicExceptionNeedsTarget(pendingAtomicException.tokens)) {
                pendingAtomicException = undefined;
              }
            }
            continue;
          }
        }
        if (predicates.length > 0 && pendingAtomicException.position === "prefix") {
          atomicExceptionForPredicate = [...pendingAtomicException.tokens];
        }
        pendingAtomicException = undefined;
      }
      const subjectProbeIndex = predicates[0]?.index ?? segment.tokens.length;
      const coordinatedCapabilityPredecessors = priorRecord?.coordinatedCapabilityPredecessors ?? [];
      const coordinatedBarePassiveCandidate =
        priorRecord?.subject.owner === "cleaning" &&
        cleaningHistoryCoordinatedBarePassiveContinuation(segment.tokens, subjectProbeIndex, segment.separatorBefore);
      if (
        coordinatedBarePassiveCandidate &&
        coordinatedCapabilityPredecessors.length + 1 >= CLEANING_HISTORY_COORDINATED_CAPABILITY_MAX
      ) {
        throw new Error(
          `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_COORDINATED_CAPABILITY_MAX}-capability coordination limit.`
        );
      }
      const coordinatedBarePassive = coordinatedBarePassiveCandidate;
      let subject = cleaningHistorySubject(segment.tokens, subjectProbeIndex);
      if (subject.owner === "none") {
        const antecedent = cleaningHistoryCurrentAntecedent(currentSubject, previousStatementSubject);
        subject =
          cleaningHistoryPostPredicateCapabilitySubject(segment.tokens, subjectProbeIndex, antecedent) ?? subject;
      }
      if (subject.owner === "anaphor") {
        const inherited = cleaningHistoryCurrentAntecedent(currentSubject, previousStatementSubject);
        subject = inherited?.owner === "cleaning" ? { ...inherited, explicit: false } : subject;
        if (subject.owner === "cleaning") {
          const localScope = cleaningHistoryScope(segment.tokens.slice(0, subjectProbeIndex));
          if (localScope !== "single" || segment.tokens.some((token) => ["this", "that"].includes(token))) {
            subject.scope = localScope === "single" ? inherited.scope : localScope;
          }
        }
      } else if (
        subject.owner === "none" &&
        currentSubject?.owner === "cleaning" &&
        (cleaningHistoryPassiveCapabilityContinuation(segment.tokens, subjectProbeIndex) || coordinatedBarePassive) &&
        (cleaningHistoryConnectorRole(segment.separatorBefore) !== undefined ||
          cleaningHistoryClausePunctuationRoles[segment.separatorBefore] === "segment")
      ) {
        subject = { ...currentSubject, explicit: false };
      }
      if (subject.owner !== "none" && subject.owner !== "anaphor") currentSubject = subject;
      if (predicates.length === 0) {
        const connectorExceptionTokens =
          segment.separatorBefore === "unless" ? [segment.separatorBefore, ...segment.tokens] : undefined;
        const atomicExceptionTokens = connectorExceptionTokens ?? segment.tokens;
        const atomicExceptionIndex = cleaningHistoryAtomicExceptionIndex(atomicExceptionTokens);
        if (atomicExceptionIndex >= 0) {
          const punctuationRole = cleaningHistoryClausePunctuationRoles[segment.separatorBefore];
          if (
            priorRecord !== undefined &&
            priorRecord.subject.owner === "cleaning" &&
            (punctuationRole === "segment" || (connectorExceptionTokens !== undefined && segment.startIndex > 1))
          ) {
            const suffixRecords = [...coordinatedCapabilityPredecessors, priorRecord];
            for (const record of suffixRecords) record.exceptionTokens = [...atomicExceptionTokens];
            if (cleaningHistoryAtomicExceptionNeedsTarget(atomicExceptionTokens)) {
              pendingAtomicException = {
                position: "suffix",
                records: suffixRecords,
                tokens: [...atomicExceptionTokens]
              };
            }
          } else if (
            ((subject.owner !== "unrelated" && currentSubject?.owner !== "unrelated") ||
              cleaningHistoryHasExclusiveConditionAt(atomicExceptionTokens, atomicExceptionIndex)) &&
            (connectorExceptionTokens === undefined || segment.startIndex === 1)
          ) {
            pendingAtomicException = { position: "prefix", tokens: [...atomicExceptionTokens] };
          }
        } else {
          const extendsExclusiveCondition = priorHasExclusiveCondition && conditionContinuation.continues;
          const exceptionContinuation =
            priorRecord !== undefined &&
            subject.owner === "cleaning" &&
            cleaningHistoryExceptionIndex(priorRecord.clauseTokens) >= 0 &&
            conditionContinuation.continues;
          const cleaningContinuation = isCleaningHistoryBareUndoContinuation(priorRecord, segment.tokens);
          if (extendsExclusiveCondition || exceptionContinuation || cleaningContinuation) {
            const continuation = conditionContinuation.tokens;
            priorRecord.clauseTokens.push(...continuation);
            if (extendsExclusiveCondition) {
              if (
                priorRecord.exceptionTokens.length + continuation.length >
                CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX
              ) {
                throw new Error(
                  `cleaning-history claim prose exceeds the ${CLEANING_HISTORY_ATOMIC_EXCEPTION_TOKEN_MAX}-token atomic condition or exception bound.`
                );
              }
              priorRecord.exceptionTokens.push(...continuation);
              immediatelyPriorRecord = priorRecord;
            }
          }
          if (subject.owner !== "unrelated" && segment.tokens.some((token) => ["all", "every"].includes(token))) {
            pendingClausePrefix = { tokens: segment.tokens };
          }
        }
      }
      const inlineExclusiveConditionTokens = cleaningHistoryInlineExclusiveConditionTokens(segment.tokens);
      for (const predicate of predicates.filter(Boolean)) {
        const predicateIndex = cleaningHistorySemanticPredicateIndex(predicate.kind, segment.tokens, predicate.index);
        let recordSubject = cleaningHistorySubject(segment.tokens, predicateIndex, predicate.index);
        const explicitUnrelatedOwner =
          recordSubject.owner === "unrelated" &&
          cleaningHistoryPostPredicateHasExplicitUnrelatedOwner(segment.tokens, predicateIndex);
        if (
          (subject.owner === "cleaning" && !explicitUnrelatedOwner) ||
          ["none", "anaphor"].includes(recordSubject.owner)
        ) {
          recordSubject = subject;
        }
        const laterSemanticPredicate = cleaningHistorySemanticPredicateIndex(
          predicate.kind,
          segment.tokens,
          predicate.index
        );
        if (predicate.kind === "undo" && recordSubject.owner === "none" && laterSemanticPredicate > predicate.index) {
          recordSubject = { owner: "cleaning", scope: "unknown", explicit: false };
        }
        if (
          predicate.kind === "reorder" &&
          recordSubject.owner === "none" &&
          laterSemanticPredicate > predicate.index
        ) {
          recordSubject = { owner: "cleaning", scope: "unknown", explicit: false };
        }
        const inheritedCoordinatedException = coordinatedBarePassive ? priorRecord?.exceptionTokens : undefined;
        const ownedExceptionTokens =
          atomicExceptionForPredicate ?? inheritedCoordinatedException ?? inlineExclusiveConditionTokens;
        const record = {
          kind: predicate.kind,
          segmentTokens: segment.tokens,
          clauseTokens: [...clausePrefix, ...segment.tokens],
          clausePredicateIndex: clausePrefix.length + predicateIndex,
          predicateIndex,
          subject: recordSubject,
          antecedent: cleaningHistoryCurrentAntecedent(currentSubject, previousStatementSubject),
          exceptionTokens: recordSubject.owner === "cleaning" ? ownedExceptionTokens : undefined,
          coordinatedCapabilityPredecessors:
            recordSubject.owner === "cleaning" && coordinatedBarePassive
              ? [...coordinatedCapabilityPredecessors, priorRecord]
              : []
        };
        if (recordSubject.owner === "cleaning" && inlineExclusiveConditionTokens !== undefined) {
          for (const predecessor of record.coordinatedCapabilityPredecessors) {
            predecessor.exceptionTokens = [...inlineExclusiveConditionTokens];
          }
        }
        statementRecords.push(record);
        records.push(record);
        immediatelyPriorRecord = record;
      }
    }
    const lastSubject =
      [...statementRecords].reverse().find(({ subject }) => subject.explicit)?.subject ?? currentSubject;
    previousStatementSubject = lastSubject;
  }
  return records;
}

function cleaningHistoryRecordContradicts(record) {
  if (record.subject.owner !== "cleaning") return false;
  const polarity = cleaningHistoryPredicatePolarity(record);
  const localTokens = record.clauseTokens;
  const latest = record.subject.scope === "latest" || cleaningHistoryScope(localTokens) === "latest";
  const prior =
    record.subject.scope === "prior" || localTokens.some((token) => cleaningHistoryPriorWords.includes(token));
  const exclusive = localTokens.some(
    (token, index) =>
      ["confined", "exclusively", "just", "limited", "only", "reserved", "restricted", "sole", "solely"].includes(
        token
      ) && !(token === "only" && localTokens[index - 1] === "not")
  );
  const exception = cleaningHistoryException(record);
  if (record.kind === "undo") {
    if (exception.exclusiveCondition) return polarity === "negative" || !exception.validLatest;
    const targetTokens = localTokens.slice(record.clausePredicateIndex);
    const noOtherLatest =
      latest && localTokens.includes("no") && localTokens.some((token) => ["other", "others"].includes(token));
    const exactPositiveLatest =
      polarity === "positive" &&
      latest &&
      (exclusive || noOtherLatest) &&
      !prior &&
      !cleaningHistoryHasMultiTarget(targetTokens);
    const priorOnlyDenial = polarity === "negative" && prior && !latest && !exception.present;
    const exactNegativeException = polarity === "negative" && exception.validLatest;
    if (noOtherLatest && exception.validLatest) return false;
    if (exception.present) return polarity === "positive" || !exception.validLatest;
    if (exactPositiveLatest || priorOnlyDenial || exactNegativeException || noOtherLatest) return false;
    if (polarity === "negative") return true;
    return prior || cleaningHistoryHasMultiTarget(targetTokens) || record.subject.scope === "set" || !latest;
  }
  if (record.kind === "reorder") return polarity === "positive" || exception.present;
  if (cleaningHistoryInvocationScoped(localTokens)) return false;
  if (polarity === "negative") return true;
  const restrictsImplementedCapability =
    exception.present ||
    (exclusive && (latest || record.subject.scope !== "set")) ||
    (exclusive && cleaningHistoryHasMultiTarget(localTokens)) ||
    (localTokens.includes("all") && localTokens.includes("but"));
  return restrictsImplementedCapability;
}

function containsContradictoryCleaningHistoryClaim(source, testHooks = undefined) {
  const rendered = parseCleaningHistoryMarkdown(source, "cleaning-history claim prose")
    .filter((token) => token.type === "inline")
    .map((token) => renderedInlineText(token, "cleaning-history claim prose", { excludeExampleCode: true, testHooks }))
    .join("\n");
  return cleaningHistoryPredicateRecords(rendered).some(cleaningHistoryRecordContradicts);
}

export function assertCleaningHistoryClaimsCurrent({ modelSource, productionAuthoritySource, documents, testHooks }) {
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
      claims[surface.claimKind],
      testHooks
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
