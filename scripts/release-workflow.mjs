import { isDeepStrictEqual } from "node:util";
import { load as parseYaml } from "js-yaml";
import { inspectPreviewReleaseWorkflow } from "./preview-release-workflow.mjs";

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const EVENT_SHA = "${{ github.sha }}";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const CHECKOUT_ACTION = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE_ACTION = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const SETUP_PYTHON_ACTION = "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1";
const STABLE_CANDIDATE_ARTIFACT_PATHS = [
  "performance-evidence/openwrangler.vsix",
  "performance-evidence/openwrangler.vsix.sha256",
  "performance-evidence/openwrangler.vsix.provenance.json"
];
const STABLE_REPORT_PATH =
  "${{ runner.temp }}/openwrangler-installed-performance-${{ github.run_id }}-${{ github.run_attempt }}.json";
const STABLE_PACKAGE_STEPS = [
  {
    name: "Require dedicated evidence branch source",
    env: {
      EVENT_REF: "${{ github.ref }}",
      EVENT_REF_TYPE: "${{ github.ref_type }}",
      EXPECTED_SHA: EVENT_SHA
    },
    run: `test "$EVENT_REF_TYPE" = "branch"
case "$EVENT_REF" in refs/heads/release/1.0-evidence-*) ;; *) exit 1 ;; esac
case "$EXPECTED_SHA" in *[!0-9a-f]*|"") exit 1 ;; esac
test "\${#EXPECTED_SHA}" -eq 40
`
  },
  {
    uses: CHECKOUT_ACTION,
    with: {
      ref: EVENT_SHA,
      "fetch-depth": 0,
      "persist-credentials": false
    }
  },
  {
    name: "Require exact protected-main descendant",
    env: {
      EXPECTED_SHA: EVENT_SHA
    },
    run: `test "$(git rev-parse --verify HEAD^{commit})" = "$EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
git rev-parse --verify refs/remotes/origin/main^{commit} >/dev/null
git merge-base --is-ancestor refs/remotes/origin/main "$EXPECTED_SHA"
`
  },
  {
    uses: SETUP_NODE_ACTION,
    with: {
      "node-version": 22,
      cache: "npm"
    }
  },
  {
    uses: SETUP_PYTHON_ACTION,
    with: {
      "python-version": "3.12",
      cache: "pip"
    }
  },
  {
    id: "release_metadata",
    name: "Validate intended stable metadata",
    env: {
      RELEASE_TAG: "${{ inputs.release_tag }}"
    },
    run: "node scripts/release-metadata.mjs"
  },
  {
    name: "Reject preview metadata",
    if: "${{ steps.release_metadata.outputs.prerelease != 'false' }}",
    run: "exit 1"
  },
  {
    name: "Prepare exact local intended tag",
    env: {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    },
    run: "node scripts/prepare-stable-candidate-tag.mjs"
  },
  { run: "npm ci" },
  { run: "python -m pip install --upgrade pip" },
  { run: 'python -m pip install -e "python[dev]"' },
  {
    run: 'python -m pip install --no-deps "https://files.pythonhosted.org/packages/90/b0/114463d056b6b328d45557001e848b8ab15539bd8f4fa7a457ccb83e2b5d/uv-0.11.32-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl#sha256=3da76cd4e2697de30928b8a8524bd39183ac1e08cb7e72833807c022b7cba6c4"'
  },
  {
    name: "Package stable candidate once",
    run: "npm run package -- --out openwrangler.candidate.vsix"
  },
  { run: "npm run verify:vsix -- openwrangler.candidate.vsix" },
  {
    name: "Publish performance-evidence candidate set",
    env: {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    },
    run: "node scripts/create-canonical-release-artifact.mjs openwrangler.candidate.vsix --out-dir performance-evidence --performance-evidence"
  },
  {
    id: "candidate_artifact",
    name: "Upload performance-evidence candidate set",
    uses: UPLOAD_ACTION,
    with: {
      name: "openwrangler-performance-evidence-candidate",
      path: `${STABLE_CANDIDATE_ARTIFACT_PATHS.join("\n")}\n`,
      "if-no-files-found": "error",
      "retention-days": 14,
      "compression-level": 0,
      "include-hidden-files": false
    }
  }
];
const STABLE_PERFORMANCE_STEPS = [
  {
    uses: CHECKOUT_ACTION,
    with: {
      ref: EVENT_SHA,
      "fetch-depth": 0,
      "persist-credentials": false
    }
  },
  {
    uses: SETUP_NODE_ACTION,
    with: {
      "node-version": 22,
      cache: "npm"
    }
  },
  {
    uses: SETUP_PYTHON_ACTION,
    with: {
      "python-version": "3.12",
      cache: "pip"
    }
  },
  { run: "npm ci" },
  { run: "python -m pip install --upgrade pip" },
  { run: 'python -m pip install -e "python[dev]"' },
  {
    name: "Prepare exact local intended tag",
    env: {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    },
    run: "node scripts/prepare-stable-candidate-tag.mjs"
  },
  {
    uses: DOWNLOAD_ACTION,
    with: {
      "artifact-ids": "${{ needs.package.outputs.artifact-id }}",
      path: "performance-evidence",
      "merge-multiple": true
    }
  },
  {
    id: "installed_performance",
    name: "Test exact evidence candidate in pinned VS Code and Cursor",
    env: {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    },
    run: [
      "/usr/bin/dbus-run-session -- npm run benchmark:installed --",
      "--pinned-editors",
      "--performance-evidence",
      "--candidate-in performance-evidence/openwrangler.vsix",
      "--candidate-checksum performance-evidence/openwrangler.vsix.sha256",
      "--candidate-provenance performance-evidence/openwrangler.vsix.provenance.json",
      `--out ${STABLE_REPORT_PATH}`
    ].join(" ")
  },
  {
    name: "Upload failed numeric installed-performance evidence",
    if: "${{ always() && steps.installed_performance.outcome == 'failure' && steps.installed_performance.outputs.evidence_ready == 'true' }}",
    uses: UPLOAD_ACTION,
    with: {
      name: "openwrangler-installed-performance-numeric-failure",
      path: "${{ steps.installed_performance.outputs.evidence_path }}",
      "if-no-files-found": "error",
      "retention-days": 7,
      "compression-level": 9,
      "include-hidden-files": false
    }
  },
  {
    name: "Upload installed-performance evidence",
    if: "${{ steps.installed_performance.outcome == 'success' }}",
    uses: UPLOAD_ACTION,
    with: {
      name: "openwrangler-installed-performance",
      path: STABLE_REPORT_PATH,
      "if-no-files-found": "error",
      "retention-days": 90,
      "compression-level": 9,
      "include-hidden-files": false
    }
  }
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeRun(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : undefined;
}

function hasExactPermissions(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue)
  );
}

export function inspectReleaseWorkflow(contents) {
  return inspectPreviewReleaseWorkflow(contents);
}

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
    packaging["runs-on"] !== "ubuntu-24.04" ||
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
  if (!isDeepStrictEqual(packageSteps, STABLE_PACKAGE_STEPS)) {
    problems.push("stable-candidate.yml package job must retain its exact pinned ordered step allowlist.");
  }
  const sourceGuard = stableCandidateStep(
    packageSteps,
    (step) => step.name === "Require dedicated evidence branch source",
    "dedicated evidence-branch guard",
    problems
  );
  if (
    sourceGuard?.index !== 0 ||
    !exactRecord(sourceGuard?.step.env, {
      EVENT_REF: "${{ github.ref }}",
      EVENT_REF_TYPE: "${{ github.ref_type }}",
      EXPECTED_SHA: EVENT_SHA
    }) ||
    normalizeRun(sourceGuard?.step.run) !==
      'test "$EVENT_REF_TYPE" = "branch" case "$EVENT_REF" in refs/heads/release/1.0-evidence-*) ;; *) exit 1 ;; esac case "$EXPECTED_SHA" in *[!0-9a-f]*|"") exit 1 ;; esac test "${#EXPECTED_SHA}" -eq 40' ||
    !defaultStableStepControls(sourceGuard?.step)
  ) {
    problems.push("stable-candidate.yml must fail first unless dispatch uses a dedicated 1.0 evidence branch.");
  }
  const packageCheckout = stableCandidateStep(
    packageSteps,
    (step) => step.uses === CHECKOUT_ACTION,
    "package checkout",
    problems
  );
  if (
    !exactRecord(packageCheckout?.step.with, {
      ref: EVENT_SHA,
      "fetch-depth": 0,
      "persist-credentials": false
    }) ||
    !defaultStableStepControls(packageCheckout?.step) ||
    hasOwn(packageCheckout?.step ?? {}, "env")
  ) {
    problems.push(
      "stable-candidate.yml package checkout must pin the event SHA and fetch history without credentials."
    );
  }
  const ancestry = stableCandidateStep(
    packageSteps,
    (step) => step.name === "Require exact protected-main descendant",
    "exact protected-main ancestry guard",
    problems
  );
  if (
    ancestry?.step.run !==
      'test "$(git rev-parse --verify HEAD^{commit})" = "$EXPECTED_SHA"\ntest -z "$(git status --porcelain --untracked-files=no)"\ngit rev-parse --verify refs/remotes/origin/main^{commit} >/dev/null\ngit merge-base --is-ancestor refs/remotes/origin/main "$EXPECTED_SHA"\n' ||
    !exactRecord(ancestry?.step.env, { EXPECTED_SHA: EVENT_SHA }) ||
    !defaultStableStepControls(ancestry?.step) ||
    packageCheckout === undefined ||
    ancestry?.index !== packageCheckout.index + 1
  ) {
    problems.push(
      "stable-candidate.yml must prove the exact clean event SHA descends from protected main immediately after checkout."
    );
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
    (step) => step.name === "Publish performance-evidence candidate set",
    "performance-evidence artifact producer",
    problems
  );
  if (
    normalizeRun(producer?.step.run) !==
      "node scripts/create-canonical-release-artifact.mjs openwrangler.candidate.vsix --out-dir performance-evidence --performance-evidence" ||
    !exactRecord(producer?.step.env, {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    }) ||
    !defaultStableStepControls(producer?.step)
  ) {
    problems.push("stable-candidate.yml must publish one exact source-bound performance-evidence artifact set.");
  }
  const candidateUpload = stableCandidateStep(
    packageSteps,
    (step) => step.name === "Upload performance-evidence candidate set",
    "performance-evidence candidate upload",
    problems
  );
  if (
    candidateUpload?.step.id !== "candidate_artifact" ||
    candidateUpload?.step.uses !== UPLOAD_ACTION ||
    !exactRecord(candidateUpload?.step.with, {
      name: "openwrangler-performance-evidence-candidate",
      path: `${STABLE_CANDIDATE_ARTIFACT_PATHS.join("\n")}\n`,
      "if-no-files-found": "error",
      "retention-days": 14,
      "compression-level": 0,
      "include-hidden-files": false
    }) ||
    !defaultStableStepControls(candidateUpload?.step) ||
    hasOwn(candidateUpload?.step ?? {}, "env")
  ) {
    problems.push("stable-candidate.yml must upload only the exact three-file evidence artifact set.");
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
    problems.push("stable-candidate.yml evidence production and upload must be one immutable final chain.");
  }

  const performance = workflow.jobs["installed-performance"];
  if (
    performance.needs !== "package" ||
    performance["runs-on"] !== "ubuntu-24.04" ||
    performance["timeout-minutes"] !== 120 ||
    ["if", "env", "defaults", "permissions", "continue-on-error"].some((key) => hasOwn(performance, key))
  ) {
    problems.push("stable-candidate.yml installed performance must use the pinned hosted Linux runner.");
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
  if (!isDeepStrictEqual(performanceSteps, STABLE_PERFORMANCE_STEPS)) {
    problems.push(
      "stable-candidate.yml installed-performance job must retain its exact pinned ordered step allowlist."
    );
  }
  const performanceCheckout = stableCandidateStep(
    performanceSteps,
    (step) => step.uses === CHECKOUT_ACTION,
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
      path: "performance-evidence",
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
    "/usr/bin/dbus-run-session -- npm run benchmark:installed --",
    "--pinned-editors",
    "--performance-evidence",
    "--candidate-in performance-evidence/openwrangler.vsix",
    "--candidate-checksum performance-evidence/openwrangler.vsix.sha256",
    "--candidate-provenance performance-evidence/openwrangler.vsix.provenance.json",
    `--out ${STABLE_REPORT_PATH}`
  ].join(" ");
  if (
    benchmark?.step.name !== "Test exact evidence candidate in pinned VS Code and Cursor" ||
    normalizeRun(benchmark?.step.run) !== expectedBenchmark ||
    !exactRecord(benchmark?.step.env, {
      EXPECTED_SHA: EVENT_SHA,
      RELEASE_TAG: "${{ inputs.release_tag }}"
    }) ||
    !defaultStableStepControls(benchmark?.step)
  ) {
    problems.push("stable-candidate.yml consumer must run one isolated unsharded evidence benchmark.");
  }
  const reportUpload = stableCandidateStep(
    performanceSteps,
    (step) => step.name === "Upload installed-performance evidence",
    "installed-performance report upload",
    problems
  );
  const failedReportUpload = stableCandidateStep(
    performanceSteps,
    (step) => step.name === "Upload failed numeric installed-performance evidence",
    "failed numeric installed-performance report upload",
    problems
  );
  if (
    failedReportUpload?.step.if !==
      "${{ always() && steps.installed_performance.outcome == 'failure' && steps.installed_performance.outputs.evidence_ready == 'true' }}" ||
    failedReportUpload?.step.uses !== UPLOAD_ACTION ||
    !exactRecord(failedReportUpload?.step.with, {
      name: "openwrangler-installed-performance-numeric-failure",
      path: "${{ steps.installed_performance.outputs.evidence_path }}",
      "if-no-files-found": "error",
      "retention-days": 7,
      "compression-level": 9,
      "include-hidden-files": false
    }) ||
    ["env", "continue-on-error", "shell", "working-directory"].some((key) =>
      hasOwn(failedReportUpload?.step ?? {}, key)
    ) ||
    failedReportUpload?.index !== benchmark?.index + 1
  ) {
    problems.push(
      "stable-candidate.yml may retain only a validated numeric-gate report through the benchmark's exact failure output."
    );
  }
  if (
    reportUpload?.step.uses !== UPLOAD_ACTION ||
    reportUpload?.step.if !== "${{ steps.installed_performance.outcome == 'success' }}" ||
    !exactRecord(reportUpload?.step.with, {
      name: "openwrangler-installed-performance",
      path: STABLE_REPORT_PATH,
      "if-no-files-found": "error",
      "retention-days": 90,
      "compression-level": 9,
      "include-hidden-files": false
    }) ||
    ["env", "continue-on-error", "shell", "working-directory"].some((key) => hasOwn(reportUpload?.step ?? {}, key)) ||
    performanceCheckout === undefined ||
    performanceTag === undefined ||
    download === undefined ||
    benchmark === undefined ||
    !(
      performanceCheckout.index < performanceTag.index &&
      performanceTag.index < download.index &&
      download.index < benchmark.index
    ) ||
    failedReportUpload === undefined ||
    reportUpload?.index !== failedReportUpload.index + 1 ||
    reportUpload?.index !== performanceSteps.length - 1
  ) {
    problems.push(
      "stable-candidate.yml must upload the successful path-free report immediately after the narrow numeric-failure slot."
    );
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
