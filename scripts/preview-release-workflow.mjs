import { load as parseYaml } from "js-yaml";
import {
  OPEN_VSX_PUBLISH_RUN,
  OPEN_VSX_VERIFY_PAT_RUN,
  PUBLIC_MEDIA_CONTRACT_RUN
} from "./open-vsx-promotion-workflow.mjs";
import { inspectDeferredDiagnosticFailures } from "./release-diagnostic-order.mjs";

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const EVENT_SHA = "${{ github.sha }}";
const EVENT_REF = "${{ github.ref }}";
const EVENT_REF_TYPE = "${{ github.ref_type }}";
const RELEASE_TAG = "${{ inputs.release_tag }}";
const ARTIFACT_ID = "${{ needs.package.outputs.artifact-id }}";
const CHECKOUT_ACTION = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE_ACTION = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const SETUP_PYTHON_ACTION = "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1";
const SETUP_R_ACTION = "r-lib/actions/setup-r@d3c5be51b12e724e68f33216ca3c148b66d5f0b6";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const CONSUMERS = ["cross-platform", "linux-acceptance", "installed-performance", "released-jupyter", "remote-ssh"];
const JOBS = ["package", ...CONSUMERS, "acceptance-gate", "release"];
const CANONICAL_PATHS = [
  "canonical-release/openwrangler.vsix",
  "canonical-release/openwrangler.vsix.sha256",
  "canonical-release/openwrangler.vsix.provenance.json"
];
const FULL_SUITE = [
  "npm run check",
  "npm run test:scripts",
  "npm run test:webview-acceptance",
  "npm run test:coverage",
  "npm audit --omit=dev",
  "npm run audit:python",
  "npm run benchmark:runtime"
];
const PROTECTED_MAIN_SOURCE_RUN = `test "$EVENT_REF_TYPE" = "branch"
test "$EVENT_REF" = "refs/heads/main"
case "$EXPECTED_SHA" in *[!0-9a-f]*|"") exit 1 ;; esac
test "\${#EXPECTED_SHA}" -eq 40`;
const EXACT_MAIN_SOURCE_RUN = `test "$(git rev-parse --verify HEAD^{commit})" = "$EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(git rev-parse --verify refs/remotes/origin/main^{commit})" = "$EXPECTED_SHA"`;
const LOCATE_RSCRIPT_RUN = `set -euo pipefail
rscript="$(command -v Rscript)"
if [[ "$rscript" != /* || ! -x "$rscript" ]]; then
  echo "Rscript did not resolve to an absolute executable." >&2
  exit 1
fi
r_version="$(Rscript --vanilla -e 'cat(as.character(getRversion()))')"
if [[ "$r_version" != "4.5.2" ]]; then
  echo "Expected hosted R 4.5.2, got $r_version." >&2
  exit 1
fi
printf 'executable=%s\\n' "$rscript" >> "$GITHUB_OUTPUT"
printf 'version=%s\\n' "$r_version" >> "$GITHUB_OUTPUT"
printf 'Hosted R: %s\\n' "$r_version"`;
const INSTALL_R_CONTRACT_PACKAGES =
  'Rscript --vanilla -e \'install.packages(c("jsonlite", "tibble", "readr", "dplyr", "data.table", "bit64", "collapse", "nanoparquet"), repos = "https://cloud.r-project.org")\'';
const R_JUPYTER_RUN =
  "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_jupyter.outputs.candidate_path }}";
const CROSS_PLATFORM_R_JUPYTER_RUN =
  "node scripts/run-packaged-editor-tests.mjs ${{ steps.canonical_r_jupyter_platform.outputs.candidate_path }}";
const PORTABLE_LOCATE_RSCRIPT_RUN = `version <- as.character(getRversion())
if (!identical(version, "4.5.2")) stop("Expected hosted R 4.5.2, got ", version, ".")
executable <- normalizePath(
  file.path(R.home("bin"), if (.Platform$OS.type == "windows") "Rscript.exe" else "Rscript"),
  winslash = "/",
  mustWork = TRUE
)
if (!nzchar(executable) || grepl("[\\r\\n]", executable)) stop("Rscript resolved to an unsafe path.")
output <- Sys.getenv("GITHUB_OUTPUT")
if (!nzchar(output)) stop("GITHUB_OUTPUT is not available.")
cat(sprintf("executable=%s\\nversion=%s\\n", executable, version), file = output, append = TRUE)`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
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

function findRun(job, expected) {
  return steps(job).find((step) => command(step?.run) === expected);
}

function inspectCheckout(job, label, problems) {
  const matches = steps(job).filter((step) => step?.uses === CHECKOUT_ACTION);
  const checkout = matches[0];
  if (
    matches.length !== 1 ||
    !exactKeys(checkout, ["uses", "with"]) ||
    !exactKeys(checkout.with, ["ref", "fetch-depth", "persist-credentials"]) ||
    checkout.with.ref !== EVENT_SHA ||
    checkout.with["fetch-depth"] !== 0 ||
    checkout.with["persist-credentials"] !== false
  ) {
    problems.push(`${label} must check out only the exact event commit without persisted credentials.`);
  }
}

function inspectPackageSourceBinding(job, problems) {
  const jobSteps = steps(job);
  const initialGuards = jobSteps.filter((step) => step?.name === "Require protected main source");
  const initialGuard = initialGuards[0];
  if (
    initialGuards.length !== 1 ||
    !exactKeys(initialGuard, ["name", "env", "run"]) ||
    !exactKeys(initialGuard.env, ["EVENT_REF", "EVENT_REF_TYPE", "EXPECTED_SHA"]) ||
    initialGuard.env.EVENT_REF !== EVENT_REF ||
    initialGuard.env.EVENT_REF_TYPE !== EVENT_REF_TYPE ||
    initialGuard.env.EXPECTED_SHA !== EVENT_SHA ||
    command(initialGuard.run) !== command(PROTECTED_MAIN_SOURCE_RUN)
  ) {
    problems.push("package must reject tags and every source other than protected main before checkout.");
  }

  const checkout = jobSteps.find((step) => step?.uses === CHECKOUT_ACTION);
  const exactGuards = jobSteps.filter((step) => step?.name === "Require exact protected main commit");
  const exactGuard = exactGuards[0];
  if (
    exactGuards.length !== 1 ||
    !exactKeys(exactGuard, ["name", "env", "run"]) ||
    !exactKeys(exactGuard.env, ["EXPECTED_SHA"]) ||
    exactGuard.env.EXPECTED_SHA !== EVENT_SHA ||
    command(exactGuard.run) !== command(EXACT_MAIN_SOURCE_RUN)
  ) {
    problems.push("package must bind the clean checkout and protected main ref to the exact event commit.");
  }

  const setupNodeSteps = jobSteps.filter((step) => step?.uses === SETUP_NODE_ACTION);
  const setupNode = setupNodeSteps[0];
  const remotePreflights = jobSteps.filter(
    (step) => command(step?.run) === "node scripts/prepare-stable-candidate-tag.mjs --verify-remote"
  );
  const remotePreflight = remotePreflights[0];
  const setupPythonSteps = jobSteps.filter((step) => step?.uses === SETUP_PYTHON_ACTION);
  const setupPython = setupPythonSteps[0];
  const metadataSteps = jobSteps.filter((step) => step?.id === "release_metadata");
  const metadata = metadataSteps[0];
  const rejectSteps = jobSteps.filter((step) => step?.name === "Require preview metadata");
  const reject = rejectSteps[0];
  if (
    setupNodeSteps.length !== 1 ||
    !exactKeys(setupNode, ["uses", "with"]) ||
    !exactKeys(setupNode.with, ["node-version", "cache"]) ||
    setupNode.with["node-version"] !== 22 ||
    setupNode.with.cache !== "npm" ||
    remotePreflights.length !== 1 ||
    setupPythonSteps.length !== 1 ||
    !exactKeys(setupPython, ["uses", "with"]) ||
    !exactKeys(setupPython.with, ["python-version", "cache"]) ||
    setupPython.with["python-version"] !== "3.12" ||
    setupPython.with.cache !== "pip" ||
    metadataSteps.length !== 1 ||
    !exactKeys(metadata, ["id", "name", "env", "run"]) ||
    metadata.name !== "Validate preview release metadata" ||
    !exactKeys(metadata.env, ["RELEASE_TAG"]) ||
    metadata.env.RELEASE_TAG !== RELEASE_TAG ||
    command(metadata.run) !== "node scripts/release-metadata.mjs --preview-only" ||
    rejectSteps.length !== 1 ||
    !exactKeys(reject, ["name", "if", "run"]) ||
    reject.if !== "${{ steps.release_metadata.outputs.prerelease != 'true' }}" ||
    command(reject.run) !== "exit 1"
  ) {
    problems.push("package must validate exact preview metadata with the pinned release toolchains.");
  }

  if (
    jobSteps.indexOf(initialGuard) !== 0 ||
    jobSteps.indexOf(checkout) !== 1 ||
    jobSteps.indexOf(exactGuard) !== 2 ||
    jobSteps.indexOf(setupNode) !== 3 ||
    jobSteps.indexOf(remotePreflight) !== 4 ||
    jobSteps.indexOf(setupPython) !== 5 ||
    jobSteps.indexOf(metadata) !== 6 ||
    jobSteps.indexOf(reject) !== 7
  ) {
    problems.push("package source, checkout, tag, and metadata guards must be the exact ordered prefix.");
  }
}

function inspectCanonicalConsumer(job, label, problems) {
  const jobSteps = steps(job);
  const downloads = jobSteps.filter((step) => step?.uses === DOWNLOAD_ACTION);
  const download = downloads[0];
  if (
    downloads.length !== 1 ||
    !exactKeys(download, ["uses", "with"]) ||
    !exactKeys(download.with, ["artifact-ids", "path", "merge-multiple"]) ||
    download.with["artifact-ids"] !== ARTIFACT_ID ||
    download.with.path !== "canonical-release" ||
    download.with["merge-multiple"] !== true
  ) {
    problems.push(`${label} must download only the package job's immutable artifact ID.`);
  }
  const verifiers = jobSteps.filter((step) => step?.id === "canonical");
  const verifier = verifiers[0];
  if (
    verifiers.length !== 1 ||
    !exactKeys(verifier, ["id", "name", "env", "run"]) ||
    !exactKeys(verifier.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    verifier.env.EXPECTED_SHA !== EVENT_SHA ||
    verifier.env.RELEASE_TAG !== RELEASE_TAG ||
    command(verifier.run) !== "node scripts/verify-preview-release-artifact.mjs canonical-release" ||
    jobSteps.indexOf(verifier) <= jobSteps.indexOf(download)
  ) {
    problems.push(`${label} must verify the source-bound preview triple before using it.`);
  }
}

function inspectPinnedActions(workflow, problems) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of steps(job)) {
      if (typeof step?.uses !== "string" || step.uses.startsWith("./")) continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(step.uses)) {
        problems.push(`${jobName} action ${step.uses} must be pinned to one full commit.`);
      }
    }
  }
}

function inspectPreviewRJupyter(job, problems) {
  const jobSteps = steps(job);
  const setupMatches = jobSteps.filter((step) => step?.uses === SETUP_R_ACTION);
  const setup = setupMatches[0];
  const locateMatches = jobSteps.filter((step) => step?.id === "rscript");
  const locate = locateMatches[0];
  const npmCi = findRun(job, "npm ci");
  const installMatches = jobSteps.filter((step) => command(step?.run) === INSTALL_R_CONTRACT_PACKAGES);
  const install = installMatches[0];
  const contractMatches = jobSteps.filter((step) => command(step?.run) === "npm run test:r-contract");
  const contract = contractMatches[0];

  if (
    setupMatches.length !== 1 ||
    !exactKeys(setup, ["uses", "with"]) ||
    !exactKeys(setup.with, ["r-version", "use-public-rspm"]) ||
    setup.with["r-version"] !== "4.5.2" ||
    setup.with["use-public-rspm"] !== true ||
    locateMatches.length !== 1 ||
    !exactKeys(locate, ["id", "name", "shell", "run"]) ||
    locate.name !== "Locate hosted Rscript" ||
    locate.shell !== "bash" ||
    command(locate.run) !== command(LOCATE_RSCRIPT_RUN) ||
    installMatches.length !== 1 ||
    !exactKeys(install, ["name", "run"]) ||
    install.name !== "Install R contract packages" ||
    contractMatches.length !== 1 ||
    !exactKeys(contract, ["run", "env"]) ||
    !exactKeys(contract.env, ["RSCRIPT"]) ||
    contract.env.RSCRIPT !== "${{ steps.rscript.outputs.executable }}" ||
    npmCi === undefined ||
    !(jobSteps.indexOf(setup) < jobSteps.indexOf(locate)) ||
    !(jobSteps.indexOf(locate) < jobSteps.indexOf(npmCi)) ||
    !(jobSteps.indexOf(npmCi) < jobSteps.indexOf(install)) ||
    !(jobSteps.indexOf(install) < jobSteps.indexOf(contract))
  ) {
    problems.push("released-jupyter must run the native R contract with exact hosted R 4.5.2.");
  }

  const verifierMatches = jobSteps.filter((step) => step?.id === "canonical_r_jupyter");
  const verifier = verifierMatches[0];
  const runnerMatches = jobSteps.filter((step) => step?.id === "packaged_editor_r");
  const runner = runnerMatches[0];
  const diagnosticsMatches = jobSteps.filter((step) => step?.name === "Upload R-Jupyter failure diagnostics");
  const diagnostics = diagnosticsMatches[0];
  if (
    verifierMatches.length !== 1 ||
    !exactKeys(verifier, ["id", "name", "env", "run"]) ||
    verifier.name !== "Reverify the exact canonical preview artifact for R Jupyter" ||
    !exactKeys(verifier.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    verifier.env.EXPECTED_SHA !== EVENT_SHA ||
    verifier.env.RELEASE_TAG !== RELEASE_TAG ||
    command(verifier.run) !== "node scripts/verify-preview-release-artifact.mjs canonical-release" ||
    runnerMatches.length !== 1 ||
    !exactKeys(runner, ["id", "name", "continue-on-error", "run", "env"]) ||
    runner.name !== "Test R Jupyter in the exact packaged VSIX" ||
    command(runner.run) !== R_JUPYTER_RUN ||
    !exactKeys(runner.env, [
      "OPEN_WRANGLER_EDITOR_DISPLAY",
      "OPEN_WRANGLER_PACKAGED_EDITORS",
      "OPEN_WRANGLER_PACKAGED_MODE",
      "OPEN_WRANGLER_REAL_JUPYTER_EXTENSION",
      "OPEN_WRANGLER_REAL_REMOTE_JUPYTER",
      "OPEN_WRANGLER_TEST_RSCRIPT",
      "OPEN_WRANGLER_XVFB_EXECUTABLE",
      "VSCODE_TEST_VERSION"
    ]) ||
    runner.env.OPEN_WRANGLER_PACKAGED_MODE !== "r-jupyter" ||
    runner.env.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode,cursor" ||
    runner.env.OPEN_WRANGLER_EDITOR_DISPLAY !== "xvfb" ||
    runner.env.OPEN_WRANGLER_XVFB_EXECUTABLE !== "${{ steps.prepare_xvfb.outputs.executable }}" ||
    runner.env.OPEN_WRANGLER_REAL_JUPYTER_EXTENSION !== "1" ||
    runner.env.OPEN_WRANGLER_REAL_REMOTE_JUPYTER !== "1" ||
    runner.env.OPEN_WRANGLER_TEST_RSCRIPT !== "${{ steps.rscript.outputs.executable }}" ||
    runner.env.VSCODE_TEST_VERSION !== "stable" ||
    jobSteps.indexOf(runner) !== jobSteps.indexOf(verifier) + 1 ||
    diagnosticsMatches.length !== 1 ||
    !exactKeys(diagnostics, ["name", "if", "uses", "with"]) ||
    diagnostics.if !==
      "${{ always() && steps.packaged_editor_r.outcome == 'failure' && steps.packaged_editor_r.outputs.evidence_ready == 'true' }}" ||
    diagnostics.uses !== UPLOAD_ACTION ||
    !exactKeys(diagnostics.with, [
      "name",
      "path",
      "if-no-files-found",
      "retention-days",
      "compression-level",
      "include-hidden-files"
    ]) ||
    diagnostics.with.name !== "preview-release-r-jupyter-${{ runner.os }}-${{ github.run_attempt }}" ||
    diagnostics.with.path !== "${{ steps.packaged_editor_r.outputs.evidence_path }}" ||
    diagnostics.with["if-no-files-found"] !== "error" ||
    diagnostics.with["retention-days"] !== 7 ||
    diagnostics.with["compression-level"] !== 9 ||
    diagnostics.with["include-hidden-files"] !== false ||
    jobSteps.indexOf(diagnostics) !== jobSteps.indexOf(runner) + 1
  ) {
    problems.push(
      "released-jupyter must reverify and test the exact preview VSIX through R Jupyter in VS Code and Cursor."
    );
  }
}

function inspectCrossPlatformRJupyter(job, problems) {
  const jobSteps = steps(job);
  const setupMatches = jobSteps.filter((step) => step?.uses === SETUP_R_ACTION);
  const setup = setupMatches[0];
  const locateMatches = jobSteps.filter((step) => step?.id === "rscript");
  const locate = locateMatches[0];
  const runnerMatches = jobSteps.filter((step) => step?.id === "packaged_editor_r_platform");
  const runner = runnerMatches[0];
  const runnerIndex = jobSteps.indexOf(runner);
  const verifier = jobSteps[runnerIndex - 1];
  const diagnostics = jobSteps[runnerIndex + 1];
  const npmCi = findRun(job, "npm ci");
  if (
    setupMatches.length !== 1 ||
    !exactKeys(setup, ["uses", "with"]) ||
    !exactKeys(setup.with, ["r-version", "use-public-rspm"]) ||
    setup.with["r-version"] !== "4.5.2" ||
    setup.with["use-public-rspm"] !== true ||
    locateMatches.length !== 1 ||
    !exactKeys(locate, ["id", "name", "shell", "run"]) ||
    locate.name !== "Locate hosted Rscript" ||
    locate.shell !== "Rscript {0}" ||
    command(locate.run) !== command(PORTABLE_LOCATE_RSCRIPT_RUN) ||
    npmCi === undefined ||
    !(jobSteps.indexOf(setup) < jobSteps.indexOf(locate)) ||
    !(jobSteps.indexOf(locate) < jobSteps.indexOf(npmCi)) ||
    runnerMatches.length !== 1 ||
    !exactKeys(runner, ["id", "name", "continue-on-error", "run", "env"]) ||
    runner.name !== "Test local R Jupyter in packaged VS Code" ||
    command(runner.run) !== CROSS_PLATFORM_R_JUPYTER_RUN ||
    !exactKeys(runner.env, [
      "OPEN_WRANGLER_PACKAGED_EDITORS",
      "OPEN_WRANGLER_PACKAGED_MODE",
      "OPEN_WRANGLER_REAL_JUPYTER_EXTENSION",
      "OPEN_WRANGLER_REAL_REMOTE_JUPYTER",
      "OPEN_WRANGLER_TEST_RSCRIPT",
      "VSCODE_TEST_VERSION"
    ]) ||
    runner.env.OPEN_WRANGLER_PACKAGED_MODE !== "r-jupyter" ||
    runner.env.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode" ||
    runner.env.OPEN_WRANGLER_REAL_JUPYTER_EXTENSION !== "1" ||
    runner.env.OPEN_WRANGLER_REAL_REMOTE_JUPYTER !== "0" ||
    runner.env.OPEN_WRANGLER_TEST_RSCRIPT !== "${{ steps.rscript.outputs.executable }}" ||
    runner.env.VSCODE_TEST_VERSION !== "stable" ||
    !exactKeys(verifier, ["id", "name", "env", "run"]) ||
    verifier.id !== "canonical_r_jupyter_platform" ||
    verifier.name !== "Reverify the exact canonical preview artifact for cross-platform R Jupyter" ||
    !exactKeys(verifier.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    verifier.env.EXPECTED_SHA !== EVENT_SHA ||
    verifier.env.RELEASE_TAG !== RELEASE_TAG ||
    command(verifier.run) !== "node scripts/verify-preview-release-artifact.mjs canonical-release" ||
    !exactKeys(diagnostics, ["name", "if", "uses", "with"]) ||
    diagnostics.name !== "Upload cross-platform R-Jupyter failure diagnostics" ||
    diagnostics.if !==
      "${{ always() && steps.packaged_editor_r_platform.outcome == 'failure' && steps.packaged_editor_r_platform.outputs.evidence_ready == 'true' }}" ||
    diagnostics.uses !== UPLOAD_ACTION ||
    !exactKeys(diagnostics.with, [
      "name",
      "path",
      "if-no-files-found",
      "retention-days",
      "compression-level",
      "include-hidden-files"
    ]) ||
    diagnostics.with.name !== "preview-release-r-jupyter-platform-${{ runner.os }}-${{ github.run_attempt }}" ||
    diagnostics.with.path !== "${{ steps.packaged_editor_r_platform.outputs.evidence_path }}" ||
    diagnostics.with["if-no-files-found"] !== "error" ||
    diagnostics.with["retention-days"] !== 7 ||
    diagnostics.with["compression-level"] !== 9 ||
    diagnostics.with["include-hidden-files"] !== false ||
    command(findRun(job, "npm run test:r-contract")?.run) !== ""
  ) {
    problems.push(
      "cross-platform must run one local VS Code R-Jupyter journey with portable R 4.5.2 setup, fresh artifact verification, and sealed failure diagnostics."
    );
  }
}

export function inspectPreviewReleaseWorkflow(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    return ["release.yml must be bounded YAML text."];
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch {
    return ["release.yml must contain valid YAML."];
  }
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    return ["release.yml must contain one workflow with jobs."];
  }
  const problems = [];
  if (
    !exactKeys(workflow, ["name", "on", "permissions", "concurrency", "jobs"]) ||
    workflow.name !== "Preview release" ||
    !exactKeys(workflow.on, ["workflow_dispatch"])
  ) {
    problems.push(
      "Preview release must be a manual candidate-first workflow without inherited environment or defaults."
    );
  }
  const inputs = workflow.on?.workflow_dispatch?.inputs;
  if (
    !exactKeys(inputs, ["release_tag", "publish"]) ||
    !exactKeys(inputs?.release_tag, ["description", "required", "type"]) ||
    inputs?.release_tag?.required !== true ||
    inputs?.release_tag?.type !== "string" ||
    !exactKeys(inputs?.publish, ["description", "required", "default", "type"]) ||
    inputs?.publish?.required !== true ||
    inputs?.publish?.default !== false ||
    inputs?.publish?.type !== "boolean"
  ) {
    problems.push("Preview inputs must require a tag and default the explicit publish decision to false.");
  }
  if (!exactKeys(workflow.permissions, ["contents"]) || workflow.permissions.contents !== "read") {
    problems.push("Preview validation must default to contents: read.");
  }
  if (
    !exactKeys(workflow.concurrency, ["group", "cancel-in-progress"]) ||
    workflow.concurrency.group !== "preview-release-${{ inputs.release_tag }}" ||
    workflow.concurrency["cancel-in-progress"] !== false
  ) {
    problems.push("Preview validation must serialize one tag without cancelling an in-flight candidate.");
  }
  if (!exactKeys(workflow.jobs, JOBS)) {
    problems.push(`Preview release must contain exactly these jobs: ${JOBS.join(", ")}.`);
    return problems;
  }
  inspectPinnedActions(workflow, problems);

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (job?.env !== undefined || job?.defaults !== undefined || job?.["continue-on-error"] !== undefined) {
      problems.push(`${jobName} must not inherit environment, shell defaults, or failure suppression.`);
    }
  }
  problems.push(...inspectDeferredDiagnosticFailures(workflow, UPLOAD_ACTION));

  const packaging = workflow.jobs.package;
  inspectCheckout(packaging, "package", problems);
  inspectPackageSourceBinding(packaging, problems);
  if (
    packaging["runs-on"] !== "ubuntu-24.04" ||
    packaging.environment !== undefined ||
    packaging.permissions !== undefined ||
    packaging.outputs?.["artifact-id"] !== "${{ steps.canonical_artifact.outputs.artifact-id }}"
  ) {
    problems.push("package must be a read-only Ubuntu producer that exposes only its immutable artifact ID.");
  }
  const packageRuns = runs(packaging);
  if (
    packageRuns.filter((run) => run.includes("package:prepared -- --out openwrangler.candidate.vsix")).length !== 1 ||
    packageRuns.some((run) => /^npm run package(?:\s|$)/u.test(run))
  ) {
    problems.push(
      "package must build and package the preview candidate exactly once without rerunning the broad suite."
    );
  }
  if (
    packageRuns.filter((run) => run.includes("scripts/create-canonical-release-artifact.mjs")).length !== 1 ||
    !packageRuns.some(
      (run) =>
        run ===
        "node scripts/create-canonical-release-artifact.mjs openwrangler.candidate.vsix --out-dir canonical-release --preview-release"
    )
  ) {
    problems.push("package must author exactly one canonical preview VSIX/checksum/provenance triple.");
  }
  const packageVerifier = findRun(packaging, "node scripts/verify-preview-release-artifact.mjs canonical-release");
  const uploads = steps(packaging).filter((step) => step?.uses === UPLOAD_ACTION);
  const upload = uploads[0];
  if (
    uploads.length !== 1 ||
    !exactKeys(upload, ["id", "name", "uses", "with"]) ||
    upload.id !== "canonical_artifact" ||
    upload.with?.name !== "openwrangler-preview-release" ||
    upload.with?.path !== `${CANONICAL_PATHS.join("\n")}\n` ||
    upload.with?.["if-no-files-found"] !== "error" ||
    upload.with?.["compression-level"] !== 0 ||
    upload.with?.["include-hidden-files"] !== false ||
    packageVerifier === undefined ||
    steps(packaging).indexOf(upload) !== steps(packaging).indexOf(packageVerifier) + 1
  ) {
    problems.push("package must verify and upload only the canonical preview triple.");
  }
  for (const consumerName of CONSUMERS) {
    const consumer = workflow.jobs[consumerName];
    if (
      consumer.needs !== "package" ||
      consumer.permissions !== undefined ||
      consumer.environment !== undefined ||
      consumer.concurrency !== undefined
    ) {
      problems.push(`${consumerName} must consume package directly in parallel under read-only permissions.`);
    }
    inspectCheckout(consumer, consumerName, problems);
    inspectCanonicalConsumer(consumer, consumerName, problems);
    if (
      runs(consumer).some(
        (run) => /^npm run package(?:\s|$)/u.test(run) || run.includes("create-canonical-release-artifact.mjs")
      )
    ) {
      problems.push(`${consumerName} must not rebuild or repackage the candidate.`);
    }
  }

  const completeOwners = Object.entries(workflow.jobs)
    .filter(([, job]) => FULL_SUITE.every((required) => runs(job).includes(required)))
    .map(([name]) => name);
  if (completeOwners.length !== 1 || completeOwners[0] !== "linux-acceptance") {
    problems.push("linux-acceptance must be the one and only complete source/full-suite owner.");
  }
  const crossPlatform = workflow.jobs["cross-platform"];
  const crossPlatformMatrix = crossPlatform.strategy?.matrix?.include;
  if (
    crossPlatform.strategy?.["fail-fast"] !== true ||
    !Array.isArray(crossPlatformMatrix) ||
    crossPlatformMatrix.length !== 2 ||
    crossPlatformMatrix[0]?.os !== "macos-latest" ||
    crossPlatformMatrix[0]?.python !== "3.12" ||
    crossPlatformMatrix[1]?.os !== "windows-latest" ||
    crossPlatformMatrix[1]?.python !== "3.14"
  ) {
    problems.push("cross-platform must fail fast across the pinned macOS and Windows release matrix.");
  }
  if (runs(crossPlatform).some((run) => run.startsWith("python -m pytest"))) {
    problems.push("cross-platform must retain native smoke coverage without repeating the complete Python suite.");
  }
  inspectCrossPlatformRJupyter(crossPlatform, problems);
  const installedPerformanceRun = runs(workflow.jobs["installed-performance"]).find((run) =>
    run.includes("benchmark:installed --")
  );
  if (!installedPerformanceRun?.includes("--preview-release")) {
    problems.push("installed-performance must retain canonical preview performance acceptance.");
  }
  const jupyter = workflow.jobs["released-jupyter"];
  const jupyterRuns = runs(jupyter);
  const pythonJupyter = steps(jupyter).find((step) => step?.id === "packaged_editor");
  if (
    !jupyterRuns.includes("npm run audit:remote-jupyter") ||
    pythonJupyter?.env?.OPEN_WRANGLER_REAL_JUPYTER_EXTENSION !== "1" ||
    pythonJupyter?.env?.OPEN_WRANGLER_REAL_REMOTE_JUPYTER !== "1"
  ) {
    problems.push("released-jupyter must retain released-extension and remote-kernel acceptance.");
  }
  inspectPreviewRJupyter(jupyter, problems);
  if (!runs(workflow.jobs["remote-ssh"]).some((run) => run.includes("npm run test:remote-workspace --"))) {
    problems.push("remote-ssh must retain real packaged Remote SSH acceptance.");
  }

  const gate = workflow.jobs["acceptance-gate"];
  const expectedNeeds = ["package", ...CONSUMERS];
  if (
    !Array.isArray(gate.needs) ||
    gate.needs.length !== expectedNeeds.length ||
    expectedNeeds.some((name) => !gate.needs.includes(name)) ||
    gate.if !== "${{ always() }}" ||
    gate.environment !== undefined ||
    gate.permissions !== undefined ||
    steps(gate).length !== 1 ||
    !CONSUMERS.every((name) =>
      runs(gate)[0]?.includes(`test "$${name.replaceAll("-", "_").toUpperCase()}_RESULT" = "success"`)
    )
  ) {
    problems.push("acceptance-gate must fail closed unless package and every parallel acceptance lane succeeds.");
  }

  const release = workflow.jobs.release;
  if (
    !Array.isArray(release.needs) ||
    release.needs.length !== 2 ||
    !release.needs.includes("package") ||
    !release.needs.includes("acceptance-gate") ||
    release.if !== "${{ inputs.publish == true }}" ||
    release.environment !== "publishing" ||
    release["runs-on"] !== "ubuntu-24.04" ||
    release["timeout-minutes"] !== 105 ||
    !exactKeys(release.permissions, ["contents"]) ||
    release.permissions.contents !== "write" ||
    !exactKeys(release.concurrency, ["group", "cancel-in-progress", "queue"]) ||
    release.concurrency.group !== "openwrangler-release-publication" ||
    release.concurrency["cancel-in-progress"] !== false ||
    release.concurrency.queue !== "max"
  ) {
    problems.push("release must be an explicit protected publication using the global non-cancelling queue.");
  }
  inspectCheckout(release, "release", problems);
  inspectCanonicalConsumer(release, "release", problems);
  const releaseRuns = runs(release);
  if (releaseRuns.some((run) => /^npm run (?:build|package)(?:\s|$)/u.test(run))) {
    problems.push("release must publish the tested candidate without rebuilding it.");
  }
  const tag = findRun(release, "node scripts/push-release-tag.mjs");
  const localTagStep = steps(release).find(
    (step) => step?.name === "Prepare the exact local release tag for registry verification"
  );
  const github = findRun(release, "node scripts/publish-github-preview-release.mjs canonical-release");
  if (
    !exactKeys(tag, ["name", "env", "run"]) ||
    !exactKeys(tag.env, ["EXPECTED_SHA", "GITHUB_REPOSITORY", "GITHUB_TOKEN", "RELEASE_TAG"]) ||
    tag.env.EXPECTED_SHA !== EVENT_SHA ||
    tag.env.GITHUB_REPOSITORY !== "${{ github.repository }}" ||
    tag.env.GITHUB_TOKEN !== "${{ github.token }}" ||
    tag.env.RELEASE_TAG !== RELEASE_TAG ||
    !exactKeys(localTagStep, ["name", "env", "run"]) ||
    !exactKeys(localTagStep?.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    localTagStep.env.EXPECTED_SHA !== EVENT_SHA ||
    localTagStep.env.RELEASE_TAG !== RELEASE_TAG ||
    command(localTagStep.run) !== "node scripts/prepare-stable-candidate-tag.mjs" ||
    !exactKeys(github, ["name", "env", "run"]) ||
    !exactKeys(github.env, [
      "EXPECTED_SHA",
      "GITHUB_IMMUTABLE_RELEASES_EXPECTED",
      "GITHUB_REPOSITORY",
      "GITHUB_TOKEN",
      "RELEASE_TAG"
    ]) ||
    github.env.GITHUB_IMMUTABLE_RELEASES_EXPECTED !== "true" ||
    steps(release).indexOf(localTagStep) !== steps(release).indexOf(tag) + 1 ||
    steps(release).indexOf(github) !== steps(release).indexOf(localTagStep) + 1
  ) {
    problems.push(
      "release must push and materialize the exact tag before idempotently publishing the draft-first GitHub preview."
    );
  }

  const releaseSteps = steps(release);
  const tokenStep = releaseSteps.find(
    (step) => typeof step?.run === "string" && step.run.includes("ovsx verify-pat Matt17BR")
  );
  const preflightStep = findRun(
    release,
    "node scripts/verify-open-vsx-github-release.mjs canonical-release --preflight"
  );
  const openVsxArtifactStep = releaseSteps.find(
    (step) =>
      step?.name === "Reverify the preview before Open VSX publication" &&
      command(step?.run) === "node scripts/verify-preview-release-artifact.mjs canonical-release"
  );
  const publishStep = releaseSteps.find(
    (step) => typeof step?.run === "string" && step.run.includes("ovsx publish --skip-duplicate")
  );
  const publicStep = findRun(release, "node scripts/verify-open-vsx-github-release.mjs canonical-release --verify");
  const publicMediaStep = releaseSteps.find(
    (step) => typeof step?.run === "string" && step.run.includes("verify-public-media-surfaces.mjs")
  );
  const publicMediaInstall = findRun(release, "npx playwright-core install --with-deps chromium");
  const publicMediaContract = releaseSteps.find((step) => step?.id === "public_media_contract");
  const publicTagStep = findRun(release, "node scripts/prepare-stable-candidate-tag.mjs --require-remote");
  const secretSteps = releaseSteps.filter((step) => step?.env?.OVSX_PAT !== undefined);
  const requiredCondition = "${{ steps.public_media_contract.outputs.required == 'true' }}";
  if (
    secretSteps.length !== 2 ||
    !secretSteps.includes(tokenStep) ||
    !secretSteps.includes(publishStep) ||
    !exactKeys(tokenStep?.env, ["OVSX_PAT"]) ||
    tokenStep.env.OVSX_PAT !== "${{ secrets.OVSX_PAT }}" ||
    command(tokenStep.run) !== command(OPEN_VSX_VERIFY_PAT_RUN) ||
    !exactKeys(preflightStep?.env, ["AUTOMATION_SHA", "EXPECTED_SHA", "RELEASE_PRERELEASE", "RELEASE_TAG"]) ||
    preflightStep.env.AUTOMATION_SHA !== EVENT_SHA ||
    preflightStep.env.EXPECTED_SHA !== EVENT_SHA ||
    preflightStep.env.RELEASE_PRERELEASE !== "true" ||
    preflightStep.env.RELEASE_TAG !== RELEASE_TAG ||
    !exactKeys(openVsxArtifactStep, ["name", "env", "run"]) ||
    openVsxArtifactStep.name !== "Reverify the preview before Open VSX publication" ||
    command(openVsxArtifactStep.run) !== "node scripts/verify-preview-release-artifact.mjs canonical-release" ||
    !exactKeys(openVsxArtifactStep.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    openVsxArtifactStep.env.EXPECTED_SHA !== EVENT_SHA ||
    openVsxArtifactStep.env.RELEASE_TAG !== RELEASE_TAG ||
    !exactKeys(publishStep?.env, ["OVSX_PAT", "RELEASE_PRERELEASE", "RELEASE_VERSION"]) ||
    publishStep.env.OVSX_PAT !== "${{ secrets.OVSX_PAT }}" ||
    publishStep.env.RELEASE_PRERELEASE !== "true" ||
    publishStep.env.RELEASE_VERSION !== "${{ steps.canonical_release.outputs.extension_version }}" ||
    command(publishStep.run) !== command(OPEN_VSX_PUBLISH_RUN) ||
    !exactKeys(publicStep?.env, ["AUTOMATION_SHA", "EXPECTED_SHA", "RELEASE_PRERELEASE", "RELEASE_TAG"]) ||
    publicStep.env.AUTOMATION_SHA !== EVENT_SHA ||
    publicStep.env.EXPECTED_SHA !== EVENT_SHA ||
    publicStep.env.RELEASE_PRERELEASE !== "true" ||
    publicStep.env.RELEASE_TAG !== RELEASE_TAG ||
    !exactKeys(publicTagStep?.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    publicTagStep.env.EXPECTED_SHA !== EVENT_SHA ||
    publicTagStep.env.RELEASE_TAG !== RELEASE_TAG ||
    !exactKeys(publicMediaContract, ["id", "name", "env", "run"]) ||
    publicMediaContract.name !== "Select the versioned public-media contract" ||
    !exactKeys(publicMediaContract.env, ["RELEASE_VERSION"]) ||
    publicMediaContract.env.RELEASE_VERSION !== "${{ steps.canonical_release.outputs.extension_version }}" ||
    command(publicMediaContract.run) !== command(PUBLIC_MEDIA_CONTRACT_RUN) ||
    publicMediaInstall?.if !== requiredCondition ||
    publicMediaStep?.if !== requiredCondition ||
    !exactKeys(publicMediaStep?.env, ["RELEASE_SOURCE_SHA", "RELEASE_VERSION"]) ||
    publicMediaStep.env.RELEASE_SOURCE_SHA !== EVENT_SHA ||
    publicMediaStep.env.RELEASE_VERSION !== "${{ steps.canonical_release.outputs.extension_version }}" ||
    command(publicMediaStep.run) !==
      command(
        'node scripts/verify-public-media-surfaces.mjs --source-sha "$RELEASE_SOURCE_SHA" --version "$RELEASE_VERSION" --wait-for-propagation'
      ) ||
    releaseSteps.indexOf(tokenStep) !== releaseSteps.indexOf(github) + 1 ||
    releaseSteps.indexOf(preflightStep) !== releaseSteps.indexOf(tokenStep) + 1 ||
    releaseSteps.indexOf(openVsxArtifactStep) !== releaseSteps.indexOf(preflightStep) + 1 ||
    releaseSteps.indexOf(publishStep) !== releaseSteps.indexOf(openVsxArtifactStep) + 1 ||
    releaseSteps.indexOf(publicStep) !== releaseSteps.indexOf(publishStep) + 1 ||
    releaseSteps.indexOf(publicTagStep) !== releaseSteps.indexOf(publicStep) + 1 ||
    releaseSteps.indexOf(publicMediaContract) !== releaseSteps.indexOf(publicTagStep) + 1 ||
    releaseSteps.indexOf(publicMediaInstall) !== releaseSteps.indexOf(publicMediaContract) + 1 ||
    releaseSteps.indexOf(publicMediaStep) !== releaseSteps.indexOf(publicMediaInstall) + 1
  ) {
    problems.push("Preview release must publish and verify the exact VSIX on Open VSX from the protected job.");
  }
  const environments = Object.entries(workflow.jobs)
    .filter(([, job]) => job.environment !== undefined)
    .map(([name]) => name);
  const writeJobs = Object.entries(workflow.jobs)
    .filter(([, job]) => job.permissions?.contents === "write")
    .map(([name]) => name);
  if (environments.join(",") !== "release" || writeJobs.join(",") !== "release") {
    problems.push(
      "publish:false must keep every validation lane outside protected environments and write permissions."
    );
  }
  return problems;
}
