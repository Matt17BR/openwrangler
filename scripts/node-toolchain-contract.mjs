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
test "$(npm --version)" = "${NODE_TOOLCHAIN_CONTRACT.compatibilityNpm}"
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

function addMismatch(problems, actual, expected, label) {
  if (actual !== expected) problems.push(`${label} must be ${expected}, not ${String(actual)}.`);
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

  const azureVersions = [...azureSource.matchAll(/^\s+versionSpec:\s*(\S+)\s*$/gmu)].map((match) => match[1]);
  if (
    azureVersions.length !== 2 ||
    azureVersions.some((version) => version !== NODE_TOOLCHAIN_CONTRACT.canonicalNode)
  ) {
    problems.push(`Azure Node fallbacks must be exactly two ${NODE_TOOLCHAIN_CONTRACT.canonicalNode} pins.`);
  }

  for (const snippet of CONTRIBUTING_SNIPPETS) {
    if (!contributingSource.includes(snippet)) problems.push(`CONTRIBUTING.md is missing: ${snippet}`);
  }
  for (const snippet of RELEASING_SNIPPETS) {
    if (!releasingSource.includes(snippet)) problems.push(`docs/releasing.md is missing: ${snippet}`);
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
