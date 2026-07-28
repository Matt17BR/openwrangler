import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const EVENT_SHA = "${{ github.sha }}";
const RELEASE_TAG = "${{ inputs.release_tag }}";
const ARTIFACT_ID = "${{ needs.package.outputs.artifact-id }}";
const CHECKOUT_ACTION = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const RELEASE_ACTION = "softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65";
const PACKAGED_EDITOR_COMMAND =
  "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix";
const PREPARED_CURSOR_XVFB = "${{ steps.prepare_cursor_xvfb.outputs.executable }}";
const CONSUMERS = ["cross-platform", "linux-acceptance", "installed-performance", "released-jupyter", "remote-ssh"];
const JOBS = ["package", ...CONSUMERS, "acceptance-gate", "release"];
const CANONICAL_PATHS = [
  "canonical-release/openwrangler.vsix",
  "canonical-release/openwrangler.vsix.sha256",
  "canonical-release/openwrangler.vsix.provenance.json"
];

function command(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

const PINNED_CURSOR_XVFB_PREPARATION = [
  'const { execFileSync } = require("node:child_process");',
  'const { X_OK } = require("node:constants");',
  'const { accessSync, appendFileSync, lstatSync } = require("node:fs");',
  'const { isAbsolute } = require("node:path");',
  "",
  'const output = execFileSync(process.execPath, ["scripts/prepare-xvfb.mjs", "--print-path"], {',
  "cwd: process.cwd(),",
  'encoding: "utf8",',
  'stdio: ["ignore", "pipe", "inherit"]',
  "});",
  "if (!/^[^\\0\\r\\n]+\\n?$/u.test(output)) {",
  'throw new Error("The Xvfb preparer must print exactly one path.");',
  "}",
  'const executable = output.endsWith("\\n") ? output.slice(0, -1) : output;',
  'if (!isAbsolute(executable)) throw new Error("The prepared Xvfb path must be absolute.");',
  "const stat = lstatSync(executable);",
  "if (!stat.isFile() || stat.isSymbolicLink()) {",
  'throw new Error("The prepared Xvfb path must be a regular, non-symlink file.");',
  "}",
  "accessSync(executable, X_OK);",
  'appendFileSync(process.env.GITHUB_OUTPUT, `executable=${executable}\\n`, "utf8");'
].join("\n");

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function findRun(job, expected) {
  return steps(job).find((step) => command(step?.run) === expected);
}

function inspectCheckout(job, name, problems) {
  const checkouts = steps(job).filter((step) => step?.uses === CHECKOUT_ACTION);
  if (checkouts.length !== 1) {
    problems.push(`${name} must check out the event commit exactly once.`);
    return;
  }
  const options = checkouts[0].with;
  if (options?.ref !== EVENT_SHA || options?.["fetch-depth"] !== 0 || options?.["persist-credentials"] !== false) {
    problems.push(`${name} checkout must pin github.sha, fetch history, and persist no credentials.`);
  }
}

function inspectDownloadAndVerification(job, name, problems) {
  const jobSteps = steps(job);
  const downloads = jobSteps.filter((step) => step?.uses === DOWNLOAD_ACTION);
  if (downloads.length !== 1) {
    problems.push(`${name} must download the canonical artifact exactly once.`);
    return;
  }
  const download = downloads[0];
  if (
    !exactKeys(download.with, ["artifact-ids", "path", "merge-multiple"]) ||
    download.with["artifact-ids"] !== ARTIFACT_ID ||
    download.with.path !== "canonical-release" ||
    download.with["merge-multiple"] !== true
  ) {
    problems.push(`${name} must download only the producer artifact ID into canonical-release.`);
  }
  const verifier = findRun(job, "node scripts/verify-canonical-release-artifact.mjs canonical-release");
  if (
    verifier === undefined ||
    verifier.id !== "canonical" ||
    verifier.env?.EXPECTED_SHA !== EVENT_SHA ||
    verifier.env?.RELEASE_TAG !== RELEASE_TAG ||
    jobSteps.indexOf(verifier) <= jobSteps.indexOf(download)
  ) {
    problems.push(`${name} must bind and verify the downloaded canonical set before consuming it.`);
  }
}

function inspectPinnedActions(workflow, problems) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of steps(job)) {
      if (typeof step?.uses !== "string") continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(step.uses)) {
        problems.push(`${jobName} action ${step.uses} must be pinned to one full commit.`);
      }
    }
  }
}

function inspectFailureUpload(jobSteps, editorStep, expectedName, label, problems) {
  const editorIndex = jobSteps.indexOf(editorStep);
  const upload = jobSteps[editorIndex + 1];
  if (
    editorIndex < 0 ||
    !exactKeys(upload, ["name", "if", "uses", "with"]) ||
    upload?.uses !== UPLOAD_ACTION ||
    upload?.if !==
      `\${{ always() && steps.${editorStep?.id}.outcome == 'failure' && steps.${editorStep?.id}.outputs.evidence_ready == 'true' }}` ||
    !exactKeys(upload.with, [
      "name",
      "path",
      "if-no-files-found",
      "retention-days",
      "compression-level",
      "include-hidden-files"
    ]) ||
    upload.with.name !== expectedName ||
    upload.with.path !== `\${{ steps.${editorStep?.id}.outputs.evidence_path }}` ||
    upload.with["if-no-files-found"] !== "error" ||
    upload.with["retention-days"] !== 7 ||
    upload.with["compression-level"] !== 9 ||
    upload.with["include-hidden-files"] !== false
  ) {
    problems.push(`${label} must immediately upload only its sealed failure diagnostics.`);
  }
}

function inspectAdjacentCanonicalVerification(jobSteps, editorStep, expectedId, expectedName, label, problems) {
  const editorIndex = jobSteps.indexOf(editorStep);
  const verifier = jobSteps[editorIndex - 1];
  if (
    editorIndex < 1 ||
    !exactKeys(verifier, ["id", "name", "env", "run"]) ||
    verifier.id !== expectedId ||
    verifier.name !== expectedName ||
    !exactKeys(verifier.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    verifier.env.EXPECTED_SHA !== EVENT_SHA ||
    verifier.env.RELEASE_TAG !== RELEASE_TAG ||
    command(verifier.run) !== "node scripts/verify-canonical-release-artifact.mjs canonical-release"
  ) {
    problems.push(`${label} must immediately follow a fresh verification of the exact canonical artifact.`);
  }
}

function inspectCursorXvfbPreparation(jobSteps, cursorStep, problems) {
  const preparations = jobSteps.filter((step) => step?.id === "prepare_cursor_xvfb");
  const preparation = preparations[0];
  if (
    preparations.length !== 1 ||
    !exactKeys(preparation, ["id", "name", "shell", "run"]) ||
    preparation.name !== "Prepare pinned private Xvfb for Cursor" ||
    preparation.shell !== "node {0}" ||
    command(preparation.run) !== command(PINNED_CURSOR_XVFB_PREPARATION) ||
    jobSteps.indexOf(preparation) >= jobSteps.indexOf(cursorStep)
  ) {
    problems.push("linux-acceptance must prepare and verify one pinned private Xvfb before launching Cursor.");
  }
}

export function inspectStableReleaseWorkflow(source) {
  const problems = [];
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    return ["stable-release.yml must be bounded UTF-8 text."];
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch {
    return ["stable-release.yml must contain valid YAML."];
  }
  if (workflow === null || typeof workflow !== "object" || Array.isArray(workflow)) {
    return ["stable-release.yml must contain one workflow object."];
  }

  if (
    !exactKeys(workflow, ["name", "on", "permissions", "concurrency", "jobs"]) ||
    workflow.name !== "Stable release"
  ) {
    problems.push("Stable release must use the exact top-level contract without inherited environment or defaults.");
  }
  if (!exactKeys(workflow.on, ["workflow_dispatch"])) {
    problems.push("Stable release must be manually dispatched only.");
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
    problems.push("Stable release inputs must require a tag and default the explicit publish boolean to false.");
  }
  if (!exactKeys(workflow.permissions, ["contents"]) || workflow.permissions.contents !== "read") {
    problems.push("Stable release must default to contents: read.");
  }
  if (
    !exactKeys(workflow.concurrency, ["group", "cancel-in-progress"]) ||
    workflow.concurrency.group !== "stable-release-${{ github.sha }}" ||
    workflow.concurrency["cancel-in-progress"] !== false
  ) {
    problems.push("Stable release concurrency must be bound to github.sha without cancellation.");
  }
  if (!exactKeys(workflow.jobs, JOBS)) {
    problems.push(`Stable release must contain exactly these jobs: ${JOBS.join(", ")}.`);
    return problems;
  }
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (job?.env !== undefined || job?.defaults !== undefined) {
      problems.push(`${jobName} must not inherit job-level environment or shell defaults.`);
    }
  }
  inspectPinnedActions(workflow, problems);

  const allRuns = Object.values(workflow.jobs).flatMap((job) => steps(job).map((step) => command(step?.run)));
  const packageRuns = allRuns.filter((run) => /^npm run package(?:\s|$)/u.test(run));
  if (packageRuns.length !== 1 || packageRuns[0] !== "npm run package -- --out openwrangler.candidate.vsix") {
    problems.push("The ordinary stable VSIX must be packaged exactly once.");
  }
  const publicationRuns = allRuns.filter((run) => run.includes("scripts/create-canonical-release-artifact.mjs"));
  if (
    publicationRuns.length !== 1 ||
    publicationRuns[0] !==
      "node scripts/create-canonical-release-artifact.mjs openwrangler.candidate.vsix --out-dir canonical-release" ||
    publicationRuns[0].includes("--performance-evidence")
  ) {
    problems.push("The producer must publish one ordinary canonical stable artifact set.");
  }
  if (/(?:vsce|ovsx)\s+publish|marketplace.*publish/iu.test(source)) {
    problems.push("The GitHub stable workflow must not publish to Marketplace or Open VSX.");
  }
  if (
    allRuns.filter((run) => run.includes('git ls-remote --exit-code --refs origin "refs/tags/$RELEASE_TAG"')).length !==
    2
  ) {
    problems.push("Stable packaging and final publication must both reject an existing remote release tag.");
  }

  const packaging = workflow.jobs.package;
  inspectCheckout(packaging, "package", problems);
  if (packaging.permissions !== undefined || packaging.environment !== undefined) {
    problems.push("package must inherit read-only permissions and use no protected release environment.");
  }
  const uploads = steps(packaging).filter((step) => step?.uses === UPLOAD_ACTION);
  if (uploads.length !== 1) {
    problems.push("package must upload the canonical stable set exactly once.");
  } else {
    const upload = uploads[0];
    const expectedPath = `${CANONICAL_PATHS.join("\n")}\n`;
    if (
      upload.id !== "canonical_artifact" ||
      upload.with?.name !== "openwrangler-stable-release" ||
      upload.with?.path !== expectedPath ||
      upload.with?.["if-no-files-found"] !== "error" ||
      upload.with?.["compression-level"] !== 0 ||
      upload.with?.["include-hidden-files"] !== false
    ) {
      problems.push("package must upload only the canonical VSIX, checksum, and provenance set.");
    }
  }
  if (packaging.outputs?.["artifact-id"] !== "${{ steps.canonical_artifact.outputs.artifact-id }}") {
    problems.push("package must expose the immutable artifact ID.");
  }

  for (const consumerName of CONSUMERS) {
    const consumer = workflow.jobs[consumerName];
    if (consumer.needs !== "package") {
      problems.push(`${consumerName} must depend directly on package so consumers run in parallel.`);
    }
    if (consumer.permissions !== undefined || consumer.environment !== undefined) {
      problems.push(`${consumerName} must inherit read-only permissions and use no release environment.`);
    }
    inspectCheckout(consumer, consumerName, problems);
    inspectDownloadAndVerification(consumer, consumerName, problems);
    if (
      steps(consumer).some((step) => {
        const run = command(step?.run);
        return /^npm run package(?:\s|$)/u.test(run) || run.includes("scripts/create-canonical-release-artifact.mjs");
      })
    ) {
      problems.push(`${consumerName} must consume the exact artifact without repackaging it.`);
    }
  }

  const crossPlatform = workflow.jobs["cross-platform"];
  const matrix = crossPlatform.strategy?.matrix?.include;
  if (
    crossPlatform.strategy?.["fail-fast"] !== false ||
    !Array.isArray(matrix) ||
    matrix.length !== 2 ||
    matrix[0]?.os !== "macos-latest" ||
    matrix[0]?.python !== "3.12" ||
    matrix[1]?.os !== "windows-latest" ||
    matrix[1]?.python !== "3.14"
  ) {
    problems.push("cross-platform must cover the pinned macOS and Windows release matrix.");
  }
  for (const required of [
    "npm run test:python-environment-smoke",
    "python -m pytest python/tests -q",
    "npm run test:extension-host",
    "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix"
  ]) {
    if (!allRunsFor(crossPlatform).includes(required)) {
      problems.push(`cross-platform must run ${required}.`);
    }
  }

  const linux = workflow.jobs["linux-acceptance"];
  for (const required of [
    "npm run check",
    "npm test",
    "npm run test:webview-acceptance",
    "npm run test:coverage",
    "npm audit --omit=dev",
    "npm run audit:python",
    "npm run benchmark:runtime"
  ]) {
    if (!allRunsFor(linux).includes(required)) {
      problems.push(`linux-acceptance must run ${required}.`);
    }
  }
  const linuxSteps = steps(linux);
  const linuxEditorSteps = linuxSteps.filter((step) => command(step?.run) === PACKAGED_EDITOR_COMMAND);
  const linuxVscodeStep = linuxEditorSteps.find((step) => step?.id === "packaged_vscode");
  const linuxCursorStep = linuxEditorSteps.find((step) => step?.id === "packaged_cursor");
  if (
    linuxEditorSteps.length !== 2 ||
    !exactKeys(linuxVscodeStep, ["id", "name", "run", "env"]) ||
    linuxVscodeStep?.name !== "Test the full package in headless VS Code" ||
    !exactKeys(linuxVscodeStep?.env, ["OPEN_WRANGLER_PACKAGED_EDITORS", "VSCODE_TEST_VERSION"]) ||
    linuxVscodeStep.env.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode" ||
    linuxVscodeStep.env.VSCODE_TEST_VERSION !== "stable" ||
    !exactKeys(linuxCursorStep, ["id", "name", "run", "env"]) ||
    linuxCursorStep?.name !== "Test the full package in private-display Cursor" ||
    !exactKeys(linuxCursorStep?.env, [
      "OPEN_WRANGLER_PACKAGED_EDITORS",
      "OPEN_WRANGLER_EDITOR_DISPLAY",
      "OPEN_WRANGLER_XVFB_EXECUTABLE",
      "VSCODE_TEST_VERSION"
    ]) ||
    linuxCursorStep.env.OPEN_WRANGLER_PACKAGED_EDITORS !== "cursor" ||
    linuxCursorStep.env.OPEN_WRANGLER_EDITOR_DISPLAY !== "xvfb" ||
    linuxCursorStep.env.OPEN_WRANGLER_XVFB_EXECUTABLE !== PREPARED_CURSOR_XVFB ||
    linuxCursorStep.env.VSCODE_TEST_VERSION !== "stable" ||
    linuxSteps.indexOf(linuxVscodeStep) >= linuxSteps.indexOf(linuxCursorStep)
  ) {
    problems.push(
      "linux-acceptance must test the exact package in headless VS Code and pinned private-Xvfb Cursor under D-Bus."
    );
  } else {
    inspectAdjacentCanonicalVerification(
      linuxSteps,
      linuxVscodeStep,
      "canonical_vscode",
      "Reverify the exact canonical stable artifact for VS Code",
      "linux-acceptance VS Code",
      problems
    );
    inspectFailureUpload(
      linuxSteps,
      linuxVscodeStep,
      "stable-release-vscode-${{ runner.os }}-${{ github.run_attempt }}",
      "linux-acceptance VS Code",
      problems
    );
    inspectCursorXvfbPreparation(linuxSteps, linuxCursorStep, problems);
    inspectAdjacentCanonicalVerification(
      linuxSteps,
      linuxCursorStep,
      "canonical_cursor",
      "Reverify the exact canonical stable artifact for Cursor",
      "linux-acceptance Cursor",
      problems
    );
    inspectFailureUpload(
      linuxSteps,
      linuxCursorStep,
      "stable-release-cursor-${{ runner.os }}-${{ github.run_attempt }}",
      "linux-acceptance Cursor",
      problems
    );
  }

  const performance = workflow.jobs["installed-performance"];
  const performanceRun = allRunsFor(performance).find((run) => run.includes("npm run benchmark:installed --"));
  if (
    performanceRun === undefined ||
    performanceRun.includes("--performance-evidence") ||
    !performanceRun.includes("--pinned-editors") ||
    !performanceRun.includes("--candidate-in canonical-release/openwrangler.vsix") ||
    !performanceRun.includes("--candidate-checksum canonical-release/openwrangler.vsix.sha256") ||
    !performanceRun.includes("--candidate-provenance canonical-release/openwrangler.vsix.provenance.json")
  ) {
    problems.push("installed-performance must consume ordinary stable provenance in both pinned editors.");
  }

  const jupyter = workflow.jobs["released-jupyter"];
  const jupyterStep = steps(jupyter).find(
    (step) =>
      command(step?.run) ===
      "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix"
  );
  if (
    jupyterStep?.env?.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode,cursor" ||
    jupyterStep?.env?.OPEN_WRANGLER_REAL_JUPYTER_EXTENSION !== "1" ||
    jupyterStep?.env?.OPEN_WRANGLER_REAL_REMOTE_JUPYTER !== "1"
  ) {
    problems.push("released-jupyter must cover local and remote Jupyter in both VS Code and Cursor.");
  }

  const remote = workflow.jobs["remote-ssh"];
  const remoteRun = allRunsFor(remote).find((run) => run.startsWith("npm run test:remote-workspace --"));
  if (
    remoteRun !==
    "npm run test:remote-workspace -- ${{ steps.canonical.outputs.candidate_path }} ${{ steps.canonical.outputs.candidate_sha256 }} ${{ steps.canonical.outputs.candidate_bytes }}"
  ) {
    problems.push("remote-ssh must run the label-equivalent gate against verifier-bound artifact outputs.");
  }
  if (steps(remote).some((step) => step?.uses === UPLOAD_ACTION)) {
    problems.push("remote-ssh must not upload raw private state before its runner exposes sealed evidence.");
  }

  const acceptanceGate = workflow.jobs["acceptance-gate"];
  const expectedGateNeeds = ["package", ...CONSUMERS];
  if (
    !Array.isArray(acceptanceGate.needs) ||
    acceptanceGate.needs.length !== expectedGateNeeds.length ||
    expectedGateNeeds.some((job) => !acceptanceGate.needs.includes(job)) ||
    acceptanceGate.if !== "${{ always() }}" ||
    acceptanceGate.permissions !== undefined ||
    acceptanceGate.environment !== undefined ||
    steps(acceptanceGate).length !== 1
  ) {
    problems.push("acceptance-gate must always inspect every required job under inherited read-only permissions.");
  } else {
    const gate = steps(acceptanceGate)[0];
    const expectedEnvironment = {
      PACKAGE_RESULT: "${{ needs.package.result }}",
      CROSS_PLATFORM_RESULT: "${{ needs.cross-platform.result }}",
      LINUX_ACCEPTANCE_RESULT: "${{ needs.linux-acceptance.result }}",
      INSTALLED_PERFORMANCE_RESULT: "${{ needs.installed-performance.result }}",
      RELEASED_JUPYTER_RESULT: "${{ needs.released-jupyter.result }}",
      REMOTE_SSH_RESULT: "${{ needs.remote-ssh.result }}"
    };
    const expectedRun = [
      'test "$PACKAGE_RESULT" = "success"',
      'test "$CROSS_PLATFORM_RESULT" = "success"',
      'test "$LINUX_ACCEPTANCE_RESULT" = "success"',
      'test "$INSTALLED_PERFORMANCE_RESULT" = "success"',
      'test "$RELEASED_JUPYTER_RESULT" = "success"',
      'test "$REMOTE_SSH_RESULT" = "success"'
    ].join(" ");
    if (
      !exactKeys(gate.env, Object.keys(expectedEnvironment)) ||
      Object.entries(expectedEnvironment).some(([key, value]) => gate.env[key] !== value) ||
      command(gate.run) !== expectedRun
    ) {
      problems.push("acceptance-gate must fail closed unless every required result is exactly success.");
    }
  }

  const release = workflow.jobs.release;
  const expectedNeeds = ["package", "acceptance-gate"];
  if (
    !Array.isArray(release.needs) ||
    release.needs.length !== expectedNeeds.length ||
    expectedNeeds.some((job) => !release.needs.includes(job))
  ) {
    problems.push("release must wait for every exact-artifact consumer.");
  }
  if (release.if !== "${{ inputs.publish == true }}") {
    problems.push("release must run only after an explicit true publish input.");
  }
  if (release.environment !== "publishing") {
    problems.push("release must use the existing protected publishing environment.");
  }
  if (!exactKeys(release.permissions, ["contents"]) || release.permissions.contents !== "write") {
    problems.push("release must have only contents: write.");
  }
  inspectCheckout(release, "release", problems);
  inspectDownloadAndVerification(release, "release", problems);
  if (
    allRunsFor(release).some(
      (run) => /^npm run (?:build|package)(?:\s|$)/u.test(run) || run.includes("create-canonical-release-artifact")
    )
  ) {
    problems.push("release must never rebuild or repackage the tested artifact.");
  }
  const releaseSteps = steps(release).filter((step) => step?.uses === RELEASE_ACTION);
  if (releaseSteps.length !== 1) {
    problems.push("release must create exactly one GitHub release with the pinned action.");
  } else {
    const options = releaseSteps[0].with;
    if (
      options?.tag_name !== RELEASE_TAG ||
      options?.target_commitish !== EVENT_SHA ||
      options?.draft !== false ||
      options?.prerelease !== false ||
      options?.make_latest !== true ||
      options?.generate_release_notes !== true ||
      options?.fail_on_unmatched_files !== true ||
      options?.files !== `${CANONICAL_PATHS.join("\n")}\n`
    ) {
      problems.push("release must attach the same canonical set as a non-draft stable GitHub release.");
    }
  }

  const writeJobs = Object.entries(workflow.jobs)
    .filter(([, job]) => job.permissions?.contents === "write")
    .map(([name]) => name);
  if (writeJobs.length !== 1 || writeJobs[0] !== "release") {
    problems.push("Only release may receive contents: write.");
  }
  return problems;
}

function allRunsFor(job) {
  return steps(job)
    .map((step) => command(step?.run))
    .filter(Boolean);
}

function runCli() {
  const workflowPath = resolve(import.meta.dirname, "..", ".github", "workflows", "stable-release.yml");
  const problems = inspectStableReleaseWorkflow(readFileSync(workflowPath, "utf8"));
  if (problems.length > 0) {
    throw new Error(`Stable release workflow validation failed:\n- ${problems.join("\n- ")}`);
  }
  console.log("Stable release workflow structure is valid.");
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
