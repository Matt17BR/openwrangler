import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CORE_SCHEMA,
  EVENT_ALIAS,
  EVENT_DOCUMENT,
  EVENT_MAPPING,
  EVENT_POP,
  EVENT_SCALAR,
  EVENT_SEQUENCE,
  SCALAR_STYLE_PLAIN,
  load as parseYaml,
  mergeTag,
  parseEvents as parseYamlEvents
} from "js-yaml";
import { loadConfigFromFile } from "vite";
import {
  CI_CLASSIFIER_OUTPUTS,
  classifyCiChange,
  parseChangedPathBuffer,
  resolvePullRequestClassificationRange,
  sanitizedGitEnvironment
} from "./ci-path-classification.mjs";
import {
  ALWAYS_REQUIRED_CI_JOBS,
  CONDITIONAL_CI_JOBS,
  REQUIRED_CI_JOBS,
  parseRequiredFlag,
  requireCiResults,
  resultEnvironmentKey
} from "./require-ci-results.mjs";
import { LOCK_ROOTS, readLock, sha256 } from "./r-dependency-lock.mjs";

const workflowPath = (name) => posix.join(".github", "workflows", name);
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const pythonProjectMetadata = readFileSync("python/pyproject.toml", "utf8");
const CAPABILITY_FILE_LIMIT = 128 * 1024;
const WORKFLOW_YAML_NODE_LIMIT = 20_000;
const WORKFLOW_YAML_DEPTH_LIMIT = 64;
const WORKFLOW_YAML_ALIAS_LIMIT = 0;
const WORKFLOW_YAML_MERGE_KEY_LIMIT = 0;
const REQUIRED_CHECK_EXPRESSION_LIMIT = 64;
const REQUIRED_CHECK_MATCH_WORK_LIMIT = 16 * 1024;
const REQUIRED_CHECK_EXPRESSION_PATTERN = /\$\{\{[^{}]{1,1024}\}\}/gu;
const WORKFLOW_YAML_SCHEMA = CORE_SCHEMA.withTags(mergeTag);
const WORKFLOW_YAML_LOAD_OPTIONS = Object.freeze({
  maxAliases: WORKFLOW_YAML_ALIAS_LIMIT,
  maxDepth: WORKFLOW_YAML_DEPTH_LIMIT,
  maxTotalMergeKeys: WORKFLOW_YAML_MERGE_KEY_LIMIT,
  schema: WORKFLOW_YAML_SCHEMA
});
const WORKFLOW_INVENTORY_LIMIT = 128;
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CAPABILITY_GRAPH_PATH = "scripts/fixtures/ci-capabilities.json";
const WORKFLOW_DIRECTORY = ".github/workflows";
const CAPABILITY_WORKFLOW_FILES = Object.freeze({
  pull_request: ".github/workflows/ci.yml",
  codeql: ".github/workflows/codeql.yml",
  candidate: ".github/workflows/candidate-acceptance.yml",
  release: ".github/workflows/release-candidate.yml"
});
const CAPABILITY_WORKFLOW_EVENTS = Object.freeze({
  pull_request: "pull_request",
  codeql: "pull_request",
  candidate: "workflow_call",
  release: "workflow_dispatch"
});
const CAPABILITY_WORKFLOW_TERMINALS = Object.freeze({
  pull_request: "validate",
  codeql: "codeql-gate",
  candidate: "acceptance",
  release: "qualify"
});
const CAPABILITY_FILES = new Set([CAPABILITY_GRAPH_PATH, ...Object.values(CAPABILITY_WORKFLOW_FILES)]);

function fileIdentity(status) {
  return Object.freeze({
    ctimeNs: status.ctimeNs,
    dev: status.dev,
    gid: status.gid,
    ino: status.ino,
    mode: status.mode,
    mtimeNs: status.mtimeNs,
    nlink: status.nlink,
    size: status.size,
    uid: status.uid
  });
}

function sameFileIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function closeDescriptor(descriptor, primaryError) {
  try {
    closeSync(descriptor);
  } catch (error) {
    return primaryError ?? error;
  }
  return primaryError;
}

function canonicalContainedPath(root, relativePath, allowedPaths) {
  assert.equal(typeof relativePath, "string", "bounded repository paths must be strings");
  assert.doesNotMatch(relativePath, /[\\\0]/u, `${relativePath} must use a canonical repository-relative path`);
  assert.equal(posix.normalize(relativePath), relativePath, `${relativePath} must be normalized`);
  assert.equal(
    relativePath.startsWith("../") || relativePath.startsWith("/"),
    false,
    `${relativePath} escapes the root`
  );
  if (allowedPaths !== undefined) {
    assert.equal(allowedPaths.has(relativePath), true, `${relativePath} is not an allowlisted repository file`);
  }
  const canonicalRoot = realpathSync.native(resolve(root));
  assert.equal(canonicalRoot, resolve(root), "the repository root must be one canonical directory");
  const absolutePath = resolve(canonicalRoot, ...relativePath.split("/"));
  const containedPath = relative(canonicalRoot, absolutePath);
  assert.equal(isAbsolute(containedPath), false, `${relativePath} must stay below the repository root`);
  assert.doesNotMatch(containedPath, /^(?:\.\.(?:[/\\]|$))/u, `${relativePath} escapes the repository root`);
  return { absolutePath, canonicalRoot };
}

function openDirectoryChain(root, components, hooks = {}) {
  const receipts = [];
  let currentPath = root;
  try {
    for (const component of [undefined, ...components]) {
      if (component !== undefined) currentPath = resolve(currentPath, component);
      let descriptor;
      try {
        descriptor = openSync(
          currentPath,
          constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
        );
        const opened = fstatSync(descriptor, { bigint: true });
        assert.equal(opened.isDirectory(), true, `${currentPath} must open as a directory`);
        hooks.afterDirectoryDescriptorOpen?.({ descriptor, path: currentPath });
        const pathStatus = lstatSync(currentPath, { bigint: true });
        assert.equal(pathStatus.isDirectory(), true, `${currentPath} must remain a directory`);
        assert.equal(pathStatus.isSymbolicLink(), false, `${currentPath} must not be a symbolic link`);
        assert.equal(
          sameFileIdentity(fileIdentity(pathStatus), fileIdentity(opened)),
          true,
          `${currentPath} directory identity changed before use`
        );
        receipts.push({ descriptor, identity: fileIdentity(opened), path: currentPath });
        descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) throw closeDescriptor(descriptor, error);
        throw error;
      }
    }
    return receipts;
  } catch (error) {
    throw closeDirectoryChain(receipts, error);
  }
}

function revalidateDirectoryChain(receipts) {
  for (const receipt of receipts) {
    const descriptorStatus = fstatSync(receipt.descriptor, { bigint: true });
    const pathStatus = lstatSync(receipt.path, { bigint: true });
    assert.equal(descriptorStatus.isDirectory(), true, `${receipt.path} descriptor must remain a directory`);
    assert.equal(pathStatus.isDirectory(), true, `${receipt.path} path must remain a directory`);
    assert.equal(pathStatus.isSymbolicLink(), false, `${receipt.path} path must not become a symbolic link`);
    assert.equal(
      sameFileIdentity(fileIdentity(descriptorStatus), receipt.identity) &&
        sameFileIdentity(fileIdentity(pathStatus), receipt.identity),
      true,
      `${receipt.path} directory identity changed while reading`
    );
  }
}

function closeDirectoryChain(receipts, primaryError) {
  let failure = primaryError;
  for (const receipt of [...receipts].reverse()) failure = closeDescriptor(receipt.descriptor, failure);
  return failure;
}

function readBoundedNoFollowFile(relativePath, { allowedPaths, hooks = {}, root = REPOSITORY_ROOT } = {}) {
  const { absolutePath, canonicalRoot } = canonicalContainedPath(root, relativePath, allowedPaths);
  const components = relativePath.split("/");
  const directories = openDirectoryChain(canonicalRoot, components.slice(0, -1), hooks);
  let descriptor;
  let failure;
  let result;
  try {
    hooks.afterDirectoryOpen?.({ directories, relativePath });
    descriptor = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    assert.equal(opened.isFile(), true, `${relativePath} must open as a regular file`);
    assert.equal(opened.nlink, 1n, `${relativePath} must not have hard-linked aliases`);
    assert.ok(opened.size <= BigInt(CAPABILITY_FILE_LIMIT), `${relativePath} exceeds the capability file limit`);
    hooks.afterFileDescriptorOpen?.({ descriptor, relativePath });
    const pathOpened = lstatSync(absolutePath, { bigint: true });
    assert.equal(pathOpened.isFile(), true, `${relativePath} path must remain a regular file`);
    assert.equal(pathOpened.isSymbolicLink(), false, `${relativePath} path must not be a symbolic link`);
    assert.equal(pathOpened.nlink, 1n, `${relativePath} path must not have hard-linked aliases`);
    assert.ok(pathOpened.size <= BigInt(CAPABILITY_FILE_LIMIT), `${relativePath} exceeds the capability file limit`);
    assert.equal(
      sameFileIdentity(fileIdentity(opened), fileIdentity(pathOpened)),
      true,
      `${relativePath} path identity changed before use`
    );
    revalidateDirectoryChain(directories);
    hooks.afterFileOpen?.({ descriptor, relativePath });

    const chunks = [];
    let total = 0;
    while (true) {
      const remaining = CAPABILITY_FILE_LIMIT + 1 - total;
      if (remaining <= 0) throw new Error(`${relativePath} exceeds the capability file limit`);
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, remaining));
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
      hooks.afterChunk?.({ descriptor, relativePath, total });
    }
    assert.ok(total <= CAPABILITY_FILE_LIMIT, `${relativePath} exceeds the capability file limit`);
    hooks.afterRead?.({ descriptor, relativePath });

    const bytes = Buffer.concat(chunks, total);
    const verification = Buffer.allocUnsafe(total);
    let verificationOffset = 0;
    while (verificationOffset < total) {
      const read = readSync(
        descriptor,
        verification,
        verificationOffset,
        total - verificationOffset,
        verificationOffset
      );
      if (read === 0) throw new Error(`${relativePath} changed while its bytes were revalidated`);
      verificationOffset += read;
    }
    assert.equal(bytes.equals(verification), true, `${relativePath} content changed while reading`);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(absolutePath, { bigint: true });
    assert.equal(
      sameFileIdentity(fileIdentity(after), fileIdentity(opened)),
      true,
      `${relativePath} changed while reading`
    );
    assert.equal(pathAfter.isFile() && !pathAfter.isSymbolicLink() && pathAfter.nlink === 1n, true);
    assert.equal(
      sameFileIdentity(fileIdentity(pathAfter), fileIdentity(after)),
      true,
      `${relativePath} path identity changed while reading`
    );
    assert.equal(BigInt(total), after.size, `${relativePath} returned incomplete bytes`);
    revalidateDirectoryChain(directories);
    result = Object.freeze({ bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) failure = closeDescriptor(descriptor, failure);
    failure = closeDirectoryChain(directories, failure);
  }
  if (failure !== undefined) throw failure;
  return result;
}

function readDirectoryInventory(directoryPath) {
  const directory = opendirSync(directoryPath);
  const entries = [];
  let failure;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      assert.ok(entries.length < WORKFLOW_INVENTORY_LIMIT, "workflow inventory exceeds its file-count limit");
      assert.ok(Buffer.byteLength(entry.name, "utf8") <= 255, "workflow inventory contains an oversized name");
      entries.push(entry.name);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      directory.closeSync();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  return entries.filter((name) => /\.ya?ml$/u.test(name)).sort();
}

function parseBoundedWorkflowYaml(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  assert.equal(typeof source, "string", "workflow YAML must be text");
  assert.ok(Buffer.byteLength(source, "utf8") <= CAPABILITY_FILE_LIMIT, "workflow YAML exceeds its byte limit");
  const stack = [];
  let depth = 0;
  let nodes = 0;
  for (const event of parseYamlEvents(source, { maxDepth: WORKFLOW_YAML_DEPTH_LIMIT })) {
    assert.notEqual(event.type, EVENT_ALIAS, "workflow YAML aliases are forbidden");
    assert.equal(event.anchorStart ?? -1, -1, "workflow YAML anchors are forbidden");
    assert.equal(event.tagStart ?? -1, -1, "workflow YAML explicit tags are forbidden");
    if ([EVENT_DOCUMENT, EVENT_MAPPING, EVENT_SEQUENCE].includes(event.type)) {
      stack.push(event.type);
      if (event.type !== EVENT_DOCUMENT) {
        depth += 1;
        nodes += 1;
      }
    } else if (event.type === EVENT_SCALAR) {
      nodes += 1;
      const scalar = source.slice(event.valueStart, event.valueEnd);
      assert.equal(
        event.style === SCALAR_STYLE_PLAIN && scalar === "<<",
        false,
        "workflow YAML merge keys are forbidden"
      );
    } else if (event.type === EVENT_POP) {
      const opened = stack.pop();
      assert.notEqual(opened, undefined, "workflow YAML structure is unbalanced");
      if (opened !== EVENT_DOCUMENT) depth -= 1;
    }
    assert.ok(depth <= WORKFLOW_YAML_DEPTH_LIMIT, "workflow YAML exceeds its depth limit");
    assert.ok(nodes <= WORKFLOW_YAML_NODE_LIMIT, "workflow YAML exceeds its node limit");
  }
  assert.deepEqual(stack, [], "workflow YAML structure is incomplete");
  return parseYaml(source, WORKFLOW_YAML_LOAD_OPTIONS);
}

function loadRepositoryWorkflowInventory({ hooks = {}, root = REPOSITORY_ROOT } = {}) {
  const { absolutePath: directoryPath, canonicalRoot } = canonicalContainedPath(root, WORKFLOW_DIRECTORY);
  const directories = openDirectoryChain(canonicalRoot, WORKFLOW_DIRECTORY.split("/"));
  let failure;
  let result;
  try {
    const firstNames = readDirectoryInventory(directoryPath);
    hooks.afterFirstInventory?.({ directoryPath, firstNames });
    const secondNames = readDirectoryInventory(directoryPath);
    assert.deepEqual(secondNames, firstNames, "workflow inventory changed while it was enumerated");
    revalidateDirectoryChain(directories);
    const paths = firstNames.map((name) => workflowPath(name));
    const allowedPaths = new Set(paths);
    const snapshots = Object.fromEntries(
      paths.map((path) => {
        const snapshot = readBoundedNoFollowFile(path, { allowedPaths, hooks: hooks.file, root: canonicalRoot });
        return [path, Object.freeze({ ...snapshot, document: parseBoundedWorkflowYaml(snapshot.bytes) })];
      })
    );
    hooks.afterFiles?.({ directoryPath, paths, snapshots });
    assert.deepEqual(readDirectoryInventory(directoryPath), firstNames, "workflow inventory changed after reading");
    revalidateDirectoryChain(directories);
    result = Object.freeze(snapshots);
  } catch (error) {
    failure = error;
  } finally {
    failure = closeDirectoryChain(directories, failure);
  }
  if (failure !== undefined) throw failure;
  return result;
}

function readBoundedCapabilityFile(relativePath, options = {}) {
  assert.equal(CAPABILITY_FILES.has(relativePath), true, `${relativePath} is not an allowlisted capability file`);
  return readBoundedNoFollowFile(relativePath, { ...options, allowedPaths: CAPABILITY_FILES }).bytes.toString("utf8");
}

function loadCapabilityDocuments(graph, workflowInventory = repositoryWorkflowInventory) {
  assert.deepEqual(Object.keys(graph.workflows).sort(), Object.keys(CAPABILITY_WORKFLOW_FILES).sort());
  return Object.fromEntries(
    Object.entries(CAPABILITY_WORKFLOW_FILES).map(([id, file]) => {
      assert.equal(graph.workflows[id]?.file, file, `${id} must use its fixed workflow file`);
      const document = workflowInventory[file]?.document;
      assert.ok(document, `${file} must exist in the bounded workflow inventory`);
      return [id, document];
    })
  );
}

const capabilityGraph = JSON.parse(readBoundedCapabilityFile(CAPABILITY_GRAPH_PATH));
const repositoryWorkflowInventory = loadRepositoryWorkflowInventory();
const repositoryWorkflowNames = Object.keys(repositoryWorkflowInventory)
  .map((path) => posix.basename(path))
  .sort();
const workflow = (name) => {
  const snapshot = repositoryWorkflowInventory[workflowPath(name)];
  assert.ok(snapshot, `${name} is absent from the bounded workflow inventory`);
  return snapshot.document;
};
const capabilityDocuments = loadCapabilityDocuments(capabilityGraph);
const ci = capabilityDocuments.pull_request;
const cross = workflow("cross-platform.yml");
const codeql = capabilityDocuments.codeql;
const performance = workflow("performance.yml");
const releasedJupyter = workflow("released-jupyter.yml");

const CHECKOUT = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const SETUP_PYTHON = "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97";
const SETUP_JAVA = "actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961";
const CODEQL = "github/codeql-action";
const CODEQL_SHA = "ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd";
const SETUP_R = "r-lib/actions/setup-r@d3c5be51b12e724e68f33216ca3c148b66d5f0b6";
const CACHE_RESTORE = "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const CACHE_SAVE = "actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809";
const SUPERSEDED_DEPENDENCY_ACTIONS = new Map([
  [SETUP_PYTHON, "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1"],
  [SETUP_JAVA, "actions/setup-java@f2beeb24e141e01a676f977032f5a29d81c9e27e"],
  [CACHE_RESTORE, "actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809"]
]);
const BOOLEAN_OUTPUTS = Object.freeze({
  rContractRequired: true,
  canonicalEditorRequired: true,
  visualAccessibilityRequired: true,
  windowsUniqueRequired: true
});
const SCRIPT_TEST_GROUPS = Object.freeze(["workflow", "portable", "media", "native"]);
const VALIDATE_CONDITION = "${{ always() && github.event_name == 'pull_request' }}";
const VALIDATE_NEEDS = Object.freeze([
  "classify",
  "invariant-core",
  "r-contract-kernel",
  "r-contract-protocol",
  "canonical-editor",
  "visual-accessibility",
  "windows-unique"
]);
const CHANGED_AREA_OWNER_OUTPUTS = Object.freeze({
  "r-contract-kernel": "r_contract_required",
  "r-contract-protocol": "r_contract_required",
  "canonical-editor": "canonical_editor_required",
  "visual-accessibility": "visual_accessibility_required",
  "windows-unique": "windows_unique_required"
});
const VALIDATE_ENV = Object.freeze({
  R_CONTRACT_REQUIRED: "${{ needs.classify.outputs.r_contract_required }}",
  CANONICAL_EDITOR_REQUIRED: "${{ needs.classify.outputs.canonical_editor_required }}",
  VISUAL_ACCESSIBILITY_REQUIRED: "${{ needs.classify.outputs.visual_accessibility_required }}",
  WINDOWS_UNIQUE_REQUIRED: "${{ needs.classify.outputs.windows_unique_required }}",
  CLASSIFY_RESULT: "${{ needs.classify.result }}",
  INVARIANT_CORE_RESULT: "${{ needs.invariant-core.result }}",
  R_CONTRACT_KERNEL_RESULT: "${{ needs.r-contract-kernel.result }}",
  R_CONTRACT_PROTOCOL_RESULT: "${{ needs.r-contract-protocol.result }}",
  CANONICAL_EDITOR_RESULT: "${{ needs.canonical-editor.result }}",
  VISUAL_ACCESSIBILITY_RESULT: "${{ needs.visual-accessibility.result }}",
  WINDOWS_UNIQUE_RESULT: "${{ needs.windows-unique.result }}"
});
const REPLACEABLE_PULL_REQUEST_WORKFLOWS = Object.freeze([
  ["ci.yml", "ci-${{ github.event_name }}-${{ github.ref }}"],
  ["codeql.yml", "codeql-${{ github.event_name }}-${{ github.ref }}"]
]);
const CAPABILITY_NAMES = Object.freeze([
  "source_coverage",
  "installed_candidate",
  "artifact_provenance",
  "release_fan_in"
]);
const PULL_REQUEST_ACTIVITY_TYPES = Object.freeze(["opened", "synchronize", "reopened", "edited", "stacked"]);
const CAPABILITY_DOCS_START = "<!-- BEGIN GENERATED CI CAPABILITIES -->";
const CAPABILITY_DOCS_END = "<!-- END GENERATED CI CAPABILITIES -->";
const APPROVED_EXTERNAL_ACTIONS = new Set([
  "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  "actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809",
  "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961",
  "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
  "github/codeql-action/analyze@ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd",
  "github/codeql-action/init@ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd",
  "r-lib/actions/setup-r-dependencies@d3c5be51b12e724e68f33216ca3c148b66d5f0b6",
  "r-lib/actions/setup-r@d3c5be51b12e724e68f33216ca3c148b66d5f0b6"
]);
const APPROVED_LOCAL_WORKFLOW_USES = Object.freeze([
  Object.freeze([
    "release-candidate.yml",
    "$.jobs.candidate-acceptance.uses",
    "./.github/workflows/candidate-acceptance.yml"
  ])
]);
const WORKFLOW_USE_INVENTORY_SHA256 = "4dad193f568dbbe53ecaf6c0d3f0ee1a85dc80a6ff0f07d13b1790f56115411a";
const REVIEWED_DEPENDENCY_ACTION_CALLSITES = Object.freeze([
  ["candidate-acceptance.yml", "$.jobs.jupyter.steps[2].uses", SETUP_PYTHON],
  ["candidate-acceptance.yml", "$.jobs.jupyter.steps[3].uses", SETUP_JAVA],
  ["candidate-acceptance.yml", "$.jobs.linux.steps[2].uses", SETUP_PYTHON],
  ["candidate-acceptance.yml", "$.jobs.performance.steps[2].uses", SETUP_PYTHON],
  ["candidate-acceptance.yml", "$.jobs.platform.steps[2].uses", SETUP_PYTHON],
  ["candidate-acceptance.yml", "$.jobs.r_local.steps[2].uses", SETUP_PYTHON],
  ["candidate-acceptance.yml", "$.jobs.r_platform.steps[2].uses", SETUP_PYTHON],
  ["ci.yml", "$.jobs.canonical-editor.steps[2].uses", SETUP_PYTHON],
  ["ci.yml", "$.jobs.invariant-core.steps[2].uses", SETUP_PYTHON],
  ["ci.yml", "$.jobs.r-contract-kernel.steps[6].uses", CACHE_RESTORE],
  ["ci.yml", "$.jobs.r-contract-protocol.steps[6].uses", CACHE_RESTORE],
  ["ci.yml", "$.jobs.visual-accessibility.steps[2].uses", SETUP_PYTHON],
  ["ci.yml", "$.jobs.windows-unique.steps[2].uses", SETUP_PYTHON],
  ["cross-platform.yml", "$.jobs.dependency-guard-windows.steps[1].uses", SETUP_PYTHON],
  ["cross-platform.yml", "$.jobs.r-4-4-scheduled-qualification.steps[6].uses", CACHE_RESTORE],
  ["cross-platform.yml", "$.jobs.runtime.steps[2].uses", SETUP_PYTHON],
  ["daily-preview.yml", "$.jobs.build.steps[4].uses", SETUP_PYTHON],
  ["daily-preview.yml", "$.jobs.representative-editor.steps[2].uses", SETUP_PYTHON],
  ["performance.yml", "$.jobs.polars-runtime.steps[1].uses", SETUP_PYTHON],
  ["performance.yml", "$.jobs.pyspark-profile.steps[1].uses", SETUP_PYTHON],
  ["performance.yml", "$.jobs.pyspark-profile.steps[2].uses", SETUP_JAVA],
  ["release-candidate.yml", "$.jobs.package.steps[3].uses", SETUP_PYTHON],
  ["released-jupyter.yml", "$.jobs.macos-r.steps[2].uses", SETUP_PYTHON],
  ["released-jupyter.yml", "$.jobs.vscode.steps[2].uses", SETUP_PYTHON],
  ["released-jupyter.yml", "$.jobs.vscode.steps[3].uses", SETUP_JAVA],
  ["released-jupyter.yml", "$.jobs.windows-r.steps[2].uses", SETUP_PYTHON]
]);

function stepsUsing(job, prefix) {
  return (job?.steps ?? []).filter((step) => typeof step?.uses === "string" && step.uses.startsWith(prefix));
}

function stepRunning(job, command) {
  return (job?.steps ?? []).find((step) => step?.run === command);
}

function assertVisualAccessibilityBrowserOwnership(document, manifest = packageJson, lock = packageLock) {
  const job = document.jobs["visual-accessibility"];
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 20);

  const orderedCommands = [
    "npm ci --ignore-scripts",
    'python -m pip install -e "python[dev]"',
    "npx --no-install playwright-core install chromium",
    "env -u CHROME_BIN npm run test:webview-acceptance"
  ];
  const commandIndexes = orderedCommands.map((command) => job.steps.findIndex((step) => step?.run === command));
  assert.ok(commandIndexes.every((index) => index >= 0));
  assert.deepEqual(
    commandIndexes,
    [...commandIndexes].sort((left, right) => left - right)
  );
  const browserInstall = stepRunning(job, "npx --no-install playwright-core install chromium");
  const acceptance = stepRunning(job, "env -u CHROME_BIN npm run test:webview-acceptance");
  assert.equal(job.steps.filter((step) => step?.run === "npx --no-install playwright-core install chromium").length, 1);
  assert.equal(manifest.scripts?.["test:webview-acceptance"], "npm run test:webview-acceptance:run");
  const acceptanceOwners = new Set(["test:webview-acceptance", "test:webview-acceptance:run"]);
  const acceptanceSteps = job.steps.filter(
    (step) =>
      typeof step?.run === "string" &&
      [...referencedPackageScripts(step.run, manifest.scripts)].some((name) => acceptanceOwners.has(name))
  );
  assert.equal(acceptanceSteps.length, 1);
  assert.equal(acceptanceSteps[0], acceptance);
  assert.equal(browserInstall.if, undefined);
  assert.equal(browserInstall["continue-on-error"], undefined);
  assert.equal(acceptance.if, undefined);
  assert.equal(acceptance["continue-on-error"], undefined);
  assert.equal(acceptance.env, undefined);
  assert.equal(document.env?.CHROME_BIN, undefined);
  assert.equal(job.env?.CHROME_BIN, undefined);
  for (const step of job.steps) {
    if (step !== acceptance) assert.equal(step?.env?.CHROME_BIN, undefined);
  }

  const runSource = job.steps
    .filter((step) => typeof step?.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.doesNotMatch(runSource, /--with-deps|\binstall-deps\b/u);
  assert.doesNotMatch(runSource, /(?:^|[\s;&|])(?:sudo|apt|apt-get)(?:[\s;&|]|$)/u);
  assert.doesNotMatch(runSource, /\/usr\/bin\/(?:chromium|chromium-browser|google-chrome)/u);
  const otherRunSource = job.steps
    .filter((step) => step !== acceptance && typeof step?.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.doesNotMatch(otherRunSource, /CHROME_BIN|PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/u);
  assert.doesNotMatch(JSON.stringify(document.env ?? {}), /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/u);
  assert.doesNotMatch(JSON.stringify(job.env ?? {}), /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/u);
  assert.doesNotMatch(JSON.stringify(job.steps.map((step) => step?.env)), /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/u);

  const declared = manifest.devDependencies?.["playwright-core"];
  const lockedDeclaration = lock.packages?.[""]?.devDependencies?.["playwright-core"];
  const lockedPackage = lock.packages?.["node_modules/playwright-core"];
  assert.equal(typeof declared, "string");
  assert.equal(lockedDeclaration, declared);
  assert.equal(lockedPackage?.dev, true);
  assert.match(lockedPackage?.version ?? "", /^\d+\.\d+\.\d+$/u);
  assert.equal(
    lockedPackage?.resolved,
    `https://registry.npmjs.org/playwright-core/-/playwright-core-${lockedPackage.version}.tgz`
  );
  assert.match(lockedPackage?.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/u);

  const uploads = job.steps.filter(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact@")
  );
  assert.equal(uploads.length, 1);
  const upload = uploads[0];
  assert.ok(job.steps.indexOf(upload) > commandIndexes.at(-1));
  assert.equal(job.steps.indexOf(upload), job.steps.length - 1);
  assert.equal(upload.if, "${{ failure() && !cancelled() }}");
  assert.deepEqual(upload.with, {
    name: "webview-visual-evidence",
    path: "tmp/screenshots-actual/\ntmp/screenshots-diff/\n",
    "if-no-files-found": "ignore",
    "retention-days": 7,
    "include-hidden-files": false
  });
}

function referencedPackageScripts(command, scripts) {
  const references = new Set();
  for (const match of command.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/gu)) {
    if (Object.hasOwn(scripts, match[1])) references.add(match[1]);
  }
  for (const match of command.matchAll(/\bnpm-run-all\b([^;&|]*)/gu)) {
    for (const token of match[1].trim().split(/\s+/u)) {
      const name = token.replace(/^["']|["']$/gu, "");
      if (Object.hasOwn(scripts, name)) references.add(name);
    }
  }
  return references;
}

function packageScriptClosure(root, scripts) {
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    assert.equal(typeof scripts[name], "string", `missing package script ${name}`);
    visited.add(name);
    for (const reference of referencedPackageScripts(scripts[name], scripts)) visit(reference);
  };
  visit(root);
  return visited;
}

function allWorkflowUses(value, path = "$", results = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => allWorkflowUses(entry, `${path}[${index}]`, results));
    return results;
  }
  if (value === null || typeof value !== "object") return results;
  for (const [key, entry] of Object.entries(value)) {
    const next = `${path}.${key}`;
    if (key === "uses") results.push([next, entry]);
    allWorkflowUses(entry, next, results);
  }
  return results;
}

function allExternalUses(value) {
  return allWorkflowUses(value).filter(([, uses]) => typeof uses === "string" && !uses.startsWith("./"));
}

function workflowUseRows(entries) {
  return entries
    .flatMap(([name, document]) => allWorkflowUses(document).map(([path, uses]) => [name, path, uses]))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function reviewedDependencyActionRows(rows) {
  return rows.filter(([, , uses]) =>
    ["actions/setup-python@", "actions/setup-java@", "actions/cache/restore@"].some(
      (prefix) => typeof uses === "string" && uses.startsWith(prefix)
    )
  );
}

function assertReviewedDependencyActionCallsites(rows) {
  assert.deepEqual(reviewedDependencyActionRows(rows), REVIEWED_DEPENDENCY_ACTION_CALLSITES);
}

function validateWorkflowUseRows(rows, { exactInventory = true } = {}) {
  const external = [];
  const local = [];
  for (const [name, path, uses] of rows) {
    if (typeof uses !== "string") throw new Error(`${name}:${path} uses must be a string.`);
    if (uses.startsWith("./")) {
      local.push([name, path, uses]);
      continue;
    }
    if (!/^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+(?:[/][A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/u.test(uses)) {
      throw new Error(`${name}:${path} has a malformed external action use: ${uses}.`);
    }
    if (!APPROVED_EXTERNAL_ACTIONS.has(uses)) {
      throw new Error(`${name}:${path} uses an unreviewed external action: ${uses}.`);
    }
    external.push([name, path, uses]);
  }
  if (!exactInventory) return Object.freeze({ external, local });
  assert.equal(external.length, 146);
  assert.deepEqual(local, APPROVED_LOCAL_WORKFLOW_USES);
  const inventoryBytes = `${rows.map((row) => row.join("\0")).join("\n")}\n`;
  assert.equal(createHash("sha256").update(inventoryBytes).digest("hex"), WORKFLOW_USE_INVENTORY_SHA256);
  return Object.freeze({ external, local });
}

function normalizedCommand(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : undefined;
}

function exactTomlSection(source, name) {
  const heading = `[${name}]`;
  const start = source.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `${heading} must exist`);
  assert.equal(source.indexOf(`${heading}\n`, start + heading.length), -1, `${heading} must be unique`);
  const contentsStart = start + heading.length + 1;
  const next = source.indexOf("\n[", contentsStart);
  return source.slice(contentsStart, next === -1 ? source.length : next + 1);
}

function nodeTestFiles(command, group) {
  const segments = normalizedCommand(command)?.split(" && ") ?? [];
  const parts = segments[0]?.split(" ") ?? [];
  assert.deepEqual(segments.slice(1), group === "portable" ? ["npm run test:scripts:media"] : []);
  const prefix =
    group === "portable"
      ? ["node", "--test", "--test-concurrency=4"]
      : group === "media"
        ? ["node", "--max-old-space-size=1024", "--test", "--test-concurrency=1"]
        : ["node", "--test"];
  assert.deepEqual(parts.slice(0, prefix.length), prefix, `${group} must invoke Node's test runner directly.`);
  const files = parts.slice(prefix.length);
  assert.ok(files.length > 0, `${group} must own at least one script contract.`);
  assert.equal(new Set(files).size, files.length, `${group} must not list a script contract twice.`);
  for (const file of files) assert.match(file, /^scripts\/[a-z0-9.-]+\.test\.mjs$/u);
  return files;
}

function assertStandaloneReleasedJupyterRTriples(document) {
  const steps = document?.jobs?.vscode?.steps;
  assert.ok(Array.isArray(steps));
  for (const [verifierId, verifierName, runnerId, uploadName] of [
    [
      "canonical_r_jupyter",
      "Reverify the VSIX for core R operations",
      "packaged_editor_r",
      "Upload packaged-editor R failure diagnostics"
    ],
    [
      "canonical_r_values",
      "Reverify the VSIX for value R operations",
      "packaged_editor_r_values",
      "Upload value R-Jupyter failure diagnostics"
    ],
    [
      "canonical_r_categorical",
      "Reverify the VSIX for categorical R operations",
      "packaged_editor_r_categorical",
      "Upload categorical R-Jupyter failure diagnostics"
    ],
    [
      "canonical_r_interactive",
      "Reverify the VSIX for the active R terminal",
      "packaged_editor_r_interactive",
      "Upload active R terminal failure diagnostics"
    ]
  ]) {
    const verifierIndices = steps.flatMap((step, index) => (step?.id === verifierId ? [index] : []));
    const runnerIndices = steps.flatMap((step, index) => (step?.id === runnerId ? [index] : []));
    const uploadIndices = steps.flatMap((step, index) => (step?.name === uploadName ? [index] : []));
    assert.equal(verifierIndices.length, 1, `Expected exactly one ${verifierId} verifier.`);
    assert.equal(runnerIndices.length, 1, `Expected exactly one ${runnerId} runner.`);
    assert.equal(uploadIndices.length, 1, `Expected exactly one ${uploadName} upload.`);
    assert.deepEqual(steps[verifierIndices[0]], {
      id: verifierId,
      name: verifierName,
      run: "npm run verify:vsix -- openwrangler.vsix"
    });
    assert.equal(runnerIndices[0], verifierIndices[0] + 1, `${runnerId} must immediately follow ${verifierId}.`);
    assert.equal(uploadIndices[0], runnerIndices[0] + 1, `${uploadName} must immediately follow ${runnerId}.`);
  }
}

function expectedResults(selections = BOOLEAN_OUTPUTS) {
  const results = Object.fromEntries(ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]));
  for (const [selection, jobIds] of Object.entries(CONDITIONAL_CI_JOBS)) {
    for (const jobId of jobIds) results[jobId] = selections[selection] ? "success" : "skipped";
  }
  return results;
}

function assertValidateOwner(document) {
  const validate = document?.jobs?.validate;
  assert.equal(validate?.name, "validate");
  assert.equal(validate?.if, VALIDATE_CONDITION);
  assert.deepEqual(validate?.needs, VALIDATE_NEEDS);
  const gate = stepRunning(validate, "node scripts/require-ci-results.mjs");
  assert.ok(gate, "validate must invoke the sole result owner");
  assert.deepEqual(gate.env, VALIDATE_ENV);
}

function normalizeWorkflowExpression(value) {
  return typeof value === "string" ? value.replaceAll(/\s+/gu, " ").trim() : value;
}

function jobNeeds(job) {
  if (job?.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function dependencyClosure(document, terminalJob) {
  const visited = new Set();
  const active = new Set();
  const visit = (jobId) => {
    if (visited.has(jobId)) return;
    assert.equal(active.has(jobId), false, `capability dependency cycle includes ${jobId}`);
    const job = document?.jobs?.[jobId];
    assert.ok(job, `missing capability job ${jobId}`);
    active.add(jobId);
    for (const dependency of jobNeeds(job)) visit(dependency);
    active.delete(jobId);
    visited.add(jobId);
  };
  visit(terminalJob);
  return visited;
}

function strategyMultiplicityIsUnevaluable(job) {
  if (!Object.hasOwn(job ?? {}, "strategy")) return false;
  const strategy = job.strategy;
  if (strategy === null || Array.isArray(strategy) || typeof strategy !== "object") return true;
  const entries = Object.entries(strategy);
  if (entries.length === 0 || Object.hasOwn(strategy, "matrix")) return true;
  return entries.some(([key, value]) => {
    if (key === "fail-fast") return typeof value !== "boolean";
    if (key === "max-parallel") return !Number.isSafeInteger(value) || value <= 0;
    return true;
  });
}

function fixedCheckNamePartsMayEqual(required, parts, fixedTextLength) {
  if (
    typeof required !== "string" ||
    required.length + fixedTextLength + parts.length > REQUIRED_CHECK_MATCH_WORK_LIMIT
  ) {
    return true;
  }
  const first = parts[0];
  const last = parts.at(-1);
  if (!required.startsWith(first) || !required.endsWith(last)) return false;
  let cursor = first.length;
  const suffixStart = required.length - last.length;
  if (cursor > suffixStart) return false;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = required.indexOf(part, cursor);
    if (next === -1 || next + part.length > suffixStart) return false;
    cursor = next + part.length;
  }
  return cursor <= suffixStart;
}

function parseDynamicCheckNameParts(name, suppliedMatches) {
  if (name.length > REQUIRED_CHECK_MATCH_WORK_LIMIT) return undefined;
  const parts = [];
  let cursor = 0;
  let expressionCount = 0;
  let fixedTextLength = 0;
  let work = 0;
  const matches = suppliedMatches ?? name.matchAll(REQUIRED_CHECK_EXPRESSION_PATTERN);
  for (const match of matches) {
    expressionCount += 1;
    if (expressionCount > REQUIRED_CHECK_EXPRESSION_LIMIT) return undefined;
    const text = match?.[0];
    const index = match?.index;
    if (
      typeof text !== "string" ||
      text.length === 0 ||
      !Number.isSafeInteger(index) ||
      index < cursor ||
      index + text.length > name.length
    ) {
      return undefined;
    }
    const literalLength = index - cursor;
    const nextWork = work + literalLength + text.length;
    if (nextWork > REQUIRED_CHECK_MATCH_WORK_LIMIT) return undefined;
    parts.push(name.slice(cursor, index));
    fixedTextLength += literalLength;
    work = nextWork;
    cursor = index + text.length;
  }
  const trailingLength = name.length - cursor;
  if (expressionCount === 0 || work + trailingLength > REQUIRED_CHECK_MATCH_WORK_LIMIT) return undefined;
  parts.push(name.slice(cursor));
  fixedTextLength += trailingLength;
  if (parts.some((part) => part.includes("${{") || part.includes("}}"))) return undefined;
  return Object.freeze({ fixedTextLength, parts: Object.freeze(parts) });
}

function requiredCheckName(jobId, job) {
  const multiplicityIsUnevaluable = strategyMultiplicityIsUnevaluable(job);
  const name = job?.name;
  if (name === undefined) {
    return Object.freeze({
      exact: multiplicityIsUnevaluable ? undefined : jobId,
      mayEqual: (required) => required === jobId
    });
  }
  assert.equal(typeof name, "string", `${jobId} check name must be text when present`);
  assert.notEqual(name, "", `${jobId} check name must not be empty`);
  if (!name.includes("${{")) {
    return Object.freeze({
      exact: multiplicityIsUnevaluable ? undefined : name,
      mayEqual: (required) => required === name
    });
  }
  const parsed = parseDynamicCheckNameParts(name);
  if (parsed === undefined) return Object.freeze({ exact: undefined, mayEqual: () => true });
  return Object.freeze({
    exact: undefined,
    mayEqual: (required) => fixedCheckNamePartsMayEqual(required, parsed.parts, parsed.fixedTextLength)
  });
}

function expectedCapabilityJobCondition(workflowId, jobId) {
  if (workflowId === "pull_request" && jobId === "validate") return normalizeWorkflowExpression(VALIDATE_CONDITION);
  if (workflowId === "pull_request" && Object.hasOwn(CHANGED_AREA_OWNER_OUTPUTS, jobId)) {
    const output = CHANGED_AREA_OWNER_OUTPUTS[jobId];
    return (
      "${{ !cancelled() && github.event_name == 'pull_request' && " +
      `(needs.classify.result != 'success' || needs.classify.outputs.${output} != 'false') }}`
    );
  }
  if ((workflowId === "candidate" && jobId === "acceptance") || (workflowId === "release" && jobId === "qualify")) {
    return "${{ always() }}";
  }
  return undefined;
}

function assertCapabilityJobFatal(job, owner) {
  assert.ok(job, `missing required capability job ${owner}`);
  assert.equal(
    job["continue-on-error"] === undefined || job["continue-on-error"] === false,
    true,
    `${owner} continue-on-error must be absent or literal false`
  );
}

function assertRequiredCapabilityJob(job, workflowId, jobId) {
  const owner = `${workflowId}:${jobId}`;
  assertCapabilityJobFatal(job, owner);
  assert.equal(
    normalizeWorkflowExpression(job.if),
    normalizeWorkflowExpression(expectedCapabilityJobCondition(workflowId, jobId)),
    `${owner} changed its qualification condition`
  );
}

function assertCapabilityGraph(graph, documents, workflowInventory = repositoryWorkflowInventory) {
  assert.equal(graph.version, 1);
  assert.deepEqual(Object.keys(graph.workflows).sort(), Object.keys(CAPABILITY_WORKFLOW_FILES).sort());
  assert.deepEqual(Object.keys(graph.capabilities), CAPABILITY_NAMES);
  for (const [workflowId, owner] of Object.entries(graph.workflows)) {
    const document = documents[workflowId];
    assert.ok(document, `missing parsed workflow ${workflowId}`);
    assert.equal(owner.file, CAPABILITY_WORKFLOW_FILES[workflowId], `${workflowId} changed its fixed workflow file`);
    assert.equal(owner.event, CAPABILITY_WORKFLOW_EVENTS[workflowId], `${workflowId} changed its exact event`);
    assert.equal(
      owner.terminalJob,
      CAPABILITY_WORKFLOW_TERMINALS[workflowId],
      `${workflowId} changed its terminal job`
    );
    assert.ok(Object.hasOwn(document.on ?? {}, owner.event), `${owner.file} must retain ${owner.event}`);
    assert.ok(document.jobs?.[owner.terminalJob], `${owner.file} must retain ${owner.terminalJob}`);
    if (workflowId === "pull_request" || workflowId === "codeql") {
      assert.deepEqual(owner.activityTypes, PULL_REQUEST_ACTIVITY_TYPES);
      assert.deepEqual(document.on[owner.event]?.types, owner.activityTypes);
    } else {
      assert.equal(owner.activityTypes, undefined, `${workflowId} must not declare pull-request activity types`);
    }
  }

  for (const [capabilityName, capability] of Object.entries(graph.capabilities)) {
    const entry = graph.workflows[capability.entryWorkflow];
    const providerOwner = graph.workflows[capability.providerWorkflow];
    const fanInOwner = graph.workflows[capability.fanInWorkflow];
    assert.ok(entry, `${capabilityName} has an unknown entry workflow`);
    assert.ok(providerOwner, `${capabilityName} has an unknown provider workflow`);
    assert.ok(fanInOwner, `${capabilityName} has an unknown fan-in workflow`);
    assert.equal(
      capability.entryWorkflow,
      capability.fanInWorkflow,
      `${capabilityName} entry workflow must own its final fan-in`
    );

    const providerDocument = documents[capability.providerWorkflow];
    const fanInDocument = documents[capability.fanInWorkflow];
    assert.equal(fanInOwner.terminalJob, capability.fanInJob, `${capabilityName} must reach the final fan-in`);
    assert.equal(Array.isArray(capability.requiredJobs), true, `${capabilityName} must declare its required jobs`);
    assert.equal(
      new Set(capability.requiredJobs).size,
      capability.requiredJobs.length,
      `${capabilityName} must not declare a required job twice`
    );
    assert.ok(capability.requiredJobs.includes(capability.providerJob));
    const providerClosure = dependencyClosure(providerDocument, capability.providerJob);
    assert.deepEqual(
      [...providerClosure].sort(),
      [...capability.requiredJobs].sort(),
      `${capabilityName} must declare the exact provider dependency closure`
    );
    for (const jobId of capability.requiredJobs) {
      assertRequiredCapabilityJob(providerDocument.jobs?.[jobId], capability.providerWorkflow, jobId);
      assert.equal(providerClosure.has(jobId), true, `${capabilityName} disconnects ${jobId} from its provider`);
    }
    assertRequiredCapabilityJob(
      fanInDocument.jobs?.[capability.fanInJob],
      capability.fanInWorkflow,
      capability.fanInJob
    );

    const fanInClosure = dependencyClosure(fanInDocument, capability.fanInJob);
    if (capability.providerWorkflow === capability.fanInWorkflow) {
      assert.equal(
        fanInClosure.has(capability.providerJob),
        true,
        `${capabilityName} provider must feed its final fan-in`
      );
    } else {
      const bridge = fanInDocument.jobs?.[capability.bridgeJob];
      assertRequiredCapabilityJob(bridge, capability.fanInWorkflow, capability.bridgeJob);
      assert.equal(bridge.uses, `./${providerOwner.file}`);
      assert.equal(providerOwner.terminalJob, capability.providerJob);
      assert.equal(fanInClosure.has(capability.bridgeJob), true, `${capabilityName} bridge must feed its final fan-in`);
    }
  }

  const release = graph.capabilities.release_fan_in;
  const requiredChecks = graph.capabilities.source_coverage.requiredChecks;
  assert.deepEqual(requiredChecks, ["validate", "CodeQL gate"]);
  assert.equal(new Set(requiredChecks).size, requiredChecks.length, "required check names must be unique");
  const completeDocuments = Object.fromEntries(
    Object.entries(workflowInventory).map(([path, snapshot]) => [path, snapshot.document ?? snapshot])
  );
  for (const [workflowId, document] of Object.entries(documents)) {
    completeDocuments[graph.workflows[workflowId].file] = document;
  }
  const declaredChecks = Object.entries(completeDocuments).flatMap(([path, document]) =>
    Object.entries(document.jobs ?? {}).map(([jobId, job]) => ({
      checkName: requiredCheckName(jobId, job),
      job,
      jobId,
      path
    }))
  );
  for (const checkName of requiredChecks) {
    const ambiguous = declaredChecks.filter(
      ({ checkName: candidate }) => candidate.exact === undefined && candidate.mayEqual(checkName)
    );
    assert.deepEqual(ambiguous, [], `${checkName} has an unevaluable possible check-name collision`);
    const owners = declaredChecks.filter(({ checkName: candidate }) => candidate.exact === checkName);
    assert.equal(owners.length, 1, `${checkName} must name exactly one declared job`);
    assertCapabilityJobFatal(owners[0].job, `${owners[0].path}:${owners[0].jobId}`);
  }
  assert.equal(requiredCheckName("validate", documents.pull_request.jobs.validate).exact, "validate");
  assert.ok(Object.hasOwn(documents.codeql.on ?? {}, "pull_request"));
  assert.equal(documents.codeql.jobs["codeql-gate"].name, "CodeQL gate");
  assert.deepEqual(release.requires, ["artifact_provenance", "installed_candidate"]);
  for (const requiredCapability of release.requires) {
    const required = graph.capabilities[requiredCapability];
    assert.equal(required.entryWorkflow, release.entryWorkflow);
    assert.equal(required.fanInWorkflow, release.fanInWorkflow);
    assert.equal(required.fanInJob, release.fanInJob);
  }
}

function renderCapabilityDocs(graph) {
  const heading = [
    CAPABILITY_DOCS_START,
    "",
    "### Enforced workflow capabilities",
    "",
    "This section is generated from `scripts/fixtures/ci-capabilities.json` and checked against the workflow graph.",
    "Job display names and YAML ordering are not part of the contract; job IDs, events, fatality, reachability, and final fan-in are.",
    ""
  ];
  const rows = CAPABILITY_NAMES.map((name) => {
    const capability = graph.capabilities[name];
    const entry = graph.workflows[capability.entryWorkflow];
    const provider = graph.workflows[capability.providerWorkflow];
    const fanIn = graph.workflows[capability.fanInWorkflow];
    const requiredChecks = capability.requiredChecks
      ? `; required checks ${capability.requiredChecks.map((check) => `\`${check}\``).join(", ")}`
      : "";
    return `- \`${name}\`: trigger \`${entry.event}\`; provider \`${provider.file}:${capability.providerJob}\`; mandatory final fan-in \`${fanIn.file}:${capability.fanInJob}\`${requiredChecks}.`;
  });
  return [...heading, ...rows, "", CAPABILITY_DOCS_END].join("\n");
}

function assertChangedAreaOwnersStartAfterClassification(document) {
  for (const [jobId, output] of Object.entries(CHANGED_AREA_OWNER_OUTPUTS)) {
    const job = document?.jobs?.[jobId];
    assert.deepEqual(job?.needs, ["classify"], `${jobId} must start after classification only`);
    assert.equal(
      normalizeWorkflowExpression(job?.if),
      "${{ !cancelled() && github.event_name == 'pull_request' && " +
        `(needs.classify.result != 'success' || needs.classify.outputs.${output} != 'false') }}`,
      `${jobId} must retain its exact PR-only fail-open selection condition`
    );
    assert.doesNotMatch(
      JSON.stringify(job),
      /needs\.invariant-core/u,
      `${jobId} must not wait for or inspect invariant-core before starting`
    );
  }
}

function assertPullRequestActivityContract(primaryDocument, codeqlDocument) {
  for (const [name, document] of [
    ["CI", primaryDocument],
    ["CodeQL", codeqlDocument]
  ]) {
    assert.deepEqual(document.on.pull_request.types, PULL_REQUEST_ACTIVITY_TYPES, `${name} activity types drifted`);
    assert.equal(document.on.pull_request.types.includes("edited"), true, `${name} must qualify base edits`);
    assert.equal(document.on.pull_request.types.includes("stacked"), true, `${name} must qualify stack joins`);
    assert.equal(
      document.on.pull_request.types.includes("ready_for_review"),
      false,
      `${name} readiness must remain SHA-idempotent`
    );
    assert.equal(
      document.on.pull_request.types.includes("converted_to_draft"),
      false,
      `${name} draft conversion must remain SHA-idempotent`
    );
  }
}

function assertCrossScheduledOwners(document) {
  assert.equal(document?.on?.pull_request, undefined);
  assert.ok(Object.hasOwn(document?.on ?? {}, "workflow_dispatch"));
  assert.ok(Object.hasOwn(document?.on ?? {}, "schedule"));
  assert.equal(document?.concurrency?.["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(document?.jobs ?? {}), [
    "runtime",
    "dependency-guard-windows",
    "r-4-4-scheduled-qualification"
  ]);

  const runtime = document.jobs.runtime;
  assert.equal(runtime.needs, undefined);
  assert.equal(runtime.if, undefined);
  assert.deepEqual(runtime.strategy.matrix.include, [
    { os: "macos-latest", python: "3.12" },
    { os: "windows-latest", python: "3.14" }
  ]);
  const nativeStep = stepRunning(runtime, "npm run test:scripts:native");
  assert.equal(nativeStep.if, "${{ runner.os == 'Windows' }}");
  assert.ok(stepRunning(runtime, "python -m pytest python/tests -q"));
  assert.deepEqual(stepRunning(runtime, "npm run test:extension-host").env, {
    VSCODE_TEST_VERSION: "stable"
  });
  for (const step of runtime.steps) {
    if (step === nativeStep) continue;
    assert.equal(step.if, undefined);
  }

  const windows = document.jobs["dependency-guard-windows"];
  assert.equal(windows.needs, undefined);
  assert.equal(windows.if, undefined);
  assert.deepEqual(windows.strategy.matrix.python, ["3.10", "3.12"]);
  assert.ok(windows.steps.every((step) => step.if === undefined));
  assert.ok(stepRunning(windows, "python -m pytest python/tests/test_dependency_guard.py -q"));

  const scheduled = document.jobs["r-4-4-scheduled-qualification"];
  assert.equal(scheduled.if, "${{ !cancelled() }}");
  assert.deepEqual(stepsUsing(scheduled, "r-lib/actions/setup-r@"), [
    {
      uses: SETUP_R,
      with: { "r-version": "4.4", "use-public-rspm": false }
    }
  ]);
  const prepare = scheduled.steps.find((step) => step.id === "r_prepare");
  assert.equal(
    prepare?.run,
    'node scripts/r-dependency-lock.mjs prepare --lock r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.4.lock.json --rscript "$(command -v Rscript)" --library "$RUNNER_TEMP/openwrangler-r-contract-4.4-scheduled-library" --archives "$RUNNER_TEMP/openwrangler-r-contract-4.4-scheduled-archives" --receipt "$RUNNER_TEMP/openwrangler-r-contract-4.4-scheduled-receipt.json"'
  );
  const restore = stepsUsing(scheduled, "actions/cache/restore@");
  assert.deepEqual(restore, [
    {
      id: "r_cache",
      uses: CACHE_RESTORE,
      with: {
        path: "${{ steps.r_prepare.outputs.archives }}",
        key: "${{ steps.r_prepare.outputs.cache-key }}",
        "fail-on-cache-miss": false
      }
    }
  ]);
  assert.equal(Object.hasOwn(restore[0].with, "restore-keys"), false);
  assert.ok(
    stepRunning(
      scheduled,
      'node scripts/r-dependency-lock.mjs install --lock r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.4.lock.json --rscript "$(command -v Rscript)" --library "${{ steps.r_prepare.outputs.library }}" --archives "${{ steps.r_prepare.outputs.archives }}" --receipt "${{ steps.r_prepare.outputs.receipt }}" --cache-hit "${{ steps.r_cache.outputs.cache-hit == \'true\' }}"'
    )
  );
  assert.deepEqual(stepsUsing(scheduled, "actions/cache/save@"), [
    {
      if: "${{ steps.r_cache.outputs.cache-hit != 'true' }}",
      uses: CACHE_SAVE,
      with: {
        path: "${{ steps.r_prepare.outputs.archives }}",
        key: "${{ steps.r_prepare.outputs.cache-key }}"
      }
    }
  ]);
  assert.deepEqual(stepRunning(scheduled, "npm run test:r-contract").env, {
    R_LIBS_USER: "${{ steps.r_prepare.outputs.library }}"
  });

  const source = JSON.stringify(document);
  assert.doesNotMatch(source, /needs\.classify|r_contract_required|canonical_editor_required|windows_unique_required/u);
}

test("sole classifier emits exactly four conservative changed-area owner outputs", () => {
  assert.deepEqual(CI_CLASSIFIER_OUTPUTS, [
    "r_contract_required",
    "canonical_editor_required",
    "visual_accessibility_required",
    "windows_unique_required"
  ]);
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["docs/architecture.md"] }), {
    rContractRequired: false,
    canonicalEditorRequired: false,
    visualAccessibilityRequired: false,
    windowsUniqueRequired: false
  });
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: ["r/openwrangler_runtime/kernel_agent.R"] }),
    {
      rContractRequired: true,
      canonicalEditorRequired: true,
      visualAccessibilityRequired: false,
      windowsUniqueRequired: false
    }
  );
  for (const path of [
    "src/extension/r/rKernelBridge.ts",
    "src/test/rKernelBridge.unit.test.ts",
    "src/test/releasedRAcceptanceCoverage.unit.test.ts",
    "protocol/openwrangler.v2.schema.json",
    "schemas/operation-catalog.v1.json",
    "src/shared/operationCatalog.generated.ts"
  ]) {
    const result = classifyCiChange({ eventName: "pull_request", changedPaths: [path] });
    assert.equal(result.rContractRequired, true, `${path} must select the R contract owner`);
    assert.equal(result.canonicalEditorRequired, true, `${path} must select the canonical editor owner`);
  }
  for (const path of [
    "python/openwrangler_runtime/protocol.py",
    "python/openwrangler_runtime/server.py",
    "python/openwrangler_runtime/session.py"
  ]) {
    assert.equal(existsSync(path), true, `${path} must remain a real classifier owner path`);
    assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: [path] }), {
      rContractRequired: true,
      canonicalEditorRequired: true,
      visualAccessibilityRequired: false,
      windowsUniqueRequired: true
    });
  }
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["src/webviews/App.tsx"] }), {
    rContractRequired: false,
    canonicalEditorRequired: true,
    visualAccessibilityRequired: true,
    windowsUniqueRequired: false
  });
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: ["python/openwrangler_runtime/export_target.py"] }),
    {
      rContractRequired: false,
      canonicalEditorRequired: true,
      visualAccessibilityRequired: false,
      windowsUniqueRequired: true
    }
  );
  for (const path of [
    "python/pyproject.toml",
    "python/openwrangler_runtime/engines/base.py",
    "python/openwrangler_runtime/engines/duckdb_engine.py",
    "python/openwrangler_runtime/error_causality.py",
    "src/extension/files/safeFileExport.ts",
    "src/extension/files/safePythonDataExport.ts",
    "src/test/extensionHost/index.ts",
    "src/test/safeFileExportHardlink.unit.test.ts"
  ]) {
    const result = classifyCiChange({ eventName: "pull_request", changedPaths: [path] });
    assert.equal(result.windowsUniqueRequired, true, `${path} must select the Windows unique-risk owner`);
    if (path === "python/pyproject.toml") assert.deepEqual(result, BOOLEAN_OUTPUTS);
  }
  for (const path of ["python/openwrangler_runtime/limits.py", "python/openwrangler_runtime/version.py"]) {
    assert.equal(existsSync(path), true, `${path} must remain a real adjacent negative path`);
    assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: [path] }), {
      rContractRequired: false,
      canonicalEditorRequired: true,
      visualAccessibilityRequired: false,
      windowsUniqueRequired: false
    });
  }
  for (const path of [
    "python/openwrangler_runtime/engines/pandas_engine.py",
    "python/openwrangler_runtime/engines/polars_engine.py",
    "src/test/extensionHost/playwrightLifecycle.ts"
  ]) {
    assert.equal(existsSync(path), true, `${path} must remain a real adjacent negative path`);
    const result = classifyCiChange({ eventName: "pull_request", changedPaths: [path] });
    assert.equal(result.windowsUniqueRequired, false, `${path} must not broaden the exact Windows owner map`);
    assert.equal(result.canonicalEditorRequired, true);
  }
  assert.deepEqual(
    classifyCiChange({
      eventName: "pull_request",
      changedPaths: ["src/extension/sessionCoordinator.ts", "docs/architecture.md"]
    }),
    {
      rContractRequired: false,
      canonicalEditorRequired: true,
      visualAccessibilityRequired: false,
      windowsUniqueRequired: false
    }
  );
  for (const path of [
    "tsconfig.json",
    "tsconfig.dependencies.json",
    "tsconfig.extension.json",
    "tsconfig.extension-test.json",
    "tsconfig.webview.json"
  ]) {
    assert.equal(existsSync(path), true, `${path} must remain a real TypeScript configuration path`);
    assert.equal(
      classifyCiChange({ eventName: "pull_request", changedPaths: [path] }).canonicalEditorRequired,
      true,
      `${path} must select the TypeScript owner`
    );
  }
  assert.equal(
    classifyCiChange({ eventName: "pull_request", changedPaths: ["docs/tsconfig.example.json"] })
      .canonicalEditorRequired,
    false,
    "documentation examples must not broaden the TypeScript owner"
  );
});

test("classifier self-selects and fails open for control-plane, malformed, empty, and unmatched changes", () => {
  for (const changedPaths of [
    [".github/workflows/ci.yml"],
    ["scripts/ci-path-classification.mjs"],
    ["scripts/ci-workflow.test.mjs"],
    ["scripts/fixtures/ci-capabilities.json"],
    ["package.json"],
    ["r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.5.lock.json"],
    ["unknown/substantive.owner"],
    [],
    ["../escape"]
  ]) {
    assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths }), BOOLEAN_OUTPUTS);
  }
  for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
    assert.deepEqual(classifyCiChange({ eventName, changedPaths: [] }), BOOLEAN_OUTPUTS);
  }
  assert.throws(() => classifyCiChange({ eventName: "pull_request", changedPaths: "not-an-array" }), /array/u);
  assert.throws(() => classifyCiChange({ eventName: "unknown", changedPaths: [] }), /Unsupported/u);
});

test("changed path transport remains NUL-safe and fatal UTF-8", () => {
  assert.deepEqual(parseChangedPathBuffer(Buffer.from("a\0docs/b.md\0")), ["a", "docs/b.md"]);
  assert.deepEqual(parseChangedPathBuffer(Buffer.alloc(0)), []);
  assert.throws(() => parseChangedPathBuffer(Buffer.from("missing terminator")), /NUL terminated/u);
  assert.throws(() => parseChangedPathBuffer(Buffer.from("a\0\0")), /empty path/u);
  assert.throws(() => parseChangedPathBuffer(Buffer.from([0xff, 0])), /encoded data/u);
});

test("stack classification uses the cumulative stack base and exposes exact prefix metadata", () => {
  const pullRequestBaseSha = "1".repeat(40);
  const pullRequestHeadSha = "2".repeat(40);
  const stackBaseSha = "3".repeat(40);
  assert.deepEqual(
    resolvePullRequestClassificationRange({
      pullRequestBaseSha,
      pullRequestHeadSha,
      stackBaseSha,
      stackPosition: "2",
      stackSize: "4"
    }),
    {
      baseSha: stackBaseSha,
      headSha: pullRequestHeadSha,
      stackedEvent: true,
      stackPosition: 2,
      stackSize: 4,
      partialPrefix: true
    }
  );
  assert.deepEqual(
    resolvePullRequestClassificationRange({
      pullRequestBaseSha,
      pullRequestHeadSha,
      stackBaseSha,
      stackPosition: "4",
      stackSize: "4"
    }),
    {
      baseSha: stackBaseSha,
      headSha: pullRequestHeadSha,
      stackedEvent: true,
      stackPosition: 4,
      stackSize: 4,
      partialPrefix: false
    }
  );
});

test("every stack layer classifies its complete cumulative prefix without dropping prior owners", () => {
  const pullRequestBaseSha = "1".repeat(40);
  const pullRequestHeadSha = "2".repeat(40);
  const stackBaseSha = "3".repeat(40);
  const prefixes = [
    ["python/openwrangler_runtime/export_target.py"],
    ["python/openwrangler_runtime/export_target.py", "r/openwrangler_runtime/kernel_agent.R"],
    ["python/openwrangler_runtime/export_target.py", "r/openwrangler_runtime/kernel_agent.R", "src/webviews/App.tsx"]
  ];
  const expected = [
    {
      rContractRequired: false,
      canonicalEditorRequired: true,
      visualAccessibilityRequired: false,
      windowsUniqueRequired: true
    },
    {
      rContractRequired: true,
      canonicalEditorRequired: true,
      visualAccessibilityRequired: false,
      windowsUniqueRequired: true
    },
    BOOLEAN_OUTPUTS
  ];
  for (const [index, changedPaths] of prefixes.entries()) {
    const position = index + 1;
    const range = resolvePullRequestClassificationRange({
      pullRequestBaseSha,
      pullRequestHeadSha,
      stackBaseSha,
      stackPosition: String(position),
      stackSize: String(prefixes.length)
    });
    assert.equal(range.baseSha, stackBaseSha);
    assert.equal(range.stackPosition, position);
    assert.equal(range.partialPrefix, position < prefixes.length);
    assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths }), expected[index]);
    assert.deepEqual(capabilityGraph.capabilities.source_coverage.requiredChecks, ["validate", "CodeQL gate"]);
  }
});

test("classifier CLI reads the real cumulative stack graph instead of the direct pull-request base", (context) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-ci-stack-graph-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const runGit = (...arguments_) =>
    execFileSync("git", arguments_, {
      cwd: root,
      encoding: "utf8",
      env: sanitizedGitEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  const commit = (message) => {
    runGit("add", "-A");
    runGit(
      "-c",
      "user.name=Open Wrangler Tests",
      "-c",
      "user.email=tests@openwrangler.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message
    );
    return runGit("rev-parse", "HEAD");
  };
  runGit("init", "--quiet");
  const stackBaseSha = commit("stack base");
  mkdirSync(join(root, "python", "openwrangler_runtime"), { recursive: true });
  writeFileSync(join(root, "python", "openwrangler_runtime", "export_target.py"), "# first stack owner\n");
  const pullRequestBaseSha = commit("first stack owner");
  mkdirSync(join(root, "r", "openwrangler_runtime"), { recursive: true });
  writeFileSync(join(root, "r", "openwrangler_runtime", "kernel_agent.R"), "# second stack owner\n");
  const pullRequestHeadSha = commit("second stack owner");
  const outputPath = join(root, "classifier-output.txt");
  const runClassifier = (stacked) => {
    writeFileSync(outputPath, "");
    const stdout = execFileSync(process.execPath, [resolve(REPOSITORY_ROOT, "scripts/ci-path-classification.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...sanitizedGitEnvironment(process.env),
        CI_BASE_SHA: pullRequestBaseSha,
        CI_EVENT_NAME: "pull_request",
        CI_HEAD_SHA: pullRequestHeadSha,
        CI_STACK_BASE_SHA: stacked ? stackBaseSha : "",
        CI_STACK_POSITION: stacked ? "2" : "",
        CI_STACK_SIZE: stacked ? "2" : "",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, "hostile-alternates"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "!exit 97",
        GIT_DIR: join(root, "hostile-git-dir"),
        GIT_OBJECT_DIRECTORY: join(root, "hostile-objects"),
        GIT_REPLACE_REF_BASE: "refs/hostile/",
        GIT_WORK_TREE: join(root, "hostile-work-tree"),
        GITHUB_OUTPUT: outputPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return {
      outputs: Object.fromEntries(
        readFileSync(outputPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("="))
      ),
      stdout
    };
  };

  const ordinary = runClassifier(false);
  assert.equal(ordinary.outputs.windows_unique_required, "false");
  assert.match(ordinary.stdout, new RegExp(`base=${pullRequestBaseSha}`, "u"));
  const stacked = runClassifier(true);
  assert.deepEqual(stacked.outputs, {
    r_contract_required: "true",
    canonical_editor_required: "true",
    visual_accessibility_required: "false",
    windows_unique_required: "true"
  });
  assert.match(stacked.stdout, new RegExp(`base=${stackBaseSha} head=${pullRequestHeadSha} stacked=true`, "u"));
});

test("Git classification scrubs every ambient Git routing and configuration override", () => {
  const clean = sanitizedGitEnvironment({
    GIT_CONFIG_COUNT: "1",
    GIT_DIR: "/hostile/git-dir",
    Git_Work_Tree: "/hostile/work-tree",
    HOME: "/safe/home",
    PATH: "/safe/bin"
  });
  assert.equal(clean.HOME, "/safe/home");
  assert.equal(clean.PATH, "/safe/bin");
  assert.equal(clean.GIT_DIR, undefined);
  assert.equal(clean.Git_Work_Tree, undefined);
  assert.equal(clean.GIT_CONFIG_COUNT, undefined);
  assert.equal(clean.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(clean.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(clean.GIT_OPTIONAL_LOCKS, "0");
  assert.throws(() => sanitizedGitEnvironment(null), /environment mapping/u);
});

test("ordinary pull requests fall back to their exact base while partial stack metadata fails closed", () => {
  const pullRequestBaseSha = "1".repeat(40);
  const pullRequestHeadSha = "2".repeat(40);
  assert.deepEqual(resolvePullRequestClassificationRange({ pullRequestBaseSha, pullRequestHeadSha }), {
    baseSha: pullRequestBaseSha,
    headSha: pullRequestHeadSha,
    stackedEvent: false,
    stackPosition: null,
    stackSize: null,
    partialPrefix: false
  });
  for (const metadata of [
    { stackBaseSha: "3".repeat(40) },
    { stackBaseSha: "3".repeat(40), stackPosition: "1" },
    { stackBaseSha: "3".repeat(40), stackPosition: "0", stackSize: "1" },
    { stackBaseSha: "3".repeat(40), stackPosition: "2", stackSize: "1" },
    { stackBaseSha: "invalid", stackPosition: "1", stackSize: "1" }
  ]) {
    assert.throws(() => resolvePullRequestClassificationRange({ pullRequestBaseSha, pullRequestHeadSha, ...metadata }));
  }
});

test("CI exposes only the current pull-request owners", () => {
  assert.deepEqual(Object.keys(ci.jobs), [
    "classify",
    "invariant-core",
    "r-contract-kernel",
    "r-contract-protocol",
    "canonical-editor",
    "visual-accessibility",
    "windows-unique",
    "validate"
  ]);
  assert.deepEqual(Object.keys(ci.jobs.classify.outputs), CI_CLASSIFIER_OUTPUTS);
  assert.equal(ci.jobs["native-r-contract"], undefined);
  assert.equal(ci.jobs["r-contract-kernel"].name, "R 4.5 kernel contract");
  assert.equal(ci.jobs["r-contract-protocol"].name, "R 4.5 protocol contracts");
  assert.equal(ci.jobs["canonical-editor"].name, "Canonical package and editor");
  assert.equal(ci.jobs["windows-unique"].name, "Windows unique-risk contracts");
});

test("machine-readable capabilities bind correct events, fatal providers, and mandatory final fan-in", () => {
  assert.equal(ci.env.OPEN_WRANGLER_CI_CAPABILITY_GRAPH, "scripts/fixtures/ci-capabilities.json");
  assert.deepEqual(repositoryWorkflowNames, [
    "candidate-acceptance.yml",
    "ci.yml",
    "codeql.yml",
    "cross-platform.yml",
    "daily-preview.yml",
    "open-vsx-promotion.yml",
    "performance.yml",
    "release-candidate.yml",
    "released-jupyter.yml",
    "stable-release.yml"
  ]);
  assert.doesNotThrow(() => assertCapabilityGraph(capabilityGraph, capabilityDocuments));
});

test("capability entry workflows own their declared final fan-in", () => {
  const wrongSourceCoverageEntry = structuredClone(capabilityGraph);
  wrongSourceCoverageEntry.capabilities.source_coverage.entryWorkflow = "candidate";
  assert.throws(
    () => assertCapabilityGraph(wrongSourceCoverageEntry, capabilityDocuments),
    /source_coverage entry workflow must own its final fan-in/u
  );
});

test("capability workflow sources stay on the fixed bounded no-follow allowlist", () => {
  for (const [workflowId, file] of Object.entries(CAPABILITY_WORKFLOW_FILES)) {
    assert.equal(capabilityGraph.workflows[workflowId].file, file);
    const source = readBoundedCapabilityFile(file);
    assert.ok(Buffer.byteLength(source, "utf8") <= CAPABILITY_FILE_LIMIT);
    assert.equal(source, repositoryWorkflowInventory[file].bytes.toString("utf8"));
  }
  for (const file of ["package.json", "../outside.yml", ".github/workflows/unknown.yml"]) {
    const graph = structuredClone(capabilityGraph);
    graph.workflows.release.file = file;
    assert.throws(() => loadCapabilityDocuments(graph), /fixed workflow file/u);
  }
});

test("bounded workflow reads reject aliasing, oversize, and in-place content drift", (context) => {
  const createFixture = (contents = "name: fixture\n") => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-ci-capability-read-")));
    context.after(() => rmSync(root, { force: true, recursive: true }));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    const relativePath = ".github/workflows/fixture.yml";
    const path = join(root, relativePath);
    writeFileSync(path, contents);
    return { path, relativePath, root };
  };
  const readFixture = (fixture, hooks) =>
    readBoundedNoFollowFile(fixture.relativePath, {
      allowedPaths: new Set([fixture.relativePath]),
      hooks,
      root: fixture.root
    });

  const valid = createFixture();
  const snapshot = readFixture(valid);
  assert.equal(snapshot.bytes.toString("utf8"), "name: fixture\n");
  assert.equal(snapshot.sha256, createHash("sha256").update(snapshot.bytes).digest("hex"));

  const oversized = createFixture("x".repeat(CAPABILITY_FILE_LIMIT + 1));
  assert.throws(() => readFixture(oversized), /exceeds the capability file limit/u);

  const hardLinked = createFixture();
  linkSync(hardLinked.path, join(hardLinked.root, "alias.yml"));
  assert.throws(() => readFixture(hardLinked), /hard-linked aliases/u);

  const sameSize = createFixture("a".repeat(4096));
  assert.throws(
    () =>
      readFixture(sameSize, {
        afterRead() {
          writeFileSync(sameSize.path, "b".repeat(4096));
        }
      }),
    /content changed|changed while reading/u
  );

  const torn = createFixture("a".repeat(32 * 1024));
  let changed = false;
  assert.throws(
    () =>
      readFixture(torn, {
        afterChunk({ total }) {
          if (!changed && total >= 16 * 1024) {
            changed = true;
            writeFileSync(torn.path, "b".repeat(32 * 1024));
          }
        }
      }),
    /content changed|changed while reading/u
  );

  if (process.platform !== "win32") {
    const symbolic = createFixture();
    const target = join(symbolic.root, "target.yml");
    writeFileSync(target, "name: target\n");
    rmSync(symbolic.path);
    symlinkSync(target, symbolic.path);
    assert.throws(() => readFixture(symbolic), /regular file|symbolic link/u);
  }
});

test(
  "bounded workflow reads bind descriptors before rejecting directory and file replacement",
  { skip: process.platform === "win32" },
  (context) => {
    const createFixtureRoot = (prefix) => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
      context.after(() => rmSync(root, { force: true, recursive: true }));
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, ".github", "workflows", "fixture.yml"), "name: owned\n");
      return root;
    };
    const relativePath = ".github/workflows/fixture.yml";
    const allowedPaths = new Set([relativePath]);

    const directoryRoot = createFixtureRoot("ow-ci-capability-directory-race-");
    mkdirSync(join(directoryRoot, ".github-replacement", "workflows"), { recursive: true });
    writeFileSync(join(directoryRoot, ".github-replacement", "workflows", "fixture.yml"), "name: replacement\n");
    let directoryReplaced = false;
    let directoryReplacementReads = 0;
    assert.throws(
      () =>
        readBoundedNoFollowFile(relativePath, {
          allowedPaths,
          hooks: {
            afterChunk() {
              directoryReplacementReads += 1;
            },
            afterDirectoryDescriptorOpen({ path }) {
              if (directoryReplaced || path !== join(directoryRoot, ".github")) return;
              directoryReplaced = true;
              renameSync(join(directoryRoot, ".github"), join(directoryRoot, ".github-owned"));
              renameSync(join(directoryRoot, ".github-replacement"), join(directoryRoot, ".github"));
            }
          },
          root: directoryRoot
        }),
      /directory identity changed before use/u
    );
    assert.equal(directoryReplaced, true);
    assert.equal(directoryReplacementReads, 0, "A replaced directory must reject before file bytes are read.");

    const fileRoot = createFixtureRoot("ow-ci-capability-file-race-");
    const filePath = join(fileRoot, relativePath);
    const replacementPath = join(fileRoot, ".github", "workflows", "replacement.yml");
    writeFileSync(replacementPath, "name: other\n");
    let fileReplaced = false;
    let fileReplacementReads = 0;
    assert.throws(
      () =>
        readBoundedNoFollowFile(relativePath, {
          allowedPaths,
          hooks: {
            afterChunk() {
              fileReplacementReads += 1;
            },
            afterFileDescriptorOpen() {
              fileReplaced = true;
              renameSync(filePath, join(fileRoot, ".github", "workflows", "owned.yml"));
              renameSync(replacementPath, filePath);
            }
          },
          root: fileRoot
        }),
      /path identity changed before use/u
    );
    assert.equal(fileReplaced, true);
    assert.equal(fileReplacementReads, 0, "A replaced file must reject before replacement bytes are read.");
  }
);

test("workflow YAML enforces parser bounds and rejects aliases, merges, tags, depth, and nodes", () => {
  assert.deepEqual(parseBoundedWorkflowYaml("name: fixture\njobs: {}\n"), { name: "fixture", jobs: {} });
  assert.throws(() => parseBoundedWorkflowYaml("base: &base\n  name: fixture\ncopy: *base\n"), /anchors|aliases/u);
  assert.throws(() => parseBoundedWorkflowYaml("job:\n  <<: { name: fixture }\n"), /merge keys/u);
  assert.throws(() => parseBoundedWorkflowYaml("name: !!str fixture\n"), /explicit tags/u);
  assert.throws(() => parseBoundedWorkflowYaml("job:\n  !!merge '<<': { name: fixture }\n"), /explicit tags/u);

  let deeplyNested = "leaf: value\n";
  for (let index = 0; index <= WORKFLOW_YAML_DEPTH_LIMIT; index += 1) {
    deeplyNested = `level_${index}:\n${deeplyNested.replace(/^/gmu, "  ")}`;
  }
  assert.throws(() => parseBoundedWorkflowYaml(deeplyNested), /depth limit|maxDepth/u);
  const excessiveNodes = `items: [${"x,".repeat(WORKFLOW_YAML_NODE_LIMIT)}x]\n`;
  assert.throws(() => parseBoundedWorkflowYaml(excessiveNodes), /node limit/u);
});

test("bounded workflow reads close every descriptor while preserving the primary failure", (context) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-ci-capability-close-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const relativePath = ".github/workflows/fixture.yml";
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, relativePath), "name: fixture\n");
  let directoryDescriptors = [];
  const primary = new Error("primary workflow read failure");
  assert.throws(
    () =>
      readBoundedNoFollowFile(relativePath, {
        allowedPaths: new Set([relativePath]),
        hooks: {
          afterDirectoryOpen({ directories }) {
            directoryDescriptors = directories.map(({ descriptor }) => descriptor);
          },
          afterRead({ descriptor }) {
            closeSync(descriptor);
            closeSync(directoryDescriptors[1]);
            throw primary;
          }
        },
        root
      }),
    (error) => error === primary
  );
  for (const descriptor of directoryDescriptors) {
    assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
  }
});

test(
  "bounded workflow reads reject intermediate ancestor replacement",
  { skip: process.platform === "win32" },
  (context) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-ci-capability-ancestor-")));
    context.after(() => rmSync(root, { force: true, recursive: true }));
    const relativePath = ".github/workflows/fixture.yml";
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, ".github-replacement", "workflows"), { recursive: true });
    writeFileSync(join(root, relativePath), "name: owned\n");
    writeFileSync(join(root, ".github-replacement", "workflows", "fixture.yml"), "name: replacement\n");
    assert.throws(
      () =>
        readBoundedNoFollowFile(relativePath, {
          allowedPaths: new Set([relativePath]),
          hooks: {
            afterFileOpen() {
              renameSync(join(root, ".github"), join(root, ".github-owned"));
              renameSync(join(root, ".github-replacement"), join(root, ".github"));
            }
          },
          root
        }),
      /identity changed/u
    );
  }
);

test("capability mutations reject remove, skip, nonfatal, and disconnected evidence", () => {
  const mutations = [
    (documents) => {
      delete documents.pull_request.jobs["invariant-core"];
    },
    (documents) => {
      documents.candidate.jobs.acceptance.if = "${{ false }}";
    },
    (documents) => {
      documents.release.jobs.qualify.needs = documents.release.jobs.qualify.needs.filter(
        (jobId) => jobId !== "candidate-acceptance"
      );
    }
  ];
  for (const mutate of mutations) {
    const documents = structuredClone(capabilityDocuments);
    mutate(documents);
    assert.throws(() => assertCapabilityGraph(capabilityGraph, documents));
  }

  for (const value of [true, "false", 0, null]) {
    const documents = structuredClone(capabilityDocuments);
    documents.candidate.jobs.platform["continue-on-error"] = value;
    assert.throws(() => assertCapabilityGraph(capabilityGraph, documents), /absent or literal false/u);
    const requiredCheckDocuments = structuredClone(capabilityDocuments);
    requiredCheckDocuments.codeql.jobs["codeql-gate"]["continue-on-error"] = value;
    assert.throws(() => assertCapabilityGraph(capabilityGraph, requiredCheckDocuments), /absent or literal false/u);
  }
  const explicitFatal = structuredClone(capabilityDocuments);
  explicitFatal.candidate.jobs.platform["continue-on-error"] = false;
  assert.doesNotThrow(() => assertCapabilityGraph(capabilityGraph, explicitFatal));

  const incompleteClosure = structuredClone(capabilityGraph);
  incompleteClosure.capabilities.installed_candidate.requiredJobs =
    incompleteClosure.capabilities.installed_candidate.requiredJobs.filter((jobId) => jobId !== "platform");
  assert.throws(
    () => assertCapabilityGraph(incompleteClosure, capabilityDocuments),
    /exact provider dependency closure/u
  );
  const duplicateRequiredJob = structuredClone(capabilityGraph);
  duplicateRequiredJob.capabilities.installed_candidate.requiredJobs.push("platform");
  assert.throws(() => assertCapabilityGraph(duplicateRequiredJob, capabilityDocuments), /required job twice/u);

  const selfCycle = structuredClone(capabilityDocuments);
  selfCycle.pull_request.jobs.validate.needs.push("validate");
  assert.throws(() => assertCapabilityGraph(capabilityGraph, selfCycle), /dependency cycle/u);
  const multiNodeCycle = structuredClone(capabilityDocuments);
  multiNodeCycle.candidate.jobs.contract.needs = "platform";
  assert.throws(() => assertCapabilityGraph(capabilityGraph, multiNodeCycle), /dependency cycle/u);

  const duplicateRequiredCheck = structuredClone(capabilityGraph);
  duplicateRequiredCheck.capabilities.source_coverage.requiredChecks = ["validate", "validate"];
  assert.throws(() => assertCapabilityGraph(duplicateRequiredCheck, capabilityDocuments));
  const duplicateCheckOwner = structuredClone(capabilityDocuments);
  duplicateCheckOwner.codeql.jobs["analyze-python"].name = "validate";
  assert.throws(() => assertCapabilityGraph(capabilityGraph, duplicateCheckOwner), /exactly one declared job/u);
  const duplicateOutsideCapabilities = Object.fromEntries(
    Object.entries(repositoryWorkflowInventory).map(([path, snapshot]) => [
      path,
      { document: structuredClone(snapshot.document) }
    ])
  );
  duplicateOutsideCapabilities[".github/workflows/daily-preview.yml"].document.jobs.duplicate = {
    name: "CodeQL gate",
    runs_on: "ubuntu-latest"
  };
  assert.throws(
    () => assertCapabilityGraph(capabilityGraph, capabilityDocuments, duplicateOutsideCapabilities),
    /exactly one declared job/u
  );
  const fallbackRequiredCheck = structuredClone(capabilityDocuments);
  delete fallbackRequiredCheck.pull_request.jobs.validate.name;
  assert.doesNotThrow(() => assertCapabilityGraph(capabilityGraph, fallbackRequiredCheck));
  const matrixFallbackRequiredCheck = structuredClone(capabilityDocuments);
  delete matrixFallbackRequiredCheck.pull_request.jobs.validate.name;
  matrixFallbackRequiredCheck.pull_request.jobs.validate.strategy = { matrix: { os: ["ubuntu-latest"] } };
  assert.throws(
    () => assertCapabilityGraph(capabilityGraph, matrixFallbackRequiredCheck),
    /unevaluable possible check-name collision/u
  );
  const namedMatrixRequiredCheck = structuredClone(matrixFallbackRequiredCheck);
  namedMatrixRequiredCheck.pull_request.jobs.validate.name = "validate";
  assert.throws(
    () => assertCapabilityGraph(capabilityGraph, namedMatrixRequiredCheck),
    /unevaluable possible check-name collision/u
  );
  for (const strategy of [{}, [], 0, null, "literal", "${{ needs.setup.outputs.strategy }}"]) {
    const unknownStrategyRequiredCheck = structuredClone(capabilityDocuments);
    unknownStrategyRequiredCheck.pull_request.jobs.validate.strategy = strategy;
    assert.throws(
      () => assertCapabilityGraph(capabilityGraph, unknownStrategyRequiredCheck),
      /unevaluable possible check-name collision/u
    );
  }
  const provenNonMatrixStrategy = structuredClone(capabilityDocuments);
  provenNonMatrixStrategy.pull_request.jobs.validate.strategy = { "fail-fast": false, "max-parallel": 1 };
  assert.doesNotThrow(() => assertCapabilityGraph(capabilityGraph, provenNonMatrixStrategy));
  const wrongFallbackRequiredCheck = structuredClone(capabilityDocuments);
  delete wrongFallbackRequiredCheck.codeql.jobs["codeql-gate"].name;
  assert.throws(() => assertCapabilityGraph(capabilityGraph, wrongFallbackRequiredCheck), /exactly one declared job/u);
  const duplicateFallbackOutsideCapabilities = structuredClone(duplicateOutsideCapabilities);
  duplicateFallbackOutsideCapabilities[".github/workflows/daily-preview.yml"].document.jobs.validate = {
    "runs-on": "ubuntu-latest"
  };
  assert.throws(
    () => assertCapabilityGraph(capabilityGraph, capabilityDocuments, duplicateFallbackOutsideCapabilities),
    /exactly one declared job/u
  );
  const ambiguousOutsideCapabilities = structuredClone(duplicateOutsideCapabilities);
  ambiguousOutsideCapabilities[".github/workflows/daily-preview.yml"].document.jobs.ambiguous = {
    name: "${{ matrix.required_check }}",
    "runs-on": "ubuntu-latest"
  };
  assert.throws(
    () => assertCapabilityGraph(capabilityGraph, capabilityDocuments, ambiguousOutsideCapabilities),
    /unevaluable possible check-name collision/u
  );
  for (const name of [
    "${{ format('{0}', matrix.required_check) }}",
    "${{ " + "x".repeat(1025) + " }}",
    "prefix ${{ matrix.os }} ${{ format('{0}', matrix.required_check) }}"
  ]) {
    const unparsedExpressionOutsideCapabilities = structuredClone(duplicateOutsideCapabilities);
    unparsedExpressionOutsideCapabilities[".github/workflows/daily-preview.yml"].document.jobs.unparsed = {
      name,
      "runs-on": "ubuntu-latest"
    };
    assert.throws(
      () => assertCapabilityGraph(capabilityGraph, capabilityDocuments, unparsedExpressionOutsideCapabilities),
      /unevaluable possible check-name collision/u
    );
  }
  const expression = "${{ matrix.value }}";
  const dense64 = Array.from({ length: REQUIRED_CHECK_EXPRESSION_LIMIT }, () => expression).join("-");
  const dense65 = dense64 + "-" + expression;
  const dense66 = dense65 + "-" + expression;
  assert.equal(requiredCheckName("fixture", { name: dense64 }).mayEqual("validate"), false);
  assert.equal(requiredCheckName("fixture", { name: dense65 }).mayEqual("validate"), true);
  let yieldedMatches = 0;
  function* countedDenseMatches() {
    for (const match of dense66.matchAll(REQUIRED_CHECK_EXPRESSION_PATTERN)) {
      yieldedMatches += 1;
      if (yieldedMatches === REQUIRED_CHECK_EXPRESSION_LIMIT + 2) {
        throw new Error("the 66th expression must not be consumed");
      }
      yield match;
    }
  }
  assert.equal(parseDynamicCheckNameParts(dense66, countedDenseMatches()), undefined);
  assert.equal(yieldedMatches, REQUIRED_CHECK_EXPRESSION_LIMIT + 1);

  const exactWorkName = "x".repeat(REQUIRED_CHECK_MATCH_WORK_LIMIT - expression.length) + expression;
  const overWorkName = exactWorkName + "x";
  assert.equal(exactWorkName.length, REQUIRED_CHECK_MATCH_WORK_LIMIT);
  assert.equal(overWorkName.length, REQUIRED_CHECK_MATCH_WORK_LIMIT + 1);
  assert.equal(requiredCheckName("fixture", { name: exactWorkName }).mayEqual("validate"), false);
  assert.equal(requiredCheckName("fixture", { name: overWorkName }).mayEqual("validate"), true);
  let openedOverWorkIterator = 0;
  const overWorkMatches = {
    [Symbol.iterator]() {
      openedOverWorkIterator += 1;
      return [][Symbol.iterator]();
    }
  };
  assert.equal(parseDynamicCheckNameParts(overWorkName, overWorkMatches), undefined);
  assert.equal(openedOverWorkIterator, 0);

  const astral = "\u{1f9ea}";
  const astralFillUnits = REQUIRED_CHECK_MATCH_WORK_LIMIT - expression.length;
  const exactAstralWorkName =
    astral.repeat(Math.floor(astralFillUnits / astral.length)) +
    "x".repeat(astralFillUnits % astral.length) +
    expression;
  const overAstralWorkName = exactAstralWorkName + "x";
  assert.equal(astral.length, 2);
  assert.equal(exactAstralWorkName.length, REQUIRED_CHECK_MATCH_WORK_LIMIT);
  assert.equal(overAstralWorkName.length, REQUIRED_CHECK_MATCH_WORK_LIMIT + 1);
  assert.ok(Array.from(exactAstralWorkName).length < REQUIRED_CHECK_MATCH_WORK_LIMIT);
  assert.ok(Buffer.byteLength(exactAstralWorkName, "utf8") > REQUIRED_CHECK_MATCH_WORK_LIMIT);
  assert.equal(requiredCheckName("fixture", { name: exactAstralWorkName }).mayEqual("validate"), false);
  assert.equal(requiredCheckName("fixture", { name: overAstralWorkName }).mayEqual("validate"), true);

  for (const name of [dense65, overWorkName]) {
    const overBudgetNameOutsideCapabilities = structuredClone(duplicateOutsideCapabilities);
    overBudgetNameOutsideCapabilities[".github/workflows/daily-preview.yml"].document.jobs.overBudget = {
      name,
      "runs-on": "ubuntu-latest"
    };
    assert.throws(
      () => assertCapabilityGraph(capabilityGraph, capabilityDocuments, overBudgetNameOutsideCapabilities),
      /unevaluable possible check-name collision/u
    );
  }
  const fixedPartCandidate = requiredCheckName("fixture", {
    name: "val${{ matrix.first }}id${{ matrix.second }}ate"
  });
  assert.equal(fixedPartCandidate.mayEqual("validate"), true);
  assert.equal(fixedPartCandidate.mayEqual("valixate"), false);
  assert.equal(fixedPartCandidate.mayEqual("x".repeat(REQUIRED_CHECK_MATCH_WORK_LIMIT + 1)), true);
  const orderedPartsCandidate = requiredCheckName("fixture", {
    name: "${{ matrix.first }}alpha${{ matrix.second }}beta${{ matrix.third }}"
  });
  assert.equal(orderedPartsCandidate.mayEqual("prefix-alpha-middle-beta-suffix"), true);
  assert.equal(orderedPartsCandidate.mayEqual("prefix-beta-middle-alpha-suffix"), false);

  const missingStackTrigger = structuredClone(capabilityGraph);
  missingStackTrigger.workflows.codeql.activityTypes = missingStackTrigger.workflows.codeql.activityTypes.filter(
    (activity) => activity !== "stacked"
  );
  assert.throws(() => assertCapabilityGraph(missingStackTrigger, capabilityDocuments));
});

test("capability validation tolerates harmless names and workflow ordering", () => {
  const documents = structuredClone(capabilityDocuments);
  for (const document of Object.values(documents)) {
    for (const [jobId, job] of Object.entries(document.jobs)) {
      if (!new Set(capabilityGraph.capabilities.source_coverage.requiredChecks).has(job.name)) {
        job.name = `Display label for ${jobId}`;
      }
      if (Array.isArray(job.needs)) job.needs.reverse();
    }
    document.jobs = Object.fromEntries(Object.entries(document.jobs).reverse());
  }
  assert.doesNotThrow(() => assertCapabilityGraph(capabilityGraph, documents));
});

test("CI capability documentation is generated exactly from the machine-readable graph", () => {
  const source = readFileSync("docs/ci.md", "utf8");
  const start = source.indexOf(CAPABILITY_DOCS_START);
  const end = source.indexOf(CAPABILITY_DOCS_END);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal(source.indexOf(CAPABILITY_DOCS_START, start + 1), -1);
  assert.equal(source.indexOf(CAPABILITY_DOCS_END, end + 1), -1);
  assert.equal(source.slice(start, end + CAPABILITY_DOCS_END.length), renderCapabilityDocs(capabilityGraph));
});

function assertInvariantCoreTopology(document, scripts = packageJson.scripts) {
  const job = document.jobs["invariant-core"];
  const pullRequestCommand =
    "npx --no-install npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label check:invariants test:scripts test:python";
  const typescriptCommand =
    "npx --no-install npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label typecheck typecheck:dependencies test:ts";
  assert.equal(
    scripts["check:pr"],
    "npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label check test"
  );
  assert.deepEqual(
    Object.keys(scripts).filter((name) => /^check:(?:pr|tier)/u.test(name)),
    ["check:pr"]
  );
  assert.deepEqual([...packageScriptClosure("check:invariants", scripts)].sort(), [
    "brand:check",
    "check:install-policy",
    "check:invariants",
    "check:r-dependency-lock",
    "check:remote-jupyter-lock",
    "docs:check",
    "format:check",
    "license:check",
    "lint",
    "lint:python",
    "protocol:check",
    "reference:check"
  ]);
  for (const forbidden of ["typecheck", "typecheck:dependencies", "test:ts"]) {
    assert.equal(packageScriptClosure("check:invariants", scripts).has(forbidden), false);
  }
  assert.equal(job.if, undefined);
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const python = stepsUsing(job, "actions/setup-python@");
  assert.equal(python.length, 1);
  assert.equal(python[0].uses, SETUP_PYTHON);
  assert.equal(python[0].with["python-version"], "3.10");
  assert.ok(stepRunning(job, 'python -m pip install -e "python[dev]"'));
  assert.equal(stepRunning(job, pullRequestCommand).if, "${{ github.event_name == 'pull_request' }}");
  assert.equal(
    stepRunning(job, pullRequestCommand).env.OPEN_WRANGLER_PYTHON,
    "${{ steps.reference_python.outputs.python-path }}"
  );
  assert.equal(stepRunning(job, "npm run check:pr").if, "${{ github.event_name == 'push' }}");
  assert.equal(
    stepRunning(job, "npm run check:pr").env.OPEN_WRANGLER_PYTHON,
    "${{ steps.reference_python.outputs.python-path }}"
  );
  assert.equal(
    job.steps.some(
      (step) => typeof step.run === "string" && /\b(?:typecheck(?::dependencies)?|test:ts)\b/u.test(step.run)
    ),
    false
  );
  assert.ok(stepRunning(job, "npm audit"));
  assert.ok(stepRunning(job, "npm run audit:python"));
  const canonical = document.jobs["canonical-editor"];
  const canonicalPython = stepsUsing(canonical, "actions/setup-python@");
  assert.equal(canonicalPython.length, 1);
  assert.equal(canonicalPython[0].id, "canonical_python");
  assert.equal(canonicalPython[0].with["python-version"], "3.12");
  const typescript = stepRunning(canonical, typescriptCommand);
  assert.equal(typescript.if, "${{ !cancelled() }}");
  assert.equal(typescript.env.OPEN_WRANGLER_PYTHON, "${{ steps.canonical_python.outputs.python-path }}");
}

test("invariant core keeps the portable and Python floor while the selected canonical owner runs TypeScript", () => {
  assertInvariantCoreTopology(ci);
  const mutations = [
    (document) => {
      stepRunning(
        document.jobs["invariant-core"],
        "npx --no-install npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label check:invariants test:scripts test:python"
      ).run =
        "npx --no-install npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label check:invariants test:scripts";
    },
    (document) => {
      stepRunning(
        document.jobs["invariant-core"],
        "npx --no-install npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label check:invariants test:scripts test:python"
      ).run =
        "npx --no-install npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label check test:scripts test:python";
    },
    (document) => {
      stepRunning(
        document.jobs["invariant-core"],
        "npx --no-install npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label check:invariants test:scripts test:python"
      ).if = "${{ !cancelled() && github.event_name == 'pull_request' }}";
    },
    (document) => {
      stepRunning(document.jobs["invariant-core"], "npm run check:pr").if =
        "${{ github.event_name == 'pull_request' }}";
    },
    (document) => {
      document.jobs["canonical-editor"].steps = document.jobs["canonical-editor"].steps.filter(
        (step) =>
          step.run !==
          "npx --no-install npm-run-all --parallel --continue-on-error --max-parallel 2 --print-label typecheck typecheck:dependencies test:ts"
      );
    }
  ];
  for (const mutate of mutations) {
    const document = structuredClone(ci);
    mutate(document);
    assert.throws(() => assertInvariantCoreTopology(document));
  }
  for (const scripts of [
    { ...packageJson.scripts, "check:invariants": `${packageJson.scripts["check:invariants"]} && npm run typecheck` },
    {
      ...packageJson.scripts,
      "check:invariants": `${packageJson.scripts["check:invariants"]} && npm run check:no-typescript`,
      "check:no-typescript": "npm run typecheck:dependencies"
    }
  ]) {
    assert.throws(() => assertInvariantCoreTopology(ci, scripts));
  }
});

test("Python build and development metadata retain the setuptools security floor and exact fsspec pin", () => {
  const buildSystem = exactTomlSection(pythonProjectMetadata, "build-system");
  const project = exactTomlSection(pythonProjectMetadata, "project");
  const development = exactTomlSection(pythonProjectMetadata, "project.optional-dependencies");

  assert.match(buildSystem, /^requires = \["setuptools>=83\.0\.0", "wheel"\]$/mu);
  assert.match(development, /^ {2}"setuptools>=83\.0\.0",$/mu);
  assert.equal(pythonProjectMetadata.match(/setuptools>=83\.0\.0/gu)?.length, 2);
  assert.match(project, /^requires-python = ">=3\.10"$/mu);
  assert.match(project, /^ {2}"fsspec==2026\.7\.0",$/mu);
  assert.equal(pythonProjectMetadata.match(/fsspec==2026\.7\.0/gu)?.length, 1);
});

const R_45_OWNER_CONTRACTS = Object.freeze([
  Object.freeze({
    jobId: "r-contract-kernel",
    lockName: "ubuntu-24.04-x86_64-r-4.5.lock.json",
    testCommand: "npm run test:r-contract -- --shard kernel-agent"
  }),
  Object.freeze({
    jobId: "r-contract-protocol",
    lockName: "ubuntu-24.04-x86_64-r-4.5.lock.json",
    testCommand: "npm run test:r-contract:protocol"
  })
]);

const R_45_ARTIFACT_MANIFEST = Object.freeze([
  "libbz2-1.0_1.0.8-5.1build0.1_amd64.deb|libbz2-1.0|1.0.8-5.1build0.1|amd64|34370|d557ab12b42ab370249142099fae3cbb979948934e4dfa58c2ab59bf5bbbda73|https://archive.ubuntu.com/ubuntu/pool/main/b/bzip2/libbz2-1.0_1.0.8-5.1build0.1_amd64.deb",
  "libbz2-dev_1.0.8-5.1build0.1_amd64.deb|libbz2-dev|1.0.8-5.1build0.1|amd64|33608|012b1118932f20ae3fa706fa44f8ebe203a21f4765893bc7a9f6861aa09fa4c5|https://archive.ubuntu.com/ubuntu/pool/main/b/bzip2/libbz2-dev_1.0.8-5.1build0.1_amd64.deb",
  "libdeflate0_1.19-1build1.1_amd64.deb|libdeflate0|1.19-1build1.1|amd64|43914|8e7dfa9e63a9b5058071b84da48bb2e30dea07de169e80fbc759fe0e68639269|https://archive.ubuntu.com/ubuntu/pool/main/libd/libdeflate/libdeflate0_1.19-1build1.1_amd64.deb",
  "libdeflate-dev_1.19-1build1.1_amd64.deb|libdeflate-dev|1.19-1build1.1|amd64|50936|78eed26d8875d0e5457d08c18d1ace9ba784f6cf84665cd2d4cba30530fb11c7|https://archive.ubuntu.com/ubuntu/pool/main/libd/libdeflate/libdeflate-dev_1.19-1build1.1_amd64.deb",
  "liblzma5_5.6.1+really5.4.5-1ubuntu0.3_amd64.deb|liblzma5|5.6.1+really5.4.5-1ubuntu0.3|amd64|127352|d2eabd41ca77d2c2dd9d5d4ef478cccb64ffde6279c47cf4699a857d46785a52|https://archive.ubuntu.com/ubuntu/pool/main/x/xz-utils/liblzma5_5.6.1+really5.4.5-1ubuntu0.3_amd64.deb",
  "liblzma-dev_5.6.1+really5.4.5-1ubuntu0.3_amd64.deb|liblzma-dev|5.6.1+really5.4.5-1ubuntu0.3|amd64|176166|a36f21970809e5ec58b6fb1186b1a819276f92c081eb109aeebf00e82e78d068|https://archive.ubuntu.com/ubuntu/pool/main/x/xz-utils/liblzma-dev_5.6.1+really5.4.5-1ubuntu0.3_amd64.deb",
  "libopenblas0-pthread_0.3.26+ds-1ubuntu0.1_amd64.deb|libopenblas0-pthread|0.3.26+ds-1ubuntu0.1|amd64|7183128|7dc3b4384c02aecb87eb8b70fa26c5843a08af242f4638aa4b36922bdc4f5b04|https://archive.ubuntu.com/ubuntu/pool/universe/o/openblas/libopenblas0-pthread_0.3.26+ds-1ubuntu0.1_amd64.deb",
  "libopenblas0_0.3.26+ds-1ubuntu0.1_amd64.deb|libopenblas0|0.3.26+ds-1ubuntu0.1|amd64|6190|ecadb5ba865e59a3eeafdad7f15908e59cdd827a80033d12bcc54ebddc72f5ae|https://archive.ubuntu.com/ubuntu/pool/universe/o/openblas/libopenblas0_0.3.26+ds-1ubuntu0.1_amd64.deb",
  "libopenblas-pthread-dev_0.3.26+ds-1ubuntu0.1_amd64.deb|libopenblas-pthread-dev|0.3.26+ds-1ubuntu0.1|amd64|4898570|01ae4d0433927e4109ae614c047f9df55dc3c8515e6369423f36f5e18d59101e|https://archive.ubuntu.com/ubuntu/pool/universe/o/openblas/libopenblas-pthread-dev_0.3.26+ds-1ubuntu0.1_amd64.deb",
  "libopenblas-dev_0.3.26+ds-1ubuntu0.1_amd64.deb|libopenblas-dev|0.3.26+ds-1ubuntu0.1|amd64|19590|3e4f39838e163d35bc7778fb3bec4f4d5ce2ae3e8e081dec49759217282c4770|https://archive.ubuntu.com/ubuntu/pool/universe/o/openblas/libopenblas-dev_0.3.26+ds-1ubuntu0.1_amd64.deb",
  "libpaper1_1.1.29build1_amd64.deb|libpaper1|1.1.29build1|amd64|13414|63d0cc29eda7adc7d9269273e9b5542b8b6aacabc5e7caaa859995269bfe3cff|https://archive.ubuntu.com/ubuntu/pool/main/libp/libpaper/libpaper1_1.1.29build1_amd64.deb",
  "libpaper-utils_1.1.29build1_amd64.deb|libpaper-utils|1.1.29build1|amd64|8650|364e323bc54ecf17c0301ee51a07b1bdc9fe6646e5126b8ddb3bed6ff008b2e9|https://archive.ubuntu.com/ubuntu/pool/main/libp/libpaper/libpaper-utils_1.1.29build1_amd64.deb",
  "libpthread-stubs0-dev_0.4-1build3_amd64.deb|libpthread-stubs0-dev|0.4-1build3|amd64|4746|b8f278da7b1907d3014c01f9bc89748208a8cd3b770f0f55f1528afcc98dc6c0|https://archive.ubuntu.com/ubuntu/pool/main/libp/libpthread-stubs/libpthread-stubs0-dev_0.4-1build3_amd64.deb",
  "libtirpc3t64_1.3.4+ds-1.1build1_amd64.deb|libtirpc3t64|1.3.4+ds-1.1build1|amd64|82558|3a3cd37160399ab235fdf2f13159fd288940abb9660e0ed1afb418b44c73d43a|https://archive.ubuntu.com/ubuntu/pool/main/libt/libtirpc/libtirpc3t64_1.3.4+ds-1.1build1_amd64.deb",
  "libtirpc-dev_1.3.4+ds-1.1build1_amd64.deb|libtirpc-dev|1.3.4+ds-1.1build1|amd64|193418|439322bbb8d0b1d44f92593edb6c8ba9693bcfb3b5f1f3bd152998f42cdf7a5d|https://archive.ubuntu.com/ubuntu/pool/main/libt/libtirpc/libtirpc-dev_1.3.4+ds-1.1build1_amd64.deb",
  "libxau6_1.0.9-1build6_amd64.deb|libxau6|1:1.0.9-1build6|amd64|7160|e40d29f1d1a62393bacaedebe0da3d9006084152a9f7e5e029293f08ce1c5c80|https://archive.ubuntu.com/ubuntu/pool/main/libx/libxau/libxau6_1.0.9-1build6_amd64.deb",
  "libxdmcp6_1.1.3-0ubuntu6_amd64.deb|libxdmcp6|1:1.1.3-0ubuntu6|amd64|10254|bcd336fce11ce2a45f34d0f95e6980af22529f22147e8f98c156e5cee8ee42bb|https://archive.ubuntu.com/ubuntu/pool/main/libx/libxdmcp/libxdmcp6_1.1.3-0ubuntu6_amd64.deb",
  "libxcb1_1.15-1ubuntu2_amd64.deb|libxcb1|1.15-1ubuntu2|amd64|47730|e1c6611d11ad7398326f1bf028afc34c3b14c51d917a3426b966ed4b9687fa58|https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcb/libxcb1_1.15-1ubuntu2_amd64.deb",
  "libx11-6_1.8.7-1build1_amd64.deb|libx11-6|2:1.8.7-1build1|amd64|649780|397f84347476a3c5786b39f3ff6f0f82866eb3d8be6d2ad3efeadf019efe5b80|https://archive.ubuntu.com/ubuntu/pool/main/libx/libx11/libx11-6_1.8.7-1build1_amd64.deb",
  "xorg-sgml-doctools_1.11-1.1_all.deb|xorg-sgml-doctools|1:1.11-1.1|all|10936|277f662c6d94606c22078f2af82ac1b6e01386d5a4dec6ca7487bca4c5b23c07|https://archive.ubuntu.com/ubuntu/pool/main/x/xorg-sgml-doctools/xorg-sgml-doctools_1.11-1.1_all.deb",
  "x11proto-dev_2023.2-1_all.deb|x11proto-dev|2023.2-1|all|602398|3bf13a2ffb79ecd4014d438936014e5863f79eb59ebf76e8f43356271c90e7ce|https://archive.ubuntu.com/ubuntu/pool/main/x/xorgproto/x11proto-dev_2023.2-1_all.deb",
  "libxau-dev_1.0.9-1build6_amd64.deb|libxau-dev|1:1.0.9-1build6|amd64|9570|46783c6af2d87c06394d55dfaa21dac07396f13cfc5ea6afbd9313ab49fc0e50|https://archive.ubuntu.com/ubuntu/pool/main/libx/libxau/libxau-dev_1.0.9-1build6_amd64.deb",
  "libxdmcp-dev_1.1.3-0ubuntu6_amd64.deb|libxdmcp-dev|1:1.1.3-0ubuntu6|amd64|26546|ba2f2230b391c292f5f399d6e04d48181be6b3100556f7870591ca95c9d00667|https://archive.ubuntu.com/ubuntu/pool/main/libx/libxdmcp/libxdmcp-dev_1.1.3-0ubuntu6_amd64.deb",
  "libxcb1-dev_1.15-1ubuntu2_amd64.deb|libxcb1-dev|1.15-1ubuntu2|amd64|85790|1bafe3432feafc9e57f858721da524dfb3ee1f6fc4ef6b0c73023e79eadb9c28|https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcb/libxcb1-dev_1.15-1ubuntu2_amd64.deb",
  "xtrans-dev_1.4.0-1_all.deb|xtrans-dev|1.4.0-1|all|68900|45277c51d5d83db351b61859314b59595c9626ac372fbb2fc0d5542e169d9086|https://archive.ubuntu.com/ubuntu/pool/main/x/xtrans/xtrans-dev_1.4.0-1_all.deb",
  "libx11-dev_1.8.7-1build1_amd64.deb|libx11-dev|2:1.8.7-1build1|amd64|732214|1969e200607ffe34070b92fe1bd3ba76ac2e2bd2f3a54530800c5872076fad24|https://archive.ubuntu.com/ubuntu/pool/main/libx/libx11/libx11-dev_1.8.7-1build1_amd64.deb",
  "r-4.5.3_1_amd64.deb|r-4.5.3|1|amd64|67491866|93a403f207fa6c8d50754106097f551ba0c55c5b756363d070ac76e880334ca8|https://cdn.posit.co/r/ubuntu-2404/pkgs/r-4.5.3_1_amd64.deb"
]);

function assertR45PullRequestOwner(job, { lockName, testCommand }) {
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 20);
  assert.match(job.if, /classify\.result != 'success'/u);
  assert.match(job.if, /r_contract_required != 'false'/u);

  const setup = stepsUsing(job, "r-lib/actions/setup-r@");
  assert.equal(setup.length, 1);
  assert.equal(setup[0].uses, SETUP_R);
  assert.deepEqual(setup[0].with, {
    "r-version": "4.5.3",
    "install-r": false,
    "use-public-rspm": false
  });

  const provisioningSteps = job.steps.filter((step) => step.name === "Install the authenticated R 4.5.3 runtime");
  assert.equal(provisioningSteps.length, 1);
  const provisioning = provisioningSteps[0];
  assert.ok(job.steps.indexOf(provisioning) < job.steps.indexOf(setup[0]));
  assert.equal(provisioning.if, undefined);
  assert.equal(provisioning["continue-on-error"], undefined);
  const run = provisioning.run;
  assert.equal(typeof run, "string");
  assert.ok(run.startsWith("set -euo pipefail\nexport LC_ALL=C\n"));
  assert.equal(
    run.split("provisioning_checkpoint() {\n  printf 'R 4.5.3 provisioning checkpoint: %s\\n' \"$1\"\n}\n").length - 1,
    1
  );
  assert.deepEqual(
    [...run.matchAll(/^[ ]*provisioning_checkpoint "([^"]+)"$/gmu)].map((match) => match[1]),
    [
      "offline install complete",
      "package database audit command",
      "package database audit output bound",
      "package database audit output empty",
      "package ${package}",
      "libx11-dev package",
      "R library directory not a symlink",
      "R library directory type",
      "R shared object ${ldd_index} not a symlink",
      "R shared object ${ldd_index} type",
      "R shared object ${ldd_index} dependency command",
      "R shared object ${ldd_index} output bound",
      "R shared object ${ldd_index} dependencies resolved",
      "R shared object count",
      "R package status",
      "R version",
      "R executable path export",
      "complete"
    ]
  );
  assert.doesNotMatch(run, /provisioning_checkpoint[^\n]*(?:\|\||;)[ ]*(?:true|:)/u);
  assert.match(run, /^readonly artifact_count="27"$/mu);
  assert.match(run, /^readonly artifact_bytes="82619754"$/mu);
  assert.match(run, /^readonly artifact_dir="\$\(mktemp -d "\$\{RUNNER_TEMP\}\/openwrangler-r-4\.5\.3-XXXXXX"\)"$/mu);
  const manifestMatch = run.match(/readonly artifact_manifest="\$\(cat <<'ARTIFACTS'\n([\s\S]+?)\nARTIFACTS\n\)"/u);
  assert.ok(manifestMatch);
  const manifest = manifestMatch[1].split("\n");
  assert.deepEqual(manifest, R_45_ARTIFACT_MANIFEST);
  assert.equal(manifest.length, 27);
  assert.equal(
    manifest.reduce((total, line) => total + Number(line.split("|")[4]), 0),
    82_619_754
  );
  assert.equal(new Set(manifest.map((line) => line.split("|")[0])).size, manifest.length);
  assert.equal(new Set(manifest.map((line) => line.split("|")[1])).size, manifest.length);
  for (const line of manifest) {
    const [filename, packageName, version, architecture, size, digest, url] = line.split("|");
    assert.equal(filename.endsWith(".deb"), true);
    assert.notEqual(packageName, "");
    assert.notEqual(version, "");
    assert.match(architecture, /^(?:all|amd64)$/u);
    assert.match(size, /^[1-9][0-9]*$/u);
    assert.match(digest, /^[0-9a-f]{64}$/u);
    if (packageName === "r-4.5.3") {
      assert.equal(url, "https://cdn.posit.co/r/ubuntu-2404/pkgs/r-4.5.3_1_amd64.deb");
    } else {
      assert.match(url, /^https:\/\/archive\.ubuntu\.com\/ubuntu\/pool\//u);
    }
  }
  assert.equal(manifest.filter((line) => line.includes("|libx11-dev|2:1.8.7-1build1|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|libbz2-1.0|1.0.8-5.1build0.1|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|libdeflate0|1.19-1build1.1|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|liblzma5|5.6.1+really5.4.5-1ubuntu0.3|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|libtirpc3t64|1.3.4+ds-1.1build1|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|libx11-6|2:1.8.7-1build1|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|libxau6|1:1.0.9-1build6|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|libxcb1|1.15-1ubuntu2|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|libxdmcp6|1:1.1.3-0ubuntu6|amd64|")).length, 1);
  assert.equal(manifest.filter((line) => line.includes("|r-4.5.3|1|amd64|67491866|")).length, 1);
  assert.match(run, /timeout --signal=TERM --kill-after=10s 300s bash -c '\n[ ]{2}set -euo pipefail/u);
  const curlInvocations = [...run.matchAll(/(?<![A-Za-z0-9_-])curl(?=\s)/gu)];
  assert.equal(curlInvocations.length, 1);
  const curlIndex = curlInvocations[0].index;
  assert.match(
    run,
    /timeout --signal=TERM --kill-after=5s 180s \\\n+[ ]{6}curl --fail --location --proto "=https" --tlsv1\.2 --connect-timeout 20 --max-time 175 --max-filesize "\$size" \\\n+[ ]{6}--output "\$artifact_path" "\$url"/u
  );
  assert.equal(run.match(/read -r actual_sha256 _ < <\(sha256sum -- "\$artifact_path"\)/gu)?.length, 2);
  assert.equal(run.match(/dpkg-deb --field "\$artifact_path" Package/gu)?.length, 2);
  assert.equal(run.match(/dpkg-deb --field "\$artifact_path" Version/gu)?.length, 2);
  assert.equal(run.match(/dpkg-deb --field "\$artifact_path" Architecture/gu)?.length, 2);
  assert.equal(run.match(/stat --format=["']%d:%i:%f:%h["'] -- "\$artifact_path"/gu)?.length, 4);
  const validationStarts = [
    ...run.matchAll(/while IFS="\|" read -r filename package version architecture size sha256 url; do/gu)
  ].map((match) => match.index);
  assert.equal(validationStarts.length, 3);
  const downloadLoopEnd = run.indexOf(`' bash "$artifact_dir" <<< "$artifact_manifest"`);
  assert.ok(validationStarts[0] < curlIndex && curlIndex < downloadLoopEnd);
  const installIndex = run.indexOf('dpkg --install -- "${install_paths[@]}"');
  assert.ok(validationStarts[1] < installIndex && installIndex < validationStarts[2]);
  assert.match(
    run,
    /test "\$verified_count" = "\$artifact_count"\ntest "\$verified_bytes" = "\$artifact_bytes"\ntest "\$\(find "\$artifact_dir" -mindepth 1 -maxdepth 1 \| wc -l\)" = "\$artifact_count"\nsudo --non-interactive timeout --signal=TERM --kill-after=10s 180s \\\n+[ ]{2}dpkg --install -- "\$\{install_paths\[@\]\}"/u
  );
  assert.match(
    run,
    /^provisioning_checkpoint "offline install complete"\ndpkg_audit_path="\$\{artifact_dir\}\/dpkg-audit\.txt"\nprovisioning_checkpoint "package database audit command"\ntimeout --signal=TERM --kill-after=5s 30s dpkg --audit \| head --bytes=65537 > "\$dpkg_audit_path"\ndpkg_audit_size="\$\(stat --format='%s' -- "\$dpkg_audit_path"\)"\nprovisioning_checkpoint "package database audit output bound"\ntest "\$dpkg_audit_size" -le 65536\nprovisioning_checkpoint "package database audit output empty"\ntest ! -s "\$dpkg_audit_path"$/mu
  );
  const auditIndex = run.indexOf('dpkg --audit | head --bytes=65537 > "$dpkg_audit_path"');
  const bareDpkgInvocations = [...run.matchAll(/(?<![A-Za-z0-9_-])dpkg(?=\s)/gu)];
  assert.deepEqual(
    bareDpkgInvocations.map((match) => match.index),
    [installIndex, auditIndex]
  );
  assert.match(
    run,
    /[ ]{2}provisioning_checkpoint "package \$\{package\}"\n[ ]{2}test "\$\(dpkg-query --show --showformat='\$\{Status\}\|\$\{Version\}\|\$\{Architecture\}' "\$package"\)" = \\\n+[ ]{4}"install ok installed\|\$\{version\}\|\$\{architecture\}"/u
  );
  assert.match(
    run,
    /provisioning_checkpoint "libx11-dev package"\ntest "\$\(dpkg-query --show --showformat='\$\{Status\}\|\$\{Version\}\|\$\{Architecture\}' libx11-dev\)" = \\\n+[ ]{2}"install ok installed\|2:1\.8\.7-1build1\|amd64"/u
  );
  assert.match(
    run,
    /readonly r_library_dir="\/opt\/R\/4\.5\.3\/lib\/R\/lib"\nprovisioning_checkpoint "R library directory not a symlink"\ntest ! -L "\$r_library_dir"\nprovisioning_checkpoint "R library directory type"\ntest -d "\$r_library_dir"/u
  );
  assert.match(
    run,
    /for r_binary in \/opt\/R\/4\.5\.3\/lib\/R\/bin\/exec\/R \/opt\/R\/4\.5\.3\/lib\/R\/lib\/libR\.so; do/u
  );
  assert.match(
    run,
    /ldd_index=0\nfor r_binary[\s\S]+?provisioning_checkpoint "R shared object \$\{ldd_index\} dependency command"\n[ ]{2}timeout --signal=TERM --kill-after=5s 30s \\\n[ ]{4}env LD_LIBRARY_PATH="\$\{r_library_dir\}\$\{LD_LIBRARY_PATH:\+:\$\{LD_LIBRARY_PATH\}\}" ldd "\$r_binary" \| \\\n[ ]{4}head --bytes=65537 > "\$ldd_output_path"\n[ ]{2}ldd_output_size="\$\(stat --format='%s' -- "\$ldd_output_path"\)"\n[ ]{2}provisioning_checkpoint "R shared object \$\{ldd_index\} output bound"\n[ ]{2}test "\$ldd_output_size" -le 65536\n[ ]{2}provisioning_checkpoint "R shared object \$\{ldd_index\} dependencies resolved"\n[ ]{2}while IFS= read -r dependency_line; do\n[ ]{4}case "\$dependency_line" in \*"not found"\*\) exit 1 ;; esac\n[ ]{2}done < "\$ldd_output_path"\n[ ]{2}ldd_index=\$\(\(ldd_index \+ 1\)\)\ndone\nprovisioning_checkpoint "R shared object count"\ntest "\$ldd_index" = "2"/u
  );
  assert.match(
    run,
    /test "\$\(dpkg-query --show --showformat='\$\{Status\}\|\$\{Version\}\|\$\{Architecture\}' r-4\.5\.3\)" = \\\n+[ ]{2}"install ok installed\|1\|amd64"/u
  );
  assert.equal(
    run.split(`test "$(/opt/R/4.5.3/bin/Rscript --vanilla -e 'cat(as.character(getRversion()))')" = "4.5.3"`).length -
      1,
    1
  );
  assert.match(run, /printf '%s\\n' '\/opt\/R\/4\.5\.3\/bin' >> "\$GITHUB_PATH"/u);
  assert.doesNotMatch(run, /\b(?:apt|apt-get|gdebi|gdebi-core|devscripts|qpdf|ghostscript)\b/u);
  assert.doesNotMatch(run, /(?:dists\/|Packages(?:\.(?:gz|xz|zst))?|InRelease|Release\.gpg)/u);

  const source = JSON.stringify(job);
  assert.equal(source.split(lockName).length - 1, 2);
  assert.match(source, /r-dependency-lock\.mjs prepare/u);
  assert.match(source, /r-dependency-lock\.mjs install/u);
  assert.match(source, /cache-hit/u);
  assert.match(source, /--archives/u);
  assert.doesNotMatch(source, /setup-r-dependencies/u);
  assert.doesNotMatch(source, /\/latest\//u);
  const restore = stepsUsing(job, "actions/cache/restore@")[0];
  const save = stepsUsing(job, "actions/cache/save@")[0];
  assert.equal(restore.uses, CACHE_RESTORE);
  assert.equal(save.uses, CACHE_SAVE);
  assert.equal(restore.with["restore-keys"], undefined);
  assert.equal(restore.with.path, "${{ steps.r_prepare.outputs.archives }}");
  assert.equal(save.with.path, "${{ steps.r_prepare.outputs.archives }}");
  assert.doesNotMatch(JSON.stringify(restore.with.path), /library|receipt/u);
  assert.doesNotMatch(JSON.stringify(save.with.path), /library|receipt/u);
  assert.deepEqual(stepRunning(job, testCommand).env, {
    R_LIBS_USER: "${{ steps.r_prepare.outputs.library }}"
  });
}

test("both R 4.5 pull-request owners install the authenticated runtime and preserve the exact lock", () => {
  for (const contract of R_45_OWNER_CONTRACTS) {
    assertR45PullRequestOwner(ci.jobs[contract.jobId], contract);
  }

  const mutateProvisioning = (job, transform) => {
    const step = job.steps.find((candidate) => candidate.name === "Install the authenticated R 4.5.3 runtime");
    step.run = transform(step.run);
  };
  const removeSecond = (source, needle) => {
    const first = source.indexOf(needle);
    const second = source.indexOf(needle, first + needle.length);
    assert.ok(first >= 0 && second > first);
    return source.slice(0, second) + source.slice(second + needle.length);
  };
  const mutations = [
    (job) => (job["runs-on"] = "ubuntu-latest"),
    (job) => (stepsUsing(job, "r-lib/actions/setup-r@")[0].with["r-version"] = "4.5"),
    (job) => delete stepsUsing(job, "r-lib/actions/setup-r@")[0].with["install-r"],
    (job) => (stepsUsing(job, "r-lib/actions/setup-r@")[0].with["install-r"] = true),
    (job) => (stepsUsing(job, "r-lib/actions/setup-r@")[0].with["use-public-rspm"] = true),
    (job) => (job["timeout-minutes"] = 21),
    (job) => mutateProvisioning(job, (run) => run.replace("set -euo pipefail\n", "")),
    (job) => mutateProvisioning(job, (run) => run.replace(R_45_ARTIFACT_MANIFEST[0] + "\n", "")),
    (job) =>
      mutateProvisioning(job, (run) => run.replace("ARTIFACTS\n)", R_45_ARTIFACT_MANIFEST[0] + "\nARTIFACTS\n)")),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          R_45_ARTIFACT_MANIFEST[0] + "\n" + R_45_ARTIFACT_MANIFEST[1],
          R_45_ARTIFACT_MANIFEST[1] + "\n" + R_45_ARTIFACT_MANIFEST[0]
        )
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace("libx11-dev_1.8.7-1build1_amd64.deb|", "libx11-dev_1.8.7-1build2_amd64.deb|")
      ),
    (job) => mutateProvisioning(job, (run) => run.replace("|libx11-dev|", "|libx11-devel|")),
    (job) => mutateProvisioning(job, (run) => run.replace("|2:1.8.7-1build1|", "|2:1.8.7-1build2|")),
    (job) =>
      mutateProvisioning(job, (run) => run.replace("|libbz2-1.0|1.0.8-5.1build0.1|", "|libbz2-1.0|1.0.8-5.1build0.2|")),
    (job) => mutateProvisioning(job, (run) => run.replace("|amd64|732214|", "|all|732214|")),
    (job) => mutateProvisioning(job, (run) => run.replace("|732214|1969e200", "|732215|1969e200")),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace("1969e200607ffe34070b92fe1bd3ba76ac2e2bd2f3a54530800c5872076fad24", "0".repeat(64))
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          "https://archive.ubuntu.com/ubuntu/pool/main/libx/libx11/",
          "https://example.invalid/ubuntu/pool/main/libx/libx11/"
        )
      ),
    (job) =>
      mutateProvisioning(job, (run) => run.replace('readonly artifact_count="27"', 'readonly artifact_count="26"')),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace('readonly artifact_bytes="82619754"', 'readonly artifact_bytes="82619753"')
      ),
    (job) =>
      mutateProvisioning(job, (run) => run.replace("timeout --signal=TERM --kill-after=10s 300s bash -c", "bash -c")),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace("timeout --signal=TERM --kill-after=5s 180s \\\n      curl", "curl")
      ),
    (job) => mutateProvisioning(job, (run) => run.replace(' --max-filesize "$size"', "")),
    (job) => mutateProvisioning(job, (run) => run.replace('--max-filesize "$size"', '--max-filesize "1"')),
    (job) =>
      mutateProvisioning(
        job,
        (run) => run + '\ncurl --output "${artifact_dir}/unbounded.deb" "https://example.invalid/unbounded.deb"\n'
      ),
    (job) =>
      mutateProvisioning(
        job,
        (run) =>
          run +
          '\ntimeout --signal=TERM --kill-after=5s 180s /usr/bin/curl --fail --max-time 175 --max-filesize "1" --output "${artifact_dir}/alias.deb" "https://example.invalid/alias.deb"\n'
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        removeSecond(run, 'test "$(dpkg-deb --field "$artifact_path" Architecture)" = "$architecture"\n')
      ),
    (job) => mutateProvisioning(job, (run) => run + "sudo apt-get update\n"),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          "sudo --non-interactive timeout --signal=TERM --kill-after=10s 180s \\\n  dpkg --install",
          "sudo --non-interactive dpkg --install"
        )
      ),
    (job) => mutateProvisioning(job, (run) => run + '\nsudo dpkg -i -- "${install_paths[@]}"\n'),
    (job) => mutateProvisioning(job, (run) => run + '\nsudo dpkg --unpack -- "${install_paths[@]}"\n'),
    (job) => mutateProvisioning(job, (run) => run + '\nsudo dpkg --force-all --install -- "${install_paths[@]}"\n'),
    (job) => mutateProvisioning(job, (run) => run + '\nsudo dpkg --root=/tmp --unpack -- "${install_paths[@]}"\n'),
    (job) =>
      mutateProvisioning(
        job,
        (run) =>
          run +
          '\nsudo --non-interactive timeout --signal=TERM --kill-after=10s 180s dpkg --install -- "${install_paths[@]}"\n'
      ),
    (job) => mutateProvisioning(job, (run) => run.replace("dpkg --audit | head", "dpkg --root=/tmp --audit | head")),
    (job) =>
      mutateProvisioning(job, (run) => run.replace("dpkg --audit | head", "dpkg --admindir=/tmp --audit | head")),
    (job) => mutateProvisioning(job, (run) => run + "\ndpkg --version\n"),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          'timeout --signal=TERM --kill-after=5s 30s dpkg --audit | head --bytes=65537 > "$dpkg_audit_path"\n',
          'true > "$dpkg_audit_path"\n'
        )
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace('head --bytes=65537 > "$dpkg_audit_path"', 'head --bytes=65536 > "$dpkg_audit_path"')
      ),
    (job) => mutateProvisioning(job, (run) => run.replace('test "$dpkg_audit_size" -le 65536\n', "")),
    (job) => mutateProvisioning(job, (run) => run.replace('test ! -s "$dpkg_audit_path"\n', "")),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          "printf 'R 4.5.3 provisioning checkpoint: %s\\n' \"$1\"\n",
          "printf 'R 4.5.3 provisioning checkpoint: %s\\n' \"$1\" || true\n"
        )
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace('provisioning_checkpoint "package database audit output empty"\n', "")
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          'test "$(dpkg-query --show --showformat=\'${Status}|${Version}|${Architecture}\' "$package")" = \\\n    "install ok installed|${version}|${architecture}"\n',
          ""
        )
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          'test "$(dpkg-query --show --showformat=\'${Status}|${Version}|${Architecture}\' libx11-dev)" = \\\n  "install ok installed|2:1.8.7-1build1|amd64"\n',
          ""
        )
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          'timeout --signal=TERM --kill-after=5s 30s \\\n    env LD_LIBRARY_PATH="${r_library_dir}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}" ldd "$r_binary" | \\\n    head --bytes=65537 > "$ldd_output_path"\n',
          'true > "$ldd_output_path"\n'
        )
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          'env LD_LIBRARY_PATH="${r_library_dir}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}" ldd "$r_binary"',
          'ldd "$r_binary"'
        )
      ),
    (job) => mutateProvisioning(job, (run) => run.replace('readonly r_library_dir="/opt/R/4.5.3/lib/R/lib"\n', "")),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace('provisioning_checkpoint "R shared object ${ldd_index} dependencies resolved"\n', "")
      ),
    (job) => mutateProvisioning(job, (run) => run.replace('test "$ldd_output_size" -le 65536\n', "")),
    (job) =>
      mutateProvisioning(job, (run) => run.replace('case "$dependency_line" in *"not found"*) exit 1 ;; esac\n', "")),
    (job) => mutateProvisioning(job, (run) => run.replace('test "$ldd_index" = "2"\n', "")),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          'test "$(dpkg-query --show --showformat=\'${Status}|${Version}|${Architecture}\' r-4.5.3)" = \\\n  "install ok installed|1|amd64"\n',
          ""
        )
      ),
    (job) =>
      mutateProvisioning(job, (run) =>
        run.replace(
          'test "$(/opt/R/4.5.3/bin/Rscript --vanilla -e \'cat(as.character(getRversion()))\')" = "4.5.3"\n',
          ""
        )
      ),
    (job) => (stepRunning(job, "npm run test:r-contract -- --shard kernel-agent").run = "npm run test:r-contract"),
    (job) =>
      (job.steps.find((step) => String(step.run).includes("r-dependency-lock.mjs prepare")).run = job.steps
        .find((step) => String(step.run).includes("r-dependency-lock.mjs prepare"))
        .run.replace("ubuntu-24.04-x86_64-r-4.5.lock.json", "ubuntu-24.04-x86_64-r-4.4.lock.json")),
    (job) => (stepsUsing(job, "actions/cache/restore@")[0].with.path = "${{ steps.r_prepare.outputs.library }}"),
    (job) => (stepsUsing(job, "actions/cache/restore@")[0].with["restore-keys"] = "openwrangler-r-contract-")
  ];
  for (const [index, mutate] of mutations.entries()) {
    const document = structuredClone(ci);
    const job = document.jobs["r-contract-kernel"];
    mutate(job);
    assert.throws(
      () => assertR45PullRequestOwner(job, R_45_OWNER_CONTRACTS[0]),
      `R 4.5 provisioning mutation ${index} was not rejected`
    );
  }
});

test("conditional owners fail open to run while sole validate owner requires exact selected outcomes", () => {
  for (const jobId of [
    "r-contract-kernel",
    "r-contract-protocol",
    "canonical-editor",
    "visual-accessibility",
    "windows-unique"
  ]) {
    assert.match(ci.jobs[jobId].if, /classify\.result != 'success'/u);
    assert.match(ci.jobs[jobId].if, /!= 'false'/u);
  }
  assertChangedAreaOwnersStartAfterClassification(ci);
  assertValidateOwner(ci);
});

test("changed-area owners start beside the invariant core and reject a restored serial dependency", () => {
  for (const jobId of Object.keys(CHANGED_AREA_OWNER_OUTPUTS)) {
    const serialDependency = structuredClone(ci);
    serialDependency.jobs[jobId].needs = ["classify", "invariant-core"];
    assert.throws(() => assertChangedAreaOwnersStartAfterClassification(serialDependency));

    const serialCondition = structuredClone(ci);
    serialCondition.jobs[jobId].if = serialCondition.jobs[jobId].if.replace(
      "github.event_name == 'pull_request' &&",
      "github.event_name == 'pull_request' && needs.invariant-core.result == 'success' &&"
    );
    assert.throws(() => assertChangedAreaOwnersStartAfterClassification(serialCondition));

    const missingClassifier = structuredClone(ci);
    missingClassifier.jobs[jobId].needs = [];
    assert.throws(() => assertChangedAreaOwnersStartAfterClassification(missingClassifier));

    const changedSelection = structuredClone(ci);
    changedSelection.jobs[jobId].if = changedSelection.jobs[jobId].if.replace("!= 'false'", "== 'true'");
    assert.throws(() => assertChangedAreaOwnersStartAfterClassification(changedSelection));
  }
});

test("validate always evaluates the exact PR-only result fan-in", () => {
  for (const condition of [
    "${{ !cancelled() && github.event_name == 'pull_request' }}",
    "${{ success() && github.event_name == 'pull_request' }}",
    "${{ github.event_name == 'pull_request' }}"
  ]) {
    const mutated = structuredClone(ci);
    mutated.jobs.validate.if = condition;
    assert.throws(() => assertValidateOwner(mutated));
  }
  const omitted = structuredClone(ci);
  delete omitted.jobs.validate.if;
  assert.throws(() => assertValidateOwner(omitted));

  const topologyDrift = structuredClone(ci);
  topologyDrift.jobs.validate.needs.pop();
  assert.throws(() => assertValidateOwner(topologyDrift));

  const resultInputDrift = structuredClone(ci);
  const gate = stepRunning(resultInputDrift.jobs.validate, "node scripts/require-ci-results.mjs");
  gate.env.WINDOWS_UNIQUE_RESULT = "${{ needs.invariant-core.result }}";
  assert.throws(() => assertValidateOwner(resultInputDrift));
});

test("required result owner rejects missing, skipped, cancelled, failed, and selection drift", () => {
  assert.deepEqual(ALWAYS_REQUIRED_CI_JOBS, ["classify", "invariant-core"]);
  assert.deepEqual(REQUIRED_CI_JOBS, [
    "classify",
    "invariant-core",
    "r-contract-kernel",
    "r-contract-protocol",
    "canonical-editor",
    "visual-accessibility",
    "windows-unique"
  ]);
  assert.doesNotThrow(() =>
    requireCiResults({
      requiredResults: expectedResults(),
      classificationResult: "success",
      selections: BOOLEAN_OUTPUTS
    })
  );
  const none = Object.fromEntries(Object.keys(BOOLEAN_OUTPUTS).map((key) => [key, false]));
  assert.doesNotThrow(() =>
    requireCiResults({
      requiredResults: expectedResults(none),
      classificationResult: "success",
      selections: none
    })
  );
  for (const jobId of REQUIRED_CI_JOBS) {
    for (const result of [undefined, "skipped", "cancelled", "failure"]) {
      const requiredResults = expectedResults();
      requiredResults[jobId] = result;
      assert.throws(
        () => requireCiResults({ requiredResults, classificationResult: "success", selections: BOOLEAN_OUTPUTS }),
        new RegExp(jobId, "u")
      );
    }
  }
  assert.throws(
    () =>
      requireCiResults({
        requiredResults: expectedResults(),
        classificationResult: "failure",
        selections: BOOLEAN_OUTPUTS
      }),
    /classify/u
  );
  assert.equal(parseRequiredFlag("true", "FLAG"), true);
  assert.equal(parseRequiredFlag("false", "FLAG"), false);
  assert.throws(() => parseRequiredFlag("", "FLAG"), /exactly true or false/u);
  assert.equal(resultEnvironmentKey("r-contract-kernel"), "R_CONTRACT_KERNEL_RESULT");
});

test("Cross is manual and scheduled only with exact platform and R 4.4 owners", () => {
  assertCrossScheduledOwners(cross);

  const pullRequestDrift = structuredClone(cross);
  pullRequestDrift.on.pull_request = { branches: ["main"] };
  assert.throws(() => assertCrossScheduledOwners(pullRequestDrift));

  const classifierDrift = structuredClone(cross);
  classifierDrift.jobs.classify = { runsOn: "ubuntu-latest" };
  assert.throws(() => assertCrossScheduledOwners(classifierDrift));

  const missingManual = structuredClone(cross);
  delete missingManual.on.workflow_dispatch;
  assert.throws(() => assertCrossScheduledOwners(missingManual));

  const missingSchedule = structuredClone(cross);
  delete missingSchedule.on.schedule;
  assert.throws(() => assertCrossScheduledOwners(missingSchedule));

  const nativeConditionDrift = structuredClone(cross);
  delete stepRunning(nativeConditionDrift.jobs.runtime, "npm run test:scripts:native").if;
  assert.throws(() => assertCrossScheduledOwners(nativeConditionDrift));

  const retainedOwnerMutations = [
    (document) => {
      document.jobs.runtime.steps = document.jobs.runtime.steps.filter(
        (step) => step.run !== "python -m pytest python/tests -q"
      );
    },
    (document) => {
      stepRunning(document.jobs.runtime, "npm run test:extension-host").run = "npm run test:ts";
    },
    (document) => {
      stepRunning(
        document.jobs["dependency-guard-windows"],
        "python -m pytest python/tests/test_dependency_guard.py -q"
      ).run = "python -m pytest -q";
    },
    (document) => {
      stepsUsing(document.jobs["r-4-4-scheduled-qualification"], "r-lib/actions/setup-r@")[0].with["r-version"] = "4.5";
    },
    (document) => {
      stepsUsing(document.jobs["r-4-4-scheduled-qualification"], "r-lib/actions/setup-r@")[0].with["use-public-rspm"] =
        true;
    },
    (document) => {
      document.jobs["r-4-4-scheduled-qualification"].steps = document.jobs[
        "r-4-4-scheduled-qualification"
      ].steps.filter((step) => step.id !== "r_prepare");
    },
    (document) => {
      const install = document.jobs["r-4-4-scheduled-qualification"].steps.find((step) =>
        String(step.run ?? "").includes("r-dependency-lock.mjs install")
      );
      install.run = install.run.replace("steps.r_prepare.outputs.archives", "steps.r_cache.outputs.archives");
    },
    (document) => {
      stepsUsing(document.jobs["r-4-4-scheduled-qualification"], "actions/cache/restore@")[0].with["restore-keys"] =
        "openwrangler-r-";
    },
    (document) => {
      stepRunning(document.jobs["r-4-4-scheduled-qualification"], "npm run test:r-contract").env.R_LIBS_USER =
        "$RUNNER_TEMP/unverified-library";
    }
  ];
  for (const mutate of retainedOwnerMutations) {
    const drift = structuredClone(cross);
    mutate(drift);
    assert.throws(() => assertCrossScheduledOwners(drift));
  }
});

test("CodeQL has two always-on explicit analyzers, preserves required names, and fails closed through one gate", () => {
  assert.deepEqual(Object.keys(codeql.jobs), ["analyze-javascript-typescript", "analyze-python", "codeql-gate"]);
  assert.equal(codeql.jobs["analyze-javascript-typescript"].name, "Analyze (javascript-typescript)");
  assert.equal(codeql.jobs["analyze-python"].name, "Analyze (python)");
  for (const [jobId, language] of [
    ["analyze-javascript-typescript", "javascript-typescript"],
    ["analyze-python", "python"]
  ]) {
    const job = codeql.jobs[jobId];
    assert.equal(job.if, undefined);
    assert.equal(stepsUsing(job, "github/codeql-action/init@")[0].uses, `${CODEQL}/init@${CODEQL_SHA}`);
    assert.equal(stepsUsing(job, "github/codeql-action/init@")[0].with.languages, language);
    assert.equal(stepsUsing(job, "github/codeql-action/analyze@")[0].uses, `${CODEQL}/analyze@${CODEQL_SHA}`);
  }
  const gate = codeql.jobs["codeql-gate"];
  assert.equal(gate.if, "${{ always() }}");
  assert.deepEqual(gate.needs, ["analyze-javascript-typescript", "analyze-python"]);
  assert.match(gate.steps[0].run, /JAVASCRIPT_TYPESCRIPT_RESULT/u);
  assert.match(gate.steps[0].run, /PYTHON_RESULT/u);
  assert.equal(codeql.jobs.classify, undefined);
});

test("workflow action inventory is exact, immutable, recursive, and fail closed", () => {
  const names = repositoryWorkflowNames;
  const rows = workflowUseRows(names.map((name) => [name, workflow(name)]));
  const inventory = validateWorkflowUseRows(rows);
  assert.equal(inventory.external.length, 146);
  assert.deepEqual(inventory.local, APPROVED_LOCAL_WORKFLOW_USES);
  assertReviewedDependencyActionCallsites(rows);

  for (let index = 0; index < REVIEWED_DEPENDENCY_ACTION_CALLSITES.length; index += 1) {
    const drift = structuredClone(rows);
    const expected = REVIEWED_DEPENDENCY_ACTION_CALLSITES[index];
    const rowIndex = drift.findIndex(
      ([name, path, uses]) => name === expected[0] && path === expected[1] && uses === expected[2]
    );
    assert.notEqual(rowIndex, -1);
    drift[rowIndex][2] = SUPERSEDED_DEPENDENCY_ACTIONS.get(expected[2]);
    assert.throws(() => assertReviewedDependencyActionCallsites(drift));
  }
  const missingReviewedCallsite = rows.filter(
    ([name, path]) =>
      name !== REVIEWED_DEPENDENCY_ACTION_CALLSITES[0][0] || path !== REVIEWED_DEPENDENCY_ACTION_CALLSITES[0][1]
  );
  assert.throws(() => assertReviewedDependencyActionCallsites(missingReviewedCallsite));
  const duplicatedReviewedCallsite = [...rows, REVIEWED_DEPENDENCY_ACTION_CALLSITES[0]];
  assert.throws(() => assertReviewedDependencyActionCallsites(duplicatedReviewedCallsite));
  const movedReviewedCallsite = structuredClone(rows);
  const movedIndex = movedReviewedCallsite.findIndex(
    ([name, path]) =>
      name === REVIEWED_DEPENDENCY_ACTION_CALLSITES[0][0] && path === REVIEWED_DEPENDENCY_ACTION_CALLSITES[0][1]
  );
  movedReviewedCallsite[movedIndex][1] = "$.jobs.jupyter.steps[99].uses";
  assert.throws(() => assertReviewedDependencyActionCallsites(movedReviewedCallsite));

  const sources = names
    .map((entry) => repositoryWorkflowInventory[workflowPath(entry)].bytes.toString("utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /@(v[0-9]+|main|master)(?:\s|$)/u);
  const rejectedSetupJava = ["f2beeba1d6a0d932", "cac8325f70a8ce911775ff96"].join("");
  assert.equal(sources.includes(rejectedSetupJava), false);
  assert.ok(sources.includes(SETUP_JAVA));

  for (const uses of [42, null, { image: "alpine" }]) {
    assert.throws(
      () => validateWorkflowUseRows([["mutated.yaml", "$.jobs.test.steps[0].uses", uses]], { exactInventory: false }),
      /must be a string/u
    );
  }
  for (const uses of [
    "docker://alpine@sha256:abc",
    "owner/repository@v1",
    "owner/repository@0123456789abcdef0123456789abcdef01234567:command",
    "owner//repository@0123456789abcdef0123456789abcdef01234567"
  ]) {
    assert.throws(
      () => validateWorkflowUseRows([["mutated.yml", "$.jobs.test.steps[0].uses", uses]], { exactInventory: false }),
      /malformed external action/u
    );
  }
  assert.throws(
    () =>
      validateWorkflowUseRows(
        [["mutated.yml", "$.jobs.test.steps[0].uses", "different/action@0123456789abcdef0123456789abcdef01234567"]],
        { exactInventory: false }
      ),
    /unreviewed external action/u
  );

  const inserted = [...rows, ["ci.yml", "$.jobs.intruder.steps[0].uses", CHECKOUT]].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  assert.throws(() => validateWorkflowUseRows(inserted));
  const replaced = rows.map((row, index) => (index === 0 ? [row[0], row[1], SETUP_NODE] : row));
  assert.throws(() => validateWorkflowUseRows(replaced));
  const localDrift = rows.map((row) =>
    row[2] === "./.github/workflows/candidate-acceptance.yml"
      ? [row[0], row[1], "./.github/workflows/unreviewed.yml"]
      : row
  );
  assert.throws(() => validateWorkflowUseRows(localDrift));
});

test("dated R locks are distinct, canonical, complete 31-package binary graphs", () => {
  const paths = [
    "r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.4.lock.json",
    "r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.5.lock.json"
  ];
  const records = paths.map((path) => readLock(path));
  assert.notEqual(records[0].digest, records[1].digest);
  for (const [index, record] of records.entries()) {
    assert.equal(record.lock.qualification.rMinor, index === 0 ? "4.4" : "4.5");
    assert.equal(record.lock.packages.length, 31);
    assert.deepEqual(record.lock.roots.runtime, LOCK_ROOTS.runtime);
    assert.deepEqual(record.lock.roots.fixtures, LOCK_ROOTS.fixtures);
    const roots = [...record.lock.roots.runtime, ...record.lock.roots.fixtures];
    assert.equal(new Set(roots).size, roots.length);
    const packagesByName = new Map(record.lock.packages.map((entry) => [entry.name, entry]));
    assert.deepEqual(
      roots.map((name) => packagesByName.get(name)?.name),
      roots
    );
    assert.deepEqual(
      record.lock.packages.filter((entry) => entry.direct).map((entry) => entry.name),
      [...LOCK_ROOTS.runtime].sort()
    );
    assert.deepEqual(record.lock.systemRequirements.packages, ["libx11-dev"]);
    assert.ok(record.lock.packages.every((entry) => entry.source.kind === "binary"));
    assert.ok(record.lock.packages.every((entry) => entry.source.repositorySnapshotUrl.includes("/2026-08-14/")));
    assert.equal(sha256(record.bytes), record.digest);
  }
});

test("package scripts bind lock checks and fail-complete named R protocol shards", () => {
  const expectedProtocolCommand =
    "npm-run-all --continue-on-error --print-label test:r-contract:frame-and-interactive-transport test:r-contract:catalog-and-process-transport";
  const assertSequentialProtocolCommand = (command) => {
    assert.equal(command, expectedProtocolCommand);
    assert.doesNotMatch(command, /(?:^|\s)--parallel(?:\s|$)/u);
    assert.doesNotMatch(command, /(?:^|\s)--max-parallel(?:\s|$)/u);
  };
  assert.match(packageJson.scripts.check, /check:r-dependency-lock/u);
  assert.match(packageJson.scripts["check:r-dependency-lock"], /r-dependency-lock\.mjs check/u);
  assert.equal(
    packageJson.scripts["test:r-contract:frame-and-interactive-transport"],
    "node scripts/run-r-contract-tests.mjs --shard frame-and-interactive-transport"
  );
  assert.equal(
    packageJson.scripts["test:r-contract:catalog-and-process-transport"],
    "node scripts/run-r-contract-tests.mjs --shard catalog-and-process-transport"
  );
  assertSequentialProtocolCommand(packageJson.scripts["test:r-contract:protocol"]);
  for (const mutation of [
    expectedProtocolCommand.replace("npm-run-all", "npm-run-all --parallel --max-parallel 2"),
    expectedProtocolCommand.replace(" --continue-on-error", ""),
    expectedProtocolCommand.replace(
      "test:r-contract:frame-and-interactive-transport test:r-contract:catalog-and-process-transport",
      "test:r-contract:catalog-and-process-transport test:r-contract:frame-and-interactive-transport"
    ),
    expectedProtocolCommand.replace(" test:r-contract:frame-and-interactive-transport", ""),
    expectedProtocolCommand.replace(" test:r-contract:catalog-and-process-transport", "")
  ]) {
    assert.throws(() => assertSequentialProtocolCommand(mutation));
  }
  assert.match(packageJson.scripts["test:scripts:portable:run"], /scripts\/r-dependency-lock\.test\.mjs/u);
});

test("visual acceptance installs only the lockfile-owned Chromium before its fail-closed artifact owner", () => {
  assertVisualAccessibilityBrowserOwnership(ci);

  const workflowMutations = [
    (document) => {
      stepRunning(document.jobs["visual-accessibility"], "npx --no-install playwright-core install chromium").run =
        "npx playwright-core install --with-deps chromium";
    },
    (document) => {
      stepRunning(document.jobs["visual-accessibility"], "npx --no-install playwright-core install chromium").run =
        "npx playwright-core install-deps chromium";
    },
    (document) => {
      const job = document.jobs["visual-accessibility"];
      const acceptance = job.steps.findIndex(
        (step) => step?.run === "env -u CHROME_BIN npm run test:webview-acceptance"
      );
      job.steps.splice(acceptance, 0, { run: "sudo apt-get install chromium" });
    },
    (document) => {
      document.jobs["visual-accessibility"].env = { CHROME_BIN: "/usr/bin/chromium" };
    },
    (document) => {
      document.env = { CHROME_BIN: "/usr/bin/google-chrome" };
    },
    (document) => {
      stepRunning(document.jobs["visual-accessibility"], "env -u CHROME_BIN npm run test:webview-acceptance").run =
        "npm run test:webview-acceptance";
    },
    (document) => {
      const job = document.jobs["visual-accessibility"];
      const acceptance = job.steps.findIndex(
        (step) => step?.run === "env -u CHROME_BIN npm run test:webview-acceptance"
      );
      job.steps.splice(acceptance, 0, { run: 'echo "CHROME_BIN=/usr/bin/google-chrome" >> "$GITHUB_ENV"' });
    },
    (document) => {
      stepRunning(document.jobs["visual-accessibility"], "env -u CHROME_BIN npm run test:webview-acceptance").if =
        "${{ false }}";
    },
    (document) => {
      stepRunning(document.jobs["visual-accessibility"], "env -u CHROME_BIN npm run test:webview-acceptance")[
        "continue-on-error"
      ] = true;
    },
    (document) => {
      document.jobs["visual-accessibility"].steps.push({ run: "npm run test:webview-acceptance" });
    },
    (document) => {
      document.jobs["visual-accessibility"].steps.push({ run: "npm run test:webview-acceptance:run" });
    },
    (document) => {
      document.jobs["visual-accessibility"].steps.push({ run: "npm run test:webview-acceptance;" });
    },
    (document) => {
      document.jobs["visual-accessibility"].steps.push({ run: "true" });
    },
    (document) => {
      const steps = document.jobs["visual-accessibility"].steps;
      const install = steps.findIndex((step) => step?.run === "npx --no-install playwright-core install chromium");
      const acceptance = steps.findIndex((step) => step?.run === "env -u CHROME_BIN npm run test:webview-acceptance");
      [steps[install], steps[acceptance]] = [steps[acceptance], steps[install]];
    },
    (document) => {
      const upload = document.jobs["visual-accessibility"].steps.find(
        (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact@")
      );
      upload.with["retention-days"] = 30;
    }
  ];
  for (const mutate of workflowMutations) {
    const document = structuredClone(ci);
    mutate(document);
    assert.throws(() => assertVisualAccessibilityBrowserOwnership(document));
  }

  const missingManifestOwner = structuredClone(packageJson);
  delete missingManifestOwner.devDependencies["playwright-core"];
  assert.throws(() => assertVisualAccessibilityBrowserOwnership(ci, missingManifestOwner, packageLock));

  const changedLockDeclaration = structuredClone(packageLock);
  changedLockDeclaration.packages[""].devDependencies["playwright-core"] = "^999.0.0";
  assert.throws(() => assertVisualAccessibilityBrowserOwnership(ci, packageJson, changedLockDeclaration));

  const missingIntegrity = structuredClone(packageLock);
  delete missingIntegrity.packages["node_modules/playwright-core"].integrity;
  assert.throws(() => assertVisualAccessibilityBrowserOwnership(ci, packageJson, missingIntegrity));
});

test("CI retains failure-only ordinary artifacts and no success artifact producer", () => {
  const uploads = allExternalUses(ci).filter(([, uses]) => uses.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 2);
  const visualUpload = ci.jobs["visual-accessibility"].steps.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact@")
  );
  assert.equal(visualUpload.if, "${{ failure() && !cancelled() }}");
  const packagedUpload = ci.jobs["canonical-editor"].steps.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact@")
  );
  assert.equal(
    packagedUpload.if,
    "${{ !cancelled() && steps.packaged_editor.outcome == 'failure' && steps.packaged_editor.outputs.evidence_ready == 'true' }}"
  );
  assert.equal(packagedUpload.with.path, "${{ steps.packaged_editor.outputs.evidence_path }}");
});

test("performance and standalone released-Jupyter retain triggers and semantics while using exact action pins", () => {
  assert.ok(performance.on.schedule);
  assert.ok(performance.on.workflow_dispatch);
  assert.deepEqual(Object.keys(performance.jobs), ["polars-runtime", "pyspark-profile"]);
  assert.ok(releasedJupyter.on.workflow_dispatch);
  assert.equal(releasedJupyter.on.pull_request, undefined);
  assert.equal(releasedJupyter.on.push, undefined);
  for (const document of [performance, releasedJupyter]) {
    for (const [, uses] of allExternalUses(document)) assert.match(uses, /@[0-9a-f]{40}$/u);
  }
  assert.ok(allExternalUses(performance).some(([, uses]) => uses === CHECKOUT));
  assert.ok(allExternalUses(performance).some(([, uses]) => uses === SETUP_PYTHON));
  assert.ok(allExternalUses(performance).some(([, uses]) => uses === SETUP_JAVA));
  assert.ok(allExternalUses(releasedJupyter).some(([, uses]) => uses === SETUP_NODE));
});

test("protected branch triggers and obsolete classifier vocabulary are absent from current PR workflow owners", () => {
  for (const document of [ci, codeql]) {
    assert.deepEqual(document.on.pull_request.branches ?? ["main"], ["main"]);
    assert.equal(document.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  }
  assert.equal(cross.on.pull_request, undefined);
  assert.ok(Object.hasOwn(cross.on, "workflow_dispatch"));
  assert.ok(Object.hasOwn(cross.on, "schedule"));
  assert.equal(cross.concurrency["cancel-in-progress"], false);
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.deepEqual(codeql.on.push.branches, ["main"]);
  const owned = [ci, cross, codeql].map((value) => JSON.stringify(value)).join("\n");
  for (const legacy of [
    "documentation_only",
    "benchmark_harness_only",
    "dependency_lock_only",
    "draft_pull_request",
    "lightweight_only",
    "package_only",
    "release_infrastructure_only",
    "full_matrix_required"
  ]) {
    assert.doesNotMatch(owned, new RegExp(legacy, "u"));
  }
});

test("CI and CodeQL align edited, stacked, readiness, and draft activity semantics", () => {
  assertPullRequestActivityContract(ci, codeql);
  for (const mutate of [
    (document) => document.on.pull_request.types.splice(document.on.pull_request.types.indexOf("edited"), 1),
    (document) => document.on.pull_request.types.splice(document.on.pull_request.types.indexOf("stacked"), 1),
    (document) => document.on.pull_request.types.push("ready_for_review"),
    (document) => document.on.pull_request.types.push("converted_to_draft")
  ]) {
    const changedCi = structuredClone(ci);
    mutate(changedCi);
    assert.throws(() => assertPullRequestActivityContract(changedCi, codeql));
    const changedCodeql = structuredClone(codeql);
    mutate(changedCodeql);
    assert.throws(() => assertPullRequestActivityContract(ci, changedCodeql));
  }
  const classify = stepRunning(ci.jobs.classify, "node scripts/ci-path-classification.mjs");
  assert.deepEqual(classify.env, {
    CI_EVENT_NAME: "${{ github.event_name }}",
    CI_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    CI_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    CI_STACK_BASE_SHA: "${{ github.event.pull_request.stack.base.sha }}",
    CI_STACK_POSITION: "${{ github.event.pull_request.stack.position }}",
    CI_STACK_SIZE: "${{ github.event.pull_request.stack.size }}"
  });
});

test("automation retains the exact Node and npm toolchain authority", () => {
  const nodeVersion = readFileSync(".node-version", "utf8").trim();
  assert.equal(nodeVersion, "22.22.0");
  assert.equal(packageJson.engines.node, ">=22.22.0 <23");
  assert.equal(packageJson.packageManager, "npm@10.9.4");
  let setupNodeCount = 0;
  for (const name of repositoryWorkflowNames.filter((entry) => entry.endsWith(".yml"))) {
    const document = workflow(name);
    for (const [jobId, job] of Object.entries(document.jobs ?? {})) {
      for (const [stepIndex, step] of (job.steps ?? []).entries()) {
        if (typeof step?.uses !== "string" || !step.uses.startsWith("actions/setup-node@")) continue;
        setupNodeCount += 1;
        assert.equal(step.with?.["node-version-file"], ".node-version", `${name}:${jobId}:${stepIndex}`);
        assert.equal(Object.hasOwn(step.with ?? {}, "node-version"), false, `${name}:${jobId}:${stepIndex}`);
      }
    }
  }
  assert.ok(setupNodeCount > 0);
  const azure = readFileSync("azure-pipelines-marketplace.yml", "utf8");
  assert.equal((azure.match(/task: NodeTool@0/gu) ?? []).length, 2);
  assert.deepEqual(
    [...azure.matchAll(/^\s+versionSpec:\s*(\S+)\s*$/gmu)].map((match) => match[1]),
    [nodeVersion, nodeVersion]
  );
});

test("script groups remain pairwise disjoint and exactly cover the script-test inventory", () => {
  const inventory = readdirSync("scripts", { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
  const groups = Object.fromEntries(
    SCRIPT_TEST_GROUPS.map((group) => [
      group,
      nodeTestFiles(
        packageJson.scripts[`test:scripts:${group}${["portable", "media"].includes(group) ? ":run" : ""}`],
        group
      )
    ])
  );
  assert.deepEqual(groups.workflow, [
    "scripts/candidate-acceptance-workflow.test.mjs",
    "scripts/ci-workflow.test.mjs",
    "scripts/install-policy.test.mjs"
  ]);
  assert.deepEqual(groups.media, ["scripts/public-media-surfaces.test.mjs", "scripts/readme-media.test.mjs"]);
  assert.deepEqual(groups.native, ["scripts/windows-job-supervisor.native.test.mjs"]);
  for (let left = 0; left < SCRIPT_TEST_GROUPS.length; left += 1) {
    for (let right = left + 1; right < SCRIPT_TEST_GROUPS.length; right += 1) {
      assert.deepEqual(
        groups[SCRIPT_TEST_GROUPS[left]].filter((file) => groups[SCRIPT_TEST_GROUPS[right]].includes(file)),
        []
      );
    }
  }
  assert.deepEqual([...new Set(SCRIPT_TEST_GROUPS.flatMap((group) => groups[group]))].sort(), inventory);
});

test("every Vitest entry point retains an effective worker ceiling", async () => {
  const config = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    fileURLToPath(new URL("../vite.config.ts", import.meta.url))
  );
  const smoke = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    fileURLToPath(new URL("../vite.python-environment-smoke.config.ts", import.meta.url))
  );
  const vitestScripts = Object.entries(packageJson.scripts)
    .filter(([, command]) => typeof command === "string" && command.startsWith("vitest run"))
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(vitestScripts, [
    ["test:coverage:ts", "vitest run --coverage"],
    ["test:python-environment-smoke", "vitest run --config vite.python-environment-smoke.config.ts"],
    ["test:ts", "vitest run"]
  ]);
  assert.ok(config);
  assert.ok(smoke);
  assert.equal(config.config.test?.maxWorkers, 4);
  assert.equal(config.config.test?.coverage?.processingConcurrency, 4);
  assert.equal(smoke.config.test?.maxWorkers, 1);
  assert.equal(smoke.config.test?.fileParallelism, false);
});

test("pull-request workflows cancel only obsolete heads while both required result gates remain fail-complete", () => {
  const alwaysEvaluatedJobs = [];
  for (const [name, group] of REPLACEABLE_PULL_REQUEST_WORKFLOWS) {
    const document = workflow(name);
    assert.equal(document.concurrency.group, group);
    assert.equal(document.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
    assert.ok(document.on.pull_request);
    assert.ok(Object.keys(document.on).some((eventName) => eventName !== "pull_request"));
    for (const [jobId, job] of Object.entries(document.jobs ?? {})) {
      if (String(job.if ?? "").includes("always()")) alwaysEvaluatedJobs.push(`${name}:${jobId}`);
      for (const step of job.steps ?? []) assert.equal(String(step.if ?? "").includes("always()"), false);
    }
  }
  assert.deepEqual(alwaysEvaluatedJobs, ["ci.yml:validate", "codeql.yml:codeql-gate"]);
});

test("repository-only roots remain excluded from the VSIX inventory", () => {
  const ignored = new Set(readFileSync(".vscodeignore", "utf8").split(/\r?\n/gu).filter(Boolean));
  for (const path of [
    "docs/**",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    ".node-version",
    ".npmrc"
  ]) {
    assert.equal(ignored.has(path), true, `${path} must stay outside the extension package.`);
  }
  const rSubtreeExclusions = [...ignored].filter((path) => path.startsWith("r/"));
  assert.deepEqual(rSubtreeExclusions, ["r/tests/**", "r/dependencies/**"]);
  const excludedRRoots = rSubtreeExclusions.map((path) => path.slice(0, -3));
  for (const path of [
    "r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.4.lock.json",
    "r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.5.lock.json"
  ]) {
    assert.equal(
      excludedRRoots.some((root) => path.startsWith(`${root}/`)),
      true,
      `${path} must stay outside the extension package.`
    );
  }
  for (const path of [
    "r/openwrangler_runtime/frame_contract.R",
    "r/openwrangler_runtime/interactive_agent.R",
    "r/openwrangler_runtime/kernel_agent.R",
    "r/openwrangler_runtime/process_agent.R"
  ]) {
    assert.equal(existsSync(path), true, `${path} must remain a real package input.`);
    assert.equal(
      excludedRRoots.some((root) => path.startsWith(`${root}/`)),
      false,
      `${path} must remain in the extension package.`
    );
  }
  for (const path of ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.equal(ignored.has(path), false, `${path} must remain in the extension package.`);
  }
});

test("routine Dependabot updates remain grouped, bounded, staggered, and security-independent", () => {
  const dependabot = parseBoundedWorkflowYaml(readFileSync(".github/dependabot.yml"));
  assert.equal(dependabot.version, 2);
  assert.deepEqual(
    dependabot.updates.map((entry) => [
      entry["package-ecosystem"],
      entry.schedule.day,
      entry["open-pull-requests-limit"]
    ]),
    [
      ["npm", "monday", 4],
      ["pip", "tuesday", 4],
      ["github-actions", "wednesday", 3]
    ]
  );
  for (const entry of dependabot.updates) {
    const group = Object.values(entry.groups)[0];
    assert.equal(group["applies-to"], "version-updates");
    assert.deepEqual(group["update-types"], ["minor", "patch"]);
  }
});

test("native R child processes retain named phases and bounded individual deadlines", () => {
  const source = readFileSync("scripts/run-r-contract-tests.mjs", "utf8");
  assert.match(source, /export function createRContractPhases/u);
  assert.match(source, /export function runRContractPhase/u);
  assert.match(source, /\[r-contract\] TIMEOUT \$\{phase\.label\}/u);
  assert.doesNotMatch(source, /DIRECT_R_CONTRACT_TIMEOUT_MS|VITEST_CONTRACT_TIMEOUT_MS/u);
  assert.doesNotMatch(source, /timeout:\s*(?:60_000|90_000|120_000|360_000),/u);
});

test("standalone Released-Jupyter retains fresh VSIX verification immediately around every R journey", () => {
  assertStandaloneReleasedJupyterRTriples(releasedJupyter);
  const missing = structuredClone(releasedJupyter);
  missing.jobs.vscode.steps.splice(
    missing.jobs.vscode.steps.findIndex((step) => step?.id === "canonical_r_jupyter"),
    1
  );
  assert.throws(() => assertStandaloneReleasedJupyterRTriples(missing), /exactly one canonical_r_jupyter/u);
  const interposed = structuredClone(releasedJupyter);
  interposed.jobs.vscode.steps.splice(
    interposed.jobs.vscode.steps.findIndex((step) => step?.id === "packaged_editor_r"),
    0,
    { run: "echo interposed" }
  );
  assert.throws(
    () => assertStandaloneReleasedJupyterRTriples(interposed),
    /packaged_editor_r must immediately follow canonical_r_jupyter/u
  );
});
