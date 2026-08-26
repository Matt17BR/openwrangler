import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";
import {
  inspectAllowedWorkflowActions,
  inspectPinnedExternalActions,
  usesPinnedAction
} from "./workflow-action-pins.mjs";

const CHECKOUT = "actions/checkout";
const SETUP_NODE = "actions/setup-node";
const ALLOWED_ACTIONS = Object.freeze({
  promote: Object.freeze({ steps: Object.freeze([CHECKOUT, SETUP_NODE]) })
});
const TAG_EXPRESSION = "${{ inputs.release_tag }}";
const COMMIT_EXPRESSION = "${{ steps.release_source.outputs.release_commit }}";
const PRERELEASE_EXPRESSION = "${{ steps.release_source.outputs.release_prerelease }}";
const VERSION_EXPRESSION = "${{ steps.release_source.outputs.release_version }}";
const AUTOMATION_EXPRESSION = "${{ steps.automation_source.outputs.automation_commit }}";

export const OPEN_VSX_VERIFY_PAT_RUN = `if [ -z "\${OVSX_PAT:-}" ]; then
echo "OVSX_PAT is unavailable in the publishing environment." >&2
exit 1
fi
npx --no-install ovsx verify-pat Matt17BR
`;
export const OPEN_VSX_PUBLISH_RUN = `if [ -z "\${OVSX_PAT:-}" ]; then
echo "OVSX_PAT is unavailable in the publishing environment." >&2
exit 1
fi
case "$RELEASE_PRERELEASE" in
true|false) ;;
*) exit 1 ;;
esac
npx --no-install ovsx publish --skip-duplicate canonical-release/openwrangler.vsix
`;
export const PUBLIC_MEDIA_CONTRACT_RUN = `required="$(node --input-type=module -e 'import { publicMediaVerificationRequired } from "./scripts/public-media-surface-contract.mjs"; process.stdout.write(String(publicMediaVerificationRequired(process.env.RELEASE_VERSION)));')"
printf 'required=%s\\n' "$required" >> "$GITHUB_OUTPUT"
`;
export const PUBLIC_MEDIA_PREFLIGHT_RUN =
  'node scripts/verify-public-media-surfaces.mjs --source-sha "$RELEASE_SOURCE_SHA" --version "$RELEASE_VERSION" --prepublish';
export const PUBLIC_MEDIA_RECOVERY_PREFLIGHT_RUN = `required="$(node --input-type=module -e 'import { publicMediaPrepublicationRequired } from "./scripts/public-media-surface-contract.mjs"; process.stdout.write(String(publicMediaPrepublicationRequired(process.env.RELEASE_VERSION)));')"
printf 'required=%s\\n' "$required" >> "$GITHUB_OUTPUT"
case "$required" in
true)
npm ci --ignore-scripts --prefix release-source
node release-source/scripts/verify-public-media-surfaces.mjs --source-sha "$RELEASE_SOURCE_SHA" --version "$RELEASE_VERSION" --prepublish
;;
false)
printf 'Prepublication public-media verification starts with v1.99.4; historical %s recovery is unchanged.\\n' "$RELEASE_VERSION"
;;
*) exit 64 ;;
esac
`;
export const PUBLIC_MEDIA_BROWSER_INSTALL_RUN = `case "$PREPUBLICATION_REQUIRED" in
true) release-source/node_modules/.bin/playwright-core install --with-deps chromium ;;
false) npx --no-install playwright-core install --with-deps chromium ;;
*) exit 64 ;;
esac
`;

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return object(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function commands(job) {
  return steps(job).filter((step) => typeof step?.run === "string");
}

function hasCommand(job, text) {
  return commands(job).some((step) => step.run.includes(text));
}

function actionSteps(job, action) {
  return steps(job).filter((step) => usesPinnedAction(step, action));
}

function releaseTagInput(trigger) {
  const input = trigger?.inputs?.release_tag;
  return input?.required === true && input?.type === "string";
}

export function inspectOpenVsxPromotionWorkflow(source) {
  const problems = [];
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 48 * 1024) {
    return ["Open VSX promotion must be a bounded workflow file."];
  }
  let workflow;
  try {
    workflow = parseYaml(source);
  } catch (error) {
    return [`Open VSX promotion YAML does not parse: ${error instanceof Error ? error.message : "unknown error"}.`];
  }
  if (!object(workflow) || workflow.name !== "Promote GitHub release to Open VSX") {
    return ["Open VSX promotion must be one named workflow."];
  }
  const trigger = workflow.on;
  if (
    JSON.stringify(Object.keys(trigger ?? {}).sort()) !== JSON.stringify(["workflow_call", "workflow_dispatch"]) ||
    !releaseTagInput(trigger.workflow_call) ||
    !releaseTagInput(trigger.workflow_dispatch)
  ) {
    problems.push("Open VSX promotion may start only from stable release or an explicit recovery tag.");
  }
  if (
    JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" }) ||
    !exactKeys(workflow.concurrency, ["group", "cancel-in-progress", "queue"]) ||
    workflow.concurrency?.group !== "openwrangler-release-publication" ||
    workflow.concurrency?.["cancel-in-progress"] !== false ||
    workflow.concurrency?.queue !== "max"
  ) {
    problems.push("Open VSX promotion must be read-only and serialized without cancelling an active publisher.");
  }
  if (JSON.stringify(Object.keys(workflow.jobs ?? {})) !== JSON.stringify(["promote"])) {
    problems.push("Open VSX promotion must have one publisher job.");
    return problems;
  }
  problems.push(...inspectPinnedExternalActions(workflow));
  problems.push(...inspectAllowedWorkflowActions(workflow, ALLOWED_ACTIONS));

  const job = workflow.jobs.promote;
  if (
    job?.["runs-on"] !== "ubuntu-24.04" ||
    job?.["timeout-minutes"] !== 75 ||
    job?.environment !== "publishing" ||
    job?.if !== "${{ github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main' }}" ||
    job?.env?.RELEASE_TAG !== TAG_EXPRESSION
  ) {
    problems.push("Open VSX publication must use the protected publishing environment and bounded recovery input.");
  }

  const checkouts = actionSteps(job, "actions/checkout");
  if (
    checkouts.length !== 2 ||
    checkouts[0]?.with?.ref !== "main" ||
    checkouts[0]?.with?.["persist-credentials"] !== false ||
    checkouts[1]?.with?.ref !== "refs/tags/${{ env.RELEASE_TAG }}" ||
    checkouts[1]?.with?.path !== "release-source" ||
    checkouts[1]?.with?.["persist-credentials"] !== false
  ) {
    problems.push("Open VSX promotion must keep reviewed automation separate from the exact release tag.");
  }

  const download = commands(job).find((step) =>
    step.run.includes("download-canonical-github-release.mjs canonical-release")
  );
  if (
    download?.env?.OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS !== 12 ||
    download?.env?.OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS !== 5000 ||
    download?.env?.OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS !== 90000 ||
    download?.env?.RELEASE_PRERELEASE !== PRERELEASE_EXPRESSION
  ) {
    problems.push("Open VSX promotion must use one short bounded GitHub release handoff.");
  }

  const registryVerifiers = commands(job).filter((step) =>
    step.run.includes("verify-registry-release-artifact.mjs canonical-release")
  );
  const publicVerifier = commands(job).find((step) =>
    step.run.includes("verify-open-vsx-github-release.mjs canonical-release --verify")
  );
  const tagChecks = commands(job).filter((step) =>
    step.run.includes("prepare-stable-candidate-tag.mjs --require-remote")
  );
  const exactVerifierEnv = (step) =>
    step?.env?.AUTOMATION_SHA === AUTOMATION_EXPRESSION &&
    step?.env?.EXPECTED_SHA === COMMIT_EXPRESSION &&
    step?.env?.RELEASE_PRERELEASE === PRERELEASE_EXPRESSION;
  if (
    registryVerifiers.length !== 3 ||
    registryVerifiers.some((step) => !exactVerifierEnv(step)) ||
    !exactVerifierEnv(publicVerifier) ||
    tagChecks.length !== 2 ||
    tagChecks.some((step) => step?.env?.EXPECTED_SHA !== COMMIT_EXPRESSION)
  ) {
    problems.push("Open VSX promotion must bind every byte and tag check to the exact public release source.");
  }

  const tokenSteps = steps(job).filter((step) => step?.env?.OVSX_PAT !== undefined);
  const verifyToken = tokenSteps.find((step) => step.run?.includes("ovsx verify-pat Matt17BR"));
  const publish = tokenSteps.find((step) => step.run?.includes("ovsx publish"));
  if (
    tokenSteps.length !== 2 ||
    tokenSteps.some((step) => step.env.OVSX_PAT !== "${{ secrets.OVSX_PAT }}") ||
    !verifyToken?.run?.includes("npx --no-install ovsx verify-pat Matt17BR") ||
    !publish?.run?.includes("ovsx publish --skip-duplicate canonical-release/openwrangler.vsix") ||
    publish?.env?.RELEASE_PRERELEASE !== PRERELEASE_EXPRESSION ||
    publish?.env?.RELEASE_VERSION !== VERSION_EXPRESSION
  ) {
    problems.push("Only token verification and idempotent exact-byte publication may receive OVSX_PAT.");
  }

  const allRuns = commands(job)
    .map((step) => step.run)
    .join("\n");
  if (
    !hasCommand(job, "verify-open-vsx-github-release.mjs canonical-release --preflight") ||
    !hasCommand(job, "verify-public-media-surfaces.mjs") ||
    /npm\s+(?:run\s+)?(?:build|package|pack|version)|vsce\s+package|git\s+(?:tag|push)/u.test(allRuns)
  ) {
    problems.push(
      "Open VSX promotion must verify and publish the GitHub release bytes without rebuilding or retagging."
    );
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
