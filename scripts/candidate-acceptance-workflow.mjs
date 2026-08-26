import { load as parseYaml } from "js-yaml";
import {
  inspectAllowedWorkflowActions,
  inspectPinnedExternalActions,
  usesPinnedAction
} from "./workflow-action-pins.mjs";

const LOCAL_CALL = "./.github/workflows/candidate-acceptance.yml";
const VERIFY = "node scripts/verify-canonical-release-artifact.mjs canonical-release";
const EXPECTED_JOBS = ["linux", "platform", "r-local", "r-platform", "performance"];
const CHECKOUT = "actions/checkout";
const SETUP_NODE = "actions/setup-node";
const SETUP_PYTHON = "actions/setup-python";
const SETUP_JAVA = "actions/setup-java";
const DOWNLOAD = "actions/download-artifact";
const UPLOAD = "actions/upload-artifact";
const SETUP_R = "r-lib/actions/setup-r";
const SETUP_R_DEPENDENCIES = "r-lib/actions/setup-r-dependencies";
const ALLOWED_ACTIONS = Object.freeze({
  linux: Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE, SETUP_PYTHON, SETUP_JAVA, DOWNLOAD, UPLOAD]) }),
  platform: Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE, SETUP_PYTHON, DOWNLOAD, UPLOAD]) }),
  "r-local": Object.freeze({
    steps: Object.freeze([CHECKOUT, SETUP_NODE, SETUP_PYTHON, SETUP_R, SETUP_R_DEPENDENCIES, DOWNLOAD, UPLOAD])
  }),
  "r-platform": Object.freeze({
    steps: Object.freeze([CHECKOUT, SETUP_NODE, SETUP_PYTHON, SETUP_R, DOWNLOAD, UPLOAD])
  }),
  performance: Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE, SETUP_PYTHON, DOWNLOAD, UPLOAD]) })
});

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function commands(job) {
  return steps(job)
    .map((step) => (typeof step?.run === "string" ? step.run.replace(/\s+/gu, " ").trim() : ""))
    .filter(Boolean);
}

function actionSteps(job, name) {
  return steps(job).filter((step) => usesPinnedAction(step, name));
}

function findId(job, id) {
  return steps(job).find((step) => step?.id === id);
}

function hasCommand(job, text) {
  return commands(job).some((command) => command.includes(text));
}

function exactVerifiedConsumer(job, id) {
  const allSteps = steps(job);
  const index = allSteps.findIndex((step) => step?.id === id);
  const consumer = allSteps[index];
  const verifier = allSteps[index - 1];
  if (index < 1 || typeof verifier?.run !== "string" || !verifier.run.includes(VERIFY)) return false;
  if (!String(consumer?.if ?? "").includes("always()")) return true;
  return typeof verifier.id === "string" && String(consumer.if).includes(`steps.${verifier.id}.outcome == 'success'`);
}

function inspectCandidateConsumer(jobName, job, problems) {
  const checkout = actionSteps(job, "actions/checkout");
  const download = actionSteps(job, "actions/download-artifact");
  if (
    checkout.length !== 1 ||
    checkout[0]?.with?.ref !== "${{ inputs.expected_sha }}" ||
    checkout[0]?.with?.["persist-credentials"] !== false
  ) {
    problems.push(`${jobName} must check out the caller's exact source without credentials.`);
  }
  if (
    download.length !== 1 ||
    download[0]?.with?.["artifact-ids"] !== "${{ inputs.artifact_id }}" ||
    download[0]?.with?.path !== "canonical-release" ||
    download[0]?.with?.["merge-multiple"] !== true
  ) {
    problems.push(`${jobName} must download the caller's exact candidate artifact.`);
  }
  if (!hasCommand(job, VERIFY)) {
    problems.push(`${jobName} must verify the candidate checksum and provenance before use.`);
  }
  if (commands(job).some((run) => /package:prepared|create-canonical-release-artifact|npm run package\b/u.test(run))) {
    problems.push(`${jobName} must consume the candidate rather than rebuild it.`);
  }
}

function inspectFailureUploads(workflow, problems) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const upload of actionSteps(job, "actions/upload-artifact")) {
      if (upload?.id === "performance_artifact") continue;
      const condition = String(upload?.if ?? "");
      if (
        !condition.includes("outcome == 'failure'") ||
        !condition.includes("evidence_ready == 'true'") ||
        upload?.with?.["retention-days"] !== 7 ||
        upload?.with?.["if-no-files-found"] !== "error"
      ) {
        problems.push(`${jobName} may upload editor details only after a failed phase produced sanitized evidence.`);
      }
    }
  }
}

export function inspectCandidateAcceptanceWorkflow(source) {
  const problems = [];
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 48 * 1024) {
    return ["Candidate acceptance must be a bounded workflow file."];
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch (error) {
    return [`Candidate acceptance YAML does not parse: ${error instanceof Error ? error.message : "unknown error"}.`];
  }
  if (!object(workflow) || workflow.name !== "Candidate acceptance") {
    return ["Candidate acceptance must be one named reusable workflow."];
  }
  const call = workflow.on?.workflow_call;
  if (
    !object(call) ||
    JSON.stringify(Object.keys(call.inputs ?? {}).sort()) !==
      JSON.stringify(["artifact_id", "expected_sha", "release_tag"]) ||
    !Object.values(call.inputs).every((input) => input?.required === true && input?.type === "string") ||
    workflow.permissions?.contents !== "read"
  ) {
    problems.push(
      "Candidate acceptance needs only the artifact ID, source SHA, and release tag with read-only access."
    );
  }
  if (JSON.stringify(Object.keys(workflow.jobs ?? {})) !== JSON.stringify(EXPECTED_JOBS)) {
    problems.push("Candidate acceptance must keep five clear job definitions and seven expanded test jobs.");
    return problems;
  }
  problems.push(...inspectPinnedExternalActions(workflow));
  problems.push(...inspectAllowedWorkflowActions(workflow, ALLOWED_ACTIONS));
  for (const [name, job] of Object.entries(workflow.jobs)) inspectCandidateConsumer(name, job, problems);
  inspectFailureUploads(workflow, problems);

  const linux = workflow.jobs.linux;
  const linuxRunner = findId(linux, "packaged_linux");
  const jupyterRunner = findId(linux, "packaged_jupyter");
  if (
    linux?.["runs-on"] !== "ubuntu-24.04" ||
    linux?.["timeout-minutes"] !== 120 ||
    linuxRunner?.env?.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode" ||
    linuxRunner?.env?.OPEN_WRANGLER_PACKAGED_MODE !== undefined ||
    jupyterRunner?.env?.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode" ||
    jupyterRunner?.env?.OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE !== "candidate-one-owner" ||
    jupyterRunner?.env?.OPEN_WRANGLER_REAL_JUPYTER_EXTENSION !== "1" ||
    jupyterRunner?.env?.OPEN_WRANGLER_REAL_REMOTE_JUPYTER !== "1" ||
    !exactVerifiedConsumer(linux, "packaged_linux") ||
    !exactVerifiedConsumer(linux, "packaged_jupyter")
  ) {
    problems.push("Linux must own one full installed run and the released Python/Jupyter first-use journey.");
  }

  const platform = workflow.jobs.platform;
  const platformRows = platform?.strategy?.matrix?.include;
  const platformRunner = findId(platform, "packaged_platform");
  if (
    JSON.stringify(platformRows?.map((row) => row.os)) !== JSON.stringify(["macos-latest", "windows-latest"]) ||
    platformRunner?.env?.OPEN_WRANGLER_PACKAGED_MODE !== "platform-smoke" ||
    platformRunner?.env?.OPEN_WRANGLER_PACKAGED_EDITORS !== "vscode" ||
    !exactVerifiedConsumer(platform, "packaged_platform")
  ) {
    problems.push("macOS and Windows must each install the exact VSIX in one focused smoke job.");
  }

  const localR = workflow.jobs["r-local"];
  const localJourneys = ["r_core", "r_frames", "r_restart"].map(
    (id) => findId(localR, id)?.env?.OPEN_WRANGLER_PACKAGED_R_JOURNEY
  );
  if (
    localR?.["runs-on"] !== "ubuntu-24.04" ||
    actionSteps(localR, "r-lib/actions/setup-r")[0]?.with?.["r-version"] !== "4.4.3" ||
    JSON.stringify(localJourneys) !== JSON.stringify(["core-operations", "native-frames", "kernel-restart"]) ||
    !["r_core", "r_frames", "r_restart"].every((id) => exactVerifiedConsumer(localR, id))
  ) {
    problems.push("Linux must own native R lifecycle, frame, and restart depth against R 4.4.");
  }

  const platformR = workflow.jobs["r-platform"];
  const rRows = platformR?.strategy?.matrix?.include;
  const rSmoke = findId(platformR, "r_smoke");
  if (
    JSON.stringify(rRows?.map((row) => [row.os, row.r])) !==
      JSON.stringify([
        ["macos-latest", "4.5.2"],
        ["windows-latest", "4.5.2"]
      ]) ||
    rSmoke?.env?.OPEN_WRANGLER_PACKAGED_R_JOURNEY !== "core-operations" ||
    !exactVerifiedConsumer(platformR, "r_smoke")
  ) {
    problems.push("macOS and Windows must each retain one installed native R 4.5 smoke.");
  }

  const performance = workflow.jobs.performance;
  const performanceArtifact = findId(performance, "performance_artifact");
  if (
    !hasCommand(performance, "npm run benchmark:installed") ||
    !exactVerifiedConsumer(performance, "installed_performance") ||
    performanceArtifact?.with?.name !== "openwrangler-release-candidate-performance-${{ github.run_attempt }}" ||
    performanceArtifact?.with?.["retention-days"] !== 90 ||
    performance?.outputs?.["artifact-id"] !== "${{ steps.performance_artifact.outputs.artifact-id }}"
  ) {
    problems.push("Installed performance must produce the one report consumed by stable promotion.");
  }

  const allRuns = Object.values(workflow.jobs).flatMap(commands).join("\n");
  if (/ovsx publish|vsce publish|publish-github|push-stable-release-tag|gh release/u.test(allRuns)) {
    problems.push("Candidate acceptance must never publish a release.");
  }
  return problems;
}

export function inspectCandidateCaller(workflow, historicalChannel) {
  const problems = [];
  const job = workflow?.jobs?.["candidate-acceptance"];
  const expectedInputs = ["artifact_id", "expected_sha", "release_tag"];
  if (historicalChannel !== undefined) expectedInputs.push("channel");
  if (
    !object(job) ||
    job.name !== (historicalChannel === undefined ? "Installed acceptance" : "Candidate acceptance") ||
    job.uses !== LOCAL_CALL ||
    job.needs !== "package" ||
    job.permissions?.contents !== "read" ||
    job.strategy !== undefined ||
    job.outputs !== undefined ||
    JSON.stringify(Object.keys(job.with ?? {}).sort()) !== JSON.stringify(expectedInputs.sort()) ||
    job.with.artifact_id !== "${{ needs.package.outputs.artifact-id }}" ||
    job.with.expected_sha !== "${{ github.sha }}" ||
    job.with.release_tag !== "${{ inputs.release_tag }}" ||
    (historicalChannel !== undefined && job.with.channel !== historicalChannel)
  ) {
    problems.push("The release candidate must call installed acceptance once with the exact package, source, and tag.");
  }
  return problems;
}
