import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { loadConfigFromFile } from "vite";
import { CI_CLASSIFIER_OUTPUTS, classifyCiChange, parseChangedPathBuffer } from "./ci-path-classification.mjs";
import {
  ALWAYS_REQUIRED_CI_JOBS,
  CONDITIONAL_CI_JOBS,
  REQUIRED_CI_JOBS,
  parseRequiredFlag,
  requireCiResults,
  resultEnvironmentKey
} from "./require-ci-results.mjs";
import { readLock, sha256 } from "./r-dependency-lock.mjs";

const workflowPath = (name) => posix.join(".github", "workflows", name);
const workflow = (name) => parseYaml(readFileSync(workflowPath(name), "utf8"));
const ci = workflow("ci.yml");
const cross = workflow("cross-platform.yml");
const codeql = workflow("codeql.yml");
const performance = workflow("performance.yml");
const releasedJupyter = workflow("released-jupyter.yml");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const pythonProjectMetadata = readFileSync("python/pyproject.toml", "utf8");

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
const WORKFLOW_USE_INVENTORY_SHA256 = "5233a012766676ecf3ecfa6232544c98b490dfe38fe825213bec93bd1b6f5f3b";
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
  ["cross-platform.yml", "$.jobs.python-runtime-dependency-cohorts.steps[1].uses", SETUP_PYTHON],
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
  assert.equal(external.length, 148);
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

function assertCrossScheduledOwners(document) {
  assert.equal(document?.on?.pull_request, undefined);
  assert.ok(Object.hasOwn(document?.on ?? {}, "workflow_dispatch"));
  assert.ok(Object.hasOwn(document?.on ?? {}, "schedule"));
  assert.equal(document?.concurrency?.["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(document?.jobs ?? {}), [
    "runtime",
    "dependency-guard-windows",
    "python-runtime-dependency-cohorts",
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

  const cohorts = document.jobs["python-runtime-dependency-cohorts"];
  assert.equal(cohorts.needs, undefined);
  assert.equal(cohorts.if, undefined);
  assert.equal(cohorts["runs-on"], "ubuntu-24.04");
  assert.equal(cohorts["timeout-minutes"], 15);
  assert.deepEqual(stepsUsing(cohorts, "actions/setup-python@"), [
    {
      uses: SETUP_PYTHON,
      with: { "python-version": "3.12" }
    }
  ]);

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
  const names = readdirSync(".github/workflows")
    .filter((entry) => /\.ya?ml$/u.test(entry))
    .sort();
  const rows = workflowUseRows(names.map((name) => [name, workflow(name)]));
  const inventory = validateWorkflowUseRows(rows);
  assert.equal(inventory.external.length, 148);
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

  const sources = names.map((entry) => readFileSync(workflowPath(entry), "utf8")).join("\n");
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
    assert.equal(record.lock.roots.length, 8);
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

test("automation retains the exact Node and npm toolchain authority", () => {
  const nodeVersion = readFileSync(".node-version", "utf8").trim();
  assert.equal(nodeVersion, "22.22.0");
  assert.equal(packageJson.engines.node, ">=22.22.0 <23");
  assert.equal(packageJson.packageManager, "npm@10.9.4");
  let setupNodeCount = 0;
  for (const name of readdirSync(".github/workflows").filter((entry) => entry.endsWith(".yml"))) {
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
  const dependabot = parseYaml(readFileSync(".github/dependabot.yml", "utf8"));
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
