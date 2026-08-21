import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_LIMIT_BYTES,
  EXPECTED_INSTRUCTION_FILES,
  REPRESENTATIVE_CONTEXTS,
  discoverAgentInstructionPaths,
  loadAgentInstructionContext,
  readBoundedInstructionFile,
  validateAgentInstructionContext,
  validateDeliveredInstructionContext
} from "./agent-instructions-context.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = new Set();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryInstructionTree() {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-instructions-"));
  temporaryRoots.add(root);
  for (const relativePath of EXPECTED_INSTRUCTION_FILES) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repositoryRoot, relativePath), destination);
  }
  return root;
}

function reseal(relativePath, text) {
  const markerStart = text.lastIndexOf("<!-- OW-INSTRUCTIONS:EOF");
  assert.notEqual(markerStart, -1);
  const body = text.slice(0, markerStart);
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return `${body}<!-- OW-INSTRUCTIONS:EOF path="${relativePath}" sha256="${digest}" -->\n`;
}

test("the repository instruction set has one bounded owner for every invariant", () => {
  const result = validateAgentInstructionContext(repositoryRoot);
  assert.equal(result.files, 9);
  assert.equal(result.rules, 58);
  assert.equal(result.totalBytes <= 96 * 1_024, true);
  assert.equal(result.maximumContextBytes <= CONTEXT_LIMIT_BYTES, true);
});

test("actual ancestor discovery loads root then only the relevant scope", () => {
  for (const representative of REPRESENTATIVE_CONTEXTS) {
    assert.deepEqual(discoverAgentInstructionPaths(repositoryRoot, representative.target), representative.instructions);
    const context = loadAgentInstructionContext(repositoryRoot, representative.target);
    assert.deepEqual(context.paths, representative.instructions);
    for (const unrelated of EXPECTED_INSTRUCTION_FILES) {
      if (!representative.instructions.includes(unrelated)) assert.equal(context.paths.includes(unrelated), false);
    }
  }
});

test("delivered context rejects truncation and reversed ancestor order", () => {
  const context = loadAgentInstructionContext(repositoryRoot, "src/extension/nativeViews.ts");
  assert.throws(
    () => validateDeliveredInstructionContext(context.delivery.slice(0, -1), context.documents),
    /changed content or order|completion marker/u
  );
  const reversed = [...context.documents].reverse();
  assert.throws(
    () => validateDeliveredInstructionContext(reversed.map((document) => document.text).join("\n"), context.documents),
    /changed content or order/u
  );
});

test("missing markers and checksum drift fail closed", () => {
  const root = temporaryInstructionTree();
  const rootPath = join(root, "AGENTS.md");
  writeFileSync(rootPath, readFileSync(rootPath, "utf8").slice(0, -20), "utf8");
  assert.throws(() => validateAgentInstructionContext(root), /completion marker/u);

  const secondRoot = temporaryInstructionTree();
  const docsPath = join(secondRoot, "docs/AGENTS.md");
  const docs = readFileSync(docsPath, "utf8").replace("Documentation instructions", "Documentation instructionz");
  writeFileSync(docsPath, docs, "utf8");
  assert.throws(() => validateAgentInstructionContext(secondRoot), /completion checksum/u);
});

test("duplicated and missing invariant ownership fail even with a renewed checksum", () => {
  const duplicateRoot = temporaryInstructionTree();
  const duplicatePath = join(duplicateRoot, "docs/AGENTS.md");
  const duplicateText = readFileSync(duplicatePath, "utf8");
  const duplicateMarker = duplicateText.lastIndexOf("<!-- OW-INSTRUCTIONS:EOF");
  const withDuplicate = `${duplicateText.slice(0, duplicateMarker)}<!-- OW-RULE:I02 -->\n2. duplicate fixture\n\n${duplicateText.slice(duplicateMarker)}`;
  writeFileSync(duplicatePath, reseal("docs/AGENTS.md", withDuplicate), "utf8");
  assert.throws(() => validateAgentInstructionContext(duplicateRoot), /ordered rule inventory|duplicate owners/u);

  const missingRoot = temporaryInstructionTree();
  const missingPath = join(missingRoot, "docs/AGENTS.md");
  const withoutRule = readFileSync(missingPath, "utf8").replace("<!-- OW-RULE:I09 -->\n", "");
  writeFileSync(missingPath, reseal("docs/AGENTS.md", withoutRule), "utf8");
  assert.throws(() => validateAgentInstructionContext(missingRoot), /ordered rule inventory|no scoped owner/u);
});

test("an unregistered intermediate scope fails instead of leaking into descendants", () => {
  const root = temporaryInstructionTree();
  const extraPath = join(root, "src/AGENTS.md");
  mkdirSync(dirname(extraPath), { recursive: true });
  const body = "# Unregistered scope\n\n";
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  writeFileSync(extraPath, `${body}<!-- OW-INSTRUCTIONS:EOF path="src/AGENTS.md" sha256="${digest}" -->\n`, "utf8");
  assert.throws(() => validateAgentInstructionContext(root), /missing or unregistered/u);
});

test("oversized instruction files reject before the descriptor is opened", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-instruction-bound-"));
  temporaryRoots.add(root);
  writeFileSync(join(root, "AGENTS.md"), "x".repeat(2_049), "utf8");
  let opened = false;
  assert.throws(
    () =>
      readBoundedInstructionFile(root, "AGENTS.md", {
        maxBytes: 2_048,
        openFile() {
          opened = true;
          throw new Error("must not open");
        }
      }),
    /bounded instruction-file size/u
  );
  assert.equal(opened, false);
});

test("aggregate context overflow fails before marker inspection", () => {
  assert.throws(
    () => validateDeliveredInstructionContext("x".repeat(CONTEXT_LIMIT_BYTES + 1), []),
    /aggregate byte bound/u
  );
});
