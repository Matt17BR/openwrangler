import { load as parseYaml } from "js-yaml";

const CHECKOUT = "actions/checkout";
const SETUP_NODE = "actions/setup-node";
const DOWNLOAD = "actions/download-artifact";
const UPLOAD = "actions/upload-artifact";
const SOURCE_SHA = "${{ needs.select.outputs.candidate-source-sha }}";
const RUN_ID = "${{ needs.select.outputs.candidate-run-id }}";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return object(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function command(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/gu, " ");
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function usesPinnedAction(step, action) {
  return (
    typeof step?.uses === "string" && step.uses.startsWith(`${action}@`) && /^[^@\s]+@[0-9a-f]{40}$/u.test(step.uses)
  );
}

function actionSteps(job, action) {
  return steps(job).filter((step) => usesPinnedAction(step, action));
}

function runSteps(job, fragment) {
  return steps(job).filter((step) => command(step?.run).includes(fragment));
}

function parse(source, problems) {
  try {
    const workflow = parseYaml(source);
    if (!object(workflow)) throw new Error("not an object");
    return workflow;
  } catch (error) {
    problems.push(`Workflow YAML must parse: ${error instanceof Error ? error.message : "unknown error"}.`);
    return undefined;
  }
}

function inspectPinnedNode(job, label, problems) {
  const setup = actionSteps(job, SETUP_NODE);
  if (
    setup.length !== 1 ||
    !exactKeys(setup[0], ["uses", "with"]) ||
    !exactKeys(setup[0].with, ["node-version-file", "cache"]) ||
    setup[0].with["node-version-file"] !== ".node-version" ||
    setup[0].with.cache !== "npm"
  ) {
    problems.push(`${label} must use the one pinned repository Node runtime with the npm cache.`);
  }
}

function inspectCheckout(job, ref, fetchDepth, label, problems) {
  const checkout = actionSteps(job, CHECKOUT);
  if (
    checkout.length !== 1 ||
    !exactKeys(
      checkout[0],
      ["name", "uses", "with"].filter((key) => key !== "name" || checkout[0].name !== undefined)
    ) ||
    !exactKeys(checkout[0].with, ["ref", "fetch-depth", "persist-credentials"]) ||
    checkout[0].with.ref !== ref ||
    checkout[0].with["fetch-depth"] !== fetchDepth ||
    checkout[0].with["persist-credentials"] !== false
  ) {
    problems.push(`${label} must check out only its exact source without persisted credentials.`);
  }
}

function inspectNoReleaseWrites(workflow, label, problems) {
  const forbidden = [
    "push-stable-release-tag.mjs",
    "publish-github-stable-release.mjs",
    "ovsx publish",
    "verify-open-vsx-github-release.mjs",
    "gh release"
  ];
  const runs = Object.values(workflow.jobs ?? {}).flatMap((job) => steps(job).map((step) => command(step?.run)));
  if (runs.some((run) => forbidden.some((fragment) => run.includes(fragment)))) {
    problems.push(`${label} must never publish a tag, release, or registry artifact.`);
  }
}

export function inspectReleaseCandidateWorkflow(source) {
  const problems = [];
  const workflow = parse(source, problems);
  if (!workflow) return problems;
  const inputs = workflow.on?.workflow_dispatch?.inputs;
  if (
    workflow.name !== "Release candidate" ||
    workflow["run-name"] !== "Release candidate ${{ inputs.release_tag }}" ||
    workflow.concurrency?.group !== "release-train-${{ inputs.release_tag }}" ||
    workflow.concurrency?.["cancel-in-progress"] !== false ||
    !exactKeys(inputs, ["release_tag"]) ||
    !exactKeys(inputs?.release_tag, ["description", "required", "type"]) ||
    inputs.release_tag.required !== true ||
    inputs.release_tag.type !== "string" ||
    !exactKeys(workflow.permissions, ["contents"]) ||
    workflow.permissions.contents !== "read"
  ) {
    problems.push("Release candidates must be one read-only manual stable-tag qualification workflow.");
  }
  if (!exactKeys(workflow.jobs, ["package", "candidate-acceptance", "remote-ssh", "qualify"])) {
    problems.push("Release candidates must have one package owner, two bounded consumers, and one manifest fan-in.");
    return problems;
  }
  const packaging = workflow.jobs.package;
  inspectCheckout(packaging, "${{ github.sha }}", 0, "Candidate packaging", problems);
  inspectPinnedNode(packaging, "Candidate packaging", problems);
  const packagingRuns = steps(packaging).map((step) => command(step?.run));
  if (
    packaging.name !== "Package the immutable candidate" ||
    packaging.environment !== undefined ||
    packaging.permissions !== undefined ||
    runSteps(
      packaging,
      "npm run clean && npm run build && npm run package:prepared -- --out openwrangler.candidate.vsix"
    ).length !== 1 ||
    runSteps(
      packaging,
      "node scripts/create-canonical-release-artifact.mjs openwrangler.candidate.vsix --out-dir canonical-release"
    ).length !== 1 ||
    runSteps(packaging, "node scripts/verify-canonical-release-artifact.mjs canonical-release").length !== 1 ||
    runSteps(packaging, "RUN_ATTEMPT").length !== 1 ||
    !packagingRuns.some((run) => run.includes('test "$RUN_ATTEMPT" = "1"'))
  ) {
    problems.push(
      "Candidate packaging must build once on first-attempt protected main and create one canonical triple."
    );
  }
  const candidateUpload = actionSteps(packaging, UPLOAD);
  if (
    candidateUpload.length !== 1 ||
    candidateUpload[0].with?.name !== "openwrangler-release-candidate" ||
    candidateUpload[0].with?.["retention-days"] !== 21 ||
    candidateUpload[0].with?.["compression-level"] !== 0 ||
    candidateUpload[0].with?.["if-no-files-found"] !== "error"
  ) {
    problems.push("Candidate packaging must retain the one uncompressed canonical triple for 21 days.");
  }
  const acceptance = workflow.jobs["candidate-acceptance"];
  if (
    acceptance.name !== "Candidate acceptance" ||
    acceptance.needs !== "package" ||
    acceptance.uses !== "./.github/workflows/candidate-acceptance.yml" ||
    !exactKeys(acceptance.with, ["artifact_id", "expected_sha", "release_tag"]) ||
    acceptance.with.artifact_id !== "${{ needs.package.outputs.artifact-id }}" ||
    acceptance.with.expected_sha !== "${{ github.sha }}" ||
    acceptance.with.release_tag !== "${{ inputs.release_tag }}"
  ) {
    problems.push("Candidate acceptance must consume the exact package without a preview channel or rebuilt bytes.");
  }
  const remote = workflow.jobs["remote-ssh"];
  inspectCheckout(remote, "${{ github.sha }}", 0, "Remote SSH", problems);
  inspectPinnedNode(remote, "Remote SSH", problems);
  const remoteDownloads = actionSteps(remote, DOWNLOAD);
  if (
    remote.name !== "Remote SSH acceptance" ||
    remote.needs !== "package" ||
    remoteDownloads.length !== 1 ||
    remoteDownloads[0].with?.["artifact-ids"] !== "${{ needs.package.outputs.artifact-id }}" ||
    runSteps(remote, "test:remote-workspace").length !== 1 ||
    runSteps(remote, "verify-canonical-release-artifact.mjs canonical-release").length !== 2
  ) {
    problems.push("Remote SSH must independently verify and exercise the exact candidate artifact.");
  }
  const qualify = workflow.jobs.qualify;
  const qualificationUpload = actionSteps(qualify, UPLOAD);
  if (
    qualify.name !== "Seal candidate qualification" ||
    qualify.if !== "${{ always() }}" ||
    JSON.stringify(qualify.needs) !== JSON.stringify(["package", "candidate-acceptance", "remote-ssh"]) ||
    runSteps(qualify, 'test "$PACKAGE_RESULT" = "success"').length !== 1 ||
    runSteps(qualify, 'test "$CANDIDATE_ACCEPTANCE_RESULT" = "success"').length !== 1 ||
    runSteps(qualify, 'test "$REMOTE_SSH_RESULT" = "success"').length !== 1 ||
    runSteps(qualify, "release-candidate.mjs create qualification/release-candidate.json").length !== 1 ||
    qualificationUpload.length !== 1 ||
    qualificationUpload[0].with?.name !== "openwrangler-release-candidate-qualification" ||
    qualificationUpload[0].with?.["retention-days"] !== 21
  ) {
    problems.push("Candidate qualification must fail closed across all owners and seal one bounded 21-day manifest.");
  }
  inspectNoReleaseWrites(workflow, "Release-candidate qualification", problems);
  return problems;
}

function inspectCrossRunDownload(step, artifactId, path, problems) {
  if (
    !usesPinnedAction(step, DOWNLOAD) ||
    !exactKeys(step.with, ["artifact-ids", "github-token", "repository", "run-id", "path", "merge-multiple"]) ||
    step.with["artifact-ids"] !== artifactId ||
    step.with["github-token"] !== "${{ github.token }}" ||
    step.with.repository !== "${{ github.repository }}" ||
    step.with["run-id"] !== RUN_ID ||
    step.with.path !== path ||
    step.with["merge-multiple"] !== true
  ) {
    problems.push(`Stable promotion must download ${path} only by the selected run and artifact IDs.`);
  }
}

export function inspectStableReleaseWorkflow(source) {
  const problems = [];
  const workflow = parse(source, problems);
  if (!workflow) return problems;
  const inputs = workflow.on?.workflow_dispatch?.inputs;
  if (
    workflow.name !== "Stable release promotion" ||
    workflow.concurrency?.group !== "release-train-${{ inputs.release_tag }}" ||
    workflow.concurrency?.["cancel-in-progress"] !== false ||
    !exactKeys(inputs, ["candidate_run_id", "release_tag"]) ||
    !["candidate_run_id", "release_tag"].every(
      (key) =>
        exactKeys(inputs?.[key], ["description", "required", "type"]) &&
        inputs[key].required === true &&
        inputs[key].type === "string"
    ) ||
    !exactKeys(workflow.permissions, ["contents"]) ||
    workflow.permissions.contents !== "read" ||
    !exactKeys(workflow.jobs, ["select", "promote"])
  ) {
    problems.push("Stable release must be a two-job candidate selection and exact-byte promotion workflow.");
    return problems;
  }
  const select = workflow.jobs.select;
  inspectCheckout(select, "${{ github.sha }}", 0, "Candidate selection", problems);
  inspectPinnedNode(select, "Candidate selection", problems);
  if (
    select.environment !== undefined ||
    !exactKeys(select.permissions, ["actions", "contents"]) ||
    select.permissions.actions !== "read" ||
    select.permissions.contents !== "read" ||
    !exactKeys(select.outputs, [
      "candidate-artifact-id",
      "candidate-run-id",
      "candidate-source-sha",
      "performance-artifact-id",
      "qualification-artifact-id"
    ]) ||
    runSteps(select, 'test "$EVENT_REF" = "refs/heads/main"').length !== 1 ||
    runSteps(select, 'test "$RUN_ATTEMPT" = "1"').length !== 1 ||
    runSteps(select, "node scripts/release-candidate.mjs select").length !== 1 ||
    runSteps(select, 'git merge-base --is-ancestor "$CANDIDATE_SOURCE_SHA" "$CURRENT_MAIN_SHA"').length !== 1
  ) {
    problems.push(
      "Candidate selection must be a read-only, first-attempt protected-main inspection with exact outputs."
    );
  }
  const selection = runSteps(select, "node scripts/release-candidate.mjs select")[0];
  if (
    !exactKeys(selection?.env, ["CANDIDATE_RUN_ID", "GITHUB_REPOSITORY", "GITHUB_TOKEN", "RELEASE_TAG"]) ||
    selection.env.CANDIDATE_RUN_ID !== "${{ inputs.candidate_run_id }}" ||
    selection.env.RELEASE_TAG !== "${{ inputs.release_tag }}"
  ) {
    problems.push("Candidate selection must bind the requested run and tag through the authenticated inspector.");
  }
  const ancestry = runSteps(select, 'git merge-base --is-ancestor "$CANDIDATE_SOURCE_SHA" "$CURRENT_MAIN_SHA"')[0];
  if (
    !exactKeys(ancestry?.env, ["CANDIDATE_SOURCE_SHA", "CURRENT_MAIN_SHA"]) ||
    ancestry.env.CANDIDATE_SOURCE_SHA !== "${{ steps.candidate.outputs.source_sha }}" ||
    ancestry.env.CURRENT_MAIN_SHA !== "${{ github.sha }}"
  ) {
    problems.push("Candidate selection must prove the historical source remains on the dispatched protected main.");
  }
  const promote = workflow.jobs.promote;
  inspectCheckout(promote, SOURCE_SHA, 0, "Stable promotion", problems);
  inspectPinnedNode(promote, "Stable promotion", problems);
  if (
    promote.needs !== "select" ||
    promote.environment !== "publishing" ||
    !exactKeys(promote.permissions, ["actions", "contents"]) ||
    promote.permissions.actions !== "read" ||
    promote.permissions.contents !== "write" ||
    promote.concurrency?.group !== "openwrangler-release-publication" ||
    promote.concurrency?.["cancel-in-progress"] !== false
  ) {
    problems.push(
      "Only exact-byte promotion may enter the serialized protected publishing environment with write access."
    );
  }
  const downloads = actionSteps(promote, DOWNLOAD);
  if (downloads.length !== 3) {
    problems.push("Stable promotion must download exactly the candidate, manifest, and performance artifacts.");
  } else {
    inspectCrossRunDownload(
      downloads[0],
      "${{ needs.select.outputs.candidate-artifact-id }}",
      "canonical-release",
      problems
    );
    inspectCrossRunDownload(
      downloads[1],
      "${{ needs.select.outputs.qualification-artifact-id }}",
      "qualification",
      problems
    );
    inspectCrossRunDownload(
      downloads[2],
      "${{ needs.select.outputs.performance-artifact-id }}",
      "performance",
      problems
    );
  }
  const promoteRuns = steps(promote).map((step) => command(step?.run));
  if (
    promoteRuns.some((run) => /(?:^|\s)npm run (?:build|package)(?::|\s|$)/u.test(run)) ||
    promoteRuns.some((run) => run.includes("create-canonical-release-artifact.mjs"))
  ) {
    problems.push("Stable promotion must never build, package, or recreate candidate bytes.");
  }
  const requiredRuns = [
    "node scripts/release-candidate.mjs verify qualification/release-candidate.json",
    "node scripts/prepare-stable-candidate-tag.mjs --verify-remote",
    "node scripts/push-stable-release-tag.mjs",
    "node scripts/publish-github-stable-release.mjs canonical-release",
    "node scripts/verify-open-vsx-github-release.mjs canonical-release --preflight",
    "ovsx publish --skip-duplicate canonical-release/openwrangler.vsix",
    "node scripts/verify-open-vsx-github-release.mjs canonical-release --verify",
    "node scripts/prepare-stable-candidate-tag.mjs --require-remote",
    "verify-public-media-surfaces.mjs"
  ];
  for (const required of requiredRuns) {
    if (promoteRuns.filter((run) => run.includes(required)).length !== 1) {
      problems.push(`Stable promotion must retain exactly one ${required} boundary.`);
    }
  }
  if (runSteps(promote, "verify-canonical-release-artifact.mjs canonical-release").length !== 3) {
    problems.push(
      "Stable promotion must reverify the same candidate before inspection, publication, and registry upload."
    );
  }
  const manifest = runSteps(promote, "release-candidate.mjs verify qualification/release-candidate.json")[0];
  if (
    !exactKeys(manifest?.env, [
      "CANDIDATE_ARTIFACT_ID",
      "CANDIDATE_BYTES",
      "CANDIDATE_RUN_ID",
      "CANDIDATE_SHA256",
      "CANDIDATE_SOURCE_SHA",
      "GITHUB_REPOSITORY",
      "PERFORMANCE_ARTIFACT_ID",
      "PERFORMANCE_REPORT",
      "RELEASE_TAG"
    ]) ||
    manifest.env.CANDIDATE_SOURCE_SHA !== SOURCE_SHA ||
    manifest.env.PERFORMANCE_REPORT !== "performance/release-candidate-performance.json"
  ) {
    problems.push(
      "Stable promotion must bind candidate bytes, source, run, manifest, and performance report together."
    );
  }
  for (const step of steps(promote).filter((entry) => entry?.env?.EXPECTED_SHA !== undefined)) {
    if (step.env.EXPECTED_SHA !== SOURCE_SHA) {
      problems.push("Every promotion verifier must use the historical candidate source, never the dispatch source.");
      break;
    }
  }
  return problems;
}
