import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";

const MAX_WORKFLOW_BYTES = 64 * 1024;
const AUDITED_WORKFLOW_SHA256 = "7e6239699f9566bc4ed4a5fb4567d95df79db1ebd75e7bc12ad05272803cd5b5";
const CHECKOUT = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const TAG_EXPRESSION = "${{ github.event_name == 'release' && github.event.release.tag_name || inputs.release_tag }}";
const COMMIT_EXPRESSION = "${{ steps.release_source.outputs.release_commit }}";
const PRERELEASE_EXPRESSION = "${{ steps.release_source.outputs.release_prerelease }}";
const AUTOMATION_EXPRESSION = "${{ steps.automation_source.outputs.automation_commit }}";
const CALL_INPUT = Object.freeze({
  description: "Canonical GitHub release tag to promote",
  required: true,
  type: "string"
});
const DISPATCH_INPUT = Object.freeze({
  description: "Existing canonical GitHub release tag to promote",
  required: true,
  type: "string"
});

const EXPECTED_RUNS = Object.freeze([
  "npm ci --ignore-scripts",
  "node scripts/registry-release-source.mjs release-source",
  "node scripts/prepare-stable-candidate-tag.mjs --require-remote release-source",
  "node scripts/download-canonical-github-release.mjs canonical-release",
  "node scripts/verify-registry-release-artifact.mjs canonical-release",
  "npx --no-install ovsx verify-pat Matt17BR",
  "node scripts/verify-registry-release-artifact.mjs canonical-release",
  "node scripts/verify-open-vsx-github-release.mjs canonical-release --preflight",
  "node scripts/verify-registry-release-artifact.mjs canonical-release",
  "npx --no-install ovsx publish --skip-duplicate canonical-release/openwrangler.vsix",
  "node scripts/verify-open-vsx-github-release.mjs canonical-release --verify",
  "node scripts/prepare-stable-candidate-tag.mjs --require-remote release-source"
]);

function exactKeys(value, keys) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function runSteps(job) {
  return job.steps.filter((step) => typeof step?.run === "string").map((step) => step.run);
}

function exactCommitEnvironment(step) {
  return exactKeys(step?.env, ["EXPECTED_SHA"]) && step.env.EXPECTED_SHA === COMMIT_EXPRESSION;
}

function exactVerifierEnvironment(step) {
  return (
    exactKeys(step?.env, ["AUTOMATION_SHA", "EXPECTED_SHA", "RELEASE_PRERELEASE"]) &&
    step.env.AUTOMATION_SHA === AUTOMATION_EXPRESSION &&
    step.env.EXPECTED_SHA === COMMIT_EXPRESSION &&
    step.env.RELEASE_PRERELEASE === PRERELEASE_EXPRESSION
  );
}

export function inspectOpenVsxPromotionWorkflow(source) {
  const problems = [];
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    return ["Open VSX promotion workflow must be bounded UTF-8 text."];
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch {
    return ["Open VSX promotion workflow must be valid YAML."];
  }
  if (
    !exactKeys(workflow, ["name", "on", "permissions", "concurrency", "jobs"]) ||
    workflow.name !== "Promote GitHub release to Open VSX"
  ) {
    problems.push("Open VSX promotion must retain the reviewed top-level workflow.");
  }
  const trigger = workflow?.on;
  if (
    !exactKeys(trigger, ["release", "workflow_call", "workflow_dispatch"]) ||
    JSON.stringify(trigger.release) !== JSON.stringify({ types: ["published"] }) ||
    !exactKeys(trigger.workflow_call, ["inputs"]) ||
    !exactKeys(trigger.workflow_call.inputs, ["release_tag"]) ||
    JSON.stringify(trigger.workflow_call.inputs.release_tag) !== JSON.stringify(CALL_INPUT) ||
    !exactKeys(trigger.workflow_dispatch, ["inputs"]) ||
    !exactKeys(trigger.workflow_dispatch.inputs, ["release_tag"]) ||
    JSON.stringify(trigger.workflow_dispatch.inputs.release_tag) !== JSON.stringify(DISPATCH_INPUT)
  ) {
    problems.push(
      "Open VSX promotion must accept direct release-workflow calls, published releases, and explicit recovery dispatches."
    );
  }
  if (
    !exactKeys(workflow.permissions, ["contents"]) ||
    workflow.permissions.contents !== "read" ||
    !exactKeys(workflow.concurrency, ["group", "cancel-in-progress"]) ||
    workflow.concurrency.group !== `open-vsx-${TAG_EXPRESSION}` ||
    workflow.concurrency["cancel-in-progress"] !== false
  ) {
    problems.push("Open VSX promotion must be read-only and serialize one release tag without cancellation.");
  }
  if (!exactKeys(workflow.jobs, ["promote"])) {
    problems.push("Open VSX promotion must contain exactly one protected promotion job.");
    return problems;
  }
  const job = workflow.jobs.promote;
  if (
    !exactKeys(job, ["name", "if", "runs-on", "timeout-minutes", "environment", "env", "steps"]) ||
    job.name !== "Promote exact public GitHub release" ||
    job.if !== "${{ github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main' }}" ||
    job["runs-on"] !== "ubuntu-24.04" ||
    job["timeout-minutes"] !== 60 ||
    job.environment !== "publishing" ||
    !exactKeys(job.env, ["RELEASE_TAG"]) ||
    job.env.RELEASE_TAG !== TAG_EXPRESSION ||
    !Array.isArray(job.steps)
  ) {
    problems.push("Open VSX promotion must use the fixed protected publishing job.");
    return problems;
  }
  const checkouts = job.steps.filter((step) => step?.uses === CHECKOUT);
  if (
    checkouts.length !== 2 ||
    JSON.stringify(checkouts[0]?.with) !==
      JSON.stringify({ ref: "main", "fetch-depth": 0, "fetch-tags": true, "persist-credentials": false }) ||
    JSON.stringify(checkouts[1]?.with) !==
      JSON.stringify({
        ref: `refs/tags/${"${{ env.RELEASE_TAG }}"}`,
        path: "release-source",
        "fetch-depth": 0,
        "fetch-tags": true,
        "persist-credentials": false
      }) ||
    job.steps.filter((step) => step?.uses === SETUP_NODE).length !== 1
  ) {
    problems.push("Open VSX promotion must separately check out reviewed main and the exact public release tag.");
  }
  const runs = runSteps(job);
  const automationSource = job.steps.find((step) => step?.id === "automation_source");
  const multilineGuard = automationSource?.run;
  const normalized = runs.filter((run) => run !== multilineGuard);
  if (
    typeof multilineGuard !== "string" ||
    !multilineGuard.includes('test "$(git rev-parse --verify HEAD^{commit})"') ||
    !multilineGuard.includes("printf 'automation_commit=%s\\n' \"$(git rev-parse --verify HEAD^{commit})\"") ||
    JSON.stringify(normalized) !== JSON.stringify(EXPECTED_RUNS)
  ) {
    problems.push("Open VSX promotion command order differs from the reviewed exact-artifact flow.");
  }
  const download = job.steps.find(
    (step) => step?.run === "node scripts/download-canonical-github-release.mjs canonical-release"
  );
  if (!exactKeys(download?.env, ["RELEASE_PRERELEASE"]) || download.env.RELEASE_PRERELEASE !== PRERELEASE_EXPRESSION) {
    problems.push("Public GitHub release download must use the source-derived stable or preview channel.");
  }
  const remoteTagChecks = job.steps.filter(
    (step) => typeof step?.run === "string" && step.run.includes("--require-remote")
  );
  if (remoteTagChecks.length !== 2 || remoteTagChecks.some((step) => !exactCommitEnvironment(step))) {
    problems.push("Both immutable public-tag checks must use the bound release commit.");
  }
  const verifierSteps = job.steps.filter(
    (step) =>
      typeof step?.run === "string" &&
      (step.run.includes("verify-registry-release-artifact") || step.run.includes("verify-open-vsx-github-release"))
  );
  if (verifierSteps.length !== 5 || verifierSteps.some((step) => !exactVerifierEnvironment(step))) {
    problems.push(
      "Every artifact, preflight, and public verification must use the exact automation and release source."
    );
  }
  const secretSteps = job.steps.filter((step) => step?.env?.OVSX_PAT !== undefined);
  if (
    secretSteps.length !== 2 ||
    secretSteps.some((step) => !exactKeys(step.env, ["OVSX_PAT"]) || step.env.OVSX_PAT !== "${{ secrets.OVSX_PAT }}")
  ) {
    problems.push("Only token verification and publication may receive protected OVSX_PAT.");
  }
  if (
    /(?:npm\s+(?:run\s+)?(?:build|package|pack|version)|vsce\s+package|git\s+(?:tag|push)|--pre-release)/u.test(source)
  ) {
    problems.push("Open VSX promotion must not rebuild, retag, push, or expose a channel/token override.");
  }
  if (createHash("sha256").update(source, "utf8").digest("hex") !== AUDITED_WORKFLOW_SHA256) {
    problems.push("Open VSX promotion YAML differs from the explicitly reviewed workflow bytes.");
  }
  return problems;
}

function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const source = readFileSync(resolve(root, ".github/workflows/open-vsx-promotion.yml"), "utf8");
  const problems = inspectOpenVsxPromotionWorkflow(source);
  if (problems.length > 0) {
    throw new Error(`Open VSX promotion workflow is unsafe:\n- ${problems.join("\n- ")}`);
  }
  console.log("Open VSX promotion workflow structure is valid.");
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
