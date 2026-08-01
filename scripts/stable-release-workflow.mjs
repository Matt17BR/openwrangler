import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const EVENT_SHA = "${{ github.sha }}";
const EVENT_REF = "${{ github.ref }}";
const EVENT_REF_TYPE = "${{ github.ref_type }}";
const RELEASE_TAG = "${{ inputs.release_tag }}";
const RELEASE_SOURCE_BRANCH = "${{ steps.release_metadata.outputs.source_branch }}";
const RELEASE_SOURCE_REF = "${{ steps.release_metadata.outputs.source_ref }}";
const ARTIFACT_ID = "${{ needs.package.outputs.artifact-id }}";
const PUBLISH_TAG_COMMAND = "node scripts/push-stable-release-tag.mjs";
const CHECKOUT_ACTION = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE_ACTION = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const SETUP_JAVA_ACTION = "actions/setup-java@f2beeb24e141e01a676f977032f5a29d81c9e27e";
const PYSPARK_COVERAGE_INSTALL = 'python -m pip install "pandas>=2.2,<3.0" "pyspark[connect]==4.2.0"';
const PYSPARK_COVERAGE_VERIFY_RUN = `python - <<'PY'
import pandas
import pyspark
from packaging.version import Version

assert pyspark.__version__ == "4.2.0", pyspark.__version__
assert Version("2.2") <= Version(pandas.__version__) < Version("3"), pandas.__version__
PY
java -XshowSettings:properties -version 2>&1 |
  grep -Eq '^[[:space:]]*java\\.specification\\.version = 17$'
`;
const PACKAGED_EDITOR_COMMAND =
  "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix";
const PREPARED_CURSOR_XVFB = "${{ steps.prepare_cursor_xvfb.outputs.executable }}";
const CONSUMERS = ["cross-platform", "linux-acceptance", "installed-performance", "released-jupyter", "remote-ssh"];
const JOBS = ["package", ...CONSUMERS, "acceptance-gate", "release", "promote-open-vsx"];
const REMOTE_SSH_SYSTEM_ANCESTOR_REPAIR = [
  "system_runtime_ancestors=(",
  "  /usr",
  "  /etc",
  ")",
  'runner_uid="$(id -u)"',
  'for directory in "${system_runtime_ancestors[@]}"; do',
  '  test -d "$directory"',
  '  test ! -L "$directory"',
  '  test "$(realpath "$directory")" = "$directory"',
  `  owner="$(stat --format='%u' "$directory")"`,
  '  test "$owner" = "0" || test "$owner" = "$runner_uid"',
  "done",
  'sudo chown --no-dereference root:root -- "${system_runtime_ancestors[@]}"',
  'sudo chmod go-w -- "${system_runtime_ancestors[@]}"',
  'for directory in / "${system_runtime_ancestors[@]}"; do',
  '  test -d "$directory"',
  '  test ! -L "$directory"',
  '  test "$(realpath "$directory")" = "$directory"',
  `  test "$(stat --format='%u:%g' "$directory")" = "0:0"`,
  `  test -z "$(find "$directory" -maxdepth 0 -perm /022 -print -quit)"`,
  '  test ! -w "$directory"',
  "done"
].join("\n");
const CANONICAL_PATHS = [
  "canonical-release/openwrangler.vsix",
  "canonical-release/openwrangler.vsix.sha256",
  "canonical-release/openwrangler.vsix.provenance.json"
];
const RECOGNIZED_RELEASE_SOURCE_RUN = `test "$EVENT_REF_TYPE" = "branch"
case "$EVENT_REF" in
  refs/heads/main|refs/heads/release/1.x) ;;
  *) exit 1 ;;
esac
case "$EXPECTED_SHA" in *[!0-9a-f]*|"") exit 1 ;; esac
test "\${#EXPECTED_SHA}" -eq 40`;
const EXACT_VERSION_SOURCE_RUN = `case "$EXPECTED_SOURCE_BRANCH" in
  main|release/1.x) ;;
  *) exit 1 ;;
esac
test "$EXPECTED_SOURCE_REF" = "refs/heads/$EXPECTED_SOURCE_BRANCH"
test "$EVENT_REF" = "$EXPECTED_SOURCE_REF"
test "$(git rev-parse --verify HEAD^{commit})" = "$EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(git rev-parse --verify refs/remotes/origin/$EXPECTED_SOURCE_BRANCH^{commit})" = "$EXPECTED_SHA"`;

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

function inspectCoverageRuntime(job, name, problems) {
  const jobSteps = steps(job);
  const coverage = jobSteps.find((step) => command(step?.run) === "npm run test:coverage");
  const javaSteps = jobSteps.filter((step) => step?.uses === SETUP_JAVA_ACTION);
  const javaStep = javaSteps[0];
  if (
    javaSteps.length !== 1 ||
    !exactKeys(javaStep, ["uses", "with"]) ||
    !exactKeys(javaStep.with, ["distribution", "java-version"]) ||
    javaStep.with.distribution !== "temurin" ||
    javaStep.with["java-version"] !== "17"
  ) {
    problems.push(`${name} coverage must provision one pinned Temurin Java 17 runtime.`);
  }
  const installs = jobSteps.filter((step) => command(step?.run) === PYSPARK_COVERAGE_INSTALL);
  const install = installs[0];
  if (installs.length !== 1 || !exactKeys(install, ["run"])) {
    problems.push(`${name} coverage must install exact PySpark 4.2.0 and compatible Pandas.`);
  }
  const verifications = jobSteps.filter((step) => step?.name === "Verify exact coverage runtimes");
  const verification = verifications[0];
  if (
    verifications.length !== 1 ||
    !exactKeys(verification, ["name", "run"]) ||
    command(verification.run) !== command(PYSPARK_COVERAGE_VERIFY_RUN)
  ) {
    problems.push(`${name} coverage must verify exact PySpark, Pandas, and Java runtimes.`);
  }
  if (
    coverage === undefined ||
    javaStep === undefined ||
    install === undefined ||
    verification === undefined ||
    jobSteps.indexOf(javaStep) >= jobSteps.indexOf(coverage) ||
    jobSteps.indexOf(install) >= jobSteps.indexOf(coverage) ||
    jobSteps.indexOf(verification) >= jobSteps.indexOf(coverage)
  ) {
    problems.push(`${name} coverage runtime setup and verification must precede the coverage gate.`);
  }
}

function inspectCheckout(job, name, problems) {
  const checkouts = steps(job).filter((step) => step?.uses === CHECKOUT_ACTION);
  if (checkouts.length !== 1) {
    problems.push(`${name} must check out the event commit exactly once.`);
    return;
  }
  const checkout = checkouts[0];
  const options = checkout.with;
  if (
    !exactKeys(checkout, ["uses", "with"]) ||
    !exactKeys(options, ["ref", "fetch-depth", "persist-credentials"]) ||
    options.ref !== EVENT_SHA ||
    options["fetch-depth"] !== 0 ||
    options["persist-credentials"] !== false
  ) {
    problems.push(`${name} checkout must pin github.sha, fetch history, and persist no credentials.`);
  }
}

function inspectPackageSourceBinding(job, problems) {
  const jobSteps = steps(job);
  const recognizedSteps = jobSteps.filter((step) => step?.name === "Require a recognized protected release source");
  const recognized = recognizedSteps[0];
  if (
    recognizedSteps.length !== 1 ||
    !exactKeys(recognized, ["name", "env", "run"]) ||
    !exactKeys(recognized.env, ["EVENT_REF", "EVENT_REF_TYPE", "EXPECTED_SHA"]) ||
    recognized.env.EVENT_REF !== EVENT_REF ||
    recognized.env.EVENT_REF_TYPE !== EVENT_REF_TYPE ||
    recognized.env.EXPECTED_SHA !== EVENT_SHA ||
    command(recognized.run) !== command(RECOGNIZED_RELEASE_SOURCE_RUN)
  ) {
    problems.push("package must reject tags and unrecognized release branches before checkout or code execution.");
  }

  const checkout = jobSteps.find((step) => step?.uses === CHECKOUT_ACTION);
  const setupNodeSteps = jobSteps.filter((step) => step?.uses === SETUP_NODE_ACTION);
  const setupNode = setupNodeSteps[0];
  if (
    setupNodeSteps.length !== 1 ||
    !exactKeys(setupNode, ["uses", "with"]) ||
    !exactKeys(setupNode.with, ["node-version", "cache"]) ||
    setupNode.with["node-version"] !== 22 ||
    setupNode.with.cache !== "npm"
  ) {
    problems.push("package must provision one pinned Node 22 runtime before release metadata validation.");
  }

  const metadataSteps = jobSteps.filter((step) => step?.id === "release_metadata");
  const metadata = metadataSteps[0];
  if (
    metadataSteps.length !== 1 ||
    !exactKeys(metadata, ["id", "name", "env", "run"]) ||
    metadata.name !== "Validate stable release metadata" ||
    !exactKeys(metadata.env, ["RELEASE_TAG"]) ||
    metadata.env.RELEASE_TAG !== RELEASE_TAG ||
    command(metadata.run) !== "node scripts/release-metadata.mjs"
  ) {
    problems.push("package must derive the release channel and version-owned source from reviewed metadata.");
  }

  const rejectSteps = jobSteps.filter((step) => step?.name === "Reject preview metadata");
  const reject = rejectSteps[0];
  if (
    rejectSteps.length !== 1 ||
    !exactKeys(reject, ["name", "if", "run"]) ||
    reject.if !== "${{ steps.release_metadata.outputs.prerelease != 'false' }}" ||
    command(reject.run) !== "exit 1"
  ) {
    problems.push("package must reject preview metadata in the stable workflow.");
  }

  const exactSteps = jobSteps.filter(
    (step) => step?.name === "Require the exact version-owned protected branch commit"
  );
  const exact = exactSteps[0];
  if (
    exactSteps.length !== 1 ||
    !exactKeys(exact, ["name", "env", "run"]) ||
    !exactKeys(exact.env, ["EVENT_REF", "EXPECTED_SHA", "EXPECTED_SOURCE_BRANCH", "EXPECTED_SOURCE_REF"]) ||
    exact.env.EVENT_REF !== EVENT_REF ||
    exact.env.EXPECTED_SHA !== EVENT_SHA ||
    exact.env.EXPECTED_SOURCE_BRANCH !== RELEASE_SOURCE_BRANCH ||
    exact.env.EXPECTED_SOURCE_REF !== RELEASE_SOURCE_REF ||
    command(exact.run) !== command(EXACT_VERSION_SOURCE_RUN)
  ) {
    problems.push("package must bind the event commit to the exact protected branch owned by its numeric version.");
  }

  const remotePreflights = jobSteps.filter(
    (step) => command(step?.run) === "node scripts/prepare-stable-candidate-tag.mjs --verify-remote"
  );
  const remotePreflight = remotePreflights[0];
  if (
    remotePreflights.length !== 1 ||
    jobSteps.indexOf(recognized) !== 0 ||
    jobSteps.indexOf(checkout) !== 1 ||
    jobSteps.indexOf(setupNode) !== 2 ||
    jobSteps.indexOf(metadata) !== 3 ||
    jobSteps.indexOf(reject) !== 4 ||
    jobSteps.indexOf(exact) !== 5 ||
    jobSteps.indexOf(remotePreflight) !== 6
  ) {
    problems.push(
      "package source recognition, exact checkout, metadata validation, branch binding, and tag preflight must be the first ordered boundary."
    );
  }
}

function inspectDownloadAndVerification(
  job,
  name,
  problems,
  verifierName = "Verify the exact canonical stable artifact"
) {
  const jobSteps = steps(job);
  const downloads = jobSteps.filter((step) => step?.uses === DOWNLOAD_ACTION);
  if (downloads.length !== 1) {
    problems.push(`${name} must download the canonical artifact exactly once.`);
    return;
  }
  const download = downloads[0];
  if (
    !exactKeys(download, ["uses", "with"]) ||
    !exactKeys(download.with, ["artifact-ids", "path", "merge-multiple"]) ||
    download.with["artifact-ids"] !== ARTIFACT_ID ||
    download.with.path !== "canonical-release" ||
    download.with["merge-multiple"] !== true
  ) {
    problems.push(`${name} must download only the producer artifact ID into canonical-release.`);
  }
  const verifiers = jobSteps.filter((step) => step?.id === "canonical");
  const verifier = verifiers[0];
  if (
    verifiers.length !== 1 ||
    !exactKeys(verifier, ["id", "name", "env", "run"]) ||
    verifier.name !== verifierName ||
    !exactKeys(verifier.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    verifier.env.EXPECTED_SHA !== EVENT_SHA ||
    verifier.env.RELEASE_TAG !== RELEASE_TAG ||
    command(verifier.run) !== "node scripts/verify-canonical-release-artifact.mjs canonical-release" ||
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
    workflow.concurrency.group !== "stable-release-${{ inputs.release_tag }}" ||
    workflow.concurrency["cancel-in-progress"] !== false
  ) {
    problems.push("Stable release concurrency must serialize one release tag without cancellation.");
  }
  if (!exactKeys(workflow.jobs, JOBS)) {
    problems.push(`Stable release must contain exactly these jobs: ${JOBS.join(", ")}.`);
    return problems;
  }
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (job?.env !== undefined || job?.defaults !== undefined) {
      problems.push(`${jobName} must not inherit job-level environment or shell defaults.`);
    }
    if (
      job?.["continue-on-error"] !== undefined ||
      steps(job).some((step) => step?.["continue-on-error"] !== undefined)
    ) {
      problems.push(`${jobName} must not convert a failed release step or job into success.`);
    }
    for (const step of steps(job)) {
      if (
        step?.if !== undefined &&
        step?.uses !== UPLOAD_ACTION &&
        !(
          jobName === "package" &&
          exactKeys(step, ["name", "if", "run"]) &&
          step.name === "Reject preview metadata" &&
          step.if === "${{ steps.release_metadata.outputs.prerelease != 'false' }}" &&
          command(step.run) === "exit 1"
        )
      ) {
        problems.push(`${jobName} must not conditionally skip a required release step.`);
      }
      if (
        step?.shell !== undefined &&
        !(
          (jobName === "linux-acceptance" &&
            step.id === "prepare_cursor_xvfb" &&
            step.shell === "node {0}" &&
            command(step.run) === command(PINNED_CURSOR_XVFB_PREPARATION)) ||
          (jobName === "released-jupyter" &&
            step.id === "prepare_xvfb" &&
            step.shell === "node {0}" &&
            command(step.run) === command(PINNED_CURSOR_XVFB_PREPARATION))
        )
      ) {
        problems.push(`${jobName} must not override the shell of a required release step.`);
      }
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
  if (allRuns.some((run) => /(?:^|\s)(?:ovsx|vsce)\s+publish(?:\s|$)/u.test(run))) {
    problems.push("Stable release must delegate registry promotion instead of publishing from its GitHub job.");
  }
  if (allRuns.filter((run) => run === "node scripts/prepare-stable-candidate-tag.mjs --verify-remote").length !== 2) {
    problems.push("Stable packaging and final publication must both accept only an absent or exact remote tag.");
  }

  const packaging = workflow.jobs.package;
  inspectCheckout(packaging, "package", problems);
  inspectPackageSourceBinding(packaging, problems);
  if (packaging.permissions !== undefined || packaging.environment !== undefined) {
    problems.push("package must inherit read-only permissions and use no protected release environment.");
  }
  const uploads = steps(packaging).filter((step) => step?.uses === UPLOAD_ACTION);
  if (uploads.length !== 1) {
    problems.push("package must upload the canonical stable set exactly once.");
  } else {
    const upload = uploads[0];
    const expectedPath = `${CANONICAL_PATHS.join("\n")}\n`;
    const packageVerifier = steps(packaging).find((step) => step?.id === "canonical");
    if (
      !exactKeys(upload, ["id", "name", "uses", "with"]) ||
      upload.id !== "canonical_artifact" ||
      upload.name !== "Upload the canonical stable artifact set" ||
      upload.with?.name !== "openwrangler-stable-release" ||
      upload.with?.path !== expectedPath ||
      upload.with?.["if-no-files-found"] !== "error" ||
      upload.with?.["compression-level"] !== 0 ||
      upload.with?.["include-hidden-files"] !== false ||
      !exactKeys(packageVerifier, ["id", "name", "env", "run"]) ||
      packageVerifier.name !== "Revalidate the canonical stable artifact set" ||
      !exactKeys(packageVerifier.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
      packageVerifier.env.EXPECTED_SHA !== EVENT_SHA ||
      packageVerifier.env.RELEASE_TAG !== RELEASE_TAG ||
      command(packageVerifier.run) !== "node scripts/verify-canonical-release-artifact.mjs canonical-release" ||
      steps(packaging).indexOf(upload) !== steps(packaging).indexOf(packageVerifier) + 1
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
  for (const required of ["npm run test:python-environment-smoke", "python -m pytest python/tests -q"]) {
    const requiredSteps = steps(crossPlatform).filter((step) => command(step?.run) === required);
    if (requiredSteps.length !== 1 || !exactKeys(requiredSteps[0], ["run"])) {
      problems.push(`cross-platform must run ${required} exactly once as an unconditional required step.`);
    }
  }
  const extensionHostStep = findRun(crossPlatform, "npm run test:extension-host");
  if (
    !exactKeys(extensionHostStep, ["run", "env"]) ||
    !exactKeys(extensionHostStep.env, ["VSCODE_TEST_VERSION"]) ||
    extensionHostStep.env.VSCODE_TEST_VERSION !== "stable"
  ) {
    problems.push("cross-platform must run stable extension-host acceptance unconditionally.");
  }
  const crossPlatformEditorStep = findRun(
    crossPlatform,
    "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix"
  );
  if (
    !exactKeys(crossPlatformEditorStep, ["id", "name", "run", "env"]) ||
    crossPlatformEditorStep.id !== "packaged_editor" ||
    crossPlatformEditorStep.name !== "Test packaged VS Code" ||
    !exactKeys(crossPlatformEditorStep.env, ["OPEN_WRANGLER_PACKAGED_EDITORS", "VSCODE_TEST_VERSION"]) ||
    crossPlatformEditorStep.env.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode" ||
    crossPlatformEditorStep.env.VSCODE_TEST_VERSION !== "stable"
  ) {
    problems.push("cross-platform must run full stable VS Code packaged acceptance unconditionally.");
  }
  inspectAdjacentCanonicalVerification(
    steps(crossPlatform),
    crossPlatformEditorStep,
    "canonical_vscode",
    "Reverify the exact canonical stable artifact for cross-platform VS Code",
    "cross-platform VS Code",
    problems
  );
  const cursorSmokeStep = steps(crossPlatform).find((step) => step?.id === "cursor_smoke");
  if (
    !exactKeys(cursorSmokeStep, ["id", "name", "run", "env"]) ||
    cursorSmokeStep.name !== "Test pinned Cursor platform smoke" ||
    command(cursorSmokeStep.run) !== "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix" ||
    !exactKeys(cursorSmokeStep.env, ["OPEN_WRANGLER_PACKAGED_EDITORS", "OPEN_WRANGLER_PACKAGED_MODE"]) ||
    cursorSmokeStep.env.OPEN_WRANGLER_PACKAGED_EDITORS !== "cursor" ||
    cursorSmokeStep.env.OPEN_WRANGLER_PACKAGED_MODE !== "platform-smoke"
  ) {
    problems.push("cross-platform must run the pinned Cursor platform smoke unconditionally.");
  }
  inspectAdjacentCanonicalVerification(
    steps(crossPlatform),
    cursorSmokeStep,
    "canonical_cursor",
    "Reverify the exact canonical stable artifact for cross-platform Cursor",
    "cross-platform Cursor",
    problems
  );

  const linux = workflow.jobs["linux-acceptance"];
  for (const required of [
    "npm run check",
    "npm run test:scripts",
    "npm run test:webview-acceptance",
    "npm run test:coverage",
    "npm audit --omit=dev",
    "npm run audit:python",
    "npm run benchmark:runtime"
  ]) {
    const requiredSteps = steps(linux).filter((step) => command(step?.run) === required);
    if (requiredSteps.length !== 1 || !exactKeys(requiredSteps[0], ["run"])) {
      problems.push(`linux-acceptance must run ${required} exactly once as an unconditional required step.`);
    }
  }
  inspectCoverageRuntime(linux, "linux-acceptance", problems);
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
  const performanceStep = steps(performance).find((step) => step?.id === "installed_performance");
  const performanceRun = command(performanceStep?.run);
  if (
    !exactKeys(performanceStep, ["id", "name", "env", "run"]) ||
    performanceStep.name !== "Test the ordinary stable artifact in pinned editors" ||
    !exactKeys(performanceStep.env, ["EXPECTED_SHA", "RELEASE_TAG"]) ||
    performanceStep.env.EXPECTED_SHA !== EVENT_SHA ||
    performanceStep.env.RELEASE_TAG !== RELEASE_TAG ||
    performanceRun.includes("--performance-evidence") ||
    !performanceRun.includes("--pinned-editors") ||
    !performanceRun.includes("--candidate-in canonical-release/openwrangler.vsix") ||
    !performanceRun.includes("--candidate-checksum canonical-release/openwrangler.vsix.sha256") ||
    !performanceRun.includes("--candidate-provenance canonical-release/openwrangler.vsix.provenance.json")
  ) {
    problems.push("installed-performance must consume ordinary stable provenance in both pinned editors.");
  }
  inspectAdjacentCanonicalVerification(
    steps(performance),
    performanceStep,
    "canonical",
    "Verify the exact canonical stable artifact",
    "installed-performance",
    problems
  );

  const jupyter = workflow.jobs["released-jupyter"];
  const jupyterStep = steps(jupyter).find((step) => step?.id === "packaged_editor");
  if (
    !exactKeys(jupyterStep, ["id", "name", "run", "env"]) ||
    jupyterStep.name !== "Test released Jupyter in the exact packaged VSIX" ||
    command(jupyterStep.run) !== PACKAGED_EDITOR_COMMAND ||
    !exactKeys(jupyterStep.env, [
      "OPEN_WRANGLER_PACKAGED_EDITORS",
      "OPEN_WRANGLER_EDITOR_DISPLAY",
      "OPEN_WRANGLER_XVFB_EXECUTABLE",
      "OPEN_WRANGLER_REAL_JUPYTER_EXTENSION",
      "OPEN_WRANGLER_REAL_REMOTE_JUPYTER",
      "VSCODE_TEST_VERSION"
    ]) ||
    jupyterStep.env.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode,cursor" ||
    jupyterStep.env.OPEN_WRANGLER_EDITOR_DISPLAY !== "xvfb" ||
    jupyterStep.env.OPEN_WRANGLER_XVFB_EXECUTABLE !== "${{ steps.prepare_xvfb.outputs.executable }}" ||
    jupyterStep.env.OPEN_WRANGLER_REAL_JUPYTER_EXTENSION !== "1" ||
    jupyterStep.env.OPEN_WRANGLER_REAL_REMOTE_JUPYTER !== "1" ||
    jupyterStep.env.VSCODE_TEST_VERSION !== "stable"
  ) {
    problems.push("released-jupyter must cover local and remote Jupyter in both VS Code and Cursor.");
  }
  const jupyterPreparations = steps(jupyter).filter((step) => step?.id === "prepare_xvfb");
  const jupyterPreparation = jupyterPreparations[0];
  if (
    jupyterPreparations.length !== 1 ||
    !exactKeys(jupyterPreparation, ["id", "name", "shell", "run"]) ||
    jupyterPreparation.name !== "Prepare pinned private Xvfb" ||
    jupyterPreparation.shell !== "node {0}" ||
    command(jupyterPreparation.run) !== command(PINNED_CURSOR_XVFB_PREPARATION) ||
    steps(jupyter).indexOf(jupyterPreparation) >= steps(jupyter).indexOf(jupyterStep)
  ) {
    problems.push("released-jupyter must prepare and verify one pinned private Xvfb before its editor gate.");
  }
  const javaSteps = steps(jupyter).filter((step) => step?.uses === SETUP_JAVA_ACTION);
  const javaStep = javaSteps[0];
  if (
    javaSteps.length !== 1 ||
    !exactKeys(javaStep, ["uses", "with"]) ||
    !exactKeys(javaStep.with, ["distribution", "java-version"]) ||
    javaStep.with.distribution !== "temurin" ||
    javaStep.with["java-version"] !== "17" ||
    steps(jupyter).indexOf(javaStep) >= steps(jupyter).indexOf(jupyterStep)
  ) {
    problems.push("released-jupyter must provision one pinned Temurin Java 17 before its PySpark editor gate.");
  }
  inspectAdjacentCanonicalVerification(
    steps(jupyter),
    jupyterStep,
    "canonical_jupyter",
    "Reverify the exact canonical stable artifact for released Jupyter",
    "released-jupyter",
    problems
  );

  const remote = workflow.jobs["remote-ssh"];
  const remoteHostSteps = steps(remote).filter((step) => step?.name === "Prepare namespace-capable acceptance host");
  const remoteHost = remoteHostSteps[0];
  const remoteStep = steps(remote).find((step) => step?.id === "remote_workspace");
  const remoteRun = command(remoteStep?.run);
  if (
    remoteHostSteps.length !== 1 ||
    !exactKeys(remoteHost, ["name", "run"]) ||
    typeof remoteHost.run !== "string" ||
    !remoteHost.run.includes(REMOTE_SSH_SYSTEM_ANCESTOR_REPAIR) ||
    steps(remote).indexOf(remoteHost) >= steps(remote).indexOf(remoteStep)
  ) {
    problems.push(
      "remote-ssh must canonically restore only the trusted /usr and /etc ancestors before namespace acceptance."
    );
  }
  if (
    !exactKeys(remoteStep, ["id", "name", "run", "env"]) ||
    remoteStep.name !== "Test packaged VS Code over Remote SSH" ||
    !exactKeys(remoteStep.env, ["OPEN_WRANGLER_EDITOR_DISPLAY", "OPEN_WRANGLER_REMOTE_PYTHON"]) ||
    remoteStep.env.OPEN_WRANGLER_EDITOR_DISPLAY !== "xvfb" ||
    remoteStep.env.OPEN_WRANGLER_REMOTE_PYTHON !== "${{ github.workspace }}/.remote-venv/bin/python" ||
    remoteRun !==
      "npm run test:remote-workspace -- ${{ steps.canonical_remote.outputs.candidate_path }} ${{ steps.canonical_remote.outputs.candidate_sha256 }} ${{ steps.canonical_remote.outputs.candidate_bytes }}"
  ) {
    problems.push("remote-ssh must run the label-equivalent gate against verifier-bound artifact outputs.");
  }
  if (steps(remote).some((step) => step?.uses === UPLOAD_ACTION)) {
    problems.push("remote-ssh must not upload raw private state before its runner exposes sealed evidence.");
  }
  inspectAdjacentCanonicalVerification(
    steps(remote),
    remoteStep,
    "canonical_remote",
    "Reverify the exact canonical stable artifact for Remote SSH",
    "remote-ssh",
    problems
  );

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
      !exactKeys(gate, ["name", "env", "run"]) ||
      gate.name !== "Fail closed unless every required job succeeded" ||
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
  if (release["runs-on"] !== "ubuntu-24.04" || release["timeout-minutes"] !== 20) {
    problems.push("release must retain bounded Ubuntu publication time.");
  }
  if (
    !exactKeys(release.concurrency, ["group", "cancel-in-progress", "queue"]) ||
    release.concurrency.group !== "openwrangler-release-publication" ||
    release.concurrency["cancel-in-progress"] !== false ||
    release.concurrency.queue !== "max"
  ) {
    problems.push("release must use the global non-cancelling publication queue.");
  }
  if (!exactKeys(release.permissions, ["contents"]) || release.permissions.contents !== "write") {
    problems.push("release must have only contents: write.");
  }
  inspectCheckout(release, "release", problems);
  inspectDownloadAndVerification(release, "release", problems, "Revalidate the exact artifact before release");
  if (
    allRunsFor(release).some(
      (run) => /^npm run (?:build|package)(?:\s|$)/u.test(run) || run.includes("create-canonical-release-artifact")
    )
  ) {
    problems.push("release must never rebuild or repackage the tested artifact.");
  }
  const releaseJobSteps = steps(release);
  const publishTagStep = findRun(release, PUBLISH_TAG_COMMAND);
  const githubReleaseStep = findRun(release, "node scripts/publish-github-stable-release.mjs canonical-release");
  if (
    !exactKeys(publishTagStep, ["name", "env", "run"]) ||
    publishTagStep.name !== "Publish or verify the exact lightweight release tag" ||
    !exactKeys(publishTagStep.env, ["EXPECTED_SHA", "GITHUB_REPOSITORY", "GITHUB_TOKEN", "RELEASE_TAG"]) ||
    publishTagStep.env.EXPECTED_SHA !== EVENT_SHA ||
    publishTagStep.env.GITHUB_REPOSITORY !== "${{ github.repository }}" ||
    publishTagStep.env.GITHUB_TOKEN !== "${{ github.token }}" ||
    publishTagStep.env.RELEASE_TAG !== RELEASE_TAG
  ) {
    problems.push("release must publish one exact lightweight tag with the ephemeral GitHub token.");
  } else {
    inspectAdjacentCanonicalVerification(
      releaseJobSteps,
      publishTagStep,
      "canonical_release",
      "Reverify the exact canonical artifact for final publication",
      "stable release tag publication",
      problems
    );
  }
  if (
    !exactKeys(githubReleaseStep, ["name", "env", "run"]) ||
    githubReleaseStep.name !== "Publish or verify the exact GitHub stable release" ||
    !exactKeys(githubReleaseStep.env, [
      "EXPECTED_SHA",
      "GITHUB_IMMUTABLE_RELEASES_EXPECTED",
      "GITHUB_REPOSITORY",
      "GITHUB_TOKEN",
      "RELEASE_TAG"
    ]) ||
    githubReleaseStep.env.EXPECTED_SHA !== EVENT_SHA ||
    githubReleaseStep.env.GITHUB_IMMUTABLE_RELEASES_EXPECTED !== "false" ||
    githubReleaseStep.env.GITHUB_REPOSITORY !== "${{ github.repository }}" ||
    githubReleaseStep.env.GITHUB_TOKEN !== "${{ github.token }}" ||
    githubReleaseStep.env.RELEASE_TAG !== RELEASE_TAG
  ) {
    problems.push("release must idempotently publish or verify the exact GitHub stable release.");
  } else if (releaseJobSteps.indexOf(githubReleaseStep) !== releaseJobSteps.indexOf(publishTagStep) + 1) {
    problems.push("GitHub release publication must immediately follow the exact lightweight tag push.");
  }

  const openVsxPromotion = workflow.jobs["promote-open-vsx"];
  if (
    !exactKeys(openVsxPromotion, ["needs", "if", "uses", "with"]) ||
    openVsxPromotion.needs !== "release" ||
    openVsxPromotion.if !== "${{ inputs.publish == true && needs.release.result == 'success' }}" ||
    openVsxPromotion.uses !== "./.github/workflows/open-vsx-promotion.yml" ||
    !exactKeys(openVsxPromotion.with, ["release_tag"]) ||
    openVsxPromotion.with.release_tag !== RELEASE_TAG
  ) {
    problems.push("Stable release must explicitly call the protected Open VSX promotion after GitHub publication.");
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
