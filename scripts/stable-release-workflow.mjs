import { load as parseYaml } from "js-yaml";
import { inspectCandidateCaller } from "./candidate-acceptance-workflow.mjs";
import {
  inspectAllowedWorkflowActions,
  inspectPinnedExternalActions,
  usesPinnedAction
} from "./workflow-action-pins.mjs";

const CHECKOUT = "actions/checkout";
const SETUP_NODE = "actions/setup-node";
const SETUP_PYTHON = "actions/setup-python";
const DOWNLOAD = "actions/download-artifact";
const UPLOAD = "actions/upload-artifact";
const CANDIDATE_WORKFLOW = "./.github/workflows/candidate-acceptance.yml";
const OPEN_VSX_WORKFLOW = "./.github/workflows/open-vsx-promotion.yml";
const RELEASE_CANDIDATE_ACTIONS = Object.freeze({
  package: Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE, SETUP_PYTHON, UPLOAD]) }),
  "candidate-acceptance": Object.freeze({ job: Object.freeze([CANDIDATE_WORKFLOW]) }),
  "remote-ssh": Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE, DOWNLOAD]) }),
  qualify: Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE, DOWNLOAD, UPLOAD]) })
});
const STABLE_RELEASE_ACTIONS = Object.freeze({
  select: Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE]) }),
  publish: Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE, DOWNLOAD]) }),
  "open-vsx": Object.freeze({ job: Object.freeze([OPEN_VSX_WORKFLOW]) })
});

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return object(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parse(source, label, limit, problems) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > limit) {
    problems.push(`${label} must be a bounded workflow file.`);
    return undefined;
  }
  try {
    const workflow = parseYaml(source);
    if (!object(workflow)) throw new Error("top level is not an object");
    return workflow;
  } catch (error) {
    problems.push(`${label} YAML does not parse: ${error instanceof Error ? error.message : "unknown error"}.`);
    return undefined;
  }
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function commands(job) {
  return steps(job)
    .map((step) => (typeof step?.run === "string" ? step.run.replace(/\s+/gu, " ").trim() : ""))
    .filter(Boolean);
}

function hasCommand(job, text) {
  return commands(job).some((run) => run.includes(text));
}

function actionSteps(job, name) {
  return steps(job).filter((step) => usesPinnedAction(step, name));
}

function exactCrossRunDownload(step, artifact, path) {
  return (
    step?.with?.["artifact-ids"] === artifact &&
    step?.with?.["github-token"] === "${{ github.token }}" &&
    step?.with?.repository === "${{ github.repository }}" &&
    step?.with?.["run-id"] === "${{ needs.select.outputs.candidate-run-id }}" &&
    step?.with?.path === path &&
    step?.with?.["merge-multiple"] === true
  );
}

export function inspectReleaseCandidateWorkflow(source) {
  const problems = [];
  const workflow = parse(source, "Release candidate", 32 * 1024, problems);
  if (!workflow) return problems;
  if (
    workflow.name !== "Release candidate" ||
    workflow["run-name"] !== "Release candidate ${{ inputs.release_tag }}" ||
    workflow.permissions?.contents !== "read" ||
    !exactKeys(workflow.concurrency, ["group", "cancel-in-progress", "queue"]) ||
    workflow.concurrency?.group !== "release-candidate-${{ inputs.release_tag }}" ||
    workflow.concurrency?.["cancel-in-progress"] !== false ||
    workflow.concurrency?.queue !== "max" ||
    JSON.stringify(Object.keys(workflow.jobs ?? {})) !==
      JSON.stringify(["package", "candidate-acceptance", "remote-ssh", "qualify"])
  ) {
    problems.push(
      "Release candidate must be one read-only manual build with acceptance, Remote SSH, and qualification."
    );
    return problems;
  }
  problems.push(...inspectPinnedExternalActions(workflow));
  problems.push(...inspectAllowedWorkflowActions(workflow, RELEASE_CANDIDATE_ACTIONS));
  problems.push(...inspectCandidateCaller(workflow));

  const packaging = workflow.jobs.package;
  const packageUploads = actionSteps(packaging, "actions/upload-artifact");
  const packageText = commands(packaging).join("\n");
  if (
    packaging.name !== "Build the candidate once" ||
    !packageText.includes('test "$EVENT_REF" = "refs/heads/main"') ||
    /RUN_ATTEMPT|first-attempt|first attempt/u.test(packageText) ||
    (packageText.match(/package:prepared/gu) ?? []).length !== 1 ||
    (packageText.match(/create-canonical-release-artifact/gu) ?? []).length !== 1 ||
    packageUploads.length !== 1 ||
    packageUploads[0]?.with?.name !== "openwrangler-release-candidate-${{ github.run_attempt }}" ||
    packageUploads[0]?.with?.["retention-days"] !== 30 ||
    packageUploads[0]?.with?.["compression-level"] !== 0
  ) {
    problems.push("Candidate packaging must build once, allow reruns, and upload one attempt-bound canonical triple.");
  }

  const remote = workflow.jobs["remote-ssh"];
  const remoteDownload = actionSteps(remote, "actions/download-artifact");
  if (
    remote?.needs !== "package" ||
    remoteDownload.length !== 1 ||
    remoteDownload[0]?.with?.["artifact-ids"] !== "${{ needs.package.outputs.artifact-id }}" ||
    !hasCommand(remote, "verify-canonical-release-artifact.mjs canonical-release") ||
    !hasCommand(remote, "node scripts/run-remote-workspace-smoke.mjs")
  ) {
    problems.push("Remote SSH must verify and exercise the exact package in its own job.");
  }

  const qualify = workflow.jobs.qualify;
  const qualificationUpload = actionSteps(qualify, "actions/upload-artifact");
  if (
    qualify?.if !== "${{ always() }}" ||
    JSON.stringify(qualify?.needs) !== JSON.stringify(["package", "candidate-acceptance", "remote-ssh"]) ||
    !hasCommand(qualify, "release-candidate.mjs create qualification/release-candidate.json") ||
    qualificationUpload.length !== 1 ||
    qualificationUpload[0]?.with?.name !== "openwrangler-release-candidate-qualification-${{ github.run_attempt }}" ||
    qualificationUpload[0]?.with?.["retention-days"] !== 30
  ) {
    problems.push("Qualification must require every owner and record one attempt-bound receipt.");
  }

  const allRuns = Object.values(workflow.jobs).flatMap(commands).join("\n");
  if (/ovsx publish|vsce publish|publish-github|push-stable-release-tag|gh release/u.test(allRuns)) {
    problems.push("Release-candidate qualification must never publish.");
  }
  return problems;
}

export function inspectStableReleaseWorkflow(source) {
  const problems = [];
  const workflow = parse(source, "Stable release", 24 * 1024, problems);
  if (!workflow) return problems;
  if (
    workflow.name !== "Stable release" ||
    workflow.permissions?.contents !== "read" ||
    !exactKeys(workflow.concurrency, ["group", "cancel-in-progress", "queue"]) ||
    workflow.concurrency?.group !== "release-train-${{ inputs.release_tag }}" ||
    workflow.concurrency?.["cancel-in-progress"] !== false ||
    workflow.concurrency?.queue !== "max" ||
    JSON.stringify(Object.keys(workflow.jobs ?? {})) !== JSON.stringify(["select", "publish", "open-vsx"])
  ) {
    problems.push("Stable release must select one qualified run and publish its exact bytes.");
    return problems;
  }
  problems.push(...inspectPinnedExternalActions(workflow));
  problems.push(...inspectAllowedWorkflowActions(workflow, STABLE_RELEASE_ACTIONS));

  const select = workflow.jobs.select;
  const selectText = commands(select).join("\n");
  if (
    select?.permissions?.actions !== "read" ||
    select?.permissions?.contents !== "read" ||
    !hasCommand(select, "release-candidate.mjs select") ||
    !hasCommand(select, 'test "$CANDIDATE_SOURCE_SHA" = "$CURRENT_MAIN_SHA"') ||
    hasCommand(select, "git merge-base --is-ancestor") ||
    select?.outputs?.["candidate-run-attempt"] !== "${{ steps.candidate.outputs.candidate_run_attempt }}" ||
    /RUN_ATTEMPT|soak|first-attempt|first attempt/u.test(selectText)
  ) {
    problems.push("Candidate selection must allow reruns and require the chosen source to equal current main.");
  }

  const publish = workflow.jobs.publish;
  if (
    publish?.needs !== "select" ||
    publish?.environment !== "publishing" ||
    publish?.permissions?.actions !== "read" ||
    publish?.permissions?.contents !== "write" ||
    !exactKeys(publish?.concurrency, ["group", "cancel-in-progress", "queue"]) ||
    publish?.concurrency?.group !== "openwrangler-release-publication" ||
    publish?.concurrency?.["cancel-in-progress"] !== false ||
    publish?.concurrency?.queue !== "max"
  ) {
    problems.push("GitHub publication must be one protected, serialized, retryable job with minimal write access.");
    return problems;
  }

  const downloads = actionSteps(publish, "actions/download-artifact");
  if (
    downloads.length !== 3 ||
    !exactCrossRunDownload(downloads[0], "${{ needs.select.outputs.candidate-artifact-id }}", "canonical-release") ||
    !exactCrossRunDownload(downloads[1], "${{ needs.select.outputs.qualification-artifact-id }}", "qualification") ||
    !exactCrossRunDownload(downloads[2], "${{ needs.select.outputs.performance-artifact-id }}", "performance")
  ) {
    problems.push("Publication must download candidate, qualification, and performance only by selected IDs.");
  }

  const publishText = commands(publish).join("\n");
  const verifyManifest = steps(publish).find((step) =>
    String(step?.run ?? "").includes("release-candidate.mjs verify")
  );
  if (
    verifyManifest?.env?.CANDIDATE_RUN_ATTEMPT !== "${{ needs.select.outputs.candidate-run-attempt }}" ||
    !hasCommand(publish, "verify-canonical-release-artifact.mjs canonical-release") ||
    !hasCommand(publish, "push-stable-release-tag.mjs") ||
    !hasCommand(publish, "publish-github-stable-release.mjs canonical-release") ||
    /ovsx publish|verify-open-vsx|vsce publish|npm run build|npm run package/u.test(publishText)
  ) {
    problems.push(
      "Stable publication must verify and publish the selected GitHub bytes without rebuilds or registry work."
    );
  }
  const openVsx = workflow.jobs["open-vsx"];
  if (
    openVsx?.needs !== "publish" ||
    openVsx?.uses !== "./.github/workflows/open-vsx-promotion.yml" ||
    openVsx?.permissions?.contents !== "read" ||
    openVsx?.with?.release_tag !== "${{ inputs.release_tag }}" ||
    openVsx?.secrets !== undefined
  ) {
    problems.push("Stable release must hand the public GitHub release to the one reusable Open VSX publisher.");
  }
  return problems;
}
