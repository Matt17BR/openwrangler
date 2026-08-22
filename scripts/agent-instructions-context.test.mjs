import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  Dir,
  copyFileSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
  APPLICATION_DELIVERY_EVIDENCE,
  CONTEXT_LIMIT_BYTES,
  EXPECTED_INSTRUCTION_FILES,
  INSTRUCTION_MANIFEST,
  REPRESENTATIVE_CONTEXTS,
  discoverAgentInstructionPaths,
  loadAgentInstructionContext,
  readBoundedInstructionFile,
  scanTrackedAgentInstructionPaths,
  validateAgentInstructionContext,
  validateConstructedInstructionContext,
  validateInstructionDocument
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
  assert.deepEqual(result.applicationDeliveryEvidence, APPLICATION_DELIVERY_EVIDENCE);
  assert.deepEqual(APPLICATION_DELIVERY_EVIDENCE, {
    actualCodexApplicationPathObserved: false,
    actualTruncationBehaviorObserved: false,
    publicationBlocked: true,
    requiredCanary: "a real application-path completion-marker canary"
  });
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
      [
        "AGENTS.md",
        "src/shared/AGENTS.md",
        "src/extension/AGENTS.md",
        "src/webviews/AGENTS.md",
        "python/AGENTS.md",
        "r/AGENTS.md",
        "scripts/AGENTS.md"
      ]
    ]
  );
  assert.deepEqual(REPRESENTATIVE_CONTEXTS.find((entry) => entry.target === "README.md")?.instructions, [
    "AGENTS.md",
    "docs/AGENTS.md"
  ]);
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
  writeFileSync(join(aliasRoot, "terminal-�"), "fixture\n", "utf8");
  for (const alias of ["alias-\ud800.txt", "alias-\udc00.txt", "alias-e\u0301.txt", "terminal-\ud800"]) {
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

test("local context construction rejects byte truncation and reversed ancestor order without claiming application delivery", () => {
  const context = loadAgentInstructionContext(repositoryRoot, "src/extension/nativeViews.ts", { targetKind: "file" });
  assert.throws(
    () => validateConstructedInstructionContext(context.contextText.slice(0, -1), context.documents),
    /changed content or order|completion marker/u
  );
  const reversed = [...context.documents].reverse();
  assert.throws(
    () =>
      validateConstructedInstructionContext(reversed.map((document) => document.text).join("\n"), context.documents),
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
    /changed identity before pathname reopen|handle belongs to another directory identity/u
  );
});

test("every instruction-scan directory handle is bound to its queued directory identity", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-owned-directory-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "openwrangler-agent-foreign-directory-"));
  temporaryRoots.add(root);
  temporaryRoots.add(foreignRoot);
  writeFileSync(join(root, "AGENTS.md"), "owned\n", "utf8");
  writeFileSync(join(foreignRoot, "AGENTS.md"), "foreign\n", "utf8");
  assert.throws(
    () =>
      scanTrackedAgentInstructionPaths(root, ["AGENTS.md"], {
        openDirectory() {
          return opendirSync(foreignRoot);
        }
      }),
    /handle belongs to another directory identity/u
  );
});

test("instruction scans accept native handles from an honest opener but reject foreign delegated wrappers", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-owned-native-directory-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "openwrangler-agent-foreign-delegate-"));
  temporaryRoots.add(root);
  temporaryRoots.add(foreignRoot);
  writeFileSync(join(root, "AGENTS.md"), "owned\n", "utf8");
  writeFileSync(join(foreignRoot, "AGENTS.md"), "foreign\n", "utf8");

  assert.deepEqual(
    scanTrackedAgentInstructionPaths(root, ["AGENTS.md"], {
      openDirectory(path) {
        return opendirSync(path);
      }
    }),
    ["AGENTS.md"]
  );

  const foreign = opendirSync(foreignRoot);
  try {
    assert.throws(
      () =>
        scanTrackedAgentInstructionPaths(root, ["AGENTS.md"], {
          openDirectory(expectedPath) {
            return {
              path: expectedPath,
              readSync: () => foreign.readSync(),
              closeSync: () => foreign.closeSync()
            };
          }
        }),
      /not an owned native directory handle/u,
      "FOREIGN_DELEGATE_ACCEPTED"
    );
  } finally {
    foreign.closeSync();
  }
});

test("instruction scans reject proxy handles without claiming their caller-owned native target", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-proxy-directory-"));
  temporaryRoots.add(root);
  writeFileSync(join(root, "AGENTS.md"), "owned\n", "utf8");
  const target = opendirSync(root);
  let proxyTraps = 0;
  const proxy = new Proxy(target, {
    getOwnPropertyDescriptor() {
      proxyTraps += 1;
      return undefined;
    },
    getPrototypeOf() {
      proxyTraps += 1;
      return Dir.prototype;
    }
  });
  try {
    assert.throws(
      () =>
        scanTrackedAgentInstructionPaths(root, ["AGENTS.md"], {
          openDirectory() {
            return proxy;
          }
        }),
      /not an owned native directory handle/u
    );
    assert.equal(proxyTraps, 0, "Proxy traps must not run while an unowned directory candidate is rejected.");
  } finally {
    Dir.prototype.closeSync.call(target);
  }
  assert.throws(
    () => Dir.prototype.closeSync.call(target),
    (error) => error?.code === "ERR_DIR_CLOSED",
    "The rejected proxy target remains caller-owned and is closed exactly once by the caller."
  );
});

test("instruction scans reject overridden native handles and close the owned descriptor through the native method", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-overridden-directory-"));
  temporaryRoots.add(root);
  writeFileSync(join(root, "AGENTS.md"), "owned\n", "utf8");
  for (const method of ["readSync", "closeSync"]) {
    let opened;
    let overrideCalls = 0;
    assert.throws(
      () =>
        scanTrackedAgentInstructionPaths(root, ["AGENTS.md"], {
          openDirectory(path) {
            opened = opendirSync(path);
            Object.defineProperty(opened, method, {
              configurable: true,
              value() {
                overrideCalls += 1;
                throw new Error(`hostile ${method} override`);
              }
            });
            return opened;
          }
        }),
      /overrides native directory methods/u
    );
    assert.equal(overrideCalls, 0, `The rejected native-handle ${method} override must never execute.`);
    assert.throws(
      () => Dir.prototype.closeSync.call(opened),
      (error) => error?.code === "ERR_DIR_CLOSED",
      `The rejected ${method}-overridden native handle must already be closed by its native owner.`
    );
  }
});

test("instruction scans retain immutable native read and close methods across prototype replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-native-method-capture-"));
  temporaryRoots.add(root);
  writeFileSync(join(root, "AGENTS.md"), "owned\n", "utf8");
  const nativeRead = Dir.prototype.readSync;
  const nativeClose = Dir.prototype.closeSync;
  let opened;
  let hostileReadCalls = 0;
  let hostileCloseCalls = 0;
  let result;
  try {
    result = scanTrackedAgentInstructionPaths(root, ["AGENTS.md"], {
      openDirectory(path) {
        opened = opendirSync(path);
        Dir.prototype.readSync = function hostileRead() {
          hostileReadCalls += 1;
          throw new Error("hostile mutable-prototype read");
        };
        Dir.prototype.closeSync = function hostileClose() {
          hostileCloseCalls += 1;
          throw new Error("hostile mutable-prototype close");
        };
        return opened;
      }
    });
  } finally {
    Dir.prototype.readSync = nativeRead;
    Dir.prototype.closeSync = nativeClose;
  }
  assert.deepEqual(result, ["AGENTS.md"]);
  assert.equal(hostileReadCalls, 0, "Mutable prototype reads must not intercept the captured native operation.");
  assert.equal(hostileCloseCalls, 0, "Mutable prototype closes must not intercept the captured native operation.");
  assert.throws(
    () => nativeClose.call(opened),
    (error) => error?.code === "ERR_DIR_CLOSED",
    "The captured native close must release the exact owned handle once."
  );
});

test("a primary scan failure aggregates the one owned native close failure in stable order", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-close-aggregation-"));
  temporaryRoots.add(root);
  writeFileSync(join(root, "AGENTS.md"), "owned\n", "utf8");
  writeFileSync(join(root, "other.txt"), "other\n", "utf8");
  const closeFailure = new Error("injected native directory close failure");
  let opened;
  let closeAttempts = 0;
  let received;
  assert.throws(
    () =>
      scanTrackedAgentInstructionPaths(root, ["AGENTS.md"], {
        maxEntries: 1,
        openDirectory(path) {
          opened = opendirSync(path);
          return opened;
        },
        cleanupFaults: {
          afterNativeDirectoryClose() {
            closeAttempts += 1;
            throw closeFailure;
          }
        }
      }),
    (error) => {
      received = error;
      return true;
    }
  );
  assert.equal(received instanceof AggregateError, true);
  assert.equal(received?.code, "AGENT_INSTRUCTIONS_INVALID");
  assert.equal(received?.errors.length, 2);
  assert.match(received.errors[0].message, /entry bound before retention/u);
  assert.match(received.errors[1].message, /descriptor did not close/u);
  assert.equal(received.errors[1].cause, closeFailure);
  assert.equal(closeAttempts, 1, "The owned native directory close must be attempted exactly once.");
  assert.throws(
    () => Dir.prototype.closeSync.call(opened),
    (error) => error?.code === "ERR_DIR_CLOSED",
    "The injected late close failure must not leave the native directory handle open."
  );
});

test("a bounded read preserves its primary plus file and every reverse-order ancestor close failure", () => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-agent-complete-close-aggregation-"));
  temporaryRoots.add(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/AGENTS.md"), Buffer.from([0xff]));
  const fileCloseFailure = new Error("injected file close failure");
  const sourceCloseFailure = new Error("injected source-directory close failure");
  const rootCloseFailure = new Error("injected root-directory close failure");
  const fileDescriptors = [];
  const ancestorDescriptors = [];
  const ancestorCloseLabels = [];
  let received;
  assert.throws(
    () =>
      readBoundedInstructionFile(root, "src/AGENTS.md", {
        openFile(path, flags) {
          const descriptor = openSync(path, flags);
          fileDescriptors.push(descriptor);
          return descriptor;
        },
        openDirectory(path, flags) {
          const descriptor = openSync(path, flags);
          ancestorDescriptors.push(descriptor);
          return descriptor;
        },
        cleanupFaults: {
          afterFileClose() {
            throw fileCloseFailure;
          },
          afterAncestorClose(label) {
            ancestorCloseLabels.push(label);
            if (label.includes("Directory src")) throw sourceCloseFailure;
            throw rootCloseFailure;
          }
        }
      }),
    (error) => {
      received = error;
      return true;
    }
  );
  assert.equal(received instanceof AggregateError, true);
  assert.equal(received?.code, "AGENT_INSTRUCTIONS_INVALID");
  assert.equal(received?.errors.length, 4);
  assert.match(received.errors[0].message, /not strict UTF-8/u);
  assert.equal(received.errors[1].cause, fileCloseFailure);
  assert.equal(received.errors[2].cause, sourceCloseFailure);
  assert.equal(received.errors[3].cause, rootCloseFailure);
  assert.deepEqual(ancestorCloseLabels, [
    "Directory src's verified descriptor",
    "The repository root's verified descriptor"
  ]);
  for (const descriptor of [...fileDescriptors, ...ancestorDescriptors]) {
    assert.throws(
      () => fstatSync(descriptor),
      (error) => error?.code === "EBADF",
      "Every descriptor with an injected post-close failure must still be closed exactly once."
    );
  }
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

test("only the positive canonical active-policy structure survives resealing", () => {
  for (const line of [
    "# Migration notes",
    "## Archived operator guidance",
    "## Prior implementation summary",
    "## Assessment findings",
    "## Validation outcomes",
    "## Execution journal",
    "## Handoff summary",
    "## Transfer acknowledgements",
    "Archived migration guidance from the prior prompt.",
    "Assessment finding: accepted for delivery.",
    "Execution result: all checks passed.",
    "Handoff acknowledgement: received."
  ]) {
    const root = temporaryInstructionTree();
    const docsPath = join(root, "docs/AGENTS.md");
    const text = readFileSync(docsPath, "utf8");
    const markerStart = text.lastIndexOf("<!-- OW-INSTRUCTIONS:EOF");
    const changed = `${text.slice(0, markerStart)}${line}\n\n${text.slice(markerStart)}`;
    writeFileSync(docsPath, reseal("docs/AGENTS.md", changed), "utf8");
    assert.throws(() => validateAgentInstructionContext(root), /canonical active-policy structure/u);
  }
});

test("canonical rule seals preserve Markdown-significant indentation, nesting, quotations, and fences", () => {
  const whitespaceRoot = temporaryInstructionTree();
  const whitespacePath = join(whitespaceRoot, "AGENTS.md");
  const whitespaceChanged = readFileSync(whitespacePath, "utf8").replace(
    "Viewing filters/sorts are separate from committed cleaning steps",
    "Viewing   filters/sorts are   separate from committed cleaning steps"
  );
  assert.notEqual(whitespaceChanged, readFileSync(whitespacePath, "utf8"));
  writeFileSync(whitespacePath, reseal("AGENTS.md", whitespaceChanged), "utf8");
  assert.doesNotThrow(() => validateAgentInstructionContext(whitespaceRoot));

  const changes = [
    {
      path: "AGENTS.md",
      mutate: (text) => text.replace("<!-- OW-RULE:I02 -->\n2. ", "<!-- OW-RULE:I02 -->\n    2. ")
    },
    {
      path: "src/shared/AGENTS.md",
      mutate: (text) => text.replace("    Grouped targets and keys", "        Grouped targets and keys")
    },
    {
      path: "src/shared/AGENTS.md",
      mutate: (text) => text.replace("    Grouped targets and keys", "    > Grouped targets and keys")
    },
    {
      path: "scripts/AGENTS.md",
      mutate: (text) => text.replace("npm run check:pr\nnpm test", "npm   run check:pr\nnpm test"),
      pattern: /canonical active-policy structure/u,
      label: "CANONICAL_FENCE_WHITESPACE_ACCEPTED"
    },
    {
      path: "scripts/AGENTS.md",
      mutate: (text) => text.replace("npm run check:pr\nnpm test", "npm run check:pr\n\nnpm test"),
      pattern: /canonical active-policy structure/u,
      label: "CANONICAL_FENCE_STRUCTURE_ACCEPTED"
    }
  ];
  for (const change of changes) {
    const root = temporaryInstructionTree();
    const instructionPath = join(root, change.path);
    const original = readFileSync(instructionPath, "utf8");
    const changed = change.mutate(original);
    assert.notEqual(changed, original);
    writeFileSync(instructionPath, reseal(change.path, changed), "utf8");
    assert.throws(
      () => validateAgentInstructionContext(root),
      change.pattern ?? /exact invariant number|independently sealed canonical body/u,
      change.label ?? (change.path === "AGENTS.md" ? "INDENTED_RULE_ACCEPTED" : "MARKDOWN_STRUCTURE_ACCEPTED")
    );
  }

  assert.doesNotThrow(() =>
    validateInstructionDocument(
      repositoryRoot,
      INSTRUCTION_MANIFEST.find((entry) => entry.path === "scripts/AGENTS.md")
    )
  );
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
    () => validateConstructedInstructionContext("x".repeat(CONTEXT_LIMIT_BYTES + 1), []),
    /aggregate byte bound/u
  );
});
