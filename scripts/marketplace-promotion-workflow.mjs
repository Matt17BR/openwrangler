import { load as parseYaml } from "js-yaml";
import { parseStrictJson } from "./strict-json.mjs";

const SERVICE_CONNECTION = "openwrangler-marketplace-publishing";
const VSCE_PACKAGE = "@vscode/vsce";
const VSCE_LOCK_PATH = "node_modules/@vscode/vsce";

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stage(pipeline, name) {
  return pipeline.stages?.find((entry) => entry?.stage === name);
}

function deploymentSteps(pipeline) {
  return stage(pipeline, "Promote")?.jobs?.[0]?.strategy?.runOnce?.deploy?.steps ?? [];
}

function scriptText(steps) {
  return steps
    .map((step) => (typeof step?.script === "string" ? step.script : (step?.inputs?.inlineScript ?? "")))
    .join("\n");
}

export function inspectMarketplaceVsceLock({ packageJson, packageLock }) {
  const problems = [];
  let manifest;
  let lock;
  try {
    manifest = parseStrictJson(packageJson, { maxBytes: 2 * 1024 * 1024 });
    lock = parseStrictJson(packageLock, { maxBytes: 16 * 1024 * 1024 });
  } catch {
    return ["Marketplace publishing dependencies must be bounded strict JSON."];
  }
  const requested = manifest?.devDependencies?.[VSCE_PACKAGE];
  const lockedRequest = lock?.packages?.[""]?.devDependencies?.[VSCE_PACKAGE];
  const entries = Object.entries(lock?.packages ?? {}).filter(
    ([path]) => path === VSCE_LOCK_PATH || path.endsWith(`/node_modules/${VSCE_PACKAGE}`)
  );
  if (typeof requested !== "string" || requested !== lockedRequest) {
    problems.push("package.json and package-lock.json must request the same VSCE version range.");
  }
  if (lock?.lockfileVersion !== 3 || entries.length !== 1 || entries[0]?.[0] !== VSCE_LOCK_PATH) {
    problems.push("The lockfile must contain one root VSCE package.");
    return problems;
  }
  const locked = entries[0][1];
  const version = locked?.version;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(version) ||
    locked?.resolved !== `https://registry.npmjs.org/@vscode/vsce/-/vsce-${version}.tgz` ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(locked?.integrity ?? "")
  ) {
    problems.push("The locked VSCE package must have a stable version, npm URL, and SHA-512 integrity.");
  }
  return problems;
}

export function inspectMarketplacePromotionPipeline(source) {
  const problems = [];
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 24 * 1024) {
    return ["Marketplace promotion must be a bounded Azure Pipeline file."];
  }
  let pipeline;
  try {
    pipeline = parseYaml(source);
  } catch (error) {
    return [`Marketplace promotion YAML does not parse: ${error instanceof Error ? error.message : "unknown error"}.`];
  }
  if (!object(pipeline) || pipeline.name !== "marketplace-$(Date:yyyyMMdd).$(Rev:r)") {
    return ["Marketplace promotion must be one named pipeline."];
  }
  if (
    pipeline.pr !== "none" ||
    pipeline.trigger?.batch !== false ||
    JSON.stringify(pipeline.trigger?.branches) !== JSON.stringify({ exclude: ["*"] }) ||
    JSON.stringify(pipeline.trigger?.tags) !== JSON.stringify({ include: ["v*"] })
  ) {
    problems.push("Marketplace promotion must run automatically for release tags, not main pushes or pull requests.");
  }
  const parameters = pipeline.parameters;
  if (
    !Array.isArray(parameters) ||
    parameters.length !== 2 ||
    parameters[0]?.name !== "marketplaceServiceConnection" ||
    parameters[0]?.default !== SERVICE_CONNECTION ||
    JSON.stringify(parameters[0]?.values) !== JSON.stringify([SERVICE_CONNECTION]) ||
    parameters[1]?.name !== "existingReleaseTag"
  ) {
    problems.push("Marketplace promotion needs one fixed WIF identity and one manual recovery tag.");
  }

  const intake = stage(pipeline, "Intake");
  const promote = stage(pipeline, "Promote");
  const intakeJob = intake?.jobs?.[0];
  const intakeScript = intakeJob?.steps?.find((step) => step?.name === "release_intake");
  if (
    pipeline.stages?.length !== 2 ||
    intakeJob?.job !== "Bind" ||
    intakeJob?.timeoutInMinutes !== 10 ||
    intakeScript?.script !== "node scripts/marketplace-release-intake.mjs" ||
    intakeScript?.env?.BUILD_SOURCEBRANCH !== "$(Build.SourceBranch)" ||
    intakeScript?.env?.EXISTING_RELEASE_TAG !== "${{ parameters.existingReleaseTag }}"
  ) {
    problems.push("Marketplace intake must bind one exact tag or explicit recovery release before publication.");
  }

  const deployment = promote?.jobs?.[0];
  const steps = deploymentSteps(pipeline);
  const download = steps.find(
    (step) => step?.script === "node scripts/download-canonical-github-release.mjs canonical-release"
  );
  const azure = steps.find((step) => step?.task === "AzureCLI@2");
  const allScripts = scriptText(steps);
  if (
    promote?.dependsOn !== "Intake" ||
    promote?.lockBehavior !== "sequential" ||
    deployment?.deployment !== "Marketplace" ||
    deployment?.timeoutInMinutes !== 60 ||
    deployment?.environment !== "openwrangler-marketplace-publishing"
  ) {
    problems.push("Marketplace publishing must be one protected, serialized, 60-minute deployment.");
  }
  if (
    download?.env?.OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS !== 30 ||
    download?.env?.OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS !== 10000 ||
    download?.env?.OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS !== 330000 ||
    download?.timeoutInMinutes !== 6 ||
    download?.env?.RELEASE_TAG !== "$(releaseTag)" ||
    download?.env?.RELEASE_PRERELEASE !== "$(releasePrerelease)"
  ) {
    problems.push("Marketplace intake must keep the GitHub release handoff within one six-minute step.");
  }
  if (
    !allScripts.includes("node scripts/verify-registry-release-artifact.mjs canonical-release") ||
    !allScripts.includes("node scripts/marketplace-identity-profile.mjs") ||
    !allScripts.includes("npx --no-install vsce verify-pat Matt17BR --azure-credential") ||
    !allScripts.includes("--packagePath canonical-release/openwrangler.vsix") ||
    (allScripts.match(/--skip-duplicate/gu) ?? []).length !== 2 ||
    !allScripts.includes("node scripts/verify-marketplace-publication.mjs canonical-release --probe-existing") ||
    !allScripts.includes("node scripts/verify-marketplace-publication.mjs canonical-release") ||
    /npm run build|npm run package|package:prepared/u.test(allScripts)
  ) {
    problems.push("Marketplace publication must verify and publish the GitHub release bytes without rebuilding them.");
  }
  if (
    azure?.inputs?.azureSubscription !== "${{ parameters.marketplaceServiceConnection }}" ||
    azure?.inputs?.addSpnToEnvironment !== false ||
    azure?.inputs?.visibleAzLogin !== false
  ) {
    problems.push("Marketplace publication must use the protected federated identity without exporting credentials.");
  }
  return problems;
}
