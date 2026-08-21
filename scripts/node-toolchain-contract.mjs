import { load as parseYaml } from "js-yaml";

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
