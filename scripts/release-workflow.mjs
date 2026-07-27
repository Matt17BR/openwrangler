import { load as parseYaml } from "js-yaml";

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const PREVIEW_CONDITION = "${{ steps.release_metadata.outputs.prerelease == 'true' }}";
const STABLE_CONDITION = "${{ steps.release_metadata.outputs.prerelease != 'true' }}";
const EVENT_SHA = "${{ github.sha }}";
const EVENT_TAG = "${{ github.ref_name }}";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
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
  if (expected.condition !== undefined && value.if !== expected.condition) {
    problems.push(`release.yml step "${value.name}" has the wrong release-channel condition.`);
  }
  if (expected.run !== undefined && normalizeRun(value.run) !== normalizeRun(expected.run)) {
    problems.push(`release.yml step "${value.name}" must run only its canonical release command.`);
  }
  for (const [key, expectedValue] of Object.entries(expected.env ?? {})) {
    if (!isRecord(value.env) || value.env[key] !== expectedValue) {
      problems.push(`release.yml step "${value.name}" must bind ${key} to ${expectedValue}.`);
    }
  }
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
  if (!isRecord(workflow.permissions) || workflow.permissions.contents !== "read") {
    problems.push("release.yml default contents permission must remain read-only.");
  }
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
    if (
      readiness !== undefined &&
      previewChecksum !== undefined &&
      upload.index <= Math.max(readiness.index, previewChecksum.index)
    ) {
      problems.push("release.yml canonical upload must occur after readiness and checksum creation.");
    }
    const options = upload.step.with;
    if (
      !isRecord(options) ||
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
  if (
    !isRecord(releaseJob) ||
    !Array.isArray(releaseJob.needs) ||
    releaseJob.needs.join("\n") !== "build\nvalidate\nrelease-acceptance" ||
    !isRecord(releaseJob.permissions) ||
    releaseJob.permissions.contents !== "write"
  ) {
    problems.push("release.yml release job must depend on all validation jobs and scope contents: write locally.");
  }
  const releaseActions = releaseSteps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => isRecord(step) && step.uses === "softprops/action-gh-release@v2");
  if (releaseActions.length !== 1) {
    problems.push("release.yml release job must contain exactly one canonical GitHub Release action.");
  } else {
    const options = releaseActions[0].step.with;
    if (
      !isRecord(options) ||
      options.prerelease !== "${{ needs.build.outputs.prerelease == 'true' }}" ||
      options.fail_on_unmatched_files !== true ||
      normalizeLines(options.files).join("\n") !== "release/openwrangler.vsix\nrelease/openwrangler.vsix.sha256"
    ) {
      problems.push("release.yml GitHub Release action must publish only the validated canonical files.");
    }
  }
  const releaseChecksum = releaseSteps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => isRecord(step) && step.name === "Verify release checksum");
  if (releaseChecksum.length !== 1) {
    problems.push("release.yml release job must contain exactly one final checksum verification.");
  } else {
    if (normalizeRun(releaseChecksum[0].step.run) !== normalizeRun(RELEASE_CHECKSUM_RUN)) {
      problems.push("release.yml final checksum step must run only its canonical verification.");
    }
    if (releaseActions.length === 1 && releaseChecksum[0].index >= releaseActions[0].index) {
      problems.push("release.yml final checksum verification must precede GitHub Release creation.");
    }
  }

  return problems;
}
