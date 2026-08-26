import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load as parseYaml, mergeTag } from "js-yaml";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKFLOW_FILE_LIMIT = 128 * 1024;
const WORKFLOW_INVENTORY_LIMIT = 128;
const WORKFLOW_SCHEMA = CORE_SCHEMA.withTags(mergeTag);

export const NODE_TOOLCHAIN_CONTRACT = Object.freeze({
  canonicalNode: "24.19.0",
  canonicalNpm: "11.17.0",
  compatibilityNode: "22.23.2",
  compatibilityNpm: "10.9.8",
  nodeEngine: "^22.22.0 || ^24.0.0",
  nodeTypes: "22.20.1",
  vscodeEngine: "^1.106.0",
  vscodeTypes: "1.106.0"
});

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
export function isGithubWorkflowFile(name) {
  return typeof name === "string" && /\.ya?ml$/u.test(name);
}

function parseBoundedWorkflow(source, name) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > WORKFLOW_FILE_LIMIT) {
    throw new Error(`${name} exceeds the workflow file limit.`);
  }
  return parseYaml(source, {
    maxAliases: 0,
    maxDepth: 64,
    maxTotalMergeKeys: 0,
    schema: WORKFLOW_SCHEMA
  });
}

export function loadBoundedNodeToolchainWorkflowDocuments({ root = REPOSITORY_ROOT } = {}) {
  const directory = join(root, ".github", "workflows");
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => isGithubWorkflowFile(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > WORKFLOW_INVENTORY_LIMIT) throw new Error("Workflow inventory exceeds its file-count limit.");
  return Object.freeze(
    Object.fromEntries(
      entries.map((entry) => {
        if (!entry.isFile()) throw new Error(`${entry.name} must be a regular workflow file.`);
        const source = readFileSync(join(directory, entry.name), "utf8");
        return [entry.name, parseBoundedWorkflow(source, entry.name)];
      })
    )
  );
}

function addMismatch(problems, actual, expected, label) {
  if (actual !== expected) problems.push(`${label} must be ${expected}, not ${String(actual)}.`);
}

function setupNodeRows(workflows) {
  const rows = [];
  for (const [workflowName, document] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
      for (const [stepIndex, step] of (job?.steps ?? []).entries()) {
        if (typeof step?.uses === "string" && step.uses.startsWith("actions/setup-node@")) {
          rows.push({ job, jobName, step, stepIndex, workflowName });
        }
      }
    }
  }
  return rows;
}

function azureNodeRows(source, problems) {
  let document;
  try {
    document = parseBoundedWorkflow(source, "azure-pipelines-marketplace.yml");
  } catch {
    problems.push("Azure Marketplace Node configuration must be valid bounded YAML.");
    return [];
  }
  const rows = [];
  for (const stage of document?.stages ?? []) {
    for (const job of stage?.jobs ?? []) {
      const steps = job?.steps ?? job?.strategy?.runOnce?.deploy?.steps ?? [];
      rows.push(...steps.filter((step) => step?.task === "NodeTool@0"));
    }
  }
  return rows;
}

function inspectWorkflowNodePolicy(workflows, problems) {
  const rows = setupNodeRows(workflows);
  if (rows.length === 0) problems.push("GitHub workflows must select the repository Node toolchain.");
  const compatibilityOwners = [];
  for (const row of rows) {
    const location = `${row.workflowName}:${row.jobName}:${row.stepIndex}`;
    const versionFile = row.step.with?.["node-version-file"];
    const matrixVersion = row.step.with?.["node-version"];
    if (versionFile === ".node-version" && matrixVersion === undefined) continue;
    if (matrixVersion !== "${{ matrix.node }}" || versionFile !== undefined) {
      problems.push(`${location} must use .node-version or the supported Node matrix.`);
      continue;
    }
    const matrix = row.job?.strategy?.matrix?.node;
    if (
      Array.isArray(matrix) &&
      matrix.includes(NODE_TOOLCHAIN_CONTRACT.canonicalNode) &&
      matrix.includes(NODE_TOOLCHAIN_CONTRACT.compatibilityNode)
    ) {
      compatibilityOwners.push(row);
    } else {
      problems.push(`${location} Node matrix must include the canonical and compatibility runtimes.`);
    }
  }
  if (compatibilityOwners.length !== 1) {
    problems.push("Exactly one GitHub job must run the canonical Node and maintained-LTS compatibility matrix.");
    return;
  }
  const [{ job, workflowName, jobName }] = compatibilityOwners;
  const commands = (job.steps ?? []).map((step) => String(step?.run ?? ""));
  if (!commands.some((command) => command.trim() === "npm ci --ignore-scripts")) {
    problems.push(`${workflowName}:${jobName} must install the lock under both supported Node runtimes.`);
  }
  const smoke = commands.find(
    (command, index) =>
      String(job.steps?.[index]?.if ?? "").includes(`matrix.node == '${NODE_TOOLCHAIN_CONTRACT.compatibilityNode}'`) &&
      command.includes(`v${NODE_TOOLCHAIN_CONTRACT.compatibilityNode}`)
  );
  for (const expected of [
    `"npm": "${NODE_TOOLCHAIN_CONTRACT.compatibilityNpm}"`,
    "npm run check:fast-feedback",
    "npm run test:scripts:workflow"
  ]) {
    if (!smoke?.includes(expected)) {
      problems.push(`Node ${NODE_TOOLCHAIN_CONTRACT.compatibilityNode} smoke is missing: ${expected}`);
    }
  }
}

export function inspectNodeToolchainContract({
  azureSource,
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

  // Extension-host types follow the minimum supported host, independently of the build Node version.
  addMismatch(problems, packageJson?.engines?.vscode, NODE_TOOLCHAIN_CONTRACT.vscodeEngine, "VS Code engine");
  addMismatch(problems, rootLock?.engines?.vscode, NODE_TOOLCHAIN_CONTRACT.vscodeEngine, "lock root VS Code engine");
  addMismatch(
    problems,
    packageJson?.devDependencies?.["@types/node"],
    NODE_TOOLCHAIN_CONTRACT.nodeTypes,
    "extension-host Node types"
  );
  addMismatch(
    problems,
    rootLock?.devDependencies?.["@types/node"],
    NODE_TOOLCHAIN_CONTRACT.nodeTypes,
    "lock root extension-host Node types"
  );
  addMismatch(
    problems,
    packageJson?.devDependencies?.["@types/vscode"],
    NODE_TOOLCHAIN_CONTRACT.vscodeTypes,
    "VS Code types"
  );
  addMismatch(
    problems,
    rootLock?.devDependencies?.["@types/vscode"],
    NODE_TOOLCHAIN_CONTRACT.vscodeTypes,
    "lock root VS Code types"
  );

  const azureRows = azureNodeRows(azureSource, problems);
  if (azureRows.length === 0) problems.push("Azure Marketplace recovery must select the canonical Node runtime.");
  for (const [index, step] of azureRows.entries()) {
    addMismatch(
      problems,
      step?.inputs?.versionSpec,
      NODE_TOOLCHAIN_CONTRACT.canonicalNode,
      `Azure Node owner ${index + 1}`
    );
    addMismatch(problems, step?.inputs?.checkLatest, false, `Azure Node owner ${index + 1} checkLatest`);
  }

  for (const snippet of CONTRIBUTING_SNIPPETS) {
    if (!contributingSource.includes(snippet)) problems.push(`CONTRIBUTING.md is missing: ${snippet}`);
  }
  for (const snippet of RELEASING_SNIPPETS) {
    if (!releasingSource.includes(snippet)) problems.push(`docs/releasing.md is missing: ${snippet}`);
  }
  inspectWorkflowNodePolicy(workflows, problems);
  return problems;
}
