import { createHash } from "node:crypto";
import { load as parseYaml } from "js-yaml";
import { inspectDeferredDiagnosticFailures } from "./release-diagnostic-order.mjs";

const CHECKOUT = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const SETUP_NODE = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const SETUP_PYTHON = "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1";
const SETUP_JAVA = "actions/setup-java@f2beeb24e141e01a676f977032f5a29d81c9e27e";
const SETUP_R = "r-lib/actions/setup-r@d3c5be51b12e724e68f33216ca3c148b66d5f0b6";
const SETUP_R_DEPENDENCIES = "r-lib/actions/setup-r-dependencies@d3c5be51b12e724e68f33216ca3c148b66d5f0b6";
const CALL_PATH = "./.github/workflows/candidate-acceptance.yml";
const ARTIFACT_ID = "${{ needs.package.outputs.artifact-id }}";
const EVENT_SHA = "${{ github.sha }}";
const RELEASE_TAG = "${{ inputs.release_tag }}";
const VERIFY =
  "node scripts/verify-${{ inputs.channel == 'preview' && 'preview' || 'canonical' }}-release-artifact.mjs canonical-release";
const MATRIX = [
  { name: "macOS platform", lane: "platform", os: "macos-latest", python: "3.12" },
  { name: "Windows platform", lane: "platform", os: "windows-latest", python: "3.14" },
  { name: "Linux acceptance", lane: "linux", os: "ubuntu-24.04", python: "3.12" },
  { name: "Installed performance", lane: "performance", os: "ubuntu-24.04", python: "3.12" },
  { name: "Released Jupyter", lane: "jupyter", os: "ubuntu-24.04", python: "3.12" }
];
const R_CONTRACT_EXTRA_PACKAGES = [
  "any::jsonlite",
  "any::tibble",
  "any::readr",
  "any::dplyr",
  "any::data.table",
  "any::bit64",
  "any::collapse",
  "any::nanoparquet"
].join("\n");
const PREPARE_XVFB_COMMAND_SHA256 = "96528481625ac66c09687cf7e47bcfc6a3cb657828919be1ca8a1bfa4f4b29b3";
const JUPYTER_STEPS_SHA256 = "79cec05ba9f583f913ca2bde401a106d48ccb4c274195fed2ac250fd043d0e1f";

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function command(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalContractValue(value) {
  if (Array.isArray(value)) return value.map(canonicalContractValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalContractValue(value[key])])
  );
}

function exactJupyterStepsHash(jobSteps) {
  return sha256(JSON.stringify(canonicalContractValue(jobSteps)));
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function runs(job) {
  return steps(job)
    .map((step) => command(step?.run))
    .filter(Boolean);
}

function sameMatrix(actual) {
  return (
    Array.isArray(actual) &&
    actual.length === MATRIX.length &&
    actual.every(
      (entry, index) =>
        exactKeys(entry, ["name", "lane", "os", "python"]) &&
        Object.entries(MATRIX[index]).every(([key, value]) => entry[key] === value)
    )
  );
}

export function inspectCandidateMatrixCaller(workflow, channel) {
  const problems = [];
  const candidate = workflow?.jobs?.["candidate-acceptance"];
  if (
    !exactKeys(candidate, ["name", "needs", "strategy", "uses", "permissions", "with"]) ||
    candidate.name !== "Candidate acceptance (${{ matrix.name }})" ||
    candidate.needs !== "package" ||
    candidate.uses !== CALL_PATH ||
    !exactKeys(candidate.strategy, ["fail-fast", "matrix"]) ||
    candidate.strategy?.["fail-fast"] !== false ||
    !exactKeys(candidate.strategy?.matrix, ["include"]) ||
    !sameMatrix(candidate.strategy?.matrix?.include) ||
    !exactKeys(candidate.permissions, ["contents"]) ||
    candidate.permissions.contents !== "read" ||
    !exactKeys(candidate.with, [
      "artifact_id",
      "channel",
      "expected_sha",
      "lane",
      "python_version",
      "release_tag",
      "runner_os"
    ]) ||
    candidate.with.artifact_id !== ARTIFACT_ID ||
    candidate.with.channel !== channel ||
    candidate.with.expected_sha !== EVENT_SHA ||
    candidate.with.lane !== "${{ matrix.lane }}" ||
    candidate.with.python_version !== "${{ matrix.python }}" ||
    candidate.with.release_tag !== RELEASE_TAG ||
    candidate.with.runner_os !== "${{ matrix.os }}"
  ) {
    problems.push(`${channel} must call the shared five-cell candidate matrix without cancelling sibling cleanup.`);
  }
  return problems;
}

function inspectLane(jobName, job, lane, timeout, problems) {
  if (
    job?.if !== `\${{ inputs.lane == '${lane}' }}` ||
    job?.needs !== "contract" ||
    job?.["runs-on"] !== "${{ inputs.runner_os }}" ||
    job?.["timeout-minutes"] !== timeout
  ) {
    problems.push(`${jobName} must be a bounded ${lane} lane selected only after input validation.`);
  }
  const jobSteps = steps(job);
  const checkouts = jobSteps.filter((step) => step?.uses === CHECKOUT);
  const downloads = jobSteps.filter((step) => step?.uses === DOWNLOAD);
  if (
    checkouts.length !== 1 ||
    checkouts[0]?.with?.ref !== "${{ inputs.expected_sha }}" ||
    checkouts[0]?.with?.["fetch-depth"] !== 0 ||
    checkouts[0]?.with?.["persist-credentials"] !== false ||
    downloads.length !== 1 ||
    downloads[0]?.with?.["artifact-ids"] !== "${{ inputs.artifact_id }}" ||
    downloads[0]?.with?.path !== "canonical-release" ||
    downloads[0]?.with?.["merge-multiple"] !== true
  ) {
    problems.push(`${jobName} must check out and consume only the caller-bound canonical artifact.`);
  }
  const verifiers = jobSteps.filter((step) => command(step?.run) === VERIFY);
  if (
    verifiers.length === 0 ||
    verifiers.some(
      (step) =>
        step?.env?.EXPECTED_SHA !== "${{ inputs.expected_sha }}" ||
        step?.env?.RELEASE_TAG !== "${{ inputs.release_tag }}"
    )
  ) {
    problems.push(`${jobName} must bind every candidate verification to the exact source and tag inputs.`);
  }
  if (
    runs(job).some(
      (run) => /^npm run package(?:\s|$)/u.test(run) || run.includes("create-canonical-release-artifact.mjs")
    )
  ) {
    problems.push(`${jobName} must consume the candidate without rebuilding it.`);
  }
}

function inspectPackagedRunner(jobName, job, specification, problems) {
  const jobSteps = steps(job);
  const runners = jobSteps.filter((step) => step?.id === specification.id);
  const runner = runners[0];
  const runnerIndex = jobSteps.indexOf(runner);
  const verifier = jobSteps[runnerIndex - 1];
  const conditionalKeys = specification.condition === undefined ? [] : ["if"];
  if (
    runners.length !== 1 ||
    !exactKeys(runner, ["id", "name", "continue-on-error", "run", "env", ...conditionalKeys]) ||
    runner?.["continue-on-error"] !== true ||
    command(runner?.run) !== specification.run ||
    runner?.if !== specification.condition ||
    !exactKeys(runner?.env, Object.keys(specification.env)) ||
    Object.entries(specification.env).some(([name, value]) => runner.env[name] !== value) ||
    verifier?.id !== specification.verifierId ||
    !exactKeys(verifier, ["id", "name", "env", "run", ...conditionalKeys]) ||
    command(verifier?.run) !== VERIFY ||
    verifier?.if !== specification.condition ||
    !exactKeys(verifier?.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    verifier.env.EXPECTED_SHA !== "${{ inputs.expected_sha }}" ||
    verifier.env.RELEASE_TAG !== "${{ inputs.release_tag }}"
  ) {
    problems.push(`${jobName}/${specification.id} must immediately follow its dedicated artifact verification.`);
  }
}

function inspectFailureDiagnosticUpload(jobName, job, specification, problems) {
  const uploads = steps(job).filter((step) => step?.name === specification.name);
  const upload = uploads[0];
  const jobSteps = steps(job);
  const runnerIndex = jobSteps.findIndex((step) => step?.id === specification.runnerId);
  const uploadIndex = jobSteps.indexOf(upload);
  const deferredFailure = jobSteps[uploadIndex + 1];
  const immediateFailureInvalid =
    specification.failureName !== undefined &&
    (!deferredFailure ||
      deferredFailure?.name !== specification.failureName ||
      !exactKeys(deferredFailure, ["name", "if", "run"]) ||
      deferredFailure.if !== `\${{ always() && steps.${specification.runnerId}.outcome == 'failure' }}` ||
      command(deferredFailure.run) !== "exit 1");
  if (
    uploads.length !== 1 ||
    !exactKeys(upload, ["name", "if", "uses", "with"]) ||
    upload?.uses !== UPLOAD ||
    upload?.if !==
      `\${{ always() && steps.${specification.runnerId}.outcome == 'failure' && steps.${specification.runnerId}.outputs.evidence_ready == 'true' }}` ||
    !exactKeys(upload?.with, [
      "name",
      "path",
      "if-no-files-found",
      "retention-days",
      "compression-level",
      "include-hidden-files"
    ]) ||
    upload.with.name !== specification.artifactName ||
    upload.with.path !== `\${{ steps.${specification.runnerId}.outputs.evidence_path }}` ||
    upload.with["if-no-files-found"] !== "error" ||
    upload.with["retention-days"] !== 7 ||
    upload.with["compression-level"] !== 9 ||
    upload.with["include-hidden-files"] !== false ||
    uploadIndex !== runnerIndex + 1 ||
    immediateFailureInvalid
  ) {
    problems.push(
      `${jobName}/${specification.runnerId} must immediately upload only its exact sealed failure evidence${
        specification.failureName === undefined ? "." : " and then fail."
      }`
    );
  }
}

function inspectAggregateFailure(jobName, job, specification, problems) {
  const jobSteps = steps(job);
  const failures = jobSteps.filter((step) => step?.name === specification.name);
  const failure = failures[0];
  const finalUpload = jobSteps.find((step) => step?.name === specification.afterUploadName);
  if (
    failures.length !== 1 ||
    !exactKeys(failure, ["name", "if", "run"]) ||
    failure?.if !==
      `\${{ always() && (${specification.runnerIds
        .map((runnerId) => `steps.${runnerId}.outcome == 'failure'`)
        .join(" || ")}) }}` ||
    command(failure?.run) !== "exit 1" ||
    jobSteps.indexOf(failure) !== jobSteps.indexOf(finalUpload) + 1
  ) {
    problems.push(`${jobName} must report the exact ordered local acceptance failures after every diagnostic upload.`);
  }
}

function inspectXvfb(jobName, job, id, beforeRunnerId, problems) {
  const jobSteps = steps(job);
  const preparations = jobSteps.filter((step) => step?.id === id);
  const preparation = preparations[0];
  const runner = jobSteps.find((step) => step?.id === beforeRunnerId);
  const preparationRun = command(preparation?.run);
  if (
    preparations.length !== 1 ||
    !exactKeys(preparation, ["id", "name", "shell", "run"]) ||
    preparation?.shell !== "node {0}" ||
    sha256(preparationRun) !== PREPARE_XVFB_COMMAND_SHA256 ||
    jobSteps.indexOf(preparation) >= jobSteps.indexOf(runner)
  ) {
    problems.push(`${jobName}/${beforeRunnerId} must use one verified private Xvfb preparation.`);
  }
}

function includesAll(values, expected) {
  return expected.every((value) => values.includes(value));
}

const JUPYTER_STEP_TOPOLOGY = [
  ["uses", CHECKOUT],
  ["uses", SETUP_NODE],
  ["uses", SETUP_PYTHON],
  ["uses", SETUP_JAVA],
  ["uses", SETUP_R],
  ["id", "rscript"],
  ["run", "npm ci"],
  ["uses", SETUP_R_DEPENDENCIES],
  ["run", "npm run test:r-contract"],
  ["run", "python -m pip install --upgrade pip"],
  ["run", 'python -m pip install -e "python[dev]"'],
  ["run-prefix", 'python -m pip install --no-deps "https://files.pythonhosted.org/'],
  ["run", "npm run lock:remote-jupyter:check"],
  ["run", "npm run audit:remote-jupyter"],
  ["uses", DOWNLOAD],
  ["id", "canonical"],
  ["run", "npm run verify:vsix -- canonical-release/openwrangler.vsix"],
  ["run", "npm run build:test-extension"],
  ["id", "prepare_xvfb"],
  ["id", "canonical_jupyter"],
  ["id", "packaged_editor"],
  ["name", "Upload released-Jupyter failure diagnostics"],
  ["name", "Fail after released-Jupyter diagnostics"],
  ["id", "canonical_r_jupyter"],
  ["id", "packaged_editor_r"],
  ["name", "Upload local R-Jupyter failure diagnostics"],
  ["id", "canonical_r_values"],
  ["id", "packaged_editor_r_values"],
  ["name", "Upload value R-Jupyter failure diagnostics"],
  ["id", "canonical_r_categorical"],
  ["id", "packaged_editor_r_categorical"],
  ["name", "Upload categorical R-Jupyter failure diagnostics"],
  ["id", "canonical_r_interactive"],
  ["id", "packaged_editor_r_interactive"],
  ["name", "Upload active R terminal failure diagnostics"],
  ["id", "canonical_r_literate"],
  ["id", "packaged_editor_r_literate"],
  ["name", "Upload R Markdown and Quarto failure diagnostics"],
  ["name", "Fail after local R acceptance diagnostics"],
  ["id", "canonical_r_remote"],
  ["id", "packaged_editor_r_remote"],
  ["name", "Upload remote R-Jupyter failure diagnostics"],
  ["name", "Fail after remote R-Jupyter diagnostics"]
];

function matchesStepTopology(step, [kind, expected]) {
  if (kind === "uses") return step?.uses === expected;
  if (kind === "uses-prefix") return typeof step?.uses === "string" && step.uses.startsWith(expected);
  if (kind === "id") return step?.id === expected;
  if (kind === "name") return step?.name === expected;
  if (kind === "run") return command(step?.run) === expected;
  if (kind === "run-prefix") return command(step?.run).startsWith(expected);
  return false;
}

function hasUniqueNonemptyStepIds(job) {
  const ids = steps(job)
    .map((step) => step?.id)
    .filter((id) => id !== undefined);
  return ids.every((id) => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;
}

export function inspectCandidateAcceptanceWorkflow(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) {
    return ["candidate-acceptance.yml must be bounded YAML text."];
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch {
    return ["candidate-acceptance.yml must contain valid YAML."];
  }
  const problems = [];
  const inputs = workflow?.on?.workflow_call?.inputs;
  const inputNames = ["artifact_id", "channel", "expected_sha", "lane", "python_version", "release_tag", "runner_os"];
  if (
    !exactKeys(workflow, ["name", "on", "permissions", "jobs"]) ||
    workflow.name !== "Candidate acceptance lane" ||
    !exactKeys(inputs, inputNames) ||
    inputNames.some(
      (name) =>
        !exactKeys(inputs?.[name], ["required", "type"]) ||
        inputs[name].required !== true ||
        inputs[name].type !== "string"
    ) ||
    !exactKeys(workflow.permissions, ["contents"]) ||
    workflow.permissions.contents !== "read" ||
    !exactKeys(workflow.jobs, ["contract", "platform", "linux", "performance", "jupyter"])
  ) {
    problems.push("candidate acceptance must expose only its seven required read-only inputs and five jobs.");
    return problems;
  }

  const contract = workflow.jobs.contract;
  const contractStep = steps(contract)[0];
  const contractRun = command(contractStep?.run);
  if (
    contract?.["runs-on"] !== "ubuntu-24.04" ||
    contract?.["timeout-minutes"] !== 5 ||
    steps(contract).length !== 1 ||
    !exactKeys(contractStep, ["name", "env", "run"]) ||
    !exactKeys(contractStep?.env, [
      "ARTIFACT_ID",
      "CHANNEL",
      "EXPECTED_SHA",
      "LANE",
      "PYTHON_VERSION",
      "RELEASE_TAG",
      "CANDIDATE_RUNNER_OS"
    ]) ||
    contractStep.env.CANDIDATE_RUNNER_OS !== "${{ inputs.runner_os }}" ||
    !includesAll(contractRun, [
      'case "$CHANNEL" in preview|stable)',
      'case "$LANE:$CANDIDATE_RUNNER_OS:$PYTHON_VERSION" in',
      "platform:macos-latest:3.12",
      "platform:windows-latest:3.14",
      "linux:ubuntu-24.04:3.12",
      "performance:ubuntu-24.04:3.12",
      "jupyter:ubuntu-24.04:3.12"
    ])
  ) {
    problems.push("candidate acceptance must reject every unknown channel or lane tuple before dispatch.");
  }

  const laneSpecs = [
    ["platform", "platform", 90],
    ["linux", "linux", 120],
    ["performance", "performance", 120],
    ["jupyter", "jupyter", 120]
  ];
  for (const [jobName, lane, timeout] of laneSpecs) {
    inspectLane(jobName, workflow.jobs[jobName], lane, timeout, problems);
  }

  const platformRuns = runs(workflow.jobs.platform);
  if (
    !includesAll(platformRuns, [
      "npm run test:python-environment-smoke",
      "npm run test:extension-host",
      "npm run build:test-extension",
      "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      "node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_jupyter_platform.outputs.candidate_path }}"
    ])
  ) {
    problems.push("platform must retain native VS Code, Cursor, and local R-Jupyter acceptance.");
  }
  inspectPackagedRunner(
    "platform",
    workflow.jobs.platform,
    {
      id: "packaged_editor",
      verifierId: "canonical_vscode",
      run: "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: { OPEN_WRANGLER_PACKAGED_EDITORS: "vscode", VSCODE_TEST_VERSION: "stable" }
    },
    problems
  );
  inspectPackagedRunner(
    "platform",
    workflow.jobs.platform,
    {
      id: "cursor_smoke",
      verifierId: "canonical_cursor",
      run: "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: { OPEN_WRANGLER_PACKAGED_EDITORS: "cursor", OPEN_WRANGLER_PACKAGED_MODE: "platform-smoke" }
    },
    problems
  );
  inspectPackagedRunner(
    "platform",
    workflow.jobs.platform,
    {
      id: "packaged_editor_r_platform",
      verifierId: "canonical_r_jupyter_platform",
      run: "node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_jupyter_platform.outputs.candidate_path }}",
      env: {
        OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
        OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );

  const linuxRuns = runs(workflow.jobs.linux);
  if (
    !includesAll(linuxRuns, [
      "npm run check",
      "npm run test:scripts",
      "npm run test:webview-acceptance",
      "npm run test:coverage",
      "npm audit --omit=dev",
      "npm run audit:python",
      "npm run benchmark:runtime",
      "npm run build:test-extension"
    ]) ||
    !linuxRuns.some((run) => run.includes('"pyspark[connect]==4.2.0"'))
  ) {
    problems.push("linux must retain the full source, webview, coverage, audit, benchmark, and editor gates.");
  }
  inspectPackagedRunner(
    "linux",
    workflow.jobs.linux,
    {
      id: "packaged_vscode",
      verifierId: "canonical_vscode",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: { OPEN_WRANGLER_PACKAGED_EDITORS: "vscode", VSCODE_TEST_VERSION: "stable" }
    },
    problems
  );
  inspectPackagedRunner(
    "linux",
    workflow.jobs.linux,
    {
      id: "packaged_cursor",
      verifierId: "canonical_cursor",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: {
        OPEN_WRANGLER_PACKAGED_EDITORS: "cursor",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_cursor_xvfb.outputs.executable }}",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );
  inspectXvfb("linux", workflow.jobs.linux, "prepare_cursor_xvfb", "packaged_cursor", problems);

  const performanceRuns = runs(workflow.jobs.performance);
  const performance = steps(workflow.jobs.performance).find((step) => step?.id === "installed_performance");
  if (
    performance?.env?.PREVIEW_FLAG !== "${{ inputs.channel == 'preview' && '--preview-release' || '' }}" ||
    !performanceRuns.some(
      (run) =>
        run.includes("benchmark:installed --") &&
        run.includes("$PREVIEW_FLAG") &&
        run.includes("--pinned-editors") &&
        run.includes("--candidate-provenance canonical-release/openwrangler.vsix.provenance.json")
    ) ||
    !performanceRuns.includes("node scripts/prepare-stable-candidate-tag.mjs") ||
    steps(workflow.jobs.performance).find(
      (step) => command(step?.run) === "node scripts/prepare-stable-candidate-tag.mjs"
    )?.if !== "${{ inputs.channel == 'stable' }}"
  ) {
    problems.push("performance must preserve preview mode and stable tag preparation against one candidate.");
  }

  const jupyterRuns = runs(workflow.jobs.jupyter);
  const jupyterStrategy = workflow.jobs.jupyter?.strategy;
  const jupyterSteps = steps(workflow.jobs.jupyter);
  const setupJavaSteps = jupyterSteps.filter((step) => step?.uses?.startsWith("actions/setup-java@"));
  const setupPythonSteps = jupyterSteps.filter((step) => step?.uses?.startsWith("actions/setup-python@"));
  const setupRSteps = jupyterSteps.filter((step) => step?.uses?.startsWith("r-lib/actions/setup-r@"));
  const setupJava = setupJavaSteps[0];
  const setupPython = setupPythonSteps[0];
  const setupR = setupRSteps[0];
  const setupRDependencies = Object.values(workflow.jobs).flatMap((job) =>
    steps(job).filter((step) => step?.uses?.startsWith("r-lib/actions/setup-r-dependencies@"))
  );
  const rDependencies = setupRDependencies[0];
  const jupyterRDependencies = jupyterSteps.filter((step) =>
    step?.uses?.startsWith("r-lib/actions/setup-r-dependencies@")
  );
  const rscriptSteps = jupyterSteps.filter((step) => step?.id === "rscript");
  const rscript = rscriptSteps[0];
  const rContracts = jupyterSteps.filter((step) => command(step?.run) === "npm run test:r-contract");
  const rContract = rContracts[0];
  const npmCiSteps = jupyterSteps.filter((step) => command(step?.run) === "npm ci");
  const npmCi = npmCiSteps[0];
  const pipUpgradeSteps = jupyterSteps.filter((step) => command(step?.run) === "python -m pip install --upgrade pip");
  const pythonDevSteps = jupyterSteps.filter((step) => command(step?.run) === 'python -m pip install -e "python[dev]"');
  const pipInstallSteps = jupyterSteps.filter((step) => /^python -m pip install(?:\s|$)/u.test(command(step?.run)));
  const uvSteps = jupyterSteps.filter((step) => command(step?.run).startsWith("python -m pip install --no-deps "));
  const remoteLockChecks = jupyterSteps.filter((step) => command(step?.run) === "npm run lock:remote-jupyter:check");
  const remoteAudits = jupyterSteps.filter((step) => command(step?.run) === "npm run audit:remote-jupyter");
  const pipUpgrade = pipUpgradeSteps[0];
  const pythonDev = pythonDevSteps[0];
  const uv = uvSteps[0];
  const remoteLockCheck = remoteLockChecks[0];
  const remoteAudit = remoteAudits[0];
  if (
    jupyterSteps.length !== JUPYTER_STEP_TOPOLOGY.length ||
    !jupyterSteps.every((step, index) => matchesStepTopology(step, JUPYTER_STEP_TOPOLOGY[index])) ||
    exactJupyterStepsHash(jupyterSteps) !== JUPYTER_STEPS_SHA256 ||
    !Object.values(workflow.jobs).every(hasUniqueNonemptyStepIds) ||
    !exactKeys(workflow.jobs.jupyter, ["if", "name", "needs", "runs-on", "timeout-minutes", "strategy", "steps"]) ||
    workflow.jobs.jupyter?.name !==
      "Released Jupyter acceptance (${{ matrix.phase == 'python' && 'Python' || matrix.phase == 'r-local' && 'R local' || 'R remote' }})" ||
    !exactKeys(jupyterStrategy, ["fail-fast", "matrix"]) ||
    jupyterStrategy?.["fail-fast"] !== false ||
    !exactKeys(jupyterStrategy?.matrix, ["phase"]) ||
    !Array.isArray(jupyterStrategy?.matrix?.phase) ||
    jupyterStrategy.matrix.phase.length !== 3 ||
    jupyterStrategy.matrix.phase[0] !== "python" ||
    jupyterStrategy.matrix.phase[1] !== "r-local" ||
    jupyterStrategy.matrix.phase[2] !== "r-remote" ||
    setupPythonSteps.length !== 1 ||
    setupPython?.if !== undefined ||
    setupJavaSteps.length !== 1 ||
    setupJava?.if !== "${{ matrix.phase == 'python' }}" ||
    setupRSteps.length !== 1 ||
    setupR?.if !== "${{ matrix.phase == 'r-local' }}" ||
    rscriptSteps.length !== 1 ||
    rscript?.if !== "${{ matrix.phase == 'r-local' }}" ||
    rContract?.if !== "${{ matrix.phase == 'r-local' }}" ||
    npmCiSteps.length !== 1 ||
    pipUpgradeSteps.length !== 1 ||
    pipUpgrade?.if !== "${{ matrix.phase != 'r-remote' }}" ||
    pythonDevSteps.length !== 1 ||
    pythonDev?.if !== "${{ matrix.phase != 'r-remote' }}" ||
    uvSteps.length !== 1 ||
    uv?.if !== "${{ matrix.phase == 'python' }}" ||
    !command(uv?.run).includes("uv-0.11.32-") ||
    !command(uv?.run).includes("#sha256=3da76cd4e2697de30928b8a8524bd39183ac1e08cb7e72833807c022b7cba6c4") ||
    remoteLockChecks.length !== 1 ||
    remoteLockCheck?.if !== "${{ matrix.phase == 'python' }}" ||
    remoteAudits.length !== 1 ||
    remoteAudit?.if !== "${{ matrix.phase == 'python' }}" ||
    pipInstallSteps.length !== 3 ||
    !includesAll(jupyterRuns, [
      "npm run test:r-contract",
      "npm run lock:remote-jupyter:check",
      "npm run audit:remote-jupyter",
      "npm run build:test-extension"
    ]) ||
    !steps(workflow.jobs.jupyter).some(
      (step) =>
        step?.env?.OPEN_WRANGLER_REAL_JUPYTER_EXTENSION === "1" && step?.env?.OPEN_WRANGLER_REAL_REMOTE_JUPYTER === "1"
    )
  ) {
    problems.push(
      "jupyter must run separate non-cancelling Python, local R, and remote R cells without hosted runtime setup in the remote cell."
    );
  }
  if (
    setupRDependencies.length !== 1 ||
    jupyterRDependencies.length !== 1 ||
    rDependencies !== jupyterRDependencies[0] ||
    !exactKeys(rDependencies, ["name", "if", "uses", "with"]) ||
    rDependencies?.name !== "Resolve R contract packages" ||
    rDependencies?.if !== "${{ matrix.phase == 'r-local' }}" ||
    rDependencies?.uses !== SETUP_R_DEPENDENCIES ||
    !exactKeys(rDependencies?.with, [
      "packages",
      "extra-packages",
      "dependencies",
      "cache",
      "cache-version",
      "install-pandoc",
      "install-quarto"
    ]) ||
    rDependencies.with.packages !== "" ||
    rDependencies.with["extra-packages"] !== R_CONTRACT_EXTRA_PACKAGES ||
    rDependencies.with.dependencies !== '"hard"' ||
    rDependencies.with.cache !== true ||
    rDependencies.with["cache-version"] !== "native-r-contract-v1" ||
    rDependencies.with["install-pandoc"] !== false ||
    rDependencies.with["install-quarto"] !== false ||
    rContracts.length !== 1 ||
    !exactKeys(rContract, ["run", "if", "env"]) ||
    !exactKeys(rContract?.env, ["RSCRIPT"]) ||
    rContract.env.RSCRIPT !== "${{ steps.rscript.outputs.executable }}" ||
    jupyterSteps.indexOf(rDependencies) !== jupyterSteps.indexOf(npmCi) + 1 ||
    jupyterSteps.indexOf(rContract) !== jupyterSteps.indexOf(rDependencies) + 1 ||
    jupyterSteps.some((step) => /\binstall\.packages\s*\(/u.test(command(step?.run)))
  ) {
    problems.push("jupyter R must resolve the exact contract dependencies before its unchanged contract run.");
  }
  inspectPackagedRunner(
    "jupyter",
    workflow.jobs.jupyter,
    {
      id: "packaged_editor",
      verifierId: "canonical_jupyter",
      condition: "${{ matrix.phase == 'python' }}",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: {
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );
  inspectPackagedRunner(
    "jupyter",
    workflow.jobs.jupyter,
    {
      id: "packaged_editor_r",
      verifierId: "canonical_r_jupyter",
      condition: "${{ matrix.phase == 'r-local' }}",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_jupyter.outputs.candidate_path }}",
      env: {
        OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
        OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );
  inspectPackagedRunner(
    "jupyter",
    workflow.jobs.jupyter,
    {
      id: "packaged_editor_r_values",
      verifierId: "canonical_r_values",
      condition: "${{ matrix.phase == 'r-local' }}",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_values.outputs.candidate_path }}",
      env: {
        OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
        OPEN_WRANGLER_PACKAGED_R_JOURNEY: "value-operations",
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
        OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );
  inspectPackagedRunner(
    "jupyter",
    workflow.jobs.jupyter,
    {
      id: "packaged_editor_r_categorical",
      verifierId: "canonical_r_categorical",
      condition: "${{ matrix.phase == 'r-local' }}",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_categorical.outputs.candidate_path }}",
      env: {
        OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
        OPEN_WRANGLER_PACKAGED_R_JOURNEY: "categorical-operations",
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
        OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );
  inspectPackagedRunner(
    "jupyter",
    workflow.jobs.jupyter,
    {
      id: "packaged_editor_r_interactive",
      verifierId: "canonical_r_interactive",
      condition: "${{ matrix.phase == 'r-local' }}",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_interactive.outputs.candidate_path }}",
      env: {
        OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
        OPEN_WRANGLER_PACKAGED_R_JOURNEY: "interactive-terminal",
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
        OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );
  inspectPackagedRunner(
    "jupyter",
    workflow.jobs.jupyter,
    {
      id: "packaged_editor_r_literate",
      verifierId: "canonical_r_literate",
      condition: "${{ matrix.phase == 'r-local' }}",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_literate.outputs.candidate_path }}",
      env: {
        OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
        OPEN_WRANGLER_PACKAGED_R_JOURNEY: "literate-documents",
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
        OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );
  inspectPackagedRunner(
    "jupyter",
    workflow.jobs.jupyter,
    {
      id: "packaged_editor_r_remote",
      verifierId: "canonical_r_remote",
      condition: "${{ matrix.phase == 'r-remote' }}",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_remote.outputs.candidate_path }}",
      env: {
        OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
        OPEN_WRANGLER_PACKAGED_R_JOURNEY: "remote-r-jupyter",
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    problems
  );
  inspectXvfb("jupyter", workflow.jobs.jupyter, "prepare_xvfb", "packaged_editor", problems);
  inspectXvfb("jupyter", workflow.jobs.jupyter, "prepare_xvfb", "packaged_editor_r", problems);
  inspectXvfb("jupyter", workflow.jobs.jupyter, "prepare_xvfb", "packaged_editor_r_values", problems);
  inspectXvfb("jupyter", workflow.jobs.jupyter, "prepare_xvfb", "packaged_editor_r_categorical", problems);
  inspectXvfb("jupyter", workflow.jobs.jupyter, "prepare_xvfb", "packaged_editor_r_interactive", problems);
  inspectXvfb("jupyter", workflow.jobs.jupyter, "prepare_xvfb", "packaged_editor_r_literate", problems);
  inspectXvfb("jupyter", workflow.jobs.jupyter, "prepare_xvfb", "packaged_editor_r_remote", problems);
  inspectFailureDiagnosticUpload(
    "jupyter",
    workflow.jobs.jupyter,
    {
      name: "Upload local R-Jupyter failure diagnostics",
      runnerId: "packaged_editor_r",
      artifactName: "${{ inputs.channel }}-release-r-jupyter-local-${{ runner.os }}-${{ github.run_attempt }}"
    },
    problems
  );
  inspectFailureDiagnosticUpload(
    "jupyter",
    workflow.jobs.jupyter,
    {
      name: "Upload value R-Jupyter failure diagnostics",
      runnerId: "packaged_editor_r_values",
      artifactName: "${{ inputs.channel }}-release-r-jupyter-values-${{ runner.os }}-${{ github.run_attempt }}"
    },
    problems
  );
  inspectFailureDiagnosticUpload(
    "jupyter",
    workflow.jobs.jupyter,
    {
      name: "Upload categorical R-Jupyter failure diagnostics",
      runnerId: "packaged_editor_r_categorical",
      artifactName: "${{ inputs.channel }}-release-r-jupyter-categorical-${{ runner.os }}-${{ github.run_attempt }}"
    },
    problems
  );
  inspectFailureDiagnosticUpload(
    "jupyter",
    workflow.jobs.jupyter,
    {
      name: "Upload active R terminal failure diagnostics",
      runnerId: "packaged_editor_r_interactive",
      artifactName: "${{ inputs.channel }}-release-r-jupyter-interactive-${{ runner.os }}-${{ github.run_attempt }}"
    },
    problems
  );
  inspectFailureDiagnosticUpload(
    "jupyter",
    workflow.jobs.jupyter,
    {
      name: "Upload R Markdown and Quarto failure diagnostics",
      runnerId: "packaged_editor_r_literate",
      artifactName: "${{ inputs.channel }}-release-r-jupyter-literate-${{ runner.os }}-${{ github.run_attempt }}"
    },
    problems
  );
  inspectAggregateFailure(
    "jupyter",
    workflow.jobs.jupyter,
    {
      name: "Fail after local R acceptance diagnostics",
      afterUploadName: "Upload R Markdown and Quarto failure diagnostics",
      runnerIds: [
        "packaged_editor_r",
        "packaged_editor_r_values",
        "packaged_editor_r_categorical",
        "packaged_editor_r_interactive",
        "packaged_editor_r_literate"
      ]
    },
    problems
  );
  inspectFailureDiagnosticUpload(
    "jupyter",
    workflow.jobs.jupyter,
    {
      name: "Upload remote R-Jupyter failure diagnostics",
      failureName: "Fail after remote R-Jupyter diagnostics",
      runnerId: "packaged_editor_r_remote",
      artifactName: "${{ inputs.channel }}-release-r-jupyter-remote-${{ runner.os }}-${{ github.run_attempt }}"
    },
    problems
  );
  const jupyterStepList = steps(workflow.jobs.jupyter);
  const ordinaryRUpload = jupyterStepList.findIndex(
    (step) => step?.name === "Upload local R-Jupyter failure diagnostics"
  );
  const valueVerifier = jupyterStepList.findIndex((step) => step?.id === "canonical_r_values");
  const valueUpload = jupyterStepList.findIndex((step) => step?.name === "Upload value R-Jupyter failure diagnostics");
  const categoricalVerifier = jupyterStepList.findIndex((step) => step?.id === "canonical_r_categorical");
  const categoricalUpload = jupyterStepList.findIndex(
    (step) => step?.name === "Upload categorical R-Jupyter failure diagnostics"
  );
  const interactiveVerifier = jupyterStepList.findIndex((step) => step?.id === "canonical_r_interactive");
  const interactiveUpload = jupyterStepList.findIndex(
    (step) => step?.name === "Upload active R terminal failure diagnostics"
  );
  const literateVerifier = jupyterStepList.findIndex((step) => step?.id === "canonical_r_literate");
  const literateUpload = jupyterStepList.findIndex(
    (step) => step?.name === "Upload R Markdown and Quarto failure diagnostics"
  );
  const localFailure = jupyterStepList.findIndex((step) => step?.name === "Fail after local R acceptance diagnostics");
  if (
    ordinaryRUpload < 0 ||
    valueVerifier <= ordinaryRUpload ||
    valueUpload <= valueVerifier ||
    categoricalVerifier <= valueUpload ||
    categoricalUpload <= categoricalVerifier ||
    interactiveVerifier <= categoricalUpload ||
    interactiveUpload <= interactiveVerifier ||
    literateVerifier <= interactiveUpload ||
    literateUpload <= literateVerifier ||
    localFailure !== literateUpload + 1
  ) {
    problems.push(
      "jupyter must finish ordinary, value, categorical, interactive, and literate R acceptance before its exact failure fan-in."
    );
  }

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of steps(job)) {
      if (typeof step?.uses === "string" && !step.uses.startsWith("./") && !/^[^@\s]+@[0-9a-f]{40}$/u.test(step.uses)) {
        problems.push(`${jobName} action ${step.uses} must be pinned to one full commit.`);
      }
      if (
        step?.uses === UPLOAD &&
        typeof step?.with?.name === "string" &&
        !step.with.name.startsWith("${{ inputs.channel }}-release-")
      ) {
        problems.push(`${jobName} diagnostics must be namespaced by the requested release channel.`);
      }
    }
  }
  problems.push(...inspectDeferredDiagnosticFailures(workflow, UPLOAD));
  return problems;
}
