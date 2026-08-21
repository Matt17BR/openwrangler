import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_LIMIT_BYTES,
  EXPECTED_INSTRUCTION_FILES,
  INSTRUCTION_MANIFEST,
  REPRESENTATIVE_CONTEXTS,
  discoverAgentInstructionPaths,
  loadAgentInstructionContext,
  readBoundedInstructionFile,
  scanTrackedAgentInstructionPaths,
  validateAgentInstructionContext,
  validateDeliveredInstructionContext
} from "./agent-instructions-context.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = new Set();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function isolatedGitEnvironment() {
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE"
  ]) {
    delete environment[name];
  }
  return environment;
}

function git(root, ...arguments_) {
  execFileSync("git", ["-C", root, ...arguments_], {
    env: isolatedGitEnvironment(),
    stdio: "ignore",
    windowsHide: true
  });
}

function temporaryInstructionTree() {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-instructions-"));
  temporaryRoots.add(root);
  for (const relativePath of EXPECTED_INSTRUCTION_FILES) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repositoryRoot, relativePath), destination);
  }
  for (const representative of REPRESENTATIVE_CONTEXTS) {
    const destination = join(root, representative.target);
    mkdirSync(dirname(destination), { recursive: true });
    if (representative.targetKind === "directory") mkdirSync(destination, { recursive: true });
    else if (!EXPECTED_INSTRUCTION_FILES.includes(representative.target))
      writeFileSync(destination, "fixture\n", "utf8");
  }
  git(root, "init", "--quiet");
  git(root, "add", "--", ...EXPECTED_INSTRUCTION_FILES);
  return root;
}

function reseal(relativePath, text) {
  const markerStart = text.lastIndexOf("<!-- OW-INSTRUCTIONS:EOF");
  assert.notEqual(markerStart, -1);
  const body = text.slice(0, markerStart);
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return `${body}<!-- OW-INSTRUCTIONS:EOF path="${relativePath}" sha256="${digest}" -->\n`;
}

function replaceAncestor(root, relativePath) {
  const original = join(root, relativePath);
  renameSync(original, `${original}-replaced`);
  mkdirSync(original, { recursive: true });
}

test("the repository instruction set has one bounded canonical owner for every invariant", () => {
  const result = validateAgentInstructionContext(repositoryRoot);
  assert.equal(result.files, 9);
  assert.equal(result.rules, 58);
  assert.equal(result.totalBytes <= 96 * 1_024, true);
  assert.equal(result.maximumContextBytes <= CONTEXT_LIMIT_BYTES, true);
});

test("actual ancestors and explicit src/test routes load every applicable owner in order", () => {
  for (const representative of REPRESENTATIVE_CONTEXTS) {
    const routed = representative.routedInstructions ?? [];
    const ancestors = representative.instructions.slice(0, representative.instructions.length - routed.length);
    assert.deepEqual(
      discoverAgentInstructionPaths(repositoryRoot, representative.target, {
        targetKind: representative.targetKind
      }),
      ancestors
    );
    const context = loadAgentInstructionContext(repositoryRoot, representative.target, {
      targetKind: representative.targetKind,
      routedInstructions: routed
    });
    assert.deepEqual(context.paths, representative.instructions);
    for (const unrelated of EXPECTED_INSTRUCTION_FILES) {
      if (!representative.instructions.includes(unrelated)) assert.equal(context.paths.includes(unrelated), false);
    }
  }
  assert.deepEqual(
    REPRESENTATIVE_CONTEXTS.filter((entry) => entry.target.startsWith("src/test/")).map((entry) => entry.instructions),
    [
      ["AGENTS.md", "src/shared/AGENTS.md"],
      ["AGENTS.md", "src/shared/AGENTS.md", "src/extension/AGENTS.md"],
      ["AGENTS.md", "src/shared/AGENTS.md", "src/webviews/AGENTS.md"],
      ["AGENTS.md", "src/shared/AGENTS.md", "src/extension/AGENTS.md", "src/webviews/AGENTS.md", "scripts/AGENTS.md"]
    ]
  );
});

test("file and directory targets are exact and path aliases fail closed", () => {
  assert.deepEqual(discoverAgentInstructionPaths(repositoryRoot, "src/shared", { targetKind: "directory" }), [
    "AGENTS.md",
    "src/shared/AGENTS.md"
  ]);
  assert.throws(() => discoverAgentInstructionPaths(repositoryRoot, "src/shared/protocol.ts"), /declare exact file/u);
  assert.throws(
    () => discoverAgentInstructionPaths(repositoryRoot, "src/shared/protocol.ts", { targetKind: "directory" }),
    /real directory/u
  );
  assert.throws(
    () => discoverAgentInstructionPaths(repositoryRoot, "src/shared", { targetKind: "file" }),
    /regular file/u
  );
  for (const alias of [
    "./README.md",
    "docs//architecture.md",
    "src/shared/../shared/protocol.ts",
    "src\\shared\\protocol.ts"
  ])
    assert.throws(
      () => discoverAgentInstructionPaths(repositoryRoot, alias, { targetKind: "file" }),
      /exact normalized/u
    );

  const aliasRoot = temporaryInstructionTree();
  writeFileSync(join(aliasRoot, "alias-�.txt"), "fixture\n", "utf8");
  for (const alias of ["alias-\ud800.txt", "alias-\udc00.txt", "alias-e\u0301.txt"]) {
    assert.throws(
      () => discoverAgentInstructionPaths(aliasRoot, alias, { targetKind: "file" }),
      /valid Unicode|exact normalized/u
    );
  }
});

test("the canonical root policy is mandatory and first for every scoped context", () => {
  const root = temporaryInstructionTree();
  rmSync(join(root, "AGENTS.md"));
  assert.throws(
    () => discoverAgentInstructionPaths(root, "src/shared/protocol.ts", { targetKind: "file" }),
    /root AGENTS\.md/u
  );
});

test("delivered context rejects truncation and reversed ancestor order", () => {
  const context = loadAgentInstructionContext(repositoryRoot, "src/extension/nativeViews.ts", { targetKind: "file" });
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

test("resealing any changed I01-I58 invariant cannot replace its independent canonical body seal", () => {
  const observed = [];
  for (const entry of INSTRUCTION_MANIFEST) {
    for (const rule of entry.rules) {
      const root = temporaryInstructionTree();
      const instructionPath = join(root, entry.path);
      const number = Number.parseInt(rule.slice(1), 10);
      const markerAndPrefix = `<!-- OW-RULE:${rule} -->\n${number}. `;
      const original = readFileSync(instructionPath, "utf8");
      assert.equal(original.includes(markerAndPrefix), true, `${rule} must expose its canonical numbered prefix.`);
      const changed = original.replace(markerAndPrefix, `${markerAndPrefix}mutated `);
      writeFileSync(instructionPath, reseal(entry.path, changed), "utf8");
      assert.throws(
        () => validateAgentInstructionContext(root),
        new RegExp(`independently sealed canonical body for ${rule}`, "u")
      );
      observed.push(rule);
    }
  }
  assert.deepEqual(
    observed.sort(),
    Array.from({ length: 58 }, (_, index) => `I${String(index + 1).padStart(2, "0")}`)
  );
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

test("tracked recursive AGENTS.md files are admitted even below formerly skipped directory names", () => {
  const root = temporaryInstructionTree();
  const extraPath = join(root, "node_modules/generated/AGENTS.md");
  mkdirSync(dirname(extraPath), { recursive: true });
  const body = "# Unregistered tracked scope\n\n";
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  writeFileSync(
    extraPath,
    `${body}<!-- OW-INSTRUCTIONS:EOF path="node_modules/generated/AGENTS.md" sha256="${digest}" -->\n`,
    "utf8"
  );
  git(root, "add", "--force", "--", "node_modules/generated/AGENTS.md");
  assert.throws(() => validateAgentInstructionContext(root), /missing or unregistered/u);
});

test("streamed directory-entry limits are charged before a tracked path is retained", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-stream-bound-"));
  temporaryRoots.add(root);
  mkdirSync(join(root, "deep"));
  writeFileSync(join(root, "deep/AGENTS.md"), "fixture\n", "utf8");
  assert.throws(
    () => scanTrackedAgentInstructionPaths(root, ["deep/AGENTS.md"], { maxEntries: 1 }),
    /entry bound before retention/u
  );
});

test("tracked ancestor prefix count, depth, and bytes reject before retention or directory opening", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-prefix-bound-"));
  temporaryRoots.add(root);
  const cases = [
    {
      paths: [`${"a/".repeat(33)}AGENTS.md`],
      options: { maxDirectories: 4_096 },
      pattern: /depth.*before retention/iu
    },
    { paths: ["a/b/AGENTS.md"], options: { maxDirectories: 2 }, pattern: /directory.*before retention/iu },
    {
      paths: Array.from(
        { length: 16 },
        (_, pathIndex) =>
          `${Array.from({ length: 32 }, (_, partIndex) => `${pathIndex}-${partIndex}-${"x".repeat(96)}`).join("/")}/AGENTS.md`
      ),
      options: { maxDirectories: 4_096 },
      pattern: /prefix byte.*before retention/iu
    }
  ];
  for (const { paths, options, pattern } of cases) {
    let opened = false;
    assert.throws(
      () =>
        scanTrackedAgentInstructionPaths(root, paths, {
          ...options,
          openDirectory() {
            opened = true;
            throw new Error("must not open before prefix admission");
          }
        }),
      pattern
    );
    assert.equal(opened, false);
  }
});

test("queued tracked-scope directory replacement fails before pathname reopening", () => {
  const root = temporaryInstructionTree();
  let opens = 0;
  assert.throws(
    () =>
      scanTrackedAgentInstructionPaths(root, ["src/shared/AGENTS.md"], {
        openDirectory(path) {
          opens += 1;
          if (opens === 2) {
            replaceAncestor(root, "src");
            mkdirSync(join(root, "src/shared"), { recursive: true });
            writeFileSync(join(root, "src/shared/AGENTS.md"), "replacement\n", "utf8");
          }
          return opendirSync(path);
        }
      }),
    /changed identity before pathname reopen/u
  );
});

test("ancestor replacement fails descriptor-bound discovery and instruction reads", () => {
  const discoveryRoot = temporaryInstructionTree();
  assert.throws(
    () =>
      discoverAgentInstructionPaths(discoveryRoot, "src/shared/protocol.ts", {
        targetKind: "file",
        beforeAncestorRevalidation() {
          replaceAncestor(discoveryRoot, "src");
        }
      }),
    /changed during the descriptor-bound operation/u
  );

  const readRoot = temporaryInstructionTree();
  assert.throws(
    () =>
      readBoundedInstructionFile(readRoot, "src/shared/AGENTS.md", {
        beforeAncestorRevalidation() {
          replaceAncestor(readRoot, "src/shared");
        }
      }),
    /changed during the descriptor-bound operation/u
  );
});

test("issue, review, run, and tracker sludge rejects outside headings", () => {
  for (const line of [
    "Issue #704: implementation history",
    "Review verdict: GREEN",
    "Run ID: 123456",
    "Tracker: state:review",
    "Owner: task-704",
    "HEAD: deadbee",
    "# Migration notes",
    "## Migration history notes",
    "# Prompt history",
    "### Prompt notes",
    "# Review notes",
    "## Review evidence",
    "# Run evidence",
    "## Run notes",
    "# Evidence",
    "## Evidence receipts",
    "# MIGRATION NOTES: archived",
    "## Prompt histories",
    "### Review note — prior",
    "# Run Evidence (local)",
    "## EVIDENCE: terminal",
    "### Workflow receipts"
  ]) {
    const root = temporaryInstructionTree();
    const docsPath = join(root, "docs/AGENTS.md");
    const text = readFileSync(docsPath, "utf8");
    const markerStart = text.lastIndexOf("<!-- OW-INSTRUCTIONS:EOF");
    const changed = `${text.slice(0, markerStart)}${line}\n\n${text.slice(markerStart)}`;
    writeFileSync(docsPath, reseal("docs/AGENTS.md", changed), "utf8");
    assert.throws(() => validateAgentInstructionContext(root), /sludge in an active prompt/u);
  }
});

test("the dedicated workflow triggers for every recursive AGENTS.md path", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/scoped-agent-instructions.yml"), "utf8");
  assert.equal(workflow.match(/- "\*\*\/AGENTS\.md"/gu)?.length, 2);
  assert.equal(workflow.match(/^\s+- (?:\.github|docs|python|r|scripts|src)\/[^\n]*AGENTS\.md$/gmu), null);
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
