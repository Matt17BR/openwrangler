import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";
import {
  inspectAllowedWorkflowActions,
  inspectPinnedExternalActions,
  usesPinnedAction
} from "./workflow-action-pins.mjs";

const MAX_WORKFLOW_BYTES = 64 * 1024;
const COMMIT_EXPRESSION = "${{ steps.release_source.outputs.release_commit }}";
const PRERELEASE_EXPRESSION = "${{ steps.release_source.outputs.release_prerelease }}";
const AUTOMATION_EXPRESSION = "${{ steps.automation_source.outputs.automation_commit }}";

function mandatory(step) {
  return (
    step !== undefined &&
    step.if === undefined &&
    (step["continue-on-error"] === undefined || step["continue-on-error"] === false)
  );
}

export function inspectOpenVsxPromotionWorkflow(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES) {
    return ["Open VSX promotion workflow must be bounded UTF-8 text."];
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch {
    return ["Open VSX promotion workflow must be valid YAML."];
  }
  const problems = [
    ...inspectPinnedExternalActions(workflow),
    ...inspectAllowedWorkflowActions(workflow, { promote: { steps: ["actions/checkout", "actions/setup-node"] } })
  ];
  const job = workflow?.jobs?.promote;
  if (!Array.isArray(job?.steps)) return [...problems, "Open VSX promotion needs its protected publishing job."];
  if (
    workflow.permissions?.contents !== "read" ||
    Object.keys(workflow.permissions).some((key) => key !== "contents") ||
    Object.values(workflow.jobs).some(
      (entry) =>
        entry.secrets !== undefined ||
        (entry.permissions !== undefined &&
          (entry.permissions?.contents !== "read" || Object.keys(entry.permissions).some((key) => key !== "contents")))
    ) ||
    job.environment !== "publishing" ||
    job.if !== "${{ github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main' }}" ||
    !mandatory({ ...job, if: undefined })
  )
    problems.push("Open VSX promotion must retain read-only permissions and protected-main publishing admission.");
  if (
    workflow.concurrency?.group !== "openwrangler-release-publication" ||
    workflow.concurrency["cancel-in-progress"] !== false ||
    workflow.concurrency.queue !== "max"
  )
    problems.push("Open VSX promotion must retain the non-cancelling publication queue.");
  const dispatch = workflow.on?.workflow_dispatch?.inputs?.release_tag;
  const reusable = workflow.on?.workflow_call?.inputs?.release_tag;
  if (
    !workflow.on?.release?.types?.includes("published") ||
    dispatch?.type !== "string" ||
    dispatch.required !== true ||
    reusable?.type !== "string" ||
    reusable.required !== true ||
    reusable.default !== undefined ||
    workflow.on.workflow_call.secrets !== undefined ||
    job.env?.RELEASE_TAG !==
      "${{ github.event_name == 'release' && github.event.release.tag_name || inputs.release_tag }}"
  )
    problems.push("Release events, manual recovery and reusable promotion must bind one explicit release tag.");
  const steps = job.steps;
  const run = (command) => steps.find((step) => step.run?.trim() === command);
  const checkouts = steps.filter((step) => usesPinnedAction(step, "actions/checkout"));
  const automation = steps.find((step) => step.id === "automation_source");
  const sourceStep = steps.find((step) => step.id === "release_source");
  if (
    checkouts.some((step) => step.with?.["persist-credentials"] !== false) ||
    !checkouts.some(
      (step) => mandatory(step) && step.with?.ref === "main" && step.with["persist-credentials"] === false
    ) ||
    !checkouts.some(
      (step) =>
        mandatory(step) &&
        step.with?.ref === "refs/tags/${{ env.RELEASE_TAG }}" &&
        step.with.path === "release-source" &&
        step.with["persist-credentials"] === false
    ) ||
    !mandatory(automation) ||
    !automation.run?.includes(
      'test "$(git rev-parse --verify HEAD^{commit})" = "$(git rev-parse --verify refs/remotes/origin/main^{commit})"'
    ) ||
    !automation.run?.includes("printf 'automation_commit=%s\\n'") ||
    !mandatory(sourceStep) ||
    sourceStep.run?.trim() !== "node scripts/registry-release-source.mjs release-source"
  )
    problems.push("Promotion must separate protected-main automation from the validated exact release checkout.");
  const install = run("npm ci --ignore-scripts");
  const download = run("node scripts/download-canonical-github-release.mjs canonical-release");
  const artifact = run("node scripts/verify-registry-release-artifact.mjs canonical-release");
  const preflight = run("node scripts/verify-open-vsx-github-release.mjs canonical-release --preflight");
  const verify = run("node scripts/verify-open-vsx-github-release.mjs canonical-release --verify");
  if (!mandatory(install) || !mandatory(download) || download.env?.RELEASE_PRERELEASE !== PRERELEASE_EXPRESSION)
    problems.push("Promotion must download the bound public release channel.");
  if (
    [artifact, preflight, verify].some(
      (step) =>
        !mandatory(step) ||
        step.env?.AUTOMATION_SHA !== AUTOMATION_EXPRESSION ||
        step.env?.EXPECTED_SHA !== COMMIT_EXPRESSION ||
        step.env?.RELEASE_PRERELEASE !== PRERELEASE_EXPRESSION
    )
  ) {
    problems.push(
      "Artifact, preflight and public verification must run and fail closed for the bound source and channel."
    );
  }
  const token = steps.find((step) => step.run?.includes("npx --no-install ovsx verify-pat Matt17BR"));
  const publish = steps.find((step) =>
    step.run?.includes("npx --no-install ovsx publish --skip-duplicate canonical-release/openwrangler.vsix")
  );
  const secretSteps = steps.filter((step) => step.env?.OVSX_PAT !== undefined);
  if (
    !mandatory(token) ||
    !mandatory(publish) ||
    secretSteps.length !== 2 ||
    !secretSteps.includes(token) ||
    !secretSteps.includes(publish) ||
    secretSteps.some((step) => step.env.OVSX_PAT !== "${{ secrets.OVSX_PAT }}") ||
    (JSON.stringify(workflow).match(/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/gu) ?? []).length !== 2 ||
    publish?.env?.RELEASE_PRERELEASE !== PRERELEASE_EXPRESSION ||
    publish?.env?.RELEASE_VERSION !== "${{ steps.release_source.outputs.release_version }}"
  )
    problems.push("Only mandatory token verification and exact-artifact publication may receive OVSX_PAT.");
  if (!(
    steps.indexOf(install) < steps.indexOf(sourceStep) &&
    steps.indexOf(sourceStep) < steps.indexOf(download) &&
    steps.indexOf(download) < steps.indexOf(artifact) &&
    steps.indexOf(artifact) < steps.indexOf(token) &&
    steps.indexOf(token) < steps.indexOf(preflight) &&
    steps.indexOf(preflight) < steps.indexOf(publish) &&
    steps.indexOf(publish) < steps.indexOf(verify)
  )) {
    problems.push(
      "Validate the downloaded artifact before authentication, preflight before publication and verify afterward."
    );
  }
  const tagChecks = steps.filter(
    (step) => step.run?.trim() === "node scripts/prepare-stable-candidate-tag.mjs --require-remote release-source"
  );
  if (
    !tagChecks.some(
      (step) =>
        mandatory(step) && step.env?.EXPECTED_SHA === COMMIT_EXPRESSION && steps.indexOf(step) < steps.indexOf(download)
    ) ||
    !tagChecks.some(
      (step) =>
        mandatory(step) && step.env?.EXPECTED_SHA === COMMIT_EXPRESSION && steps.indexOf(step) > steps.indexOf(verify)
    )
  ) {
    problems.push("The bound public tag must be checked before download and after registry verification.");
  }
  if (
    steps.some((step) =>
      /(?:npm\s+(?:run\s+)?(?:build|package|pack|version)|vsce\s+package|git\s+(?:tag|push))/u.test(step.run ?? "")
    )
  )
    problems.push("Open VSX promotion must not rebuild, retag, or push.");
  return problems;
}

function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const source = readFileSync(resolve(root, ".github/workflows/open-vsx-promotion.yml"), "utf8");
  const problems = inspectOpenVsxPromotionWorkflow(source);
  if (problems.length > 0) throw new Error(`Open VSX promotion workflow is unsafe:\n- ${problems.join("\n- ")}`);
  console.log("Open VSX promotion workflow structure is valid.");
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli();
