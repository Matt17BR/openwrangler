import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ROOT_FILE_LIMIT_BYTES = 12 * 1_024;
const SCOPED_FILE_LIMIT_BYTES = 24 * 1_024;
const TOTAL_INSTRUCTION_LIMIT_BYTES = 96 * 1_024;
export const CONTEXT_LIMIT_BYTES = 32 * 1_024;
const MAX_INSTRUCTION_FILES = 16;
const MAX_ANCESTOR_DEPTH = 32;
const MAX_SCAN_DIRECTORIES = 4_096;
const MAX_SCAN_ENTRIES = 65_536;
const SKIPPED_SCAN_DIRECTORIES = new Set([".git", ".venv", "coverage", "dist", "node_modules", "out", "tmp"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function invariantIds(...numbers) {
  return numbers.map((number) => `I${String(number).padStart(2, "0")}`);
}

export const INSTRUCTION_MANIFEST = Object.freeze([
  Object.freeze({ path: "AGENTS.md", rules: invariantIds(2, 3, 4, 8), maxBytes: ROOT_FILE_LIMIT_BYTES }),
  Object.freeze({ path: ".github/AGENTS.md", rules: invariantIds(50), maxBytes: SCOPED_FILE_LIMIT_BYTES }),
  Object.freeze({ path: "docs/AGENTS.md", rules: invariantIds(9), maxBytes: SCOPED_FILE_LIMIT_BYTES }),
  Object.freeze({
    path: "python/AGENTS.md",
    rules: invariantIds(1, 10, 16, 17, 21, 23, 25, 53),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  }),
  Object.freeze({ path: "r/AGENTS.md", rules: invariantIds(54, 55, 56), maxBytes: SCOPED_FILE_LIMIT_BYTES }),
  Object.freeze({
    path: "scripts/AGENTS.md",
    rules: invariantIds(15, 37, 40, 41, 48, 49, 52, 58),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  }),
  Object.freeze({
    path: "src/extension/AGENTS.md",
    rules: invariantIds(6, 12, 14, 18, 19, 22, 24, 26, 27, 28, 34, 36, 38, 39, 42, 43, 45, 46, 47),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  }),
  Object.freeze({
    path: "src/shared/AGENTS.md",
    rules: invariantIds(5, 11, 29, 31, 32, 33, 35, 51, 57),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  }),
  Object.freeze({
    path: "src/webviews/AGENTS.md",
    rules: invariantIds(7, 13, 20, 30, 44),
    maxBytes: SCOPED_FILE_LIMIT_BYTES
  })
]);

export const EXPECTED_INSTRUCTION_FILES = Object.freeze(INSTRUCTION_MANIFEST.map((entry) => entry.path));
const MANIFEST_BY_PATH = new Map(INSTRUCTION_MANIFEST.map((entry) => [entry.path, entry]));
const EXPECTED_RULE_IDS = Object.freeze(invariantIds(...Array.from({ length: 58 }, (_, index) => index + 1)));

export const REPRESENTATIVE_CONTEXTS = Object.freeze([
  Object.freeze({ target: "README.md", instructions: Object.freeze(["AGENTS.md"]) }),
  Object.freeze({
    target: ".github/workflows/ci.yml",
    instructions: Object.freeze(["AGENTS.md", ".github/AGENTS.md"])
  }),
  Object.freeze({ target: "docs/architecture.md", instructions: Object.freeze(["AGENTS.md", "docs/AGENTS.md"]) }),
  Object.freeze({
    target: "python/openwrangler_runtime/server.py",
    instructions: Object.freeze(["AGENTS.md", "python/AGENTS.md"])
  }),
  Object.freeze({
    target: "r/openwrangler_runtime/frame_contract.R",
    instructions: Object.freeze(["AGENTS.md", "r/AGENTS.md"])
  }),
  Object.freeze({
    target: "scripts/check-docs.mjs",
    instructions: Object.freeze(["AGENTS.md", "scripts/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/extension/nativeViews.ts",
    instructions: Object.freeze(["AGENTS.md", "src/extension/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/shared/protocol.ts",
    instructions: Object.freeze(["AGENTS.md", "src/shared/AGENTS.md"])
  }),
  Object.freeze({
    target: "src/webviews/App.tsx",
    instructions: Object.freeze(["AGENTS.md", "src/webviews/AGENTS.md"])
  })
]);

function instructionError(message) {
  const error = new Error(message);
  error.code = "AGENT_INSTRUCTIONS_INVALID";
  return error;
}

function portableRelativePath(path) {
  return path.split(sep).join("/");
}

function containedRelativePath(root, candidate) {
  const value = relative(root, candidate);
  if (value === "") return "";
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) {
    throw instructionError("An agent-instruction path escaped the repository root.");
  }
  return portableRelativePath(value);
}

function exactStatIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function readBoundedInstructionFile(
  repositoryRoot,
  relativePath,
  { maxBytes = SCOPED_FILE_LIMIT_BYTES, openFile = openSync } = {}
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > TOTAL_INSTRUCTION_LIMIT_BYTES) {
    throw instructionError("The agent-instruction file limit is invalid.");
  }
  const root = realpathSync(repositoryRoot);
  const absolutePath = resolve(root, relativePath);
  const normalizedPath = containedRelativePath(root, absolutePath);
  if (normalizedPath !== portableRelativePath(relativePath)) {
    throw instructionError(`Agent-instruction path normalization changed ${relativePath}.`);
  }
  const pathSnapshot = lstatSync(absolutePath, { bigint: true });
  if (!pathSnapshot.isFile() || pathSnapshot.isSymbolicLink() || pathSnapshot.nlink !== 1n) {
    throw instructionError(`${relativePath} must be one private regular file.`);
  }
  if (pathSnapshot.size <= 0n || pathSnapshot.size > BigInt(maxBytes)) {
    throw instructionError(`${relativePath} exceeds its bounded instruction-file size.`);
  }

  const descriptor = openFile(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let closeError;
  try {
    const openedSnapshot = fstatSync(descriptor, { bigint: true });
    if (!exactStatIdentity(pathSnapshot, openedSnapshot)) {
      throw instructionError(`${relativePath} changed identity before its bounded read.`);
    }
    const bytes = Buffer.alloc(Number(pathSnapshot.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw instructionError(`${relativePath} ended before its recorded size.`);
      offset += count;
    }
    const finalSnapshot = fstatSync(descriptor, { bigint: true });
    if (!exactStatIdentity(openedSnapshot, finalSnapshot)) {
      throw instructionError(`${relativePath} changed during its bounded read.`);
    }
    let text;
    try {
      text = UTF8.decode(bytes);
    } catch {
      throw instructionError(`${relativePath} is not strict UTF-8.`);
    }
    if (text.includes("\0")) throw instructionError(`${relativePath} contains a NUL character.`);
    return Object.freeze({ path: relativePath, bytes: bytes.length, text });
  } finally {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
    if (closeError) throw instructionError(`${relativePath} could not close its verified descriptor.`);
  }
}

function completionMarker(path, digest) {
  return `<!-- OW-INSTRUCTIONS:EOF path="${path}" sha256="${digest}" -->`;
}

export function validateInstructionDocument(repositoryRoot, manifestEntry) {
  const document = readBoundedInstructionFile(repositoryRoot, manifestEntry.path, {
    maxBytes: manifestEntry.maxBytes
  });
  const markerPattern = /<!-- OW-INSTRUCTIONS:EOF path="([^"]+)" sha256="([0-9a-f]{64})" -->\n$/u;
  const markerMatch = markerPattern.exec(document.text);
  if (!markerMatch || markerMatch[1] !== manifestEntry.path) {
    throw instructionError(`${manifestEntry.path} is missing its exact path-bound completion marker.`);
  }
  const marker = completionMarker(markerMatch[1], markerMatch[2]);
  const markerIndex = document.text.lastIndexOf(marker);
  const body = document.text.slice(0, markerIndex);
  if (body.includes("OW-INSTRUCTIONS:EOF")) {
    throw instructionError(`${manifestEntry.path} contains more than one completion marker.`);
  }
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  if (digest !== markerMatch[2]) {
    throw instructionError(`${manifestEntry.path} does not match its completion checksum.`);
  }
  const rules = [...document.text.matchAll(/<!-- OW-RULE:(I\d{2}) -->/gu)].map((match) => match[1]);
  if (rules.length !== manifestEntry.rules.length || rules.some((rule, index) => rule !== manifestEntry.rules[index])) {
    throw instructionError(`${manifestEntry.path} does not own its exact ordered rule inventory.`);
  }
  if (/^#{1,6}\s+(?:migration history|delivery history|evidence receipts?)\b/imu.test(body)) {
    throw instructionError(`${manifestEntry.path} contains migration or receipt history in an active prompt.`);
  }
  return Object.freeze({ ...document, digest, marker, rules: Object.freeze(rules) });
}

export function discoverAgentInstructionPaths(repositoryRoot, targetPath) {
  const root = realpathSync(repositoryRoot);
  if (typeof targetPath !== "string" || targetPath.length === 0 || isAbsolute(targetPath)) {
    throw instructionError("The context target must be one repository-relative path.");
  }
  const absoluteTarget = resolve(root, targetPath);
  containedRelativePath(root, absoluteTarget);
  const parent = dirname(absoluteTarget);
  const relativeParent = relative(root, parent);
  const parts = relativeParent === "" ? [] : relativeParent.split(sep);
  if (parts.length > MAX_ANCESTOR_DEPTH) throw instructionError("The instruction ancestor depth is too large.");

  const discovered = [];
  let current = root;
  for (const part of ["", ...parts]) {
    if (part !== "") {
      current = join(current, part);
      const directory = lstatSync(current, { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw instructionError("The context target traverses a non-directory or symbolic-link ancestor.");
      }
    }
    const candidate = join(current, "AGENTS.md");
    try {
      const snapshot = lstatSync(candidate, { bigint: true });
      if (!snapshot.isFile() || snapshot.isSymbolicLink()) {
        throw instructionError("An ancestor AGENTS.md is not a regular file.");
      }
      discovered.push(containedRelativePath(root, candidate));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (discovered.length === 0 || discovered.length > MAX_INSTRUCTION_FILES) {
    throw instructionError("The context target has an invalid instruction-file count.");
  }
  return Object.freeze(discovered);
}

function scanAgentInstructionPaths(repositoryRoot) {
  const root = realpathSync(repositoryRoot);
  const pending = [{ path: root, depth: 0 }];
  const found = [];
  let directoryCount = 0;
  let entryCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    directoryCount += 1;
    if (directoryCount > MAX_SCAN_DIRECTORIES || current.depth > MAX_ANCESTOR_DEPTH) {
      throw instructionError("The instruction scope scan exceeded its directory bound.");
    }
    const entries = readdirSync(current.path, { withFileTypes: true });
    entryCount += entries.length;
    if (entryCount > MAX_SCAN_ENTRIES) throw instructionError("The instruction scope scan exceeded its entry bound.");
    for (const entry of entries) {
      const absolutePath = join(current.path, entry.name);
      if (entry.name === "AGENTS.md") found.push(containedRelativePath(root, absolutePath));
      if (entry.isDirectory() && !SKIPPED_SCAN_DIRECTORIES.has(entry.name)) {
        pending.push({ path: absolutePath, depth: current.depth + 1 });
      }
    }
  }
  found.sort();
  if (found.length > MAX_INSTRUCTION_FILES) throw instructionError("Too many active AGENTS.md files were discovered.");
  return Object.freeze(found);
}

export function validateDeliveredInstructionContext(delivery, documents, maxBytes = CONTEXT_LIMIT_BYTES) {
  if (Buffer.byteLength(delivery, "utf8") > maxBytes) {
    throw instructionError("The delivered instruction context exceeds its aggregate byte bound.");
  }
  const expected = documents.map((document) => document.text).join("\n");
  if (delivery !== expected) throw instructionError("The delivered instruction context changed content or order.");
  let previousMarker = -1;
  for (const document of documents) {
    const index = delivery.indexOf(document.marker);
    if (index <= previousMarker || delivery.indexOf(document.marker, index + 1) !== -1) {
      throw instructionError("The delivered instruction context has a missing, duplicate, or reordered completion marker.");
    }
    previousMarker = index;
  }
  return true;
}

export function loadAgentInstructionContext(repositoryRoot, targetPath) {
  const paths = discoverAgentInstructionPaths(repositoryRoot, targetPath);
  const documents = paths.map((path) => {
    const entry = MANIFEST_BY_PATH.get(path);
    if (!entry) throw instructionError(`The context target discovered unregistered scope ${path}.`);
    return validateInstructionDocument(repositoryRoot, entry);
  });
  const totalBytes = documents.reduce((total, document) => total + document.bytes, 0) + documents.length - 1;
  if (totalBytes > CONTEXT_LIMIT_BYTES) {
    throw instructionError(`The ${targetPath} instruction context exceeds its aggregate byte bound.`);
  }
  const delivery = documents.map((document) => document.text).join("\n");
  validateDeliveredInstructionContext(delivery, documents);
  return Object.freeze({
    target: targetPath,
    paths,
    documents: Object.freeze(documents),
    delivery,
    bytes: Buffer.byteLength(delivery, "utf8")
  });
}

export function validateAgentInstructionContext(repositoryRoot) {
  const discoveredFiles = scanAgentInstructionPaths(repositoryRoot);
  const expectedFiles = [...EXPECTED_INSTRUCTION_FILES].sort();
  if (
    discoveredFiles.length !== expectedFiles.length ||
    discoveredFiles.some((path, index) => path !== expectedFiles[index])
  ) {
    throw instructionError("The repository contains a missing or unregistered AGENTS.md scope.");
  }

  const documents = INSTRUCTION_MANIFEST.map((entry) => validateInstructionDocument(repositoryRoot, entry));
  const totalBytes = documents.reduce((total, document) => total + document.bytes, 0);
  if (totalBytes > TOTAL_INSTRUCTION_LIMIT_BYTES) {
    throw instructionError("The complete instruction set exceeds its aggregate byte bound.");
  }
  const owners = new Map();
  for (const document of documents) {
    for (const rule of document.rules) {
      if (owners.has(rule)) throw instructionError(`${rule} has duplicate owners.`);
      owners.set(rule, document.path);
    }
  }
  for (const rule of EXPECTED_RULE_IDS) {
    if (!owners.has(rule)) throw instructionError(`${rule} has no scoped owner.`);
  }
  if (owners.size !== EXPECTED_RULE_IDS.length) throw instructionError("The rule inventory contains an unknown owner.");

  const contexts = REPRESENTATIVE_CONTEXTS.map((representative) => {
    const context = loadAgentInstructionContext(repositoryRoot, representative.target);
    if (
      context.paths.length !== representative.instructions.length ||
      context.paths.some((path, index) => path !== representative.instructions[index])
    ) {
      throw instructionError(`${representative.target} loaded the wrong instruction scopes or ancestor order.`);
    }
    return Object.freeze({ target: context.target, paths: context.paths, bytes: context.bytes });
  });
  return Object.freeze({
    files: documents.length,
    rules: owners.size,
    totalBytes,
    maximumContextBytes: Math.max(...contexts.map((context) => context.bytes)),
    contexts: Object.freeze(contexts)
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = validateAgentInstructionContext(repositoryRoot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Scoped agent instructions are invalid: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
