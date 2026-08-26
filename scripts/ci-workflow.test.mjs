import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { load as parseYaml } from "js-yaml";
import { parseCLI as parseVitestCli, resolveConfig as resolveVitestConfig } from "vitest/node";
import {
  CI_CLASSIFIER_OUTPUTS,
  classifyCiChange,
  parseChangedPathBuffer,
  resolvePullRequestClassificationRange
} from "./ci-path-classification.mjs";
import {
  ALWAYS_REQUIRED_CI_JOBS,
  CONDITIONAL_CI_JOBS,
  REQUIRED_CI_JOBS,
  requireCiResults,
  resultEnvironmentKey
} from "./require-ci-results.mjs";
import { inspectNodeToolchainContract, loadBoundedNodeToolchainWorkflowDocuments } from "./node-toolchain-contract.mjs";

const WORKFLOW_DIRECTORY = join(".github", "workflows");
const workflowNames = readdirSync(WORKFLOW_DIRECTORY)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
const workflow = (name) => parseYaml(readFileSync(join(WORKFLOW_DIRECTORY, name), "utf8"));
const ci = workflow("ci.yml");

function readSource(path) {
  return readFileSync(path, "utf8");
}

function inspectCurrentNodePolicy(workflows = loadBoundedNodeToolchainWorkflowDocuments()) {
  return inspectNodeToolchainContract({
    azureSource: readSource("azure-pipelines-marketplace.yml"),
    contributingSource: readSource("CONTRIBUTING.md"),
    nodeVersionSource: readSource(".node-version"),
    packageJson: JSON.parse(readSource("package.json")),
    packageLock: JSON.parse(readSource("package-lock.json")),
    releasingSource: readSource("docs/releasing.md"),
    workflows
  });
}

const none = Object.freeze({
  pythonRequired: false,
  rRequired: false,
  packageEditorRequired: false,
  webRequired: false,
  windowsRequired: false,
  nodeDependenciesRequired: false,
  pythonDependenciesRequired: false
});
const all = Object.freeze(Object.fromEntries(Object.keys(none).map((name) => [name, true])));
const allLanes = Object.freeze({
  ...all,
  nodeDependenciesRequired: false,
  pythonDependenciesRequired: false
});
const packageJson = JSON.parse(readSource("package.json"));
const repositoryRoot = resolve(".");

function packageVitestCommands(scripts) {
  return Object.entries(scripts).filter(([, command]) => {
    const trimmed = command.trim();
    return trimmed === "vitest" || trimmed.startsWith("vitest ");
  });
}

async function resolveVitestCommand(command, root = repositoryRoot) {
  const { filter, options } = parseVitestCli(command);
  const invocationRoot = options.root === undefined ? root : resolve(root, options.root);
  const resolved = await resolveVitestConfig({ ...options, root: invocationRoot });
  return { ...resolved, filter, options };
}

function stepRunning(job, command) {
  return (job?.steps ?? []).find((step) => step?.run === command);
}

function stepsUsing(job, prefix) {
  return (job?.steps ?? []).filter((step) => typeof step?.uses === "string" && step.uses.startsWith(prefix));
}

function expectedResults(selections = all) {
  const results = Object.fromEntries(ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]));
  for (const [selection, jobIds] of Object.entries(CONDITIONAL_CI_JOBS)) {
    for (const jobId of jobIds) results[jobId] = selections[selection] ? "success" : "skipped";
  }
  return results;
}

function allUses(value, path = "$") {
  if (Array.isArray(value)) return value.flatMap((child, index) => allUses(child, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  const rows = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === "uses") rows.push([childPath, child]);
    rows.push(...allUses(child, childPath));
  }
  return rows;
}

test("path selection keeps small changes small", () => {
  assert.deepEqual(CI_CLASSIFIER_OUTPUTS, [
    "python_required",
    "r_required",
    "package_editor_required",
    "web_required",
    "windows_required",
    "node_dependencies_required",
    "python_dependencies_required"
  ]);
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: [".github/dependabot.yml"] }), none);
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["docs/ci.md"] }), none);
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["python/tests/test_limits.py"] }), {
    ...none,
    pythonRequired: true
  });
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["src/webviews/App.tsx"] }), {
    ...none,
    packageEditorRequired: true,
    webRequired: true
  });
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: ["fixtures/view-literal-contract.json"] }),
    {
      ...none,
      pythonRequired: true,
      rRequired: true,
      packageEditorRequired: true
    }
  );
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["media/open-wrangler.svg"] }), {
    ...none,
    packageEditorRequired: true,
    webRequired: true
  });
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["package-lock.json"] }), {
    ...allLanes,
    nodeDependenciesRequired: true
  });
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: [".github/workflows/cross-platform.yml"] }),
    allLanes
  );
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["unknown/owner"] }), allLanes);
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: ["python/pyproject.toml"] }), {
    ...none,
    pythonRequired: true,
    packageEditorRequired: true,
    webRequired: true,
    windowsRequired: true,
    pythonDependenciesRequired: true
  });
  assert.deepEqual(classifyCiChange({ eventName: "push", changedPaths: [] }), allLanes);
  assert.throws(() => classifyCiChange({ eventName: "merge_group", changedPaths: [] }), /Unsupported CI event/u);
});

test("Dependabot covers each dependency source with bounded routine updates", () => {
  const dependabot = parseYaml(readSource(".github/dependabot.yml"));
  assert.equal(dependabot.version, 2);
  assert.deepEqual(
    dependabot.updates.map((entry) => [entry["package-ecosystem"], entry.directory]),
    [
      ["npm", "/"],
      ["pip", "/python"],
      ["github-actions", "/"]
    ]
  );
  for (const entry of dependabot.updates) {
    assert.equal(entry.schedule.interval, "weekly");
    assert.ok(entry["open-pull-requests-limit"] > 0 && entry["open-pull-requests-limit"] <= 10);
    const groups = Object.values(entry.groups ?? {});
    assert.equal(groups.length, 1);
    assert.equal(groups[0]["applies-to"], "version-updates");
    assert.deepEqual(groups[0]["update-types"], ["minor", "patch"]);
  }
});

test("changed paths and pull-request revisions are validated", () => {
  assert.deepEqual(parseChangedPathBuffer(Buffer.from("a\0docs/b.md\0")), ["a", "docs/b.md"]);
  assert.throws(() => parseChangedPathBuffer(Buffer.from("missing terminator")), /NUL terminated/u);
  assert.throws(() => parseChangedPathBuffer(Buffer.from([0xff, 0])), /encoded data/u);
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  assert.deepEqual(
    resolvePullRequestClassificationRange({
      pullRequestBaseSha: base,
      pullRequestHeadSha: head
    }),
    { baseSha: base, headSha: head }
  );
  assert.throws(() =>
    resolvePullRequestClassificationRange({
      pullRequestBaseSha: base,
      pullRequestHeadSha: "not-a-commit"
    })
  );
});

test("pull-request checks use the real triggers and read-only defaults", () => {
  assert.deepEqual(ci.on.pull_request.types, ["opened", "synchronize", "reopened"]);
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.equal(ci.on.merge_group, undefined);
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.equal(ci.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.deepEqual(Object.keys(ci.jobs.changes.outputs), CI_CLASSIFIER_OUTPUTS);
  assert.deepEqual(ci.jobs.javascript.needs, ["changes"]);
  assert.deepEqual(ci.jobs.javascript.strategy.matrix.node, ["24.19.0", "22.23.2"]);
  assert.equal(stepsUsing(ci.jobs.javascript, "actions/setup-python@").length, 0);

  for (const [jobId, output] of Object.entries({
    python: "python_required",
    r: "r_required",
    "package-editor": "package_editor_required",
    web: "web_required",
    windows: "windows_required"
  })) {
    assert.deepEqual(ci.jobs[jobId].needs, ["changes"]);
    assert.match(ci.jobs[jobId].if, /needs\.changes\.result != 'success'/u);
    assert.match(ci.jobs[jobId].if, new RegExp(`needs\\.changes\\.outputs\\.${output} != 'false'`, "u"));
  }
});

test("each selected job retains its behavior checks", () => {
  const sharedCheckSteps = ci.jobs.javascript.steps.filter((step) => step.if === "${{ matrix.node == '24.19.0' }}");
  assert.equal(sharedCheckSteps.length, 1);
  const sharedChecks = sharedCheckSteps[0];
  assert.equal(sharedChecks.if, "${{ matrix.node == '24.19.0' }}");
  const sharedCommands = sharedChecks.run.trim().split(/\s+/u);
  assert.deepEqual(sharedCommands.slice(0, 8), [
    "npx",
    "--no-install",
    "npm-run-all",
    "--parallel",
    "--continue-on-error",
    "--max-parallel",
    "2",
    "--print-label"
  ]);
  const sharedTasks = sharedCommands.slice(8);
  assert.equal(sharedTasks.filter((command) => command === "typecheck").length, 1);
  assert.equal(sharedTasks.filter((command) => command === "typecheck:dependencies").length, 1);

  const python = ci.jobs.python;
  assert.equal(stepsUsing(python, "actions/setup-python@")[0].with["python-version"], "3.10");
  assert.equal(stepsUsing(python, "actions/setup-java@").length, 1);
  assert.ok(stepRunning(python, 'python -m pip install -e "python[dev]"'));
  assert.ok(stepRunning(python, 'python -m pip install "pandas>=2.2,<3.0" "pyspark[connect]==4.2.0"'));
  assert.match(
    python.steps.find((step) => step.name === "Python lint and coverage").run,
    /lint:python test:coverage:python/u
  );

  const r = ci.jobs.r;
  const setupR = stepsUsing(r, "r-lib/actions/setup-r@");
  assert.equal(setupR.length, 1);
  assert.equal(setupR[0].with["r-version"], "4.5.3");
  assert.equal(setupR[0].with["install-r"], undefined);
  const rSystemRequirement = r.steps.find((step) => step.name === "Install the R lock's system requirement");
  assert.match(rSystemRequirement.run, /apt-get install --yes --no-install-recommends libx11-dev/u);
  assert.match(rSystemRequirement.run, /dpkg-query .*libx11-dev/u);
  assert.ok(stepRunning(r, "node --test scripts/run-r-contract-tests.test.mjs"));
  assert.ok(stepRunning(r, "npm run test:r-contract -- --shard kernel-agent"));
  assert.ok(stepRunning(r, "npm run test:r-contract:protocol"));
  assert.equal(
    r.steps.some((step) => /\bcurl\b/u.test(String(step.run ?? ""))),
    false
  );

  const packageEditor = ci.jobs["package-editor"];
  assert.equal(packageEditor.steps.filter((step) => step.run === "npm run build").length, 1);
  assert.equal(packageEditor.steps.filter((step) => step.run === "npm run build:test-extension").length, 1);
  assert.ok(stepRunning(packageEditor, "node scripts/run-extension-tests.mjs"));
  assert.ok(stepRunning(packageEditor, "npm run package:prepared -- --out openwrangler.vsix"));
  assert.ok(stepRunning(packageEditor, "npm run verify:vsix -- openwrangler.vsix"));
  assert.ok(stepRunning(packageEditor, "npm run test:scripts:portable"));
  assert.equal(packageEditor.steps.find((step) => step.name === "TypeScript tests").run, "npm run test:coverage:ts");
  assert.equal(stepRunning(packageEditor, "npm run test:extension-host"), undefined);

  assert.ok(stepRunning(ci.jobs.web, "env -u CHROME_BIN npm run test:webview-acceptance"));
  assert.ok(stepRunning(ci.jobs.windows, "node --test scripts/copy-extension-vendor-assets.test.mjs"));
  assert.ok(stepRunning(ci.jobs.windows, "npm run test:scripts:native"));
});

test("every top-level script test belongs to one suite", () => {
  const suites = {
    workflow: packageJson.scripts["test:scripts:workflow"],
    portable: packageJson.scripts["test:scripts:portable:run"],
    media: packageJson.scripts["test:scripts:media:run"],
    native: packageJson.scripts["test:scripts:native"]
  };
  const files = readdirSync("scripts", { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
  const owners = new Map(files.map((file) => [file, []]));
  for (const [suite, command] of Object.entries(suites)) {
    for (const match of command.matchAll(/scripts\/[A-Za-z0-9._/-]+\.test\.mjs/gu)) {
      assert.ok(owners.has(match[0]), `${suite} names an unexpected top-level test: ${match[0]}`);
      owners.get(match[0]).push(suite);
    }
  }
  assert.deepEqual(
    [...owners].filter(([, suitesForFile]) => suitesForFile.length !== 1),
    []
  );
});

test("every package Vitest invocation resolves bounded workers", async () => {
  const commands = packageVitestCommands(packageJson.scripts);
  assert.deepEqual(commands.map(([scriptName]) => scriptName).sort(), [
    "test:coverage:ts",
    "test:python-environment-smoke",
    "test:ts"
  ]);

  const resolved = new Map();
  for (const [scriptName, command] of commands) resolved.set(scriptName, await resolveVitestCommand(command));

  for (const scriptName of ["test:ts", "test:coverage:ts"]) {
    const invocation = resolved.get(scriptName);
    assert.equal(relative(repositoryRoot, invocation.viteConfig.configFile), "vite.config.ts");
    assert.equal(invocation.vitestConfig.maxWorkers, 4);
    assert.equal(invocation.vitestConfig.coverage.processingConcurrency, 4);
  }
  assert.equal(resolved.get("test:ts").vitestConfig.coverage.enabled, false);
  assert.equal(resolved.get("test:coverage:ts").vitestConfig.coverage.enabled, true);

  const smoke = resolved.get("test:python-environment-smoke");
  assert.equal(relative(repositoryRoot, smoke.viteConfig.configFile), "vite.python-environment-smoke.config.ts");
  assert.equal(smoke.vitestConfig.fileParallelism, false);
  assert.equal(smoke.vitestConfig.maxWorkers, 1);
  assert.equal(smoke.vitestConfig.minWorkers, 1);
});

test("Vitest resolution honors short configs, implicit precedence, and CLI worker overrides", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-vitest-resolution-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n', "utf8");
  writeFileSync(join(root, "vite.config.ts"), "export default { test: { maxWorkers: 2 } };\n", "utf8");
  writeFileSync(join(root, "vitest.config.ts"), "export default { test: { maxWorkers: 3 } };\n", "utf8");

  const implicit = await resolveVitestCommand("vitest run", root);
  assert.equal(relative(root, implicit.viteConfig.configFile), "vitest.config.ts");
  assert.equal(implicit.vitestConfig.maxWorkers, 3);

  const shortConfig = await resolveVitestCommand("vitest run -c vite.config.ts", root);
  assert.equal(relative(root, shortConfig.viteConfig.configFile), "vite.config.ts");
  assert.equal(shortConfig.vitestConfig.maxWorkers, 2);

  const overridden = await resolveVitestCommand("vitest run --maxWorkers=9", root);
  assert.equal(relative(root, overridden.viteConfig.configFile), "vitest.config.ts");
  assert.equal(overridden.vitestConfig.maxWorkers, 9);
});

test("dependency audits are selected only by dependency changes", () => {
  const nodeAudit = ci.jobs.javascript.steps.find((step) => step.name === "Dependency audit");
  const pythonAudit = ci.jobs.python.steps.find((step) => step.name === "Python dependency checks");
  assert.equal(
    nodeAudit.if,
    "${{ matrix.node == '24.19.0' && needs.changes.outputs.node_dependencies_required == 'true' }}"
  );
  assert.equal(nodeAudit.run, "npm run audit:node");
  assert.equal(pythonAudit.if, "${{ needs.changes.outputs.python_dependencies_required == 'true' }}");
  assert.equal(pythonAudit.run, "npm run lock:remote-jupyter:check && npm run audit:python");
});

test("Node policy follows supported runtimes without duplicating action revisions", () => {
  const workflows = loadBoundedNodeToolchainWorkflowDocuments();
  assert.deepEqual(inspectCurrentNodePolicy(workflows), []);
  const updatedPin = structuredClone(workflows);
  updatedPin["ci.yml"].jobs.changes.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).uses =
    `actions/setup-node@${"a".repeat(40)}`;
  assert.deepEqual(inspectCurrentNodePolicy(updatedPin), []);
});

test("validate accepts expected skips and rejects every bad or missing result", () => {
  assert.deepEqual(ALWAYS_REQUIRED_CI_JOBS, ["changes", "javascript"]);
  assert.deepEqual(REQUIRED_CI_JOBS, ["changes", "javascript", "python", "r", "package-editor", "web", "windows"]);
  const noConditionalJobs = Object.fromEntries(Object.keys(CONDITIONAL_CI_JOBS).map((name) => [name, false]));
  assert.doesNotThrow(() =>
    requireCiResults({ requiredResults: expectedResults(noConditionalJobs), selections: noConditionalJobs })
  );
  assert.doesNotThrow(() => requireCiResults({ requiredResults: expectedResults(), selections: all }));

  for (const result of [undefined, "failure", "cancelled", "skipped", "surprise"]) {
    const results = expectedResults();
    results.python = result;
    assert.throws(() => requireCiResults({ requiredResults: results, selections: all }));
  }
  const unexpectedRun = expectedResults(noConditionalJobs);
  unexpectedRun.r = "success";
  assert.throws(
    () => requireCiResults({ requiredResults: unexpectedRun, selections: noConditionalJobs }),
    /R ran even though it was not selected/u
  );
  const twoFailures = expectedResults();
  twoFailures.python = "failure";
  twoFailures.web = "failure";
  assert.throws(
    () => requireCiResults({ requiredResults: twoFailures, selections: all }),
    (error) =>
      (error.message.match(/Python/gu) ?? []).length === 1 && (error.message.match(/Web UI/gu) ?? []).length === 1
  );
  assert.equal(resultEnvironmentKey("package-editor"), "PACKAGE_EDITOR_RESULT");
});

test("validate is the stable required fan-in", () => {
  assert.deepEqual(ci.jobs.validate.needs, REQUIRED_CI_JOBS);
  assert.equal(ci.jobs.validate.if, "${{ always() && github.event_name == 'pull_request' }}");
  const validation = stepRunning(ci.jobs.validate, "node scripts/require-ci-results.mjs");
  assert.ok(validation);
  assert.deepEqual(Object.keys(validation.env).sort(), [
    "CHANGES_RESULT",
    "JAVASCRIPT_RESULT",
    "PACKAGE_EDITOR_REQUIRED",
    "PACKAGE_EDITOR_RESULT",
    "PYTHON_REQUIRED",
    "PYTHON_RESULT",
    "R_REQUIRED",
    "R_RESULT",
    "WEB_REQUIRED",
    "WEB_RESULT",
    "WINDOWS_REQUIRED",
    "WINDOWS_RESULT"
  ]);
});

test("all workflow actions use fixed revisions", () => {
  for (const name of workflowNames) {
    for (const [path, uses] of allUses(workflow(name))) {
      assert.equal(typeof uses, "string", `${name}:${path} uses must be text`);
      if (uses.startsWith("./")) continue;
      assert.match(
        uses,
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u,
        `${name}:${path} must use a commit`
      );
    }
  }
});

test("CodeQL covers source changes and keeps write access limited to results", () => {
  const codeql = workflow("codeql.yml");
  assert.deepEqual(codeql.on.pull_request.types, ["opened", "synchronize", "reopened"]);
  assert.deepEqual(codeql.on.pull_request.branches, ["main"]);
  assert.deepEqual(codeql.on.push.branches, ["main"]);
  assert.equal(codeql.on.merge_group, undefined);
  assert.deepEqual(codeql.permissions, { actions: "read", contents: "read", "security-events": "write" });
  assert.equal(codeql.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.equal(codeql.jobs["codeql-gate"].name, "CodeQL gate");
  assert.equal(codeql.jobs["codeql-gate"].if, "${{ always() }}");
  assert.deepEqual(codeql.jobs["codeql-gate"].needs, ["analyze-javascript-typescript", "analyze-python"]);
  for (const [name, jobId, needs] of [
    ["release-candidate.yml", "qualify", ["package", "candidate-acceptance", "remote-ssh"]]
  ]) {
    const job = workflow(name).jobs[jobId];
    assert.equal(job.if, "${{ always() }}", `${name}:${jobId} must always inspect dependencies`);
    assert.deepEqual(job.needs, needs);
  }
});
