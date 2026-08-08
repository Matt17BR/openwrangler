import { createHash } from "node:crypto";
import { load as parseYaml } from "js-yaml";
import { parseStrictJson } from "./strict-json.mjs";

const MAX_PIPELINE_BYTES = 32 * 1024;
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_LOCK_BYTES = 16 * 1024 * 1024;
const AUDITED_MARKETPLACE_PIPELINE_SHA256 = "92b1bba5b16e7378e1db61c129fb102afbe10e860a2754e894654a667bd46fbf";
const SERVICE_CONNECTION = "openwrangler-marketplace-publishing";
const VSCE_PACKAGE = "@vscode/vsce";
const VSCE_LOCK_PATH = "node_modules/@vscode/vsce";
const STABLE_PUBLISH_COMMAND =
  "npx --no-install vsce publish --azure-credential --packagePath canonical-release/openwrangler.vsix --skip-duplicate";
const PREVIEW_PUBLISH_COMMAND =
  "npx --no-install vsce publish --azure-credential --packagePath canonical-release/openwrangler.vsix --pre-release --skip-duplicate";
const STABLE_PUBLISH_ATTEMPT = `${STABLE_PUBLISH_COMMAND} || publish_status=$?`;
const PREVIEW_PUBLISH_ATTEMPT = `${PREVIEW_PUBLISH_COMMAND} || publish_status=$?`;
const PROFILE_ID_COMMAND = "node scripts/marketplace-identity-profile.mjs";
const VERIFY_IDENTITY_COMMAND = "npx --no-install vsce verify-pat Matt17BR --azure-credential";
const VERIFY_ARTIFACT_COMMAND = "node scripts/verify-registry-release-artifact.mjs canonical-release";

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function deploySteps(stage) {
  return stage?.jobs?.[0]?.strategy?.runOnce?.deploy?.steps ?? [];
}

function normalizedLines(value) {
  return typeof value === "string"
    ? value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

export function inspectMarketplaceVsceLock({ packageJson, packageLock }) {
  const problems = [];
  let manifest;
  let lock;
  try {
    manifest = parseStrictJson(packageJson, { maxBytes: MAX_PACKAGE_JSON_BYTES });
    lock = parseStrictJson(packageLock, { maxBytes: MAX_PACKAGE_LOCK_BYTES });
  } catch {
    return ["Marketplace promotion dependency manifests must be bounded strict JSON."];
  }
  const requested = manifest?.devDependencies?.[VSCE_PACKAGE];
  const lockedRequest = lock?.packages?.[""]?.devDependencies?.[VSCE_PACKAGE];
  const lockedPackages =
    lock?.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages)
      ? Object.entries(lock.packages).filter(
          ([path]) => path === VSCE_LOCK_PATH || path.endsWith(`/node_modules/${VSCE_PACKAGE}`)
        )
      : [];
  if (typeof requested !== "string" || requested !== lockedRequest) {
    problems.push("package.json and package-lock.json must request the same VSCE dependency range.");
  }
  if (lock?.lockfileVersion !== 3 || lockedPackages.length !== 1 || lockedPackages[0]?.[0] !== VSCE_LOCK_PATH) {
    problems.push("package-lock.json must resolve exactly one root VSCE package with lockfile version 3.");
    return problems;
  }
  const locked = lockedPackages[0][1];
  const version = locked?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    problems.push("The locked VSCE package must use one exact stable semantic version.");
    return problems;
  }
  if (locked?.resolved !== `https://registry.npmjs.org/@vscode/vsce/-/vsce-${version}.tgz`) {
    problems.push("The locked VSCE package must resolve from its exact npm registry tarball.");
  }
  const integrity = locked?.integrity;
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
    problems.push("The locked VSCE package must carry a valid SHA-512 Subresource Integrity value.");
  } else {
    const encoded = integrity.slice("sha512-".length);
    const digest = Buffer.from(encoded, "base64");
    if (digest.byteLength !== 64 || digest.toString("base64") !== encoded) {
      problems.push("The locked VSCE package must carry a canonical 64-byte SHA-512 digest.");
    }
  }
  return problems;
}

export function inspectMarketplacePromotionPipeline(source) {
  const problems = [];
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_PIPELINE_BYTES) {
    return ["azure-pipelines-marketplace.yml must be bounded UTF-8 text."];
  }
  let pipeline;
  try {
    pipeline = parseYaml(source);
  } catch {
    return ["azure-pipelines-marketplace.yml must contain valid YAML."];
  }
  if (
    !exactKeys(pipeline, ["name", "trigger", "pr", "parameters", "stages"]) ||
    pipeline.name !== "marketplace-$(Date:yyyyMMdd).$(Rev:r)"
  ) {
    problems.push("Marketplace promotion must use the reviewed top-level Azure Pipeline contract.");
  }
  if (
    !exactKeys(pipeline.trigger, ["batch", "branches", "tags"]) ||
    pipeline.trigger.batch !== false ||
    JSON.stringify(pipeline.trigger.branches) !== JSON.stringify({ include: ["main"] }) ||
    JSON.stringify(pipeline.trigger.tags) !== JSON.stringify({ include: ["v*"] }) ||
    pipeline.pr !== "none"
  ) {
    problems.push(
      "Marketplace promotion must preserve path-independent immutable-tag runs plus fail-closed main-branch recovery and disable pull-request runs."
    );
  }
  if (
    !Array.isArray(pipeline.parameters) ||
    pipeline.parameters.length !== 2 ||
    !exactKeys(pipeline.parameters[0], ["name", "displayName", "type", "default", "values"]) ||
    pipeline.parameters[0].name !== "marketplaceServiceConnection" ||
    pipeline.parameters[0].type !== "string" ||
    pipeline.parameters[0].default !== SERVICE_CONNECTION ||
    JSON.stringify(pipeline.parameters[0].values) !== JSON.stringify([SERVICE_CONNECTION]) ||
    !exactKeys(pipeline.parameters[1], ["name", "displayName", "type", "default"]) ||
    pipeline.parameters[1].name !== "existingReleaseTag" ||
    pipeline.parameters[1].type !== "string" ||
    pipeline.parameters[1].default !== ""
  ) {
    problems.push(
      "Marketplace promotion must use the fixed WIF service connection plus one validated manual existing-release parameter."
    );
  }
  if (!Array.isArray(pipeline.stages) || pipeline.stages.length !== 2) {
    problems.push("Marketplace promotion must contain exactly Intake and Promote stages.");
    return problems;
  }
  const [intake, promote] = pipeline.stages;
  if (
    intake?.stage !== "Intake" ||
    !Array.isArray(intake.jobs) ||
    intake.jobs.length !== 1 ||
    intake.jobs[0]?.job !== "Bind"
  ) {
    problems.push("Marketplace promotion intake must bind one exact tag checkout.");
  }
  const intakeSteps = steps(intake?.jobs?.[0]);
  const intakeScript = intakeSteps.find((step) => step?.name === "release_intake");
  if (
    intakeSteps[0]?.checkout !== "self" ||
    intakeSteps[0]?.clean !== true ||
    intakeSteps[0]?.fetchDepth !== 0 ||
    intakeSteps[0]?.fetchTags !== true ||
    intakeSteps[0]?.persistCredentials !== false ||
    intakeScript?.script !== "node scripts/marketplace-release-intake.mjs" ||
    intakeScript?.env?.BUILD_REASON !== "$(Build.Reason)" ||
    intakeScript?.env?.BUILD_SOURCEBRANCH !== "$(Build.SourceBranch)" ||
    intakeScript?.env?.BUILD_SOURCEVERSION !== "$(Build.SourceVersion)" ||
    intakeScript?.env?.EXISTING_RELEASE_TAG !== "${{ parameters.existingReleaseTag }}"
  ) {
    problems.push(
      "Marketplace promotion intake must validate either the exact tag event or one manual historical tag selected from protected main."
    );
  }
  if (
    promote?.stage !== "Promote" ||
    promote.dependsOn !== "Intake" ||
    promote.condition !== "and(succeeded(), eq(dependencies.Intake.outputs['Bind.release_intake.promote'], 'true'))" ||
    promote.lockBehavior !== "sequential" ||
    !Array.isArray(promote.jobs) ||
    promote.jobs.length !== 1
  ) {
    problems.push("Marketplace promotion must serialize validated release intake through one deployment stage.");
  }
  const deployment = promote?.jobs?.[0];
  if (
    deployment?.deployment !== "Marketplace" ||
    deployment?.timeoutInMinutes !== 240 ||
    deployment?.environment !== SERVICE_CONNECTION ||
    JSON.stringify(deployment?.variables) !==
      JSON.stringify({
        releaseCommit: "$[stageDependencies.Intake.Bind.outputs['release_intake.releaseCommit']]",
        releasePrerelease: "$[stageDependencies.Intake.Bind.outputs['release_intake.releasePrerelease']]",
        releaseTag: "$[stageDependencies.Intake.Bind.outputs['release_intake.releaseTag']]"
      }) ||
    deployment?.strategy?.runOnce?.deploy === undefined
  ) {
    problems.push("Marketplace publication must use the fixed protected Azure deployment environment.");
  }
  const promotionSteps = deploySteps(promote);
  const download = promotionSteps.find(
    (step) => step?.script === "node scripts/download-canonical-github-release.mjs canonical-release"
  );
  const canonicalVerifier = promotionSteps.find((step) => step?.script === VERIFY_ARTIFACT_COMMAND);
  const publicVerifier = promotionSteps.find(
    (step) => step?.script === "node scripts/verify-marketplace-publication.mjs canonical-release"
  );
  const verifierEnvironment = {
    AUTOMATION_SHA: "$(Build.SourceVersion)",
    EXPECTED_SHA: "$(releaseCommit)",
    RELEASE_PRERELEASE: "$(releasePrerelease)",
    RELEASE_TAG: "$(releaseTag)"
  };
  const publicVerifierEnvironment = {
    AUTOMATION_SHA: "$(Build.SourceVersion)",
    EXPECTED_SHA: "$(releaseCommit)",
    OPEN_WRANGLER_MARKETPLACE_VERIFY_ATTEMPTS: 40,
    RELEASE_PRERELEASE: "$(releasePrerelease)",
    RELEASE_TAG: "$(releaseTag)"
  };
  if (
    JSON.stringify(download?.env) !==
      JSON.stringify({
        OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS: 210,
        OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS: 60000,
        RELEASE_PRERELEASE: "$(releasePrerelease)",
        RELEASE_TAG: "$(releaseTag)"
      }) ||
    JSON.stringify(canonicalVerifier?.env) !== JSON.stringify(verifierEnvironment) ||
    JSON.stringify(publicVerifier?.env) !== JSON.stringify(publicVerifierEnvironment)
  ) {
    problems.push(
      "Every registry artifact consumer must use the exact intake outputs and the public verifier's maximum reviewed polling bound."
    );
  }
  const azure = promotionSteps.find((step) => step?.task === "AzureCLI@2");
  const azureLines = normalizedLines(azure?.inputs?.inlineScript);
  if (
    azure?.inputs?.azureSubscription !== "${{ parameters.marketplaceServiceConnection }}" ||
    azure?.inputs?.scriptType !== "bash" ||
    azure?.inputs?.scriptLocation !== "inlineScript" ||
    azure?.inputs?.addSpnToEnvironment !== false ||
    azure?.inputs?.visibleAzLogin !== false ||
    azure?.inputs?.failOnStandardError !== false ||
    azure?.env?.AUTOMATION_SHA !== "$(Build.SourceVersion)" ||
    azure?.env?.EXPECTED_SHA !== "$(releaseCommit)" ||
    azure?.env?.RELEASE_PRERELEASE !== "$(releasePrerelease)" ||
    azure?.env?.RELEASE_TAG !== "$(releaseTag)" ||
    JSON.stringify(azureLines) !==
      JSON.stringify([
        "set -euo pipefail",
        PROFILE_ID_COMMAND,
        VERIFY_IDENTITY_COMMAND,
        VERIFY_ARTIFACT_COMMAND,
        "publish_status=0",
        'if [ "$RELEASE_PRERELEASE" = "true" ]; then',
        PREVIEW_PUBLISH_ATTEMPT,
        'elif [ "$RELEASE_PRERELEASE" = "false" ]; then',
        STABLE_PUBLISH_ATTEMPT,
        "else",
        "exit 64",
        "fi",
        'if [ "$publish_status" -ne 0 ]; then',
        'echo "vsce publish exited with status $publish_status; public verification will determine the result." >&2',
        "fi"
      ])
  ) {
    problems.push("Marketplace publication must use locked VSCE through the named WIF AzureCLI task.");
  }
  const commands = promotionSteps.flatMap((step) => [
    ...(typeof step?.script === "string" ? [step.script] : []),
    ...normalizedLines(step?.inputs?.inlineScript)
  ]);
  if (
    commands.filter((command) => command === "npm ci --ignore-scripts").length !== 1 ||
    commands.filter((command) => command === STABLE_PUBLISH_ATTEMPT).length !== 1 ||
    commands.filter((command) => command === PREVIEW_PUBLISH_ATTEMPT).length !== 1 ||
    commands.filter((command) => command === PROFILE_ID_COMMAND).length !== 1 ||
    commands.filter((command) => command === VERIFY_IDENTITY_COMMAND).length !== 1 ||
    commands.filter((command) => command === VERIFY_ARTIFACT_COMMAND).length !== 2 ||
    commands.filter((command) => command === "node scripts/download-canonical-github-release.mjs canonical-release")
      .length !== 1 ||
    commands.filter((command) => command === "node scripts/verify-marketplace-publication.mjs canonical-release")
      .length !== 1
  ) {
    problems.push(
      "Marketplace promotion must install its lockfile, download, reverify, channel-publish, and publicly verify one canonical artifact."
    );
  }
  if (
    /(?:VSCE_PAT|AZURE_CLIENT_SECRET|clientSecret|password|token:|npm\s+(?:run\s+)?(?:pack|package|build|version)|vsce\s+package|ovsx)/iu.test(
      source
    )
  ) {
    problems.push(
      "Marketplace promotion must not carry secrets, rebuild/reversion artifacts, or publish to another registry."
    );
  }
  const publicVerifierIndex = promotionSteps.findIndex(
    (step) => step?.script === "node scripts/verify-marketplace-publication.mjs canonical-release"
  );
  const azureIndex = promotionSteps.indexOf(azure);
  if (azureIndex < 0 || publicVerifierIndex !== azureIndex + 1) {
    problems.push("Public Marketplace verification must immediately follow the authenticated publication task.");
  }
  const canonicalVerifierIndex = promotionSteps.findIndex((step) => step?.script === VERIFY_ARTIFACT_COMMAND);
  const downloadIndex = promotionSteps.findIndex(
    (step) => step?.script === "node scripts/download-canonical-github-release.mjs canonical-release"
  );
  if (downloadIndex < 0 || canonicalVerifierIndex !== downloadIndex + 1 || azureIndex !== canonicalVerifierIndex + 1) {
    problems.push(
      "No mutable command may intervene between canonical download, verification, and authenticated promotion."
    );
  }
  if (createHash("sha256").update(source, "utf8").digest("hex") !== AUDITED_MARKETPLACE_PIPELINE_SHA256) {
    problems.push("Marketplace promotion YAML differs from the explicitly reviewed pipeline bytes.");
  }
  return problems;
}
