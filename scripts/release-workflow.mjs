import { load as parseYaml } from "js-yaml";

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const PREVIEW_CONDITION = "${{ steps.release_metadata.outputs.prerelease == 'true' }}";
const STABLE_CONDITION = "${{ steps.release_metadata.outputs.prerelease != 'true' }}";
const EVENT_SHA = "${{ github.sha }}";
const EVENT_TAG = "${{ github.ref_name }}";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const RELEASE_ACTION = "softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65";
const PREVIEW_CHECKSUM_RUN = `const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const digest = createHash("sha256").update(readFileSync("openwrangler.vsix")).digest("hex");
writeFileSync("openwrangler.vsix.sha256", \`\${digest}  openwrangler.vsix\\n\`);`;
const RELEASE_CHECKSUM_RUN = `const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const expectedLine = readFileSync("release/openwrangler.vsix.sha256", "utf8").trim();
const match = /^([0-9a-f]{64})\\s+\\*?openwrangler\\.vsix$/iu.exec(expectedLine);
if (!match) throw new Error(\`Malformed canonical checksum: \${expectedLine}\`);
const actual = createHash("sha256")
.update(readFileSync("release/openwrangler.vsix"))
.digest("hex");
if (actual !== match[1].toLowerCase()) {
throw new Error(\`Release VSIX checksum mismatch: expected \${match[1]}, received \${actual}\`);
}`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeRun(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : undefined;
}

function normalizeLines(value) {
  return typeof value === "string"
    ? value
        .split(/\r?\n/gu)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function uniqueNamedStep(steps, name, problems) {
  const matches = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => isRecord(step) && step.name === name);
  if (matches.length !== 1) {
    problems.push(`release.yml build job must contain exactly one "${name}" step; found ${matches.length}.`);
    return undefined;
  }
  return matches[0];
}

function requireExactStep(step, expected, problems) {
  if (step === undefined) {
    return;
  }
  const value = step.step;
  if (expected.id !== undefined && value.id !== expected.id) {
    problems.push(`release.yml step "${value.name}" must use id ${expected.id}.`);
  }
  if (
    (expected.condition === undefined && hasOwn(value, "if")) ||
    (expected.condition !== undefined && value.if !== expected.condition)
  ) {
    problems.push(`release.yml step "${value.name}" has the wrong release-channel condition.`);
  }
  if (
    (expected.shell === undefined && hasOwn(value, "shell")) ||
    (expected.shell !== undefined && value.shell !== expected.shell)
  ) {
    problems.push(`release.yml step "${value.name}" must use its canonical command shell.`);
  }
  if (hasOwn(value, "continue-on-error") || hasOwn(value, "working-directory")) {
    problems.push(`release.yml step "${value.name}" must not override command execution controls.`);
  }
  if (expected.run !== undefined && normalizeRun(value.run) !== normalizeRun(expected.run)) {
    problems.push(`release.yml step "${value.name}" must run only its canonical release command.`);
  }
  const expectedEnvironment = expected.env;
  if (expectedEnvironment === undefined) {
    if (hasOwn(value, "env")) {
      problems.push(`release.yml step "${value.name}" must not add command environment overrides.`);
    }
  } else if (!isRecord(value.env)) {
    problems.push(`release.yml step "${value.name}" must use only its canonical command environment.`);
  } else {
    for (const [key, expectedValue] of Object.entries(expectedEnvironment)) {
      if (value.env[key] !== expectedValue) {
        problems.push(`release.yml step "${value.name}" must bind ${key} to ${expectedValue}.`);
      }
    }
    if (
      Object.keys(value.env).length !== Object.keys(expectedEnvironment).length ||
      Object.keys(value.env).some((key) => !hasOwn(expectedEnvironment, key))
    ) {
      problems.push(`release.yml step "${value.name}" must use only its canonical command environment.`);
    }
  }
}

function requireDefaultActionControls(step, label, problems) {
  if (
    hasOwn(step, "if") ||
    hasOwn(step, "continue-on-error") ||
    hasOwn(step, "env") ||
    hasOwn(step, "shell") ||
    hasOwn(step, "working-directory")
  ) {
    problems.push(`release.yml ${label} must use default successful action execution controls.`);
  }
}

function hasExactPermissions(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue)
  );
}

function inspectJobExecutionControls(job, name, { allowContentsWrite = false } = {}) {
  const problems = [];
  if (job["runs-on"] !== "ubuntu-latest") {
    problems.push(`release.yml ${name} job must run on canonical ubuntu-latest.`);
  }
  if (hasOwn(job, "env") || hasOwn(job, "defaults")) {
    problems.push(`release.yml ${name} job must not override environment or run defaults.`);
  }
  if (hasOwn(job, "if")) {
    problems.push(`release.yml ${name} job must use the default successful dependency condition.`);
  }
  if (allowContentsWrite) {
    if (!hasExactPermissions(job.permissions, { contents: "write" })) {
      problems.push(`release.yml ${name} job permissions must be exactly contents: write.`);
    }
  } else if (hasOwn(job, "permissions")) {
    problems.push(`release.yml ${name} job must inherit the read-only workflow permissions.`);
  }
  return problems;
}

export function inspectReleaseWorkflow(contents) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_WORKFLOW_BYTES) {
    return ["release.yml must be bounded YAML text."];
  }
  let workflow;
  try {
    workflow = parseYaml(contents);
  } catch {
    return ["release.yml must contain one well-formed YAML document without duplicate keys."];
  }
  if (!isRecord(workflow) || !isRecord(workflow.jobs) || !isRecord(workflow.jobs.build)) {
    return ["release.yml must contain a build job."];
  }
  const problems = [];
  if (
    !isRecord(workflow.on) ||
    !isRecord(workflow.on.push) ||
    !Array.isArray(workflow.on.push.tags) ||
    workflow.on.push.tags.length !== 1 ||
    workflow.on.push.tags[0] !== "v*"
  ) {
    problems.push('release.yml must trigger only from pushed "v*" tags.');
  }
  if (!hasExactPermissions(workflow.permissions, { contents: "read" })) {
    problems.push("release.yml default permissions must be exactly contents: read.");
  }
  if (hasOwn(workflow, "env") || hasOwn(workflow, "defaults")) {
    problems.push("release.yml must not override workflow environment or run defaults.");
  }
  problems.push(...inspectJobExecutionControls(workflow.jobs.build, "build"));
  const steps = workflow.jobs.build.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 128) {
    return [...problems, "release.yml build job must contain a bounded non-empty steps array."];
  }

  const metadata = uniqueNamedStep(steps, "Validate release tag and manifest channel", problems);
  const previewPackage = uniqueNamedStep(steps, "Package canonical preview VSIX", problems);
  const stablePackage = uniqueNamedStep(steps, "Package stable VSIX candidate", problems);
  const sourceCheck = uniqueNamedStep(steps, "Verify exact tagged source after packaging", problems);
  const previewVerification = uniqueNamedStep(steps, "Verify canonical preview VSIX", problems);
  const stableVerification = uniqueNamedStep(steps, "Verify stable VSIX candidate", problems);
  const readiness = uniqueNamedStep(steps, "Enforce stable release readiness and publish immutable snapshot", problems);
  const previewChecksum = uniqueNamedStep(steps, "Create canonical preview checksum", problems);

  requireExactStep(
    metadata,
    {
      env: { RELEASE_TAG: EVENT_TAG },
      id: "release_metadata",
      run: "node scripts/release-metadata.mjs"
    },
    problems
  );
  requireExactStep(
    previewPackage,
    {
      condition: PREVIEW_CONDITION,
      run: "npm run package -- --pre-release --out openwrangler.vsix"
    },
    problems
  );
  requireExactStep(
    stablePackage,
    {
      condition: STABLE_CONDITION,
      run: "npm run package -- --out openwrangler.candidate.vsix"
    },
    problems
  );
  requireExactStep(
    sourceCheck,
    {
      env: { EXPECTED_SHA: EVENT_SHA },
      shell: "bash",
      run: `test "$(git rev-parse HEAD)" = "$(git rev-parse "\${EXPECTED_SHA}^{commit}")"
git update-index -q --refresh
git diff-index --quiet HEAD --`
    },
    problems
  );
  requireExactStep(
    previewVerification,
    {
      condition: PREVIEW_CONDITION,
      run: "npm run verify:vsix -- openwrangler.vsix"
    },
    problems
  );
  requireExactStep(
    stableVerification,
    {
      condition: STABLE_CONDITION,
      run: "npm run verify:vsix -- openwrangler.candidate.vsix"
    },
    problems
  );
  requireExactStep(
    readiness,
    {
      condition: STABLE_CONDITION,
      env: {
        EXPECTED_SHA: EVENT_SHA,
        RELEASE_TAG: EVENT_TAG
      },
      run: "npm run release:readiness -- openwrangler.candidate.vsix --out openwrangler.vsix --checksum-out openwrangler.vsix.sha256"
    },
    problems
  );
  requireExactStep(
    previewChecksum,
    {
      condition: PREVIEW_CONDITION,
      shell: "node {0}",
      run: PREVIEW_CHECKSUM_RUN
    },
    problems
  );

  const ordered = [
    metadata,
    previewPackage,
    stablePackage,
    sourceCheck,
    previewVerification,
    stableVerification,
    readiness,
    previewChecksum
  ];
  if (
    ordered.every((entry) => entry !== undefined) &&
    ordered.some((entry, index) => index > 0 && entry.index <= ordered[index - 1].index)
  ) {
    problems.push("release.yml build release-gate steps must remain in canonical order.");
  }

  const uploads = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => isRecord(step) && step.uses === UPLOAD_ACTION);
  if (uploads.length !== 1) {
    problems.push(`release.yml build job must contain exactly one canonical release upload; found ${uploads.length}.`);
  } else {
    const upload = uploads[0];
    requireDefaultActionControls(upload.step, "canonical upload", problems);
    if (readiness !== undefined && previewChecksum !== undefined) {
      if (previewChecksum.index !== readiness.index + 1 || upload.index !== previewChecksum.index + 1) {
        problems.push("release.yml readiness, preview checksum, and canonical upload must be one exact final chain.");
      }
      if (upload.index !== steps.length - 1) {
        problems.push("release.yml canonical upload must be the final build step.");
      }
    }
    const options = upload.step.with;
    if (
      !isRecord(options) ||
      Object.keys(options).length !== 4 ||
      options.name !== "openwrangler-release" ||
      options["if-no-files-found"] !== "error" ||
      options["compression-level"] !== 0 ||
      normalizeLines(options.path).join("\n") !== "openwrangler.vsix\nopenwrangler.vsix.sha256"
    ) {
      problems.push("release.yml canonical upload must publish only the verified VSIX and checksum.");
    }
  }

  const releaseJob = workflow.jobs.release;
  const releaseSteps = isRecord(releaseJob) && Array.isArray(releaseJob.steps) ? releaseJob.steps : [];
  if (isRecord(releaseJob)) {
    problems.push(...inspectJobExecutionControls(releaseJob, "release", { allowContentsWrite: true }));
  }
  if (
    !isRecord(releaseJob) ||
    !Array.isArray(releaseJob.needs) ||
    releaseJob.needs.join("\n") !== "build\nvalidate\nrelease-acceptance" ||
    !hasExactPermissions(releaseJob.permissions, { contents: "write" })
  ) {
    problems.push("release.yml release job must depend on all validation jobs with only local contents: write.");
  }
  if (releaseSteps.length !== 3 || releaseSteps.some((step) => !isRecord(step))) {
    problems.push("release.yml release job must contain exactly download, checksum, and release steps.");
  }
  const releaseDownload = releaseSteps[0];
  if (
    !isRecord(releaseDownload) ||
    releaseDownload.uses !== DOWNLOAD_ACTION ||
    !isRecord(releaseDownload.with) ||
    Object.keys(releaseDownload.with).length !== 2 ||
    releaseDownload.with.name !== "openwrangler-release" ||
    releaseDownload.with.path !== "release"
  ) {
    problems.push("release.yml release job must begin with the pinned canonical artifact download.");
  } else {
    requireDefaultActionControls(releaseDownload, "release download", problems);
  }
  const releaseChecksum = releaseSteps[1];
  if (!isRecord(releaseChecksum) || releaseChecksum.name !== "Verify release checksum") {
    problems.push("release.yml canonical download must be followed immediately by final checksum verification.");
  } else {
    requireExactStep({ index: 1, step: releaseChecksum }, { run: RELEASE_CHECKSUM_RUN, shell: "node {0}" }, problems);
  }
  const releaseAction = releaseSteps[2];
  if (!isRecord(releaseAction) || releaseAction.uses !== RELEASE_ACTION) {
    problems.push("release.yml final checksum verification must be followed immediately by GitHub Release creation.");
  } else {
    requireDefaultActionControls(releaseAction, "GitHub Release action", problems);
    const options = releaseAction.with;
    if (
      !isRecord(options) ||
      Object.keys(options).length !== 4 ||
      options.prerelease !== "${{ needs.build.outputs.prerelease == 'true' }}" ||
      options.generate_release_notes !== true ||
      options.fail_on_unmatched_files !== true ||
      normalizeLines(options.files).join("\n") !== "release/openwrangler.vsix\nrelease/openwrangler.vsix.sha256"
    ) {
      problems.push("release.yml GitHub Release action must publish only the validated canonical files.");
    }
  }

  return problems;
}

const STABLE_CANDIDATE_ARTIFACT_PATHS = [
  "canonical-release/openwrangler.vsix",
  "canonical-release/openwrangler.vsix.sha256",
  "canonical-release/openwrangler.vsix.provenance.json"
];
const STABLE_REPORT_PATH =
  "${{ runner.temp }}/openwrangler-installed-performance-${{ github.run_id }}-${{ github.run_attempt }}.json";

function exactRecord(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, expectedValue]) => {
      const actual = value[key];
      if (Array.isArray(expectedValue)) {
        return (
          Array.isArray(actual) &&
          actual.length === expectedValue.length &&
          expectedValue.every((entry, index) => actual[index] === entry)
        );
      }
      if (isRecord(expectedValue)) {
        return exactRecord(actual, expectedValue);
      }
      return actual === expectedValue;
    })
  );
}

function stableCandidateStep(steps, predicate, label, problems) {
  const matches = steps.map((step, index) => ({ index, step })).filter(({ step }) => isRecord(step) && predicate(step));
  if (matches.length !== 1) {
    problems.push(`stable-candidate.yml must contain exactly one ${label}; found ${matches.length}.`);
    return undefined;
  }
  return matches[0];
}

function defaultStableStepControls(step) {
  return (
    !hasOwn(step, "if") &&
    !hasOwn(step, "continue-on-error") &&
    !hasOwn(step, "shell") &&
    !hasOwn(step, "working-directory")
  );
}

export function inspectStableCandidateWorkflow(contents) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_WORKFLOW_BYTES) {
    return ["stable-candidate.yml must be bounded YAML text."];
  }
  let workflow;
  try {
    workflow = parseYaml(contents);
  } catch {
    return ["stable-candidate.yml must contain one well-formed YAML document without duplicate keys."];
  }
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    return ["stable-candidate.yml must contain one jobs object."];
  }

  const problems = [];
  const dispatch = workflow.on?.workflow_dispatch;
  if (
    !isRecord(workflow.on) ||
    Object.keys(workflow.on).length !== 1 ||
    !exactRecord(dispatch?.inputs, {
      release_tag: {
        description: "Intended stable tag matching package.json, for example v1.0.0",
        required: true,
        type: "string"
      }
    })
  ) {
    problems.push("stable-candidate.yml must have only one manual release_tag dispatch trigger.");
  }
  if (!hasExactPermissions(workflow.permissions, { contents: "read" })) {
    problems.push("stable-candidate.yml permissions must be exactly contents: read.");
  }
  if (
    !exactRecord(workflow.concurrency, {
      group: "stable-candidate-${{ github.sha }}",
      "cancel-in-progress": false
    })
  ) {
    problems.push("stable-candidate.yml must retain exact-source concurrency without cancellation.");
  }
  if (hasOwn(workflow, "env") || hasOwn(workflow, "defaults")) {
    problems.push("stable-candidate.yml must not override workflow environment or run defaults.");
  }
  if (
    Object.keys(workflow.jobs).length !== 2 ||
    !isRecord(workflow.jobs.package) ||
    !isRecord(workflow.jobs["installed-performance"])
  ) {
    problems.push("stable-candidate.yml must contain only package and installed-performance jobs.");
    return problems;
  }

  const packaging = workflow.jobs.package;
  if (
    packaging["runs-on"] !== "ubuntu-latest" ||
    packaging["timeout-minutes"] !== 60 ||
    !exactRecord(packaging.outputs, {
      "artifact-id": "${{ steps.candidate_artifact.outputs.artifact-id }}"
    }) ||
    ["if", "env", "defaults", "permissions", "continue-on-error"].some((key) => hasOwn(packaging, key))
  ) {
    problems.push("stable-candidate.yml package job must retain its hosted read-only execution contract.");
  }
  const packageSteps = Array.isArray(packaging.steps) ? packaging.steps : [];
  if (packageSteps.length === 0 || packageSteps.length > 64 || packageSteps.some((step) => !isRecord(step))) {
    problems.push("stable-candidate.yml package job must contain one bounded steps array.");
    return problems;
  }
  const sourceGuard = stableCandidateStep(
    packageSteps,
    (step) => step.name === "Require protected main source",
    "protected-main guard",
    problems
  );
  if (
    sourceGuard?.index !== 0 ||
    !exactRecord(sourceGuard?.step.env, {
      EVENT_REF: "${{ github.ref }}",
      EVENT_REF_PROTECTED: "${{ github.ref_protected }}"
    }) ||
    normalizeRun(sourceGuard?.step.run) !==
      'test "$EVENT_REF" = "refs/heads/main" test "$EVENT_REF_PROTECTED" = "true"' ||
    !defaultStableStepControls(sourceGuard?.step)
  ) {
    problems.push("stable-candidate.yml must fail first unless the dispatch uses protected main.");
  }
  const packageCheckout = stableCandidateStep(
    packageSteps,
    (step) => step.uses === "actions/checkout@v6",
    "package checkout",
    problems
  );
  if (
    !exactRecord(packageCheckout?.step.with, {
      "fetch-depth": 0,
      "persist-credentials": false
    }) ||
    !defaultStableStepControls(packageCheckout?.step) ||
    hasOwn(packageCheckout?.step ?? {}, "env")
  ) {
    problems.push("stable-candidate.yml package checkout must fetch all tags without push credentials.");
  }
  const metadata = stableCandidateStep(
    packageSteps,
    (step) => step.id === "release_metadata",
    "stable metadata guard",
    problems
  );
  if (
    metadata?.step.name !== "Validate intended stable metadata" ||
    metadata?.step.run !== "node scripts/release-metadata.mjs" ||
    !exactRecord(metadata?.step.env, { RELEASE_TAG: "${{ inputs.release_tag }}" }) ||
    !defaultStableStepControls(metadata?.step)
  ) {
    problems.push("stable-candidate.yml must validate the intended tag against stable package metadata.");
  }
  const previewRejection = stableCandidateStep(
    packageSteps,
    (step) => step.name === "Reject preview metadata",
    "preview metadata rejection",
    problems
  );
  if (
    previewRejection?.step.if !== "${{ steps.release_metadata.outputs.prerelease != 'false' }}" ||
    previewRejection?.step.run !== "exit 1" ||
    ["env", "continue-on-error", "shell", "working-directory"].some((key) => hasOwn(previewRejection?.step ?? {}, key))
  ) {
    problems.push("stable-candidate.yml must fail rather than package preview metadata.");
  }
  const packageTag = stableCandidateStep(
    packageSteps,
    (step) => step.name === "Prepare exact local intended tag",
    "package intended-tag guard",
    problems
  );
  if (
    packageTag?.step.run !== "node scripts/prepare-stable-candidate-tag.mjs" ||
    !exactRecord(packageTag?.step.env, {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    }) ||
    !defaultStableStepControls(packageTag?.step)
  ) {
    problems.push("stable-candidate.yml producer must bind one non-pushed local intended tag.");
  }
  const packageCommand = stableCandidateStep(
    packageSteps,
    (step) => normalizeRun(step.run) === "npm run package -- --out openwrangler.candidate.vsix",
    "stable package command",
    problems
  );
  const producer = stableCandidateStep(
    packageSteps,
    (step) => step.name === "Publish canonical candidate set",
    "canonical artifact producer",
    problems
  );
  if (
    normalizeRun(producer?.step.run) !==
      "node scripts/create-canonical-release-artifact.mjs openwrangler.candidate.vsix --out-dir canonical-release" ||
    !exactRecord(producer?.step.env, {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    }) ||
    !defaultStableStepControls(producer?.step)
  ) {
    problems.push("stable-candidate.yml must publish one exact source-bound canonical artifact set.");
  }
  const candidateUpload = stableCandidateStep(
    packageSteps,
    (step) => step.name === "Upload canonical candidate set",
    "canonical candidate upload",
    problems
  );
  if (
    candidateUpload?.step.id !== "candidate_artifact" ||
    candidateUpload?.step.uses !== UPLOAD_ACTION ||
    !exactRecord(candidateUpload?.step.with, {
      name: "openwrangler-stable-candidate",
      path: `${STABLE_CANDIDATE_ARTIFACT_PATHS.join("\n")}\n`,
      "if-no-files-found": "error",
      "retention-days": 14,
      "compression-level": 0,
      "include-hidden-files": false
    }) ||
    !defaultStableStepControls(candidateUpload?.step) ||
    hasOwn(candidateUpload?.step ?? {}, "env")
  ) {
    problems.push("stable-candidate.yml must upload only the exact three-file canonical artifact set.");
  }
  if (
    packageCommand === undefined ||
    sourceGuard === undefined ||
    packageCheckout === undefined ||
    metadata === undefined ||
    previewRejection === undefined ||
    packageTag === undefined ||
    producer === undefined ||
    candidateUpload === undefined ||
    !(
      sourceGuard.index < packageCheckout.index &&
      packageCheckout.index < metadata.index &&
      metadata.index < previewRejection.index &&
      previewRejection.index < packageTag.index &&
      packageTag.index < packageCommand.index
    ) ||
    candidateUpload.index !== producer.index + 1 ||
    candidateUpload.index !== packageSteps.length - 1
  ) {
    problems.push("stable-candidate.yml canonical production and upload must be one immutable final chain.");
  }

  const performance = workflow.jobs["installed-performance"];
  if (
    performance.needs !== "package" ||
    !Array.isArray(performance["runs-on"]) ||
    performance["runs-on"].join("\n") !== "self-hosted\nlinux\nx64\nopenwrangler-performance" ||
    performance["timeout-minutes"] !== 120 ||
    ["if", "env", "defaults", "permissions", "continue-on-error"].some((key) => hasOwn(performance, key))
  ) {
    problems.push("stable-candidate.yml installed performance must use the protected Linux reference runner.");
  }
  const performanceSteps = Array.isArray(performance.steps) ? performance.steps : [];
  if (
    performanceSteps.length === 0 ||
    performanceSteps.length > 64 ||
    performanceSteps.some((step) => !isRecord(step))
  ) {
    problems.push("stable-candidate.yml installed-performance job must contain one bounded steps array.");
    return problems;
  }
  const performanceCheckout = stableCandidateStep(
    performanceSteps,
    (step) => step.uses === "actions/checkout@v6",
    "installed-performance checkout",
    problems
  );
  if (
    !exactRecord(performanceCheckout?.step.with, {
      ref: EVENT_SHA,
      "fetch-depth": 0,
      "persist-credentials": false
    }) ||
    !defaultStableStepControls(performanceCheckout?.step) ||
    hasOwn(performanceCheckout?.step ?? {}, "env")
  ) {
    problems.push("stable-candidate.yml consumer must check out the exact producer SHA with all tags.");
  }
  const performanceTag = stableCandidateStep(
    performanceSteps,
    (step) => step.name === "Prepare exact local intended tag",
    "consumer intended-tag guard",
    problems
  );
  if (
    performanceTag?.step.run !== "node scripts/prepare-stable-candidate-tag.mjs" ||
    !exactRecord(performanceTag?.step.env, {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    }) ||
    !defaultStableStepControls(performanceTag?.step)
  ) {
    problems.push("stable-candidate.yml consumer must bind the same non-pushed local intended tag.");
  }
  const download = stableCandidateStep(
    performanceSteps,
    (step) => step.uses === DOWNLOAD_ACTION,
    "exact candidate artifact download",
    problems
  );
  if (
    !exactRecord(download?.step.with, {
      "artifact-ids": "${{ needs.package.outputs.artifact-id }}",
      path: "canonical-release",
      "merge-multiple": true
    }) ||
    !defaultStableStepControls(download?.step) ||
    hasOwn(download?.step ?? {}, "env")
  ) {
    problems.push("stable-candidate.yml consumer must download only the producer's exact artifact ID.");
  }
  const benchmark = stableCandidateStep(
    performanceSteps,
    (step) => step.id === "installed_performance",
    "stable installed-performance command",
    problems
  );
  const expectedBenchmark = [
    "npm run benchmark:installed --",
    "--candidate-in canonical-release/openwrangler.vsix",
    "--candidate-checksum canonical-release/openwrangler.vsix.sha256",
    "--candidate-provenance canonical-release/openwrangler.vsix.provenance.json",
    `--out ${STABLE_REPORT_PATH}`
  ].join(" ");
  if (
    benchmark?.step.name !== "Test exact canonical candidate in VS Code and Cursor" ||
    normalizeRun(benchmark?.step.run) !== expectedBenchmark ||
    !exactRecord(benchmark?.step.env, {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    }) ||
    !defaultStableStepControls(benchmark?.step)
  ) {
    problems.push("stable-candidate.yml consumer must run one unsharded consume-only stable benchmark.");
  }
  const reportUpload = stableCandidateStep(
    performanceSteps,
    (step) => step.name === "Upload installed-performance evidence",
    "installed-performance report upload",
    problems
  );
  if (
    reportUpload?.step.uses !== UPLOAD_ACTION ||
    !exactRecord(reportUpload?.step.with, {
      name: "openwrangler-installed-performance",
      path: STABLE_REPORT_PATH,
      "if-no-files-found": "error",
      "retention-days": 90,
      "compression-level": 9,
      "include-hidden-files": false
    }) ||
    !defaultStableStepControls(reportUpload?.step) ||
    hasOwn(reportUpload?.step ?? {}, "env") ||
    performanceCheckout === undefined ||
    performanceTag === undefined ||
    download === undefined ||
    benchmark === undefined ||
    !(
      performanceCheckout.index < performanceTag.index &&
      performanceTag.index < download.index &&
      download.index < benchmark.index
    ) ||
    reportUpload?.index !== benchmark.index + 1 ||
    reportUpload?.index !== performanceSteps.length - 1
  ) {
    problems.push("stable-candidate.yml must upload only the successful path-free report immediately.");
  }

  const allCommands = [...packageSteps, ...performanceSteps].map((step) => normalizeRun(step.run)).filter(Boolean);
  if (allCommands.filter((command) => command.startsWith("npm run package ")).length !== 1) {
    problems.push("stable-candidate.yml must package the production extension exactly once.");
  }
  if (
    performanceSteps.some((step) => /\bnpm run (?:package|build)(?:\s|$)/u.test(step.run ?? "")) ||
    /(?:vsce|ovsx)\s+publish|gh\s+release|git\s+push|action-gh-release/iu.test(contents)
  ) {
    problems.push("stable-candidate.yml must never rebuild, publish, push, shard, or retry stable evidence.");
  }
  return [...new Set(problems)];
}
