import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
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

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKFLOW_FILE_LIMIT = 128 * 1024;
export const BOUNDED_WORKFLOW_FILE_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export const WORKFLOW_YAML_NODE_LIMIT = 20_000;
export const WORKFLOW_YAML_DEPTH_LIMIT = 64;
const WORKFLOW_YAML_ALIAS_LIMIT = 0;
const WORKFLOW_YAML_MERGE_KEY_LIMIT = 0;
const WORKFLOW_YAML_SCHEMA = CORE_SCHEMA.withTags(mergeTag);
export const WORKFLOW_YAML_LOAD_OPTIONS = Object.freeze({
  maxAliases: WORKFLOW_YAML_ALIAS_LIMIT,
  maxDepth: WORKFLOW_YAML_DEPTH_LIMIT,
  maxTotalMergeKeys: WORKFLOW_YAML_MERGE_KEY_LIMIT,
  schema: WORKFLOW_YAML_SCHEMA
});
const WORKFLOW_INVENTORY_LIMIT = 128;
export const WORKFLOW_DIRECTORY = ".github/workflows";
const WORKFLOW_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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

export function readBoundedNoFollowFile(relativePath, { allowedPaths, hooks = {}, root = REPOSITORY_ROOT } = {}) {
  const { absolutePath, canonicalRoot } = canonicalContainedPath(root, relativePath, allowedPaths);
  const components = relativePath.split("/");
  const directories = openDirectoryChain(canonicalRoot, components.slice(0, -1), hooks);
  let descriptor;
  let failure;
  let result;
  try {
    hooks.afterDirectoryOpen?.({ directories, relativePath });
    descriptor = openSync(absolutePath, BOUNDED_WORKFLOW_FILE_OPEN_FLAGS);
    const opened = fstatSync(descriptor, { bigint: true });
    assert.equal(opened.isFile(), true, `${relativePath} must open as a regular file`);
    assert.equal(opened.nlink, 1n, `${relativePath} must not have hard-linked aliases`);
    assert.ok(opened.size <= BigInt(WORKFLOW_FILE_LIMIT), `${relativePath} exceeds the capability file limit`);
    hooks.afterFileDescriptorOpen?.({ descriptor, relativePath });
    const pathOpened = lstatSync(absolutePath, { bigint: true });
    assert.equal(pathOpened.isFile(), true, `${relativePath} path must remain a regular file`);
    assert.equal(pathOpened.isSymbolicLink(), false, `${relativePath} path must not be a symbolic link`);
    assert.equal(pathOpened.nlink, 1n, `${relativePath} path must not have hard-linked aliases`);
    assert.ok(pathOpened.size <= BigInt(WORKFLOW_FILE_LIMIT), `${relativePath} exceeds the capability file limit`);
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
      const remaining = WORKFLOW_FILE_LIMIT + 1 - total;
      if (remaining <= 0) throw new Error(`${relativePath} exceeds the capability file limit`);
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, remaining));
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
      hooks.afterChunk?.({ descriptor, relativePath, total });
    }
    assert.ok(total <= WORKFLOW_FILE_LIMIT, `${relativePath} exceeds the capability file limit`);
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
  return entries.filter(isGithubWorkflowFile).sort();
}

export function parseBoundedWorkflowYaml(bytes) {
  let source = bytes;
  if (Buffer.isBuffer(bytes)) {
    try {
      source = WORKFLOW_UTF8_DECODER.decode(bytes);
    } catch (cause) {
      throw new Error("workflow YAML is not valid UTF-8", { cause });
    }
  }
  assert.equal(typeof source, "string", "workflow YAML must be text");
  assert.ok(Buffer.byteLength(source, "utf8") <= WORKFLOW_FILE_LIMIT, "workflow YAML exceeds its byte limit");
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

export function loadRepositoryWorkflowInventory({ hooks = {}, root = REPOSITORY_ROOT } = {}) {
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
    const paths = firstNames.map((name) => posix.join(WORKFLOW_DIRECTORY, name));
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

export function loadBoundedNodeToolchainWorkflowDocuments({ root = REPOSITORY_ROOT } = {}) {
  const inventory = loadRepositoryWorkflowInventory({ root });
  return Object.freeze(
    Object.fromEntries(Object.entries(inventory).map(([path, snapshot]) => [posix.basename(path), snapshot.document]))
  );
}

export const NODE_TOOLCHAIN_CONTRACT = Object.freeze({
  canonicalNode: "24.19.0",
  canonicalNpm: "11.17.0",
  compatibilityNode: "22.23.2",
  compatibilityNpm: "10.9.8",
  nodeEngine: "^22.22.0 || ^24.0.0",
  nodeTypes: "22.20.1",
  setupNodeAction: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  vscodeEngine: "^1.106.0",
  vscodeTypes: "1.106.0"
});

const CANONICAL_SETUP_NODE_COUNT = 27;
const COMPATIBILITY_WORKFLOW = "ci.yml";
const COMPATIBILITY_JOB = "invariant-core";
const COMPATIBILITY_SETUP_NAME = "Select the Node 22 maintained-LTS compatibility runtime";
const COMPATIBILITY_SMOKE_NAME = "Node 22 maintained-LTS compatibility smoke";
const PULL_REQUEST_ONLY = "${{ github.event_name == 'pull_request' }}";
const COMPATIBILITY_SMOKE = `test "$(node --version)" = "v${NODE_TOOLCHAIN_CONTRACT.compatibilityNode}"
npm version --json | grep --fixed-strings --line-regexp '  "npm": "${NODE_TOOLCHAIN_CONTRACT.compatibilityNpm}",' > /dev/null
npm ci --ignore-scripts --no-audit
test -z "$(git status --porcelain --untracked-files=no)"
npm run check:invariants
npm run typecheck
npm run test:scripts:workflow`;

const CONTRIBUTING_SNIPPETS = Object.freeze([
  "Node.js `24.19.0` with its bundled npm `11.17.0`",
  "`^22.22.0 || ^24.0.0`",
  "Node 23 is intentionally unsupported.",
  "Node `22.23.2` with its bundled npm `10.9.8`",
  "not the canonical packaging pair."
]);
const RELEASING_SNIPPETS = Object.freeze([
  "Node.js 24.19.0 from `.node-version`",
  "npm 11.17.0 package manager",
  "`^22.22.0 || ^24.0.0`",
  "Node 23 is intentionally excluded.",
  "Node 22.23.2/npm 10.9.8 compatibility smoke.",
  "`engines.vscode` `^1.106.0`",
  "`@types/vscode` 1.106.0",
  "`@types/node` 22.20.1"
]);
const CHANGELOG_SNIPPETS = Object.freeze([
  "Node.js 24.19.0 with npm 11.17.0",
  "`^22.22.0 || ^24.0.0`",
  "excluding Node 23",
  "Node 22.23.2 with npm 10.9.8",
  "`engines.vscode` `^1.106.0`",
  "`@types/vscode` 1.106.0",
  "`@types/node` 22.20.1"
]);
const AZURE_NODE_OWNERS = Object.freeze([
  Object.freeze({ stage: "Intake", job: "Bind", stepIndex: 1 }),
  Object.freeze({ stage: "Promote", job: "Marketplace", stepIndex: 1 })
]);
const AZURE_NODE_STEP_KEYS = Object.freeze(["displayName", "inputs", "task"]);
const AZURE_NODE_INPUT_KEYS = Object.freeze(["checkLatest", "versionSpec"]);

export function isGithubWorkflowFile(name) {
  return typeof name === "string" && /\.ya?ml$/u.test(name);
}

function addMismatch(problems, actual, expected, label) {
  if (actual !== expected) problems.push(`${label} must be ${expected}, not ${String(actual)}.`);
}

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function azureJobSteps(job) {
  if (Array.isArray(job?.steps)) return job.steps;
  return Array.isArray(job?.strategy?.runOnce?.deploy?.steps) ? job.strategy.runOnce.deploy.steps : [];
}

function collectPropertyPaths(value, property, path = "$", seen = new WeakSet(), result = []) {
  if (typeof value !== "object" || value === null) return result;
  if (seen.has(value)) {
    result.aliasDetected = true;
    return result;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectPropertyPaths(value[index], property, `${path}[${index}]`, seen, result);
    }
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === property) result.push(childPath);
    collectPropertyPaths(child, property, childPath, seen, result);
  }
  return result;
}

function inspectAzureNodeOwners(source, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 64 * 1024) {
    problems.push("Azure Node fallback source must be bounded UTF-8 text.");
    return;
  }
  let pipeline;
  try {
    pipeline = parseYaml(source);
  } catch {
    problems.push("Azure Node fallback source must contain valid YAML.");
    return;
  }
  const versionPaths = collectPropertyPaths(pipeline, "versionSpec");
  if (versionPaths.aliasDetected) problems.push("Azure Node fallback YAML may not use shared aliases.");
  const rows = [];
  for (const [stageIndex, stage] of (pipeline?.stages ?? []).entries()) {
    for (const [jobIndex, job] of (stage?.jobs ?? []).entries()) {
      for (const [stepIndex, step] of azureJobSteps(job).entries()) {
        if (step?.task !== "NodeTool@0") continue;
        rows.push({
          job: job.job ?? job.deployment,
          jobIndex,
          stage: stage.stage,
          stageIndex,
          step,
          stepIndex
        });
      }
    }
  }
  if (rows.length !== AZURE_NODE_OWNERS.length) {
    problems.push(`Azure Node fallbacks must contain exactly ${AZURE_NODE_OWNERS.length} NodeTool@0 owners.`);
  }
  const expectedVersionPaths = [
    "$.stages[0].jobs[0].steps[1].inputs.versionSpec",
    "$.stages[1].jobs[0].strategy.runOnce.deploy.steps[1].inputs.versionSpec"
  ];
  if (JSON.stringify(versionPaths) !== JSON.stringify(expectedVersionPaths)) {
    problems.push("Azure versionSpec values must belong only to the two exact NodeTool@0 owners.");
  }
  for (let index = 0; index < AZURE_NODE_OWNERS.length; index += 1) {
    const expected = AZURE_NODE_OWNERS[index];
    const row = rows[index];
    const location = `Azure Node owner ${index + 1}`;
    addMismatch(problems, row?.stage, expected.stage, `${location} stage`);
    addMismatch(problems, row?.job, expected.job, `${location} job`);
    addMismatch(problems, row?.jobIndex, 0, `${location} job position`);
    addMismatch(problems, row?.stepIndex, expected.stepIndex, `${location} step position`);
    if (!exactKeys(row?.step, AZURE_NODE_STEP_KEYS)) problems.push(`${location} must retain its exact task mapping.`);
    if (!exactKeys(row?.step?.inputs, AZURE_NODE_INPUT_KEYS)) {
      problems.push(`${location} must retain its exact input mapping.`);
    }
    addMismatch(problems, row?.step?.displayName, "Use pinned Node.js", `${location} display name`);
    addMismatch(
      problems,
      row?.step?.inputs?.versionSpec,
      NODE_TOOLCHAIN_CONTRACT.canonicalNode,
      `${location} versionSpec`
    );
    addMismatch(problems, row?.step?.inputs?.checkLatest, false, `${location} checkLatest`);
  }
}

function currentUnreleasedSection(source, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) {
    problems.push("CHANGELOG.md must be bounded UTF-8 text.");
    return "";
  }
  const headings = [...source.matchAll(/^## \[Unreleased\]\s*$/gmu)];
  if (headings.length !== 1) {
    problems.push("CHANGELOG.md must contain exactly one Unreleased section.");
    return "";
  }
  const start = headings[0].index + headings[0][0].length;
  const next = source.slice(start).search(/^## \[/mu);
  return source.slice(start, next === -1 ? source.length : start + next);
}

function setupNodeSteps(workflows) {
  const rows = [];
  for (const [workflowName, document] of Object.entries(workflows).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    for (const [jobName, job] of Object.entries(document?.jobs ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      for (const [stepIndex, step] of (job?.steps ?? []).entries()) {
        if (typeof step?.uses === "string" && step.uses.startsWith("actions/setup-node@")) {
          rows.push({ job, jobName, step, stepIndex, workflowName });
        }
      }
    }
  }
  return rows;
}

export function inspectNodeToolchainContract({
  azureSource,
  changelogSource,
  contributingSource,
  nodeVersionSource,
  packageJson,
  packageLock,
  releasingSource,
  workflows
}) {
  const problems = [];
  const rootLock = packageLock?.packages?.[""];

  addMismatch(
    problems,
    nodeVersionSource,
    `${NODE_TOOLCHAIN_CONTRACT.canonicalNode}\n`,
    ".node-version exact contents"
  );
  addMismatch(problems, packageJson?.packageManager, `npm@${NODE_TOOLCHAIN_CONTRACT.canonicalNpm}`, "packageManager");
  addMismatch(problems, packageJson?.engines?.node, NODE_TOOLCHAIN_CONTRACT.nodeEngine, "package Node engine");
  addMismatch(problems, rootLock?.engines?.node, NODE_TOOLCHAIN_CONTRACT.nodeEngine, "lock root Node engine");
  addMismatch(problems, packageJson?.engines?.vscode, NODE_TOOLCHAIN_CONTRACT.vscodeEngine, "VS Code engine");
  addMismatch(problems, rootLock?.engines?.vscode, NODE_TOOLCHAIN_CONTRACT.vscodeEngine, "lock root VS Code engine");
  addMismatch(
    problems,
    packageJson?.devDependencies?.["@types/node"],
    NODE_TOOLCHAIN_CONTRACT.nodeTypes,
    "extension-host Node type contract"
  );
  addMismatch(
    problems,
    rootLock?.devDependencies?.["@types/node"],
    NODE_TOOLCHAIN_CONTRACT.nodeTypes,
    "lock root extension-host Node type contract"
  );
  addMismatch(
    problems,
    packageJson?.devDependencies?.["@types/vscode"],
    NODE_TOOLCHAIN_CONTRACT.vscodeTypes,
    "VS Code type contract"
  );
  addMismatch(
    problems,
    rootLock?.devDependencies?.["@types/vscode"],
    NODE_TOOLCHAIN_CONTRACT.vscodeTypes,
    "lock root VS Code type contract"
  );

  inspectAzureNodeOwners(azureSource, problems);

  for (const snippet of CONTRIBUTING_SNIPPETS) {
    if (!contributingSource.includes(snippet)) problems.push(`CONTRIBUTING.md is missing: ${snippet}`);
  }
  for (const snippet of RELEASING_SNIPPETS) {
    if (!releasingSource.includes(snippet)) problems.push(`docs/releasing.md is missing: ${snippet}`);
  }
  const unreleased = currentUnreleasedSection(changelogSource, problems);
  for (const snippet of CHANGELOG_SNIPPETS) {
    if (!unreleased.includes(snippet)) problems.push(`CHANGELOG.md Unreleased is missing: ${snippet}`);
  }

  const setupRows = setupNodeSteps(workflows);
  const compatibilityRows = setupRows.filter(({ step }) => Object.hasOwn(step.with ?? {}, "node-version"));
  const canonicalRows = setupRows.filter(({ step }) => !Object.hasOwn(step.with ?? {}, "node-version"));
  if (canonicalRows.length !== CANONICAL_SETUP_NODE_COUNT) {
    problems.push(`Canonical setup-node inventory must contain ${CANONICAL_SETUP_NODE_COUNT} calls.`);
  }
  for (const { jobName, step, stepIndex, workflowName } of canonicalRows) {
    const location = `${workflowName}:${jobName}:${stepIndex}`;
    addMismatch(problems, step.uses, NODE_TOOLCHAIN_CONTRACT.setupNodeAction, `${location} setup-node action`);
    addMismatch(problems, step.with?.["node-version-file"], ".node-version", `${location} Node authority`);
  }

  if (compatibilityRows.length !== 1) {
    problems.push("Exactly one setup-node compatibility exception is required.");
  } else {
    const [{ job, jobName, step, stepIndex, workflowName }] = compatibilityRows;
    const location = `${workflowName}:${jobName}:${stepIndex}`;
    addMismatch(problems, workflowName, COMPATIBILITY_WORKFLOW, `${location} compatibility workflow`);
    addMismatch(problems, jobName, COMPATIBILITY_JOB, `${location} compatibility job`);
    addMismatch(problems, step.name, COMPATIBILITY_SETUP_NAME, `${location} compatibility setup name`);
    addMismatch(problems, step.uses, NODE_TOOLCHAIN_CONTRACT.setupNodeAction, `${location} setup-node action`);
    addMismatch(
      problems,
      step.with?.["node-version"],
      NODE_TOOLCHAIN_CONTRACT.compatibilityNode,
      `${location} compatibility Node`
    );
    addMismatch(problems, step.with?.cache, "npm", `${location} compatibility cache`);
    addMismatch(problems, step.if, PULL_REQUEST_ONLY, `${location} compatibility condition`);
    if (Object.hasOwn(step.with ?? {}, "node-version-file")) {
      problems.push(`${location} compatibility setup may not inherit the canonical version file.`);
    }
    const smoke = job.steps?.[stepIndex + 1];
    addMismatch(problems, stepIndex + 2, job.steps?.length, `${location} compatibility tail position`);
    addMismatch(problems, smoke?.name, COMPATIBILITY_SMOKE_NAME, `${location} compatibility smoke name`);
    addMismatch(problems, smoke?.if, PULL_REQUEST_ONLY, `${location} compatibility smoke condition`);
    addMismatch(
      problems,
      typeof smoke?.run === "string" ? smoke.run.trimEnd() : smoke?.run,
      COMPATIBILITY_SMOKE,
      `${location} compatibility smoke command`
    );
  }

  return problems;
}
