import { load as parseYaml } from "js-yaml";
import { inspectDeferredDiagnosticFailures } from "./release-diagnostic-order.mjs";

const CHECKOUT = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
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
const EXPECTED_JOBS = [
  "contract",
  "platform",
  "linux",
  "performance",
  "jupyter",
  "r_contract",
  "r_local",
  "acceptance"
];
const FAN_IN_NEEDS = ["contract", "platform", "linux", "performance", "jupyter", "r_contract", "r_local"];
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

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function runs(job) {
  return steps(job)
    .map((step) => command(step?.run))
    .filter(Boolean);
}

function includesAll(value, expected) {
  return expected.every((part) => value.includes(part));
}

function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function hasUniqueStepIds(job) {
  const ids = steps(job)
    .map((step) => step?.id)
    .filter((id) => id !== undefined);
  return ids.every((id) => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;
}

export function inspectCandidateCaller(workflow, channel) {
  const problems = [];
  const candidate = workflow?.jobs?.["candidate-acceptance"];
  if (
    !exactKeys(candidate, ["name", "needs", "uses", "permissions", "with"]) ||
    candidate.name !== "Candidate acceptance" ||
    candidate.needs !== "package" ||
    candidate.uses !== CALL_PATH ||
    !exactKeys(candidate.permissions, ["contents"]) ||
    candidate.permissions.contents !== "read" ||
    !exactKeys(candidate.with, ["artifact_id", "channel", "expected_sha", "release_tag"]) ||
    candidate.with.artifact_id !== ARTIFACT_ID ||
    candidate.with.channel !== channel ||
    candidate.with.expected_sha !== EVENT_SHA ||
    candidate.with.release_tag !== RELEASE_TAG
  ) {
    problems.push(`${channel} must make one read-only call to the shared candidate acceptance workflow.`);
  }
  return problems;
}

function inspectCheckout(jobName, job, problems) {
  const checkouts = steps(job).filter((step) => step?.uses === CHECKOUT);
  const checkout = checkouts[0];
  if (
    checkouts.length !== 1 ||
    !exactKeys(checkout, ["uses", "with"]) ||
    !exactKeys(checkout?.with, ["ref", "fetch-depth", "persist-credentials"]) ||
    checkout.with.ref !== "${{ inputs.expected_sha }}" ||
    checkout.with["fetch-depth"] !== 0 ||
    checkout.with["persist-credentials"] !== false
  ) {
    problems.push(`${jobName} must check out only the caller-bound source without credentials.`);
  }
}

function inspectCanonicalConsumer(jobName, job, problems) {
  inspectCheckout(jobName, job, problems);
  const downloads = steps(job).filter((step) => step?.uses === DOWNLOAD);
  const download = downloads[0];
  if (
    downloads.length !== 1 ||
    !exactKeys(download, ["uses", "with"]) ||
    !exactKeys(download?.with, ["artifact-ids", "path", "merge-multiple"]) ||
    download.with["artifact-ids"] !== "${{ inputs.artifact_id }}" ||
    download.with.path !== "canonical-release" ||
    download.with["merge-multiple"] !== true
  ) {
    problems.push(`${jobName} must consume only the numeric caller-bound canonical artifact.`);
  }
  const verifiers = steps(job).filter((step) => command(step?.run) === VERIFY);
  if (
    verifiers.length === 0 ||
    verifiers.some(
      (step) =>
        !exactKeys(step?.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
        step.env.EXPECTED_SHA !== "${{ inputs.expected_sha }}" ||
        step.env.RELEASE_TAG !== "${{ inputs.release_tag }}"
    )
  ) {
    problems.push(`${jobName} must bind every artifact verification to the exact source and release tag.`);
  }
  if (
    runs(job).some(
      (run) => /^npm run package(?:\s|$)/u.test(run) || run.includes("create-canonical-release-artifact.mjs")
    )
  ) {
    problems.push(`${jobName} must never rebuild the canonical candidate.`);
  }
}

function inspectJobEnvelope(jobName, job, { needs = "contract", runner, timeout }, problems) {
  if (job?.needs !== needs || job?.["runs-on"] !== runner || job?.["timeout-minutes"] !== timeout) {
    problems.push(`${jobName} must retain its bounded fixed runner and direct dependency.`);
  }
}

function inspectImmediateRunner(jobName, job, specification, problems) {
  const jobSteps = steps(job);
  const runners = jobSteps.filter((step) => step?.id === specification.id);
  const runner = runners[0];
  const runnerIndex = jobSteps.indexOf(runner);
  const verifier = jobSteps[runnerIndex - 1];
  const upload = jobSteps[runnerIndex + 1];
  if (
    runners.length !== 1 ||
    runner?.["continue-on-error"] !== true ||
    command(runner?.run) !== specification.run ||
    runner?.if !== specification.runnerIf ||
    !exactKeys(runner?.env, Object.keys(specification.env)) ||
    Object.entries(specification.env).some(([key, value]) => runner.env[key] !== value) ||
    verifier?.id !== specification.verifierId ||
    command(verifier?.run) !== VERIFY ||
    verifier?.if !== specification.verifierIf ||
    verifier?.env?.EXPECTED_SHA !== "${{ inputs.expected_sha }}" ||
    verifier?.env?.RELEASE_TAG !== "${{ inputs.release_tag }}" ||
    upload?.name !== specification.uploadName ||
    upload?.uses !== UPLOAD ||
    upload?.if !== specification.uploadIf ||
    upload?.with?.name !== specification.artifactName ||
    upload?.with?.path !== `\${{ steps.${specification.id}.outputs.evidence_path }}` ||
    upload?.with?.["if-no-files-found"] !== "error" ||
    upload?.with?.["retention-days"] !== 7 ||
    upload?.with?.["compression-level"] !== 9 ||
    upload?.with?.["include-hidden-files"] !== false
  ) {
    problems.push(`${jobName}/${specification.id} must run verifier → packaged phase → exact sealed failure upload.`);
  }
  if (specification.failureName !== undefined) {
    const failure = jobSteps[runnerIndex + 2];
    if (
      failure?.name !== specification.failureName ||
      failure?.if !== `\${{ always() && steps.${specification.id}.outcome == 'failure' }}` ||
      command(failure?.run) !== "exit 1"
    ) {
      problems.push(`${jobName}/${specification.id} must fail immediately after preserving its diagnostics.`);
    }
  }
}

function inspectXvfb(jobName, job, beforeRunnerIds, problems) {
  const preparations = steps(job).filter((step) => step?.id === "prepare_xvfb" || step?.id === "prepare_cursor_xvfb");
  const preparation = preparations[0];
  const preparationIndex = steps(job).indexOf(preparation);
  const preparedRun = command(preparation?.run);
  if (
    preparations.length !== 1 ||
    preparation?.shell !== "node {0}" ||
    !includesAll(preparedRun, [
      "scripts/prepare-xvfb.mjs",
      "--print-path",
      "lstatSync(executable)",
      "stat.isSymbolicLink()",
      "appendFileSync(process.env.GITHUB_OUTPUT"
    ]) ||
    beforeRunnerIds.some(
      (id) => preparationIndex < 0 || preparationIndex >= steps(job).findIndex((step) => step?.id === id)
    )
  ) {
    problems.push(`${jobName} must prepare one pinned private Xvfb before every private-display phase.`);
  }
}

function inspectRPackages(jobName, job, problems) {
  const setupR = steps(job).filter((step) => step?.uses === SETUP_R);
  const dependencies = steps(job).filter((step) => step?.uses === SETUP_R_DEPENDENCIES);
  const dependency = dependencies[0];
  if (
    setupR.length !== 1 ||
    setupR[0]?.with?.["r-version"] !== "4.5.2" ||
    setupR[0]?.with?.["use-public-rspm"] !== true ||
    dependencies.length !== 1 ||
    !exactKeys(dependency, ["name", "uses", "with"]) ||
    !exactKeys(dependency?.with, [
      "packages",
      "extra-packages",
      "dependencies",
      "cache",
      "cache-version",
      "install-pandoc",
      "install-quarto"
    ]) ||
    dependency.with.packages !== "" ||
    dependency.with["extra-packages"] !== R_CONTRACT_EXTRA_PACKAGES ||
    dependency.with.dependencies !== '"hard"' ||
    dependency.with.cache !== true ||
    dependency.with["cache-version"] !== "native-r-contract-v1" ||
    dependency.with["install-pandoc"] !== false ||
    dependency.with["install-quarto"] !== false ||
    steps(job).some((step) => /\binstall\.packages\s*\(/u.test(command(step?.run)))
  ) {
    problems.push(`${jobName} must resolve the exact hosted R 4.5.2 package contract once.`);
  }
}

function localSpecification({ id, verifierId, journey, shard, uploadName, artifactSuffix }) {
  const verifierIf = `\${{ always() && matrix.shard == '${shard}' && steps.r_local_setup.outcome == 'success' }}`;
  const runnerIf = `\${{ always() && matrix.shard == '${shard}' && steps.${verifierId}.outcome == 'success' }}`;
  return {
    id,
    verifierId,
    verifierIf,
    runnerIf,
    run: `/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs \${{ steps.${verifierId}.outputs.candidate_path }}`,
    env: {
      OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
      OPEN_WRANGLER_PACKAGED_R_JOURNEY: journey,
      OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
      OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
      OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
      OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
      OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
      OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
      VSCODE_TEST_VERSION: "stable"
    },
    uploadName,
    uploadIf: `\${{ always() && matrix.shard == '${shard}' && steps.${id}.outcome == 'failure' && steps.${id}.outputs.evidence_ready == 'true' }}`,
    artifactName: `\${{ inputs.channel }}-release-r-jupyter-${artifactSuffix}-\${{ runner.os }}-\${{ github.run_attempt }}`
  };
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
  const workflowCall = workflow?.on?.workflow_call;
  const inputs = workflowCall?.inputs;
  const inputNames = ["artifact_id", "channel", "expected_sha", "release_tag"];
  if (
    !exactKeys(workflow, ["name", "on", "permissions", "jobs"]) ||
    workflow.name !== "Candidate acceptance" ||
    !exactKeys(workflowCall, ["inputs"]) ||
    !exactKeys(inputs, inputNames) ||
    inputNames.some(
      (name) =>
        !exactKeys(inputs?.[name], ["required", "type"]) ||
        inputs[name].required !== true ||
        inputs[name].type !== "string"
    ) ||
    !exactKeys(workflow.permissions, ["contents"]) ||
    workflow.permissions.contents !== "read" ||
    !exactKeys(workflow.jobs, EXPECTED_JOBS)
  ) {
    problems.push(
      "candidate acceptance must expose four required inputs, no outputs, read-only permissions, and eight fixed jobs."
    );
    return problems;
  }

  const {
    contract,
    platform,
    linux,
    performance,
    jupyter,
    r_contract: rContract,
    r_local: rLocal,
    acceptance
  } = workflow.jobs;
  const contractSteps = steps(contract);
  const contractRun = command(contractSteps[0]?.run);
  if (
    contract?.name !== "Validate candidate inputs" ||
    contract?.["runs-on"] !== "ubuntu-24.04" ||
    contract?.["timeout-minutes"] !== 5 ||
    contractSteps.length !== 1 ||
    !exactKeys(contractSteps[0]?.env, ["ARTIFACT_ID", "CHANNEL", "EXPECTED_SHA", "RELEASE_TAG"]) ||
    contractSteps[0].env.ARTIFACT_ID !== "${{ inputs.artifact_id }}" ||
    contractSteps[0].env.CHANNEL !== "${{ inputs.channel }}" ||
    contractSteps[0].env.EXPECTED_SHA !== "${{ inputs.expected_sha }}" ||
    contractSteps[0].env.RELEASE_TAG !== "${{ inputs.release_tag }}" ||
    !includesAll(contractRun, [
      'case "$ARTIFACT_ID" in *[!0-9]*|"") exit 1',
      'case "$EXPECTED_SHA" in *[!0-9a-f]*|"") exit 1',
      'test "${#EXPECTED_SHA}" -eq 40',
      'case "$CHANNEL" in preview|stable)'
    ])
  ) {
    problems.push("contract must fail closed on every malformed shared invocation before fan-out.");
  }

  inspectJobEnvelope("platform", platform, { runner: "${{ matrix.os }}", timeout: 90 }, problems);
  if (
    platform?.name !== "Platform acceptance (${{ matrix.os }})" ||
    !exactKeys(platform?.strategy, ["fail-fast", "max-parallel", "matrix"]) ||
    platform.strategy["fail-fast"] !== false ||
    platform.strategy["max-parallel"] !== 2 ||
    !exactKeys(platform.strategy.matrix, ["include"]) ||
    JSON.stringify(platform.strategy.matrix.include) !==
      JSON.stringify([
        { os: "macos-latest", python: "3.12" },
        { os: "windows-latest", python: "3.14" }
      ]) ||
    steps(platform).filter((step) => step?.uses === SETUP_PYTHON).length !== 1 ||
    steps(platform).find((step) => step?.uses === SETUP_PYTHON)?.with?.["python-version"] !== "${{ matrix.python }}"
  ) {
    problems.push("platform must run the exact non-cancelling macOS and Windows matrix internally.");
  }
  inspectCanonicalConsumer("platform", platform, problems);
  inspectImmediateRunner(
    "platform",
    platform,
    {
      id: "packaged_editor",
      verifierId: "canonical_vscode",
      run: "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: { OPEN_WRANGLER_PACKAGED_EDITORS: "vscode", VSCODE_TEST_VERSION: "stable" },
      uploadName: "Upload VS Code failure diagnostics",
      uploadIf:
        "${{ always() && steps.packaged_editor.outcome == 'failure' && steps.packaged_editor.outputs.evidence_ready == 'true' }}",
      artifactName: "${{ inputs.channel }}-release-vscode-${{ runner.os }}-${{ github.run_attempt }}",
      failureName: "Fail after VS Code diagnostics"
    },
    problems
  );
  inspectImmediateRunner(
    "platform",
    platform,
    {
      id: "cursor_smoke",
      verifierId: "canonical_cursor",
      run: "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: { OPEN_WRANGLER_PACKAGED_EDITORS: "cursor", OPEN_WRANGLER_PACKAGED_MODE: "platform-smoke" },
      uploadName: "Upload Cursor failure diagnostics",
      uploadIf:
        "${{ always() && steps.cursor_smoke.outcome == 'failure' && steps.cursor_smoke.outputs.evidence_ready == 'true' }}",
      artifactName: "${{ inputs.channel }}-release-cursor-${{ runner.os }}-${{ github.run_attempt }}",
      failureName: "Fail after Cursor diagnostics"
    },
    problems
  );
  inspectImmediateRunner(
    "platform",
    platform,
    {
      id: "packaged_editor_r_platform",
      verifierId: "canonical_r_jupyter_platform",
      run: "node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_jupyter_platform.outputs.candidate_path }}",
      env: {
        OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
        OPEN_WRANGLER_PACKAGED_R_JOURNEY: "core-operations",
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
        OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
        VSCODE_TEST_VERSION: "stable"
      },
      uploadName: "Upload cross-platform R-Jupyter failure diagnostics",
      uploadIf:
        "${{ always() && steps.packaged_editor_r_platform.outcome == 'failure' && steps.packaged_editor_r_platform.outputs.evidence_ready == 'true' }}",
      artifactName: "${{ inputs.channel }}-release-r-jupyter-platform-${{ runner.os }}-${{ github.run_attempt }}",
      failureName: "Fail after cross-platform R-Jupyter diagnostics"
    },
    problems
  );

  inspectJobEnvelope("linux", linux, { runner: "ubuntu-24.04", timeout: 120 }, problems);
  inspectCanonicalConsumer("linux", linux, problems);
  if (
    ![
      "npm run check",
      "npm run test:scripts",
      "npm run test:webview-acceptance",
      "npm run test:coverage",
      "npm audit --omit=dev",
      "npm run audit:python",
      "npm run benchmark:runtime",
      "npm run build:test-extension"
    ].every((run) => runs(linux).includes(run))
  ) {
    problems.push("linux must retain the source, webview, coverage, audit, benchmark, and packaged-editor gates.");
  }

  inspectJobEnvelope("performance", performance, { runner: "ubuntu-24.04", timeout: 120 }, problems);
  inspectCanonicalConsumer("performance", performance, problems);
  const performanceRunner = steps(performance).find((step) => step?.id === "installed_performance");
  if (
    performanceRunner?.["continue-on-error"] !== true ||
    performanceRunner?.env?.PREVIEW_FLAG !== "${{ inputs.channel == 'preview' && '--preview-release' || '' }}" ||
    !command(performanceRunner?.run).includes("--pinned-editors") ||
    !command(performanceRunner?.run).includes(
      "--candidate-provenance canonical-release/openwrangler.vsix.provenance.json"
    ) ||
    steps(performance).find((step) => command(step?.run) === "node scripts/prepare-stable-candidate-tag.mjs")?.if !==
      "${{ inputs.channel == 'stable' }}"
  ) {
    problems.push("performance must benchmark the exact candidate in both channels without rebuilding it.");
  }

  inspectJobEnvelope("jupyter", jupyter, { runner: "ubuntu-24.04", timeout: 120 }, problems);
  inspectCanonicalConsumer("jupyter", jupyter, problems);
  if (
    jupyter?.name !== "Released Jupyter acceptance (${{ matrix.phase == 'python' && 'Python' || 'R remote' }})" ||
    !exactKeys(jupyter?.strategy, ["fail-fast", "max-parallel", "matrix"]) ||
    jupyter.strategy["fail-fast"] !== false ||
    jupyter.strategy["max-parallel"] !== 2 ||
    !exactKeys(jupyter.strategy.matrix, ["phase"]) ||
    !sameArray(jupyter.strategy.matrix.phase, ["python", "r-remote"]) ||
    steps(jupyter).some((step) => step?.uses === SETUP_R || command(step?.run) === "npm run test:r-contract") ||
    steps(jupyter).filter((step) => step?.uses === SETUP_JAVA).length !== 1 ||
    steps(jupyter).find((step) => step?.uses === SETUP_JAVA)?.if !== "${{ matrix.phase == 'python' }}"
  ) {
    problems.push("jupyter must run only independent Python and remote-R cells; local R belongs to its shards.");
  }
  inspectImmediateRunner(
    "jupyter",
    jupyter,
    {
      id: "packaged_editor",
      verifierId: "canonical_jupyter",
      verifierIf: "${{ matrix.phase == 'python' }}",
      runnerIf: "${{ matrix.phase == 'python' }}",
      run: "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: {
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
        OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
        OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
        OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
        OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1",
        VSCODE_TEST_VERSION: "stable"
      },
      uploadName: "Upload released-Jupyter failure diagnostics",
      uploadIf:
        "${{ always() && steps.packaged_editor.outcome == 'failure' && steps.packaged_editor.outputs.evidence_ready == 'true' }}",
      artifactName: "${{ inputs.channel }}-release-jupyter-${{ runner.os }}-${{ github.run_attempt }}",
      failureName: "Fail after released-Jupyter diagnostics"
    },
    problems
  );
  inspectImmediateRunner(
    "jupyter",
    jupyter,
    {
      id: "packaged_editor_r_remote",
      verifierId: "canonical_r_remote",
      verifierIf: "${{ matrix.phase == 'r-remote' }}",
      runnerIf: "${{ matrix.phase == 'r-remote' }}",
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
      },
      uploadName: "Upload remote R-Jupyter failure diagnostics",
      uploadIf:
        "${{ always() && steps.packaged_editor_r_remote.outcome == 'failure' && steps.packaged_editor_r_remote.outputs.evidence_ready == 'true' }}",
      artifactName: "${{ inputs.channel }}-release-r-jupyter-remote-${{ runner.os }}-${{ github.run_attempt }}",
      failureName: "Fail after remote R-Jupyter diagnostics"
    },
    problems
  );
  inspectXvfb("jupyter", jupyter, ["packaged_editor", "packaged_editor_r_remote"], problems);

  inspectJobEnvelope("r_contract", rContract, { runner: "ubuntu-24.04", timeout: 30 }, problems);
  inspectCheckout("r_contract", rContract, problems);
  inspectRPackages("r_contract", rContract, problems);
  const rContractRuns = runs(rContract);
  const contractTest = steps(rContract).find((step) => command(step?.run) === "npm run test:r-contract");
  if (
    rContractRuns.filter((run) => run === "npm run test:r-contract").length !== 1 ||
    contractTest?.env?.RSCRIPT !== "${{ steps.rscript.outputs.executable }}" ||
    steps(rContract).some((step) => step?.uses === DOWNLOAD) ||
    rContract.needs !== "contract"
  ) {
    problems.push("r_contract must run the native contract once as an artifact-independent sibling of local R.");
  }

  inspectJobEnvelope("r_local", rLocal, { runner: "ubuntu-24.04", timeout: 120 }, problems);
  inspectCanonicalConsumer("r_local", rLocal, problems);
  inspectRPackages("r_local", rLocal, problems);
  if (
    rLocal?.name !== "Local R acceptance (${{ matrix.shard }})" ||
    !exactKeys(rLocal?.strategy, ["fail-fast", "max-parallel", "matrix"]) ||
    rLocal.strategy["fail-fast"] !== false ||
    rLocal.strategy["max-parallel"] !== 2 ||
    !exactKeys(rLocal.strategy.matrix, ["shard"]) ||
    !sameArray(rLocal.strategy.matrix.shard, ["lifecycle", "editing"]) ||
    rLocal.needs !== "contract" ||
    steps(rLocal).some((step) => command(step?.run) === "npm run test:r-contract")
  ) {
    problems.push("r_local must run two non-cancelling balanced shards directly beside r_contract.");
  }
  const localSpecs = [
    localSpecification({
      id: "packaged_editor_r_core",
      verifierId: "canonical_r_core",
      journey: "core-operations",
      shard: "lifecycle",
      uploadName: "Upload local R-Jupyter failure diagnostics",
      artifactSuffix: "local"
    }),
    localSpecification({
      id: "packaged_editor_r_restart",
      verifierId: "canonical_r_restart",
      journey: "kernel-restart",
      shard: "lifecycle",
      uploadName: "Upload R kernel restart failure diagnostics",
      artifactSuffix: "restart"
    }),
    localSpecification({
      id: "packaged_editor_r_interactive",
      verifierId: "canonical_r_interactive",
      journey: "interactive-terminal",
      shard: "lifecycle",
      uploadName: "Upload active R terminal failure diagnostics",
      artifactSuffix: "interactive"
    }),
    localSpecification({
      id: "packaged_editor_r_literate",
      verifierId: "canonical_r_literate",
      journey: "literate-documents",
      shard: "lifecycle",
      uploadName: "Upload R Markdown and Quarto failure diagnostics",
      artifactSuffix: "literate"
    }),
    localSpecification({
      id: "packaged_editor_r_values",
      verifierId: "canonical_r_values",
      journey: "value-operations",
      shard: "editing",
      uploadName: "Upload value R-Jupyter failure diagnostics",
      artifactSuffix: "values"
    }),
    localSpecification({
      id: "packaged_editor_r_categorical",
      verifierId: "canonical_r_categorical",
      journey: "categorical-operations",
      shard: "editing",
      uploadName: "Upload categorical R-Jupyter failure diagnostics",
      artifactSuffix: "categorical"
    })
  ];
  for (const specification of localSpecs) inspectImmediateRunner("r_local", rLocal, specification, problems);
  inspectXvfb(
    "r_local",
    rLocal,
    localSpecs.map(({ id }) => id),
    problems
  );
  const localOrder = steps(rLocal)
    .filter((step) => localSpecs.some(({ id }) => id === step?.id))
    .map((step) => step.id);
  if (
    !sameArray(localOrder, [
      "packaged_editor_r_core",
      "packaged_editor_r_restart",
      "packaged_editor_r_interactive",
      "packaged_editor_r_literate",
      "packaged_editor_r_values",
      "packaged_editor_r_categorical"
    ])
  ) {
    problems.push("r_local must keep lifecycle and editing phases in their balanced shard order.");
  }
  const verdicts = steps(rLocal).filter((step) => step?.name === "Require successful local R shard outcomes");
  const verdict = verdicts[0];
  const verdictRun = command(verdict?.run);
  if (
    verdicts.length !== 1 ||
    verdict?.if !== "${{ always() }}" ||
    !exactKeys(verdict?.env, [
      "SHARD",
      "CORE_OUTCOME",
      "RESTART_OUTCOME",
      "INTERACTIVE_OUTCOME",
      "LITERATE_OUTCOME",
      "VALUES_OUTCOME",
      "CATEGORICAL_OUTCOME"
    ]) ||
    verdict.env.SHARD !== "${{ matrix.shard }}" ||
    verdict.env.CORE_OUTCOME !== "${{ steps.packaged_editor_r_core.outcome }}" ||
    verdict.env.RESTART_OUTCOME !== "${{ steps.packaged_editor_r_restart.outcome }}" ||
    verdict.env.INTERACTIVE_OUTCOME !== "${{ steps.packaged_editor_r_interactive.outcome }}" ||
    verdict.env.LITERATE_OUTCOME !== "${{ steps.packaged_editor_r_literate.outcome }}" ||
    verdict.env.VALUES_OUTCOME !== "${{ steps.packaged_editor_r_values.outcome }}" ||
    verdict.env.CATEGORICAL_OUTCOME !== "${{ steps.packaged_editor_r_categorical.outcome }}" ||
    !includesAll(verdictRun, [
      'case "$SHARD" in lifecycle)',
      'test "$CORE_OUTCOME" = "success"',
      'test "$RESTART_OUTCOME" = "success"',
      'test "$INTERACTIVE_OUTCOME" = "success"',
      'test "$LITERATE_OUTCOME" = "success"',
      'editing) test "$VALUES_OUTCOME" = "success"',
      'test "$CATEGORICAL_OUTCOME" = "success"',
      "*) exit 1"
    ]) ||
    steps(rLocal).indexOf(verdict) !== steps(rLocal).length - 1
  ) {
    problems.push("r_local must defer one literal raw-outcome verdict until every shard diagnostic upload ran.");
  }

  const fanInSteps = steps(acceptance);
  const fanIn = fanInSteps[0];
  const fanInRun = command(fanIn?.run);
  if (
    acceptance?.name !== "Candidate acceptance" ||
    acceptance?.if !== "${{ always() }}" ||
    !sameArray(acceptance?.needs, FAN_IN_NEEDS) ||
    acceptance?.["runs-on"] !== "ubuntu-24.04" ||
    acceptance?.["timeout-minutes"] !== 5 ||
    fanInSteps.length !== 1 ||
    !exactKeys(fanIn?.env, [
      "CONTRACT_RESULT",
      "PLATFORM_RESULT",
      "LINUX_RESULT",
      "PERFORMANCE_RESULT",
      "JUPYTER_RESULT",
      "R_CONTRACT_RESULT",
      "R_LOCAL_RESULT"
    ]) ||
    FAN_IN_NEEDS.some(
      (name) =>
        fanIn.env[`${name.toUpperCase()}_RESULT`] !== `\${{ needs.${name}.result }}` ||
        !fanInRun.includes(`test "$${name.toUpperCase()}_RESULT" = "success"`)
    )
  ) {
    problems.push("acceptance must always fan in every direct job and require each literal success result.");
  }

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!hasUniqueStepIds(job)) problems.push(`${jobName} must use unique non-empty step IDs.`);
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
  const ordinaryDiagnosticJobs = Object.fromEntries(
    Object.entries(workflow.jobs).filter(([jobName]) => jobName !== "r_local")
  );
  problems.push(...inspectDeferredDiagnosticFailures({ jobs: ordinaryDiagnosticJobs }, UPLOAD));
  return problems;
}
