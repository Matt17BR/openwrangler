import { load as parseYaml } from "js-yaml";
import { parseStrictJson } from "./strict-json.mjs";

const MAX_PIPELINE_BYTES = 32 * 1024;
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_LOCK_BYTES = 16 * 1024 * 1024;
const SERVICE_CONNECTION = "openwrangler-marketplace-publishing";
const VSCE_PACKAGE = "@vscode/vsce";
const VSCE_LOCK_PATH = "node_modules/@vscode/vsce";

function mandatory(step, condition) {
  return (
    step !== undefined &&
    step.condition === condition &&
    (step.continueOnError === undefined || step.continueOnError === false)
  );
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
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_PIPELINE_BYTES)
    return ["Marketplace promotion must be bounded UTF-8 YAML."];
  let pipeline;
  try {
    pipeline = parseYaml(source);
  } catch {
    return ["Marketplace promotion must contain valid YAML."];
  }
  const problems = [];
  const intake = pipeline?.stages?.find((stage) => stage.stage === "Intake");
  const promote = pipeline?.stages?.find((stage) => stage.stage === "Promote");
  const bind = intake?.jobs?.find((job) => job.job === "Bind");
  const deployment = promote?.jobs?.find((job) => job.deployment === "Marketplace");
  const intakeSteps = bind?.steps ?? [];
  const promotionSteps = deployment?.strategy?.runOnce?.deploy?.steps ?? [];
  if (!Array.isArray(intakeSteps) || !Array.isArray(promotionSteps))
    return ["Marketplace intake and deployment need their release steps."];
  const service = pipeline?.parameters?.find((parameter) => parameter.name === "marketplaceServiceConnection");
  if (
    !mandatory(intake) ||
    !mandatory(bind) ||
    !mandatory(deployment) ||
    pipeline?.pr !== "none" ||
    !pipeline.trigger?.branches?.include?.includes("main") ||
    !pipeline.trigger?.tags?.include?.includes("v*") ||
    service?.default !== SERVICE_CONNECTION ||
    JSON.stringify(service.values) !== JSON.stringify([SERVICE_CONNECTION]) ||
    promote?.dependsOn !== "Intake" ||
    promote.condition !== "and(succeeded(), eq(dependencies.Intake.outputs['Bind.release_intake.promote'], 'true'))" ||
    promote.lockBehavior !== "sequential" ||
    deployment?.environment !== SERVICE_CONNECTION
  )
    problems.push(
      "Marketplace publication needs validated release intake, no PR trigger and the protected sequential WIF environment."
    );
  const intakeScript = intakeSteps.find((step) => step.name === "release_intake");
  if (
    !mandatory(intakeScript) ||
    intakeScript.script?.trim() !== "node scripts/marketplace-release-intake.mjs" ||
    intakeScript.env?.BUILD_REASON !== "$(Build.Reason)" ||
    intakeScript.env?.BUILD_SOURCEBRANCH !== "$(Build.SourceBranch)" ||
    intakeScript.env?.BUILD_SOURCEVERSION !== "$(Build.SourceVersion)" ||
    intakeScript.env?.EXISTING_RELEASE_TAG !== "${{ parameters.existingReleaseTag }}" ||
    deployment?.variables?.releaseCommit !==
      "$[stageDependencies.Intake.Bind.outputs['release_intake.releaseCommit']]" ||
    deployment?.variables?.releasePrerelease !==
      "$[stageDependencies.Intake.Bind.outputs['release_intake.releasePrerelease']]" ||
    deployment?.variables?.releaseTag !== "$[stageDependencies.Intake.Bind.outputs['release_intake.releaseTag']]"
  )
    problems.push("Promotion must consume the exact source, channel and tag admitted by release intake.");
  for (const list of [intakeSteps, promotionSteps]) {
    if (
      list.some((step) => step.checkout !== undefined && step.persistCredentials !== false) ||
      !list.some(
        (step) =>
          mandatory(step) &&
          step.checkout === "self" &&
          step.fetchDepth === 0 &&
          step.fetchTags === true &&
          step.persistCredentials === false
      )
    )
      problems.push("Release intake and promotion require the full checkout without persisted credentials.");
  }
  const run = (command) => promotionSteps.find((step) => step.script?.trim() === command);
  const install = run("npm ci --ignore-scripts");
  const download = run("node scripts/download-canonical-github-release.mjs canonical-release");
  const artifact = run("node scripts/verify-registry-release-artifact.mjs canonical-release");
  const probe = run("node scripts/verify-marketplace-publication.mjs canonical-release --probe-existing");
  const verify = run("node scripts/verify-marketplace-publication.mjs canonical-release");
  const azure = promotionSteps.find((step) => step.task === "AzureCLI@2");
  const bound = (step) =>
    step?.env?.AUTOMATION_SHA === "$(Build.SourceVersion)" &&
    step.env.EXPECTED_SHA === "$(releaseCommit)" &&
    step.env.RELEASE_PRERELEASE === "$(releasePrerelease)" &&
    step.env.RELEASE_TAG === "$(releaseTag)";
  if (
    !mandatory(install) ||
    !mandatory(download) ||
    download.env?.RELEASE_PRERELEASE !== "$(releasePrerelease)" ||
    download.env?.RELEASE_TAG !== "$(releaseTag)" ||
    [artifact, probe].some((step) => !mandatory(step) || !bound(step))
  )
    problems.push(
      "Download, artifact verification and existing-public probe must fail closed for the admitted release."
    );
  const skipExisting = "and(succeeded(), ne(variables['marketplaceAlreadyPublic'], 'true'))";
  if (
    !mandatory(verify, skipExisting) ||
    !bound(verify) ||
    !mandatory(azure, skipExisting) ||
    !bound(azure) ||
    azure.inputs?.azureSubscription !== "${{ parameters.marketplaceServiceConnection }}" ||
    azure.inputs?.scriptType !== "bash" ||
    azure.inputs?.scriptLocation !== "inlineScript" ||
    azure.inputs?.addSpnToEnvironment !== false ||
    azure.inputs?.visibleAzLogin !== false
  )
    problems.push(
      "Only the protected WIF task may publish; exact existing bytes or mandatory public verification must determine success."
    );
  const lines =
    typeof azure?.inputs?.inlineScript === "string"
      ? azure.inputs.inlineScript.split(/\r?\n/u).map((line) => line.trim())
      : [];
  if (
    !lines.includes("set -euo pipefail") ||
    !lines.includes("node scripts/marketplace-identity-profile.mjs") ||
    !lines.includes("npx --no-install vsce verify-pat Matt17BR --azure-credential") ||
    !lines.includes("node scripts/verify-registry-release-artifact.mjs canonical-release") ||
    !lines.some((line) =>
      line.startsWith(
        "npx --no-install vsce publish --azure-credential --packagePath canonical-release/openwrangler.vsix --skip-duplicate"
      )
    ) ||
    !lines.some((line) =>
      line.startsWith(
        "npx --no-install vsce publish --azure-credential --packagePath canonical-release/openwrangler.vsix --pre-release --skip-duplicate"
      )
    ) ||
    !lines.includes('if [ "$RELEASE_PRERELEASE" = "true" ]; then') ||
    !lines.includes('elif [ "$RELEASE_PRERELEASE" = "false" ]; then')
  )
    problems.push("WIF publication must validate identity and canonical bytes and select the bound package channel.");
  if (!(
    promotionSteps.indexOf(install) < promotionSteps.indexOf(download) &&
    promotionSteps.indexOf(download) < promotionSteps.indexOf(artifact) &&
    promotionSteps.indexOf(artifact) < promotionSteps.indexOf(probe) &&
    promotionSteps.indexOf(probe) < promotionSteps.indexOf(azure) &&
    promotionSteps.indexOf(azure) < promotionSteps.indexOf(verify)
  ))
    problems.push(
      "Artifact verification and existing-public probe must precede authentication; public verification follows publication."
    );
  const scripts = [...intakeSteps, ...promotionSteps]
    .map((step) => `${step.script ?? ""}\n${step.inputs?.inlineScript ?? ""}`)
    .join("\n");
  if (
    /(?:VSCE_PAT|AZURE_CLIENT_SECRET|clientSecret|password|token:|npm\s+(?:run\s+)?(?:pack|package|build|version)|vsce\s+package|ovsx)/iu.test(
      scripts
    ) ||
    /(?:VSCE_PAT|AZURE_CLIENT_SECRET|clientSecret|password|"token":)/iu.test(JSON.stringify(pipeline))
  )
    problems.push(
      "Marketplace promotion must not expose credentials or rebuild, reversion or publish to another registry."
    );
  return problems;
}
