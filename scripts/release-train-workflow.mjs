import { load as parseYaml } from "js-yaml";
import { inspectCandidateCaller } from "./candidate-acceptance-workflow.mjs";
import {
  OPEN_VSX_PUBLISH_RUN,
  OPEN_VSX_VERIFY_PAT_RUN,
  PUBLIC_MEDIA_CONTRACT_RUN
} from "./open-vsx-promotion-workflow.mjs";

const MAX_WORKFLOW_BYTES = 1024 * 1024;
const EVENT_SHA = "${{ github.sha }}";
const RELEASE_TAG = "${{ inputs.release_tag }}";
const CHECKOUT = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const CANDIDATE_IF = "${{ inputs.publish == false && needs.package.result == 'success' }}";
const PROTECTED_MAIN_GUARD = commandText(`test "$EVENT_REF_TYPE" = "branch"
test "$EVENT_REF" = "refs/heads/main"
case "$EXPECTED_SHA" in *[!0-9a-f]*|"") exit 1 ;; esac
test "\${#EXPECTED_SHA}" -eq 40`);
const PROMOTION_IF =
  "${{ always() && !cancelled() && inputs.publish == true && needs.package.result == 'skipped' && needs.candidate-acceptance.result == 'skipped' && needs.remote-ssh.result == 'skipped' }}";
const JOBS = Object.freeze(["package", "candidate-acceptance", "remote-ssh", "release"]);
const CANONICAL_PATHS = Object.freeze([
  "canonical-release/openwrangler.vsix",
  "canonical-release/openwrangler.vsix.sha256",
  "canonical-release/openwrangler.vsix.provenance.json"
]);
const CHANNELS = Object.freeze({
  preview: Object.freeze({
    artifactName: "openwrangler-preview-release",
    authorMarker: "--preview-release",
    githubPublisher: "node scripts/publish-github-preview-release.mjs canonical-release",
    metadataCommand: "node scripts/release-metadata.mjs --preview-only",
    name: "Preview release",
    tagPublisher: "node scripts/push-release-tag.mjs",
    verifier: "node scripts/verify-preview-release-artifact.mjs canonical-release"
  }),
  stable: Object.freeze({
    artifactName: "openwrangler-stable-release",
    authorMarker: "--out-dir canonical-release",
    githubPublisher: "node scripts/publish-github-stable-release.mjs canonical-release",
    metadataCommand: "node scripts/release-metadata.mjs",
    name: "Stable release",
    tagPublisher: "node scripts/push-stable-release-tag.mjs",
    verifier: "node scripts/verify-canonical-release-artifact.mjs canonical-release"
  })
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function command(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function commandText(value) {
  return value.trim().replace(/\s+/gu, " ");
}

function runs(job) {
  return steps(job)
    .map((step) => command(step?.run))
    .filter(Boolean);
}

function oneStep(job, predicate) {
  const matches = steps(job).filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function before(job, left, right) {
  return left !== undefined && right !== undefined && steps(job).indexOf(left) < steps(job).indexOf(right);
}

function inspectInputs(workflow, problems) {
  const inputs = workflow?.on?.workflow_dispatch?.inputs;
  if (
    !exactKeys(inputs, ["candidate_run_id", "publish", "release_tag"]) ||
    !exactKeys(inputs?.release_tag, ["description", "required", "type"]) ||
    inputs.release_tag.required !== true ||
    inputs.release_tag.type !== "string" ||
    !exactKeys(inputs?.publish, ["description", "required", "default", "type"]) ||
    inputs.publish.required !== true ||
    inputs.publish.default !== false ||
    inputs.publish.type !== "boolean" ||
    !exactKeys(inputs?.candidate_run_id, ["description", "required", "default", "type"]) ||
    inputs.candidate_run_id.required !== false ||
    inputs.candidate_run_id.default !== "" ||
    inputs.candidate_run_id.type !== "string"
  ) {
    problems.push("Release inputs must separate candidate creation from explicit run-ID promotion.");
  }
}

function inspectActions(workflow, problems) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of steps(job)) {
      if (typeof step?.uses !== "string" || step.uses.startsWith("./")) continue;
      if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(step.uses)) {
        problems.push(`${jobName} action ${step.uses} must be pinned to one full commit.`);
      }
    }
  }
}

function inspectCheckout(job, label, problems) {
  const checkout = oneStep(job, (step) => step?.uses === CHECKOUT);
  if (
    checkout === undefined ||
    !exactKeys(checkout, ["uses", "with"]) ||
    !exactKeys(checkout.with, ["ref", "fetch-depth", "persist-credentials"]) ||
    checkout.with.ref !== EVENT_SHA ||
    checkout.with["fetch-depth"] !== 0 ||
    checkout.with["persist-credentials"] !== false
  ) {
    problems.push(`${label} must check out only the exact event commit without persisted credentials.`);
  }
}

function inspectNodeRuntime(job, label, problems) {
  const setupNode = oneStep(job, (step) => step?.uses === SETUP_NODE);
  if (
    setupNode === undefined ||
    !exactKeys(setupNode, ["uses", "with"]) ||
    !exactKeys(setupNode.with, ["cache", "node-version-file"]) ||
    setupNode.with["node-version-file"] !== ".node-version" ||
    setupNode.with.cache !== "npm"
  ) {
    problems.push(`${label} must provision the exact Node runtime from .node-version with the npm cache.`);
  }
}

function inspectPackage(workflow, channel, contract, problems) {
  const job = workflow.jobs.package;
  if (
    job?.if !== "${{ inputs.publish == false }}" ||
    job?.["runs-on"] !== "ubuntu-24.04" ||
    job?.environment !== undefined ||
    job?.permissions !== undefined ||
    job?.outputs?.["artifact-id"] !== "${{ steps.canonical_artifact.outputs.artifact-id }}"
  ) {
    problems.push("package must be the read-only candidate-only producer of one artifact ID.");
  }
  inspectCheckout(job, "package", problems);
  inspectNodeRuntime(job, "package", problems);
  const packageStep = oneStep(job, (step) =>
    command(step?.run).includes("package:prepared -- --out openwrangler.candidate.vsix")
  );
  const fullVerifier = oneStep(
    job,
    (step) => command(step?.run) === "npm run verify:vsix -- openwrangler.candidate.vsix"
  );
  const metadata = oneStep(job, (step) => step?.id === "release_metadata");
  const sourceGuard = oneStep(job, (step) => command(step?.run).includes('test "$EVENT_REF" = "refs/heads/main"'));
  const cleanGuard = oneStep(job, (step) => command(step?.run).includes("git status --porcelain --untracked-files=no"));
  const mediaPreflight = oneStep(job, (step) => command(step?.run).includes("--prepublish"));
  const author = oneStep(job, (step) => command(step?.run).includes("create-canonical-release-artifact.mjs"));
  const canonical = oneStep(job, (step) => step?.id === "canonical");
  const upload = oneStep(job, (step) => step?.id === "canonical_artifact" && step?.uses === UPLOAD);
  const uploadPaths = typeof upload?.with?.path === "string" ? upload.with.path.trim().split("\n") : [];
  if (
    metadata === undefined ||
    command(metadata.run) !== contract.metadataCommand ||
    metadata?.env?.RELEASE_TAG !== RELEASE_TAG ||
    sourceGuard === undefined ||
    command(sourceGuard.run) !== PROTECTED_MAIN_GUARD ||
    cleanGuard === undefined ||
    !command(cleanGuard.run).startsWith("test ") ||
    packageStep === undefined ||
    fullVerifier === undefined ||
    mediaPreflight === undefined ||
    author === undefined ||
    !command(author.run).includes(contract.authorMarker) ||
    canonical === undefined ||
    command(canonical.run) !== contract.verifier ||
    upload === undefined ||
    upload.with.name !== contract.artifactName ||
    JSON.stringify(uploadPaths) !== JSON.stringify(CANONICAL_PATHS) ||
    upload.with["retention-days"] !== 90 ||
    upload.with["compression-level"] !== 0 ||
    upload.with["if-no-files-found"] !== "error" ||
    !before(job, sourceGuard, metadata) ||
    !before(job, cleanGuard, packageStep) ||
    !before(job, metadata, mediaPreflight) ||
    !before(job, mediaPreflight, packageStep) ||
    !before(job, packageStep, fullVerifier) ||
    !before(job, fullVerifier, author) ||
    !before(job, author, canonical) ||
    !before(job, canonical, upload)
  ) {
    problems.push(`${channel} package must bind protected main and author, verify, and upload one canonical triple.`);
  }
  if (
    runs(job).filter((run) => run.includes("package:prepared")).length !== 1 ||
    runs(job).some((run) => /^npm (?:test|run test:|run benchmark:)/u.test(run))
  ) {
    problems.push("package must package once without rerunning source or acceptance suites.");
  }
}

function inspectRemote(workflow, contract, problems) {
  const job = workflow.jobs["remote-ssh"];
  if (
    job?.needs !== "package" ||
    job?.if !== CANDIDATE_IF ||
    job?.environment !== undefined ||
    job?.permissions !== undefined ||
    job?.concurrency !== undefined
  ) {
    problems.push("remote-ssh must be a candidate-only sibling that depends only on package.");
  }
  inspectCheckout(job, "remote-ssh", problems);
  inspectNodeRuntime(job, "remote-ssh", problems);
  const download = oneStep(job, (step) => step?.uses === DOWNLOAD);
  const verifier = oneStep(job, (step) => step?.id === "canonical");
  const reverify = oneStep(job, (step) => step?.id === "canonical_remote");
  const runner = oneStep(job, (step) => step?.id === "remote_workspace");
  if (
    download?.with?.["artifact-ids"] !== "${{ needs.package.outputs.artifact-id }}" ||
    download?.with?.path !== "canonical-release" ||
    command(verifier?.run) !== contract.verifier ||
    command(reverify?.run) !== contract.verifier ||
    !command(runner?.run).includes("npm run test:remote-workspace --") ||
    !before(job, download, verifier) ||
    !before(job, verifier, reverify) ||
    !before(job, reverify, runner) ||
    runs(job).some((run) => /package:prepared|create-canonical-release-artifact|npm run verify:vsix/u.test(run))
  ) {
    problems.push("remote-ssh must consume and reverify the package artifact without rebuilding it.");
  }
}

function inspectPromotion(workflow, contract, problems) {
  const job = workflow.jobs.release;
  if (
    JSON.stringify(job?.needs) !== JSON.stringify(["package", "candidate-acceptance", "remote-ssh"]) ||
    job?.if !== PROMOTION_IF ||
    job?.environment !== "publishing" ||
    job?.["runs-on"] !== "ubuntu-24.04" ||
    job?.["timeout-minutes"] !== 105 ||
    !exactKeys(job?.permissions, ["actions", "contents"]) ||
    job.permissions.actions !== "read" ||
    job.permissions.contents !== "write" ||
    job?.concurrency?.group !== "openwrangler-release-publication" ||
    job?.concurrency?.["cancel-in-progress"] !== false ||
    job?.concurrency?.queue !== "max"
  ) {
    problems.push(
      "release must be the sole protected promotion job and run only after candidate-mode jobs are skipped."
    );
  }
  inspectCheckout(job, "release", problems);
  inspectNodeRuntime(job, "release", problems);
  const candidate = oneStep(job, (step) => step?.id === "candidate_source");
  const download = oneStep(job, (step) => step?.uses === DOWNLOAD);
  const canonical = oneStep(job, (step) => step?.id === "canonical");
  const finalCanonical = oneStep(job, (step) => step?.id === "canonical_release");
  const tag = oneStep(job, (step) => command(step?.run) === contract.tagPublisher);
  const localTag = oneStep(job, (step) => command(step?.run) === "node scripts/prepare-stable-candidate-tag.mjs");
  const github = oneStep(job, (step) => command(step?.run) === contract.githubPublisher);
  const token = oneStep(job, (step) => command(step?.run).includes("ovsx verify-pat Matt17BR"));
  const openVsxArtifact = oneStep(
    job,
    (step) => step?.name?.startsWith("Reverify the ") && step.name.includes("before Open VSX publication")
  );
  const openVsx = oneStep(job, (step) => command(step?.run).includes("ovsx publish --skip-duplicate"));
  const publicVerifier = oneStep(
    job,
    (step) =>
      command(step?.run).includes("verify-open-vsx-github-release.mjs") && command(step?.run).includes("--verify")
  );
  const media = oneStep(job, (step) => command(step?.run).includes("--wait-for-propagation"));
  const mediaContract = oneStep(job, (step) => step?.id === "public_media_contract");
  const mediaCondition = "${{ steps.public_media_contract.outputs.required == 'true' }}";
  if (
    command(candidate?.run) !== "node scripts/release-candidate-source.mjs" ||
    !exactKeys(candidate?.env, [
      "CANDIDATE_RUN_ID",
      "EXPECTED_AUTOMATION_SHA",
      "GITHUB_TOKEN",
      "RELEASE_CHANNEL",
      "RELEASE_TAG"
    ]) ||
    candidate?.env?.CANDIDATE_RUN_ID !== "${{ inputs.candidate_run_id }}" ||
    candidate?.env?.EXPECTED_AUTOMATION_SHA !== EVENT_SHA ||
    candidate?.env?.GITHUB_TOKEN !== "${{ github.token }}" ||
    candidate?.env?.RELEASE_CHANNEL !== (contract === CHANNELS.preview ? "preview" : "stable") ||
    candidate?.env?.RELEASE_TAG !== RELEASE_TAG ||
    download?.with?.["artifact-ids"] !== "${{ steps.candidate_source.outputs.artifact_id }}" ||
    download?.with?.["run-id"] !== "${{ steps.candidate_source.outputs.candidate_run_id }}" ||
    download?.with?.["github-token"] !== "${{ github.token }}" ||
    download?.with?.repository !== "${{ github.repository }}" ||
    command(canonical?.run) !== contract.verifier ||
    command(finalCanonical?.run) !== contract.verifier ||
    tag === undefined ||
    !exactKeys(tag?.env, ["EXPECTED_SHA", "GITHUB_REPOSITORY", "GITHUB_TOKEN", "RELEASE_TAG"]) ||
    tag.env.EXPECTED_SHA !== EVENT_SHA ||
    tag.env.GITHUB_REPOSITORY !== "${{ github.repository }}" ||
    tag.env.GITHUB_TOKEN !== "${{ github.token }}" ||
    tag.env.RELEASE_TAG !== RELEASE_TAG ||
    localTag === undefined ||
    github === undefined ||
    !exactKeys(github?.env, [
      "EXPECTED_SHA",
      "GITHUB_IMMUTABLE_RELEASES_EXPECTED",
      "GITHUB_REPOSITORY",
      "GITHUB_TOKEN",
      "RELEASE_TAG"
    ]) ||
    github.env.GITHUB_IMMUTABLE_RELEASES_EXPECTED !== "true" ||
    github.env.GITHUB_TOKEN !== "${{ github.token }}" ||
    token === undefined ||
    command(token.run) !== command(OPEN_VSX_VERIFY_PAT_RUN) ||
    openVsxArtifact === undefined ||
    command(openVsxArtifact.run) !== contract.verifier ||
    openVsx === undefined ||
    command(openVsx.run) !== command(OPEN_VSX_PUBLISH_RUN) ||
    openVsx.env?.RELEASE_VERSION !== "${{ steps.canonical_release.outputs.extension_version }}" ||
    publicVerifier === undefined ||
    command(publicVerifier.run) !== "node scripts/verify-open-vsx-github-release.mjs canonical-release --verify" ||
    media === undefined ||
    media.if !== mediaCondition ||
    mediaContract === undefined ||
    command(mediaContract.run) !== command(PUBLIC_MEDIA_CONTRACT_RUN) ||
    !before(job, candidate, download) ||
    !before(job, download, canonical) ||
    !before(job, canonical, finalCanonical) ||
    !before(job, finalCanonical, tag) ||
    !before(job, tag, localTag) ||
    !before(job, localTag, github) ||
    !before(job, github, token) ||
    !before(job, token, openVsxArtifact) ||
    !before(job, openVsxArtifact, openVsx) ||
    !before(job, openVsx, publicVerifier) ||
    !before(job, publicVerifier, mediaContract) ||
    !before(job, mediaContract, media) ||
    runs(job).some((run) =>
      /package:prepared|create-canonical-release-artifact|npm run (?:build|verify:vsix)/u.test(run)
    )
  ) {
    problems.push("release must select, download, reverify, and promote one accepted artifact without rebuilding it.");
  }
  const secretSteps = steps(job).filter((step) => step?.env?.OVSX_PAT !== undefined);
  if (secretSteps.length !== 2 || !secretSteps.includes(openVsx)) {
    problems.push("Only token verification and exact Open VSX publication may receive OVSX_PAT.");
  }
}

export function inspectReleaseTrainWorkflow(source, channel) {
  const contract = CHANNELS[channel];
  if (contract === undefined) throw new TypeError("Release channel must be preview or stable.");
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    return [`${contract.name} workflow must be bounded YAML text.`];
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch {
    return [`${contract.name} workflow must contain valid YAML.`];
  }
  const problems = [];
  if (
    !exactKeys(workflow, ["name", "on", "permissions", "concurrency", "jobs"]) ||
    workflow.name !== contract.name ||
    !exactKeys(workflow.on, ["workflow_dispatch"]) ||
    !exactKeys(workflow.jobs, JOBS)
  ) {
    return [`${contract.name} must remain one manual four-job candidate/promotion workflow.`];
  }
  inspectInputs(workflow, problems);
  if (!exactKeys(workflow.permissions, ["contents"]) || workflow.permissions.contents !== "read") {
    problems.push("Release workflows must default to contents: read.");
  }
  if (workflow.concurrency?.["cancel-in-progress"] !== false) {
    problems.push("Release workflows must not cancel in-flight candidate or promotion work.");
  }
  inspectActions(workflow, problems);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (job?.env !== undefined || job?.defaults !== undefined || job?.["continue-on-error"] !== undefined) {
      problems.push(`${jobName} must not inherit environment, defaults, or failure suppression.`);
    }
  }
  inspectPackage(workflow, channel, contract, problems);
  problems.push(...inspectCandidateCaller(workflow, channel, CANDIDATE_IF));
  inspectRemote(workflow, contract, problems);
  inspectPromotion(workflow, contract, problems);
  const protectedJobs = Object.entries(workflow.jobs)
    .filter(([, job]) => job.environment !== undefined || job.permissions?.contents === "write")
    .map(([name]) => name);
  if (JSON.stringify(protectedJobs) !== JSON.stringify(["release"])) {
    problems.push("Only release may enter the publishing environment or receive contents: write.");
  }
  return problems;
}
