import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { loadConfigFromFile } from "vite";
import {
  classifyCiChange,
  isDocumentationOnlyChangeSet,
  isInternalToolingOnlyChangeSet,
  isPackageOnlyChangeSet,
  parseChangedPathBuffer,
  parsePullRequestDraft,
  requiresReleasedJupyter
} from "./ci-path-classification.mjs";
import { inspectStableCandidateWorkflow } from "./release-workflow.mjs";
import {
  ALWAYS_REQUIRED_CI_JOBS,
  CONDITIONAL_CI_JOB,
  FULL_MATRIX_CI_JOBS,
  INTERNAL_TOOLING_CI_JOB,
  OPTIONAL_CI_JOB,
  PACKAGE_CI_JOBS,
  PRODUCT_CI_JOBS,
  REQUIRED_CI_JOBS,
  parseRequiredFlag,
  requireCiResults,
  resultEnvironmentKey
} from "./require-ci-results.mjs";

const replaceablePullRequestWorkflows = [
  [".github/workflows/ci.yml", "ci-${{ github.event_name }}-${{ github.ref }}"],
  [".github/workflows/cross-platform.yml", "cross-platform-${{ github.event_name }}-${{ github.ref }}"],
  [".github/workflows/codeql.yml", "codeql-${{ github.event_name }}-${{ github.ref }}"]
];

const requiredPullRequestWorkflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/cross-platform.yml",
  ".github/workflows/codeql.yml"
];
const EXPECTED_BLOCKING_CI_JOBS = Object.freeze([
  "classify",
  "fast-feedback",
  "checkout-lifecycle-contracts",
  "contract-tests",
  "visual-accessibility",
  "production-audits",
  "canonical-vsix",
  "linux-packaged-editor",
  "coverage",
  "python-matrix",
  "native-r-contract",
  "extension-host",
  "native-script-portability",
  "native-extension-host",
  "native-editor-matrix",
  "native-cursor-smoke"
]);
const CHECKOUT_ACTION = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE_ACTION = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const SETUP_PYTHON_ACTION = "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1";
const SETUP_R_ACTION = "r-lib/actions/setup-r@d3c5be51b12e724e68f33216ca3c148b66d5f0b6";
const SCRIPT_TEST_GROUPS = Object.freeze(["workflow", "portable", "media", "native"]);
const CANONICAL_CI_IF =
  "${{ !cancelled() && (needs.classify.result != 'success' || needs.classify.outputs.lightweight_only != 'true') }}";
const FULL_CI_IF =
  "${{ !cancelled() && (needs.classify.result != 'success' || needs.classify.outputs.full_matrix_required != 'false') }}";
const INTERNAL_TOOLING_CI_IF =
  "${{ !cancelled() && (needs.classify.result != 'success' || (needs.classify.outputs.internal_tooling_only == 'true' && needs.classify.outputs.draft_pull_request == 'false')) }}";
const MATRIX_CONTEXT_IF = "${{ !cancelled() }}";
const NON_MATRIX_CONTEXT_IF =
  "${{ needs.classify.result == 'success' && needs.classify.outputs.full_matrix_required == 'false' }}";
const SUBSTANTIVE_MATRIX_STEP_IF =
  "${{ needs.classify.result == 'success' && needs.classify.outputs.full_matrix_required == 'true' }}";
const CLASSIFICATION_GATE_IF =
  "${{ needs.classify.result != 'success' || (needs.classify.outputs.documentation_only != 'true' && needs.classify.outputs.documentation_only != 'false') || (needs.classify.outputs.draft_pull_request != 'true' && needs.classify.outputs.draft_pull_request != 'false') || (needs.classify.outputs.internal_tooling_only != 'true' && needs.classify.outputs.internal_tooling_only != 'false') || (needs.classify.outputs.lightweight_only != 'true' && needs.classify.outputs.lightweight_only != 'false') || (needs.classify.outputs.package_only != 'true' && needs.classify.outputs.package_only != 'false') || (needs.classify.outputs.full_matrix_required != 'true' && needs.classify.outputs.full_matrix_required != 'false') || (needs.classify.outputs.lightweight_only == 'true' && needs.classify.outputs.documentation_only == 'false' && needs.classify.outputs.internal_tooling_only == 'false' && needs.classify.outputs.draft_pull_request == 'false') || (needs.classify.outputs.lightweight_only == 'false' && (needs.classify.outputs.documentation_only == 'true' || needs.classify.outputs.internal_tooling_only == 'true' || needs.classify.outputs.draft_pull_request == 'true')) || (needs.classify.outputs.documentation_only == 'true' && needs.classify.outputs.package_only == 'true') || (needs.classify.outputs.internal_tooling_only == 'true' && (needs.classify.outputs.documentation_only == 'true' || needs.classify.outputs.package_only == 'true')) || (needs.classify.outputs.full_matrix_required == 'true' && (needs.classify.outputs.documentation_only == 'true' || needs.classify.outputs.internal_tooling_only == 'true' || needs.classify.outputs.package_only == 'true' || needs.classify.outputs.draft_pull_request == 'true')) || (needs.classify.outputs.full_matrix_required == 'false' && needs.classify.outputs.documentation_only == 'false' && needs.classify.outputs.internal_tooling_only == 'false' && needs.classify.outputs.package_only == 'false' && needs.classify.outputs.draft_pull_request == 'false') }}";
const PROTECTED_PRODUCT_BRANCHES = ["main", "release/1.x"];
const PULL_REQUEST_ACTIVITY_TYPES = ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"];

function normalizedCommand(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : undefined;
}

function nodeTestFiles(command, group) {
  const segments = normalizedCommand(command)?.split(" && ") ?? [];
  const parts = segments[0]?.split(" ") ?? [];
  assert.deepEqual(
    segments.slice(1),
    group === "portable" ? ["npm run test:scripts:media"] : [],
    `${group} must not hide unrelated commands in its script contract.`
  );
  const prefix =
    group === "portable"
      ? ["node", "--test", "--test-concurrency=4"]
      : group === "media"
        ? ["node", "--max-old-space-size=1024", "--test", "--test-concurrency=1"]
        : ["node", "--test"];
  assert.deepEqual(parts.slice(0, prefix.length), prefix, `${group} must invoke Node's test runner directly.`);
  const files = parts.slice(prefix.length);
  assert.ok(files.length > 0, `${group} must own at least one script contract.`);
  for (const file of files) assert.match(file, /^scripts\/[a-z0-9.-]+\.test\.mjs$/u);
  assert.equal(new Set(files).size, files.length, `${group} must not list a script contract twice.`);
  return files;
}

test("product CI covers both protected integration and v1 maintenance branches", () => {
  const ci = parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.deepEqual(ci?.on?.push?.branches, PROTECTED_PRODUCT_BRANCHES);
  assert.deepEqual(ci?.on?.pull_request?.types, PULL_REQUEST_ACTIVITY_TYPES);

  for (const path of ["codeql.yml", "cross-platform.yml"]) {
    const workflow = parseYaml(readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8"));
    assert.deepEqual(workflow?.on?.pull_request?.branches, PROTECTED_PRODUCT_BRANCHES);
    assert.deepEqual(workflow?.on?.pull_request?.types, PULL_REQUEST_ACTIVITY_TYPES);
    assert.deepEqual(workflow?.on?.push?.branches, PROTECTED_PRODUCT_BRANCHES);
  }
});

test("script groups are pairwise-disjoint and exactly cover the filesystem inventory", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const inventory = readdirSync(new URL(".", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
  const groups = Object.fromEntries(
    SCRIPT_TEST_GROUPS.map((group) => [
      group,
      nodeTestFiles(
        manifest?.scripts?.[`test:scripts:${group}${["portable", "media"].includes(group) ? ":run" : ""}`],
        group
      )
    ])
  );

  assert.equal(
    manifest?.scripts?.["test:scripts"],
    "node scripts/run-heavy-local-command.mjs test:scripts -- npm run test:scripts:run"
  );
  assert.equal(
    manifest?.scripts?.["test:scripts:run"],
    "npm run test:scripts:workflow && npm run test:scripts:portable && npm run test:scripts:native"
  );
  assert.equal(
    manifest?.scripts?.["test:scripts:portable"],
    "node scripts/run-heavy-local-command.mjs test:scripts:portable -- npm run test:scripts:portable:run"
  );
  assert.equal(
    manifest?.scripts?.["test:scripts:media"],
    "node scripts/run-heavy-local-command.mjs test:scripts:media -- npm run test:scripts:media:run"
  );
  assert.equal(manifest?.scripts?.test, "node scripts/run-heavy-local-command.mjs test -- npm run test:run");
  assert.equal(manifest?.scripts?.["test:run"], "npm run test:scripts && npm run test:ts && npm run test:python");
  assert.deepEqual(groups.workflow, ["scripts/ci-workflow.test.mjs"]);
  assert.deepEqual(groups.media, ["scripts/public-media-surfaces.test.mjs", "scripts/readme-media.test.mjs"]);
  assert.deepEqual(groups.native, ["scripts/windows-job-supervisor.native.test.mjs"]);
  assert.deepEqual(
    groups.portable,
    inventory.filter((file) =>
      SCRIPT_TEST_GROUPS.filter((group) => group !== "portable").every((group) => !groups[group].includes(file))
    )
  );

  for (let left = 0; left < SCRIPT_TEST_GROUPS.length; left += 1) {
    for (let right = left + 1; right < SCRIPT_TEST_GROUPS.length; right += 1) {
      const leftGroup = SCRIPT_TEST_GROUPS[left];
      const rightGroup = SCRIPT_TEST_GROUPS[right];
      assert.deepEqual(
        groups[leftGroup].filter((file) => groups[rightGroup].includes(file)),
        [],
        `${leftGroup} and ${rightGroup} script ownership must remain disjoint.`
      );
    }
  }
  assert.deepEqual([...new Set(SCRIPT_TEST_GROUPS.flatMap((group) => groups[group]))].sort(), inventory);
});

test("every Vitest run has an effective worker ceiling", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const config = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    fileURLToPath(new URL("../vite.config.ts", import.meta.url))
  );
  const smokeConfig = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    fileURLToPath(new URL("../vite.python-environment-smoke.config.ts", import.meta.url))
  );
  const vitestScripts = Object.entries(manifest?.scripts ?? {})
    .filter(([, command]) => typeof command === "string" && command.startsWith("vitest run"))
    .sort(([left], [right]) => left.localeCompare(right));

  assert.deepEqual(vitestScripts, [
    ["test:coverage:ts", "vitest run --coverage"],
    ["test:python-environment-smoke", "vitest run --config vite.python-environment-smoke.config.ts"],
    ["test:ts", "vitest run"]
  ]);
  assert.ok(config, "The ordinary Vitest configuration must load.");
  assert.ok(smokeConfig, "The Python-environment smoke Vitest configuration must load.");
  assert.equal(config.config.test?.maxWorkers, 4);
  assert.equal(config.config.test?.coverage?.processingConcurrency, 4);
  assert.equal(smokeConfig.config.test?.maxWorkers, 1);
  assert.equal(smokeConfig.config.test?.fileParallelism, false);
});

test("manual stable evidence packages once and consumes the same canonical artifact set", () => {
  const source = readFileSync(new URL("../.github/workflows/stable-candidate.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);

  assert.deepEqual(inspectStableCandidateWorkflow(source), []);
  assert.deepEqual(Object.keys(workflow?.on ?? {}), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs, {
    release_tag: {
      description: "Intended stable tag matching package.json, for example v1.0.0",
      required: true,
      type: "string"
    }
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "stable-candidate-${{ github.sha }}",
    "cancel-in-progress": false
  });
  assert.equal(workflow.env, undefined);
  assert.equal(workflow.defaults, undefined);
  assert.deepEqual(Object.keys(workflow.jobs), ["package", "installed-performance"]);

  const packaging = workflow.jobs.package;
  assert.equal(packaging["runs-on"], "ubuntu-24.04");
  assert.equal(packaging["timeout-minutes"], 60);
  assert.deepEqual(packaging.outputs, {
    "artifact-id": "${{ steps.candidate_artifact.outputs.artifact-id }}"
  });
  assert.equal(packaging.permissions, undefined);
  assert.equal(packaging.if, undefined);
  assert.equal(packaging.env, undefined);
  assert.equal(packaging.defaults, undefined);
  assert.ok(Array.isArray(packaging.steps));

  const sourceGuard = packaging.steps[0];
  assert.equal(sourceGuard?.name, "Require dedicated evidence branch source");
  assert.deepEqual(sourceGuard?.env, {
    EVENT_REF: "${{ github.ref }}",
    EVENT_REF_TYPE: "${{ github.ref_type }}",
    EXPECTED_SHA: "${{ github.sha }}"
  });
  assert.equal(
    normalizedCommand(sourceGuard?.run),
    'test "$EVENT_REF_TYPE" = "branch" case "$EVENT_REF" in refs/heads/release/1.0-evidence-*) ;; *) exit 1 ;; esac case "$EXPECTED_SHA" in *[!0-9a-f]*|"") exit 1 ;; esac test "${#EXPECTED_SHA}" -eq 40'
  );
  const packageCheckout = packaging.steps.find((step) => step.uses === CHECKOUT_ACTION);
  assert.deepEqual(packageCheckout?.with, {
    ref: "${{ github.sha }}",
    "fetch-depth": 0,
    "persist-credentials": false
  });
  const ancestryGuard = packaging.steps.find((step) => step.name === "Require exact protected-main descendant");
  assert.deepEqual(ancestryGuard?.env, { EXPECTED_SHA: "${{ github.sha }}" });
  assert.equal(
    normalizedCommand(ancestryGuard?.run),
    'test "$(git rev-parse --verify HEAD^{commit})" = "$EXPECTED_SHA" test -z "$(git status --porcelain --untracked-files=no)" git rev-parse --verify refs/remotes/origin/main^{commit} >/dev/null git merge-base --is-ancestor refs/remotes/origin/main "$EXPECTED_SHA"'
  );
  assert.equal(packaging.steps.filter((step) => step.uses === SETUP_NODE_ACTION).length, 1);
  assert.equal(packaging.steps.filter((step) => step.uses === SETUP_PYTHON_ACTION).length, 1);
  const metadata = packaging.steps.find((step) => step.id === "release_metadata");
  assert.equal(metadata?.run, "node scripts/release-metadata.mjs");
  assert.deepEqual(metadata?.env, { RELEASE_TAG: "${{ inputs.release_tag }}" });
  const previewRejection = packaging.steps.find((step) => step.name === "Reject preview metadata");
  assert.equal(previewRejection?.if, "${{ steps.release_metadata.outputs.prerelease != 'false' }}");
  assert.equal(previewRejection?.run, "exit 1");

  const allRuns = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .map((step) => normalizedCommand(step.run))
    .filter(Boolean);
  assert.equal(
    allRuns.filter((command) => command.startsWith("npm run package ")).length,
    1,
    "The stable workflow must package the production VSIX exactly once."
  );
  assert.ok(allRuns.includes("npm run package -- --out openwrangler.candidate.vsix"));
  for (const forbidden of ["vsce publish", "ovsx publish", "gh release", "git push", "action-gh-release"]) {
    assert.equal(source.includes(forbidden), false, `The prepublication workflow must not contain ${forbidden}.`);
  }

  const producerIndex = packaging.steps.findIndex((step) => step.name === "Publish performance-evidence candidate set");
  const candidateUploadIndex = packaging.steps.findIndex(
    (step) => step.name === "Upload performance-evidence candidate set"
  );
  assert.equal(candidateUploadIndex, producerIndex + 1);
  assert.equal(
    normalizedCommand(packaging.steps[producerIndex]?.run),
    "node scripts/create-canonical-release-artifact.mjs openwrangler.candidate.vsix --out-dir performance-evidence --performance-evidence"
  );
  assert.deepEqual(packaging.steps[producerIndex]?.env, {
    EXPECTED_SHA: "${{ github.sha }}",
    RELEASE_TAG: "${{ inputs.release_tag }}"
  });
  const candidateUpload = packaging.steps[candidateUploadIndex];
  assert.equal(candidateUpload?.id, "candidate_artifact");
  assert.equal(candidateUpload?.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.deepEqual(candidateUpload?.with, {
    name: "openwrangler-performance-evidence-candidate",
    path:
      [
        "performance-evidence/openwrangler.vsix",
        "performance-evidence/openwrangler.vsix.sha256",
        "performance-evidence/openwrangler.vsix.provenance.json"
      ].join("\n") + "\n",
    "if-no-files-found": "error",
    "retention-days": 14,
    "compression-level": 0,
    "include-hidden-files": false
  });

  const performance = workflow.jobs["installed-performance"];
  assert.equal(performance.needs, "package");
  assert.equal(performance["runs-on"], "ubuntu-24.04");
  assert.equal(performance["timeout-minutes"], 120);
  assert.equal(performance.permissions, undefined);
  assert.equal(performance.if, undefined);
  assert.equal(performance.env, undefined);
  assert.equal(performance.defaults, undefined);
  assert.ok(Array.isArray(performance.steps));
  const performanceCheckout = performance.steps.find((step) => step.uses === CHECKOUT_ACTION);
  assert.deepEqual(performanceCheckout?.with, {
    ref: "${{ github.sha }}",
    "fetch-depth": 0,
    "persist-credentials": false
  });
  assert.equal(performance.steps.filter((step) => step.uses === SETUP_NODE_ACTION).length, 1);
  assert.equal(performance.steps.filter((step) => step.uses === SETUP_PYTHON_ACTION).length, 1);
  const downloadIndex = performance.steps.findIndex(
    (step) => step.uses === "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
  );
  const benchmarkIndex = performance.steps.findIndex((step) => step.id === "installed_performance");
  const evidenceUploadIndex = performance.steps.findIndex(
    (step) => step.name === "Upload installed-performance evidence"
  );
  const failedEvidenceUploadIndex = performance.steps.findIndex(
    (step) => step.name === "Upload failed numeric installed-performance evidence"
  );
  assert.ok(
    downloadIndex >= 0 &&
      downloadIndex < benchmarkIndex &&
      failedEvidenceUploadIndex === benchmarkIndex + 1 &&
      evidenceUploadIndex === failedEvidenceUploadIndex + 1
  );
  assert.deepEqual(performance.steps[downloadIndex]?.with, {
    "artifact-ids": "${{ needs.package.outputs.artifact-id }}",
    path: "performance-evidence",
    "merge-multiple": true
  });
  assert.equal(
    normalizedCommand(performance.steps[benchmarkIndex]?.run),
    [
      "/usr/bin/dbus-run-session -- npm run benchmark:installed --",
      "--pinned-editors",
      "--performance-evidence",
      "--candidate-in performance-evidence/openwrangler.vsix",
      "--candidate-checksum performance-evidence/openwrangler.vsix.sha256",
      "--candidate-provenance performance-evidence/openwrangler.vsix.provenance.json",
      "--out ${{ runner.temp }}/openwrangler-installed-performance-${{ github.run_id }}-${{ github.run_attempt }}.json"
    ].join(" ")
  );
  assert.deepEqual(performance.steps[benchmarkIndex]?.env, {
    EXPECTED_SHA: "${{ github.sha }}",
    RELEASE_TAG: "${{ inputs.release_tag }}"
  });
  const failedEvidenceUpload = performance.steps[failedEvidenceUploadIndex];
  assert.equal(failedEvidenceUpload?.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(
    failedEvidenceUpload?.if,
    "${{ always() && steps.installed_performance.outcome == 'failure' && steps.installed_performance.outputs.evidence_ready == 'true' }}"
  );
  assert.deepEqual(failedEvidenceUpload?.with, {
    name: "openwrangler-installed-performance-numeric-failure",
    path: "${{ steps.installed_performance.outputs.evidence_path }}",
    "if-no-files-found": "error",
    "retention-days": 7,
    "compression-level": 9,
    "include-hidden-files": false
  });
  const evidenceUpload = performance.steps[evidenceUploadIndex];
  assert.equal(evidenceUpload?.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(evidenceUpload?.if, "${{ steps.installed_performance.outcome == 'success' }}");
  assert.deepEqual(evidenceUpload?.with, {
    name: "openwrangler-installed-performance",
    path: "${{ runner.temp }}/openwrangler-installed-performance-${{ github.run_id }}-${{ github.run_attempt }}.json",
    "if-no-files-found": "error",
    "retention-days": 90,
    "compression-level": 9,
    "include-hidden-files": false
  });
  assert.equal(
    performance.steps.some((step) => /\bnpm run (?:package|build)(?:\s|$)/u.test(step.run ?? "")),
    false,
    "The stable consumer may build its test harness internally but must never package or rebuild the extension."
  );
});

test("stable evidence workflow inspector rejects source, artifact, and consumer drift", () => {
  const source = readFileSync(new URL("../.github/workflows/stable-candidate.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const inspect = (mutate) => {
    const candidate = structuredClone(workflow);
    mutate(candidate);
    return inspectStableCandidateWorkflow(JSON.stringify(candidate));
  };

  assert.ok(
    inspect((candidate) => {
      candidate.on.push = { branches: ["main"] };
    }).some((problem) => problem.includes("only one manual release_tag"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs.package.steps[0].if = "${{ false }}";
    }).some((problem) => problem.includes("fail first"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs.package.steps[0].run = 'test "$EVENT_REF_TYPE" = "branch"';
    }).some((problem) => problem.includes("dedicated 1.0 evidence branch"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs.package.steps[2].run = "true";
    }).some((problem) => problem.includes("descends from protected main"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs.package.steps.at(-1).with.path += "canonical-release/untrusted.txt\n";
    }).some((problem) => problem.includes("exact three-file"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs["installed-performance"]["runs-on"] = "ubuntu-latest";
    }).some((problem) => problem.includes("pinned hosted Linux runner"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs["installed-performance"].steps.find((step) => step.id === "installed_performance").run +=
        " --smoke";
    }).some((problem) => problem.includes("isolated unsharded"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs["installed-performance"].steps.find(
        (step) => step.name === "Upload failed numeric installed-performance evidence"
      ).with.path = "performance-evidence/openwrangler.vsix";
    }).some((problem) => problem.includes("validated numeric-gate report"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs["installed-performance"].steps.find(
        (step) => step.name === "Upload failed numeric installed-performance evidence"
      ).if = "${{ always() }}";
    }).some((problem) => problem.includes("validated numeric-gate report"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs["installed-performance"].steps.find(
        (step) => step.name === "Upload installed-performance evidence"
      ).if = "${{ always() }}";
    }).some((problem) => problem.includes("successful path-free report immediately after"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.permissions.contents = "write";
    }).some((problem) => problem.includes("exactly contents: read"))
  );
  for (const jobName of ["package", "installed-performance"]) {
    const expectedProblem = "exact pinned ordered step allowlist";
    for (let index = 0; index < workflow.jobs[jobName].steps.length; index += 1) {
      assert.ok(
        inspect((candidate) => {
          candidate.jobs[jobName].steps.splice(index, 1);
        }).some((problem) => problem.includes(expectedProblem)),
        `${jobName} must reject removing step ${index}.`
      );
    }
    assert.ok(
      inspect((candidate) => {
        candidate.jobs[jobName].steps.splice(1, 0, {
          uses: "attacker/example@main"
        });
      }).some((problem) => problem.includes(expectedProblem)),
      `${jobName} must reject inserted actions.`
    );
  }
  assert.ok(
    inspect((candidate) => {
      candidate.jobs.package.steps.find((step) => step.uses === CHECKOUT_ACTION).uses = "actions/checkout@v6";
    }).some((problem) => problem.includes("exact pinned ordered step allowlist"))
  );
  assert.ok(
    inspect((candidate) => {
      candidate.jobs.package.steps.find(
        (step) => step.run === "npm run verify:vsix -- openwrangler.candidate.vsix"
      ).run = "true";
    }).some((problem) => problem.includes("exact pinned ordered step allowlist"))
  );
});

test("PR workflows cancel only obsolete pull-request heads", () => {
  for (const [relativePath, expectedGroup] of replaceablePullRequestWorkflows) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const workflow = parseYaml(source);
    assert.equal(workflow?.concurrency?.group, expectedGroup, `${relativePath} must retain its ref-scoped group.`);
    assert.equal(
      workflow?.concurrency?.["cancel-in-progress"],
      "${{ github.event_name == 'pull_request' }}",
      `${relativePath} may cancel only an obsolete pull-request run.`
    );
    assert.ok(workflow?.on?.pull_request !== undefined, `${relativePath} must still run for pull requests.`);
    assert.ok(
      Object.keys(workflow?.on ?? {}).some((eventName) => eventName !== "pull_request"),
      `${relativePath} must retain non-PR evidence that the cancellation expression leaves uninterrupted.`
    );
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      assert.equal(
        String(job?.if ?? "").includes("always()"),
        false,
        `${relativePath}:${jobId} must not resist cancellation with always().`
      );
      for (const [stepIndex, step] of (job?.steps ?? []).entries()) {
        assert.equal(
          String(step?.if ?? "").includes("always()"),
          false,
          `${relativePath}:${jobId}:step-${stepIndex + 1} must not resist cancellation with always().`
        );
      }
    }
  }
});

test("NUL-safe path classification limits every fast path to explicit files", () => {
  assert.deepEqual(
    parseChangedPathBuffer(Buffer.from("docs/testing.md\0AGENTS.md\0docs/images/über.png\0docs/a\nfile.md\0", "utf8")),
    ["docs/testing.md", "AGENTS.md", "docs/images/über.png", "docs/a\nfile.md"]
  );
  assert.throws(() => parseChangedPathBuffer(Buffer.from("src/extension/activate.ts", "utf8")), /NUL terminated/u);
  assert.throws(() => parseChangedPathBuffer(Buffer.from("README.md\0\0", "utf8")), /empty path/u);
  assert.throws(() => parseChangedPathBuffer(Buffer.from([0xff, 0])), /encoded data/u);
  assert.throws(() => parseChangedPathBuffer("AGENTS.md\0"), /provided as a Buffer/u);

  const required = (changedPaths, pullRequestDraft = "false") =>
    requiresReleasedJupyter({ eventName: "pull_request", changedPaths, pullRequestDraft });
  const documentationOnly = (eventName, changedPaths) => isDocumentationOnlyChangeSet({ eventName, changedPaths });
  const internalToolingOnly = (eventName, changedPaths) => isInternalToolingOnlyChangeSet({ eventName, changedPaths });
  const packageOnly = (eventName, changedPaths) => isPackageOnlyChangeSet({ eventName, changedPaths });
  const allowed = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "docs/testing.md",
    "docs/a\nfile.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/PULL_REQUEST_TEMPLATE/docs.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md"
  ];
  assert.equal(documentationOnly("pull_request", allowed), true);
  assert.equal(required(allowed), false);
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: allowed, pullRequestDraft: "false" }), {
    documentationOnly: true,
    draftPullRequest: false,
    internalToolingOnly: false,
    lightweightOnly: true,
    packageOnly: false,
    fullMatrixRequired: false,
    releasedJupyterRequired: false
  });
  const checkoutLifecyclePaths = [
    "AGENTS.md",
    "docs/testing.md",
    "scripts/checkout-lifecycle.mjs",
    "scripts/checkout-lifecycle.test.mjs"
  ];
  assert.equal(internalToolingOnly("pull_request", checkoutLifecyclePaths), true);
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: checkoutLifecyclePaths, pullRequestDraft: "false" }),
    {
      documentationOnly: false,
      draftPullRequest: false,
      internalToolingOnly: true,
      lightweightOnly: true,
      packageOnly: false,
      fullMatrixRequired: false,
      releasedJupyterRequired: false
    }
  );
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: checkoutLifecyclePaths, pullRequestDraft: "true" }),
    {
      documentationOnly: false,
      draftPullRequest: true,
      internalToolingOnly: true,
      lightweightOnly: true,
      packageOnly: false,
      fullMatrixRequired: false,
      releasedJupyterRequired: false
    }
  );
  assert.equal(internalToolingOnly("pull_request", ["AGENTS.md", "docs/testing.md"]), false);
  assert.equal(
    internalToolingOnly("pull_request", ["scripts/checkout-lifecycle.mjs", "scripts/checkout-lifecycle.test.mjs"]),
    true
  );
  const packagedDocuments = ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"];
  assert.equal(packageOnly("pull_request", packagedDocuments), true);
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: packagedDocuments, pullRequestDraft: "false" }),
    {
      documentationOnly: false,
      draftPullRequest: false,
      internalToolingOnly: false,
      lightweightOnly: false,
      packageOnly: true,
      fullMatrixRequired: false,
      releasedJupyterRequired: false
    }
  );
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: packagedDocuments, pullRequestDraft: "true" }),
    {
      documentationOnly: false,
      draftPullRequest: true,
      internalToolingOnly: false,
      lightweightOnly: true,
      packageOnly: true,
      fullMatrixRequired: false,
      releasedJupyterRequired: false
    }
  );
  for (const path of [
    ".github/workflows/ci.yml",
    ".vscodeignore",
    "assets/openwrangler.png",
    "package.json",
    "protocol/openwrangler.v2.schema.json",
    "python/openwrangler_runtime/notebook.py",
    "scripts/build-webviews.mjs",
    "scripts/repository-python-environment.mjs",
    "src/extension/notebooks/jupyterBridge.ts",
    "src/webviews/notebookRenderer.ts",
    "docs/images/acceptance/grid-dark-1920.png",
    "docs/images/editor-acceptance/vscode-hero-dark.png",
    "docs/images/readme/v1.2/explore.png",
    "docs/images/legacy.png",
    "docs/media-gallery.md",
    "docs/media-spec-v1.2.md",
    "docs/../src/extension/activate.ts",
    "/docs/testing.md",
    "docs//testing.md",
    "docs\\testing.md",
    "Docs/testing.md",
    ".github/ISSUE_TEMPLATE",
    ".github/PULL_REQUEST_TEMPLATE",
    "unknown/future-package-surface"
  ]) {
    assert.equal(documentationOnly("pull_request", [path]), false, `${path} must require the complete PR matrix.`);
    assert.equal(internalToolingOnly("pull_request", [path]), false, `${path} must not select internal-tooling CI.`);
    assert.equal(packageOnly("pull_request", [path]), false, `${path} must not select package-only CI.`);
    assert.equal(required([path]), true, `${path} must require released-Jupyter acceptance.`);
  }
  for (const path of packagedDocuments) {
    assert.equal(documentationOnly("pull_request", [path]), false, `${path} is shipped, not documentation-only.`);
    assert.equal(packageOnly("pull_request", [path]), true, `${path} must select package-only CI.`);
    assert.equal(required([path]), false, `${path} must not require released-Jupyter acceptance.`);
  }
  assert.equal(packageOnly("pull_request", ["README.md", "docs/testing.md"]), false);
  assert.equal(internalToolingOnly("pull_request", ["scripts/checkout-lifecycle.mjs", "README.md"]), false);
  assert.equal(
    internalToolingOnly("pull_request", ["scripts/checkout-lifecycle.mjs", "scripts/ci-path-classification.mjs"]),
    false
  );
  assert.equal(
    internalToolingOnly("pull_request", ["scripts/checkout-lifecycle.mjs", ".github/workflows/ci.yml"]),
    false
  );
  assert.equal(
    internalToolingOnly("pull_request", ["scripts/checkout-lifecycle.mjs", ".github/workflows/stable-release.yml"]),
    false
  );
  assert.equal(
    internalToolingOnly("pull_request", ["scripts/checkout-lifecycle.mjs", "src/extension/activate.ts"]),
    false
  );
  for (const mixedPath of [
    "README.md",
    ".github/workflows/ci.yml",
    ".github/workflows/stable-release.yml",
    "src/extension/activate.ts",
    "unknown/future-tooling-surface"
  ]) {
    const classification = classifyCiChange({
      eventName: "pull_request",
      changedPaths: ["scripts/checkout-lifecycle.mjs", mixedPath],
      pullRequestDraft: "false"
    });
    assert.equal(classification.internalToolingOnly, false, `${mixedPath} must leave the tooling fast path.`);
    assert.equal(classification.fullMatrixRequired, true, `${mixedPath} must require the complete PR matrix.`);
  }
  assert.equal(packageOnly("pull_request", ["README.md", "src/shared/notebookOutput.ts"]), false);
  assert.equal(documentationOnly("pull_request", ["docs/testing.md", "src/shared/notebookOutput.ts"]), false);
  assert.equal(required(["docs/testing.md", "src/shared/notebookOutput.ts"]), true);
  assert.deepEqual(
    classifyCiChange({
      eventName: "pull_request",
      changedPaths: ["src/shared/notebookOutput.ts"],
      pullRequestDraft: "true"
    }),
    {
      documentationOnly: false,
      draftPullRequest: true,
      internalToolingOnly: false,
      lightweightOnly: true,
      packageOnly: false,
      fullMatrixRequired: false,
      releasedJupyterRequired: false
    }
  );
  assert.equal(required(["src/shared/notebookOutput.ts"], "true"), false);
  assert.equal(documentationOnly("pull_request", []), false, "an empty PR diff must fail closed");
  assert.equal(internalToolingOnly("pull_request", []), false, "an empty PR diff must fail closed");
  assert.equal(packageOnly("pull_request", []), false, "an empty PR diff must fail closed");
  assert.equal(required([]), true, "an empty PR diff must fail closed into acceptance");
  for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
    assert.equal(documentationOnly(eventName, allowed), false, `${eventName} must always use the complete workflow.`);
    assert.equal(
      packageOnly(eventName, packagedDocuments),
      false,
      `${eventName} must always use the complete workflow.`
    );
    assert.deepEqual(classifyCiChange({ eventName, changedPaths: [], pullRequestDraft: "" }), {
      documentationOnly: false,
      draftPullRequest: false,
      internalToolingOnly: false,
      lightweightOnly: false,
      packageOnly: false,
      fullMatrixRequired: true,
      releasedJupyterRequired: false
    });
  }
  assert.equal(documentationOnly("pull_request", [undefined]), false);
  assert.equal(internalToolingOnly("pull_request", [undefined]), false);
  assert.equal(documentationOnly("pull_request", ["docs/testing.md", 42]), false);
  assert.throws(() => documentationOnly("pull_request", undefined), /changedPaths must be an array/u);
  assert.throws(() => internalToolingOnly("pull_request", undefined), /changedPaths must be an array/u);
  assert.throws(() => packageOnly("pull_request", undefined), /changedPaths must be an array/u);
  assert.equal(requiresReleasedJupyter({ eventName: "push", changedPaths: ["src/extension/activate.ts"] }), false);
  assert.throws(() => requiresReleasedJupyter({ eventName: "schedule", changedPaths: [] }), /Unsupported CI event/u);
  assert.equal(parsePullRequestDraft({ eventName: "pull_request", value: "true" }), true);
  assert.equal(parsePullRequestDraft({ eventName: "pull_request", value: "false" }), false);
  for (const value of [undefined, "", "TRUE", "0", true, false]) {
    assert.throws(
      () => parsePullRequestDraft({ eventName: "pull_request", value }),
      /draft state must be exactly true or false/u
    );
  }
  assert.equal(parsePullRequestDraft({ eventName: "push", value: "" }), false);
  assert.equal(parsePullRequestDraft({ eventName: "schedule", value: undefined }), false);
  assert.throws(
    () => parsePullRequestDraft({ eventName: "push", value: "false" }),
    /must not carry pull-request draft state/u
  );
});

test("documentation fast-path roots remain excluded from the VSIX inventory", () => {
  const ignored = new Set(
    readFileSync(new URL("../.vscodeignore", import.meta.url), "utf8")
      .split(/\r?\n/gu)
      .filter(Boolean)
  );
  for (const path of ["docs/**", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md"]) {
    assert.equal(ignored.has(path), true, `${path} must remain outside the packaged extension.`);
  }
  for (const path of ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.equal(ignored.has(path), false, `${path} changes shipped extension bytes and must keep packaging CI.`);
  }
});

test("affected PR released-Jupyter acceptance consumes the exact canonical VSIX", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const canonical = workflow?.jobs?.["canonical-vsix"];
  const canonicalCheckout = canonical?.steps?.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@")
  );
  assert.deepEqual(canonicalCheckout?.with, { "fetch-depth": 0 });
  assert.equal(
    canonical?.outputs?.released_jupyter_required,
    "${{ needs.classify.outputs.released_jupyter_required }}"
  );
  const classification = workflow?.jobs?.classify;
  assert.equal(classification?.name, "CI change classification");
  assert.equal(classification?.outputs?.documentation_only, "${{ steps.classify.outputs.documentation_only }}");
  assert.equal(classification?.outputs?.draft_pull_request, "${{ steps.classify.outputs.draft_pull_request }}");
  assert.equal(classification?.outputs?.internal_tooling_only, "${{ steps.classify.outputs.internal_tooling_only }}");
  assert.equal(classification?.outputs?.lightweight_only, "${{ steps.classify.outputs.lightweight_only }}");
  assert.equal(classification?.outputs?.package_only, "${{ steps.classify.outputs.package_only }}");
  assert.equal(classification?.outputs?.full_matrix_required, "${{ steps.classify.outputs.full_matrix_required }}");
  assert.equal(
    classification?.outputs?.released_jupyter_required,
    "${{ steps.classify.outputs.released_jupyter_required }}"
  );
  assert.deepEqual(classification?.steps?.find((step) => step?.uses === "actions/checkout@v6")?.with, {
    "fetch-depth": 0
  });
  const classify = classification?.steps?.find((step) => step?.id === "classify");
  assert.equal(classify?.run, "node scripts/ci-path-classification.mjs");
  assert.deepEqual(classify?.env, {
    CI_EVENT_NAME: "${{ github.event_name }}",
    CI_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    CI_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    CI_PR_DRAFT: "${{ github.event.pull_request.draft }}"
  });

  const job = workflow?.jobs?.[CONDITIONAL_CI_JOB];
  assert.equal(job?.name, "VS Code with released Jupyter");
  assert.deepEqual(job?.needs, ["classify", "canonical-vsix"]);
  assert.equal(
    normalizedCommand(job?.if),
    "${{ !cancelled() && needs.classify.outputs.full_matrix_required == 'true' && needs.classify.outputs.released_jupyter_required == 'true' }}"
  );
  assert.equal(job?.["runs-on"], "ubuntu-latest");
  assert.equal(job?.["timeout-minutes"], 90);

  const steps = job?.steps;
  assert.ok(Array.isArray(steps));
  const prerequisite = steps.find((step) => step?.name === "Require the canonical PR artifact");
  assert.equal(prerequisite?.if, "${{ needs.canonical-vsix.result != 'success' }}");
  assert.equal(prerequisite?.run, "exit 1");
  const download = steps.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/download-artifact@")
  );
  assert.deepEqual(download?.with, { name: "openwrangler-vsix", path: "canonical-vsix" });
  const checksum = steps.find((step) => step?.name === "Verify canonical PR checksum");
  assert.match(checksum?.run ?? "", /canonical-vsix\/openwrangler\.vsix\.sha256/u);
  assert.match(checksum?.run ?? "", /canonical-vsix\/openwrangler\.vsix/u);
  assert.equal(
    steps.some((step) => step?.run === "npm run verify:vsix -- canonical-vsix/openwrangler.vsix"),
    true
  );
  assert.equal(
    steps.some((step) => /npm run package(?::|\s)/u.test(step?.run ?? "")),
    false
  );
  assert.equal(
    steps.some((step) => step?.run === "npm run lock:remote-jupyter:check"),
    true
  );
  assert.equal(
    steps.some((step) => step?.run === "npm run audit:remote-jupyter"),
    true
  );
  assert.deepEqual(
    steps.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-java@"))?.with,
    { distribution: "temurin", "java-version": "17" }
  );
  const prepare = steps.find((step) => step?.id === "prepare_xvfb");
  assert.match(prepare?.run ?? "", /scripts\/prepare-xvfb\.mjs/u);
  const acceptance = steps.find((step) => step?.id === "packaged_editor");
  assert.equal(acceptance?.run, "node scripts/run-packaged-editor-tests.mjs canonical-vsix/openwrangler.vsix");
  assert.deepEqual(acceptance?.env, {
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1",
    VSCODE_TEST_VERSION: "stable"
  });
  const upload = steps.find((step) => step?.name === "Upload packaged-editor failure diagnostics");
  assert.match(upload?.if ?? "", /steps\.packaged_editor\.outcome == 'failure'/u);
  assert.equal(upload?.with?.path, "${{ steps.packaged_editor.outputs.evidence_path }}");
});

test("native VS Code and Cursor jobs consume the same downloaded canonical VSIX independently", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  assert.equal(
    workflow?.jobs?.["canonical-vsix"]?.steps?.some(
      (step) => step?.run === "npm run package:prepared -- --out openwrangler.vsix"
    ),
    true,
    "CI must let package.json select the canonical VSIX channel."
  );
  assert.doesNotMatch(source, /package:prepared -- --pre-release/u);
  const vscodeSteps = workflow?.jobs?.["native-editor-matrix"]?.steps;
  const cursorSteps = workflow?.jobs?.["native-cursor-smoke"]?.steps;
  assert.ok(Array.isArray(vscodeSteps), "CI must retain the native VS Code matrix.");
  assert.ok(Array.isArray(cursorSteps), "CI must retain the independent native Cursor matrix.");

  for (const steps of [vscodeSteps, cursorSteps]) {
    const download = steps.find(
      (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/download-artifact@")
    );
    assert.equal(download?.with?.name, "openwrangler-vsix");
    assert.equal(download?.with?.path, "canonical-vsix");
    assert.equal(
      steps.some((step) => step?.run === "npm run build:test-extension"),
      true
    );
  }

  const expectedCommand = "node scripts/run-packaged-editor-tests.mjs canonical-vsix/openwrangler.vsix";
  assert.equal(vscodeSteps.find((step) => step?.id === "packaged_editor")?.run, expectedCommand);
  assert.equal(
    vscodeSteps.some((step) => step?.id === "cursor_smoke"),
    false
  );
  assert.equal(cursorSteps.find((step) => step?.id === "cursor_smoke")?.run, expectedCommand);
  assert.equal(
    cursorSteps.some((step) => step?.id === "packaged_editor"),
    false
  );
});

test("PR CI starts one bounded static fast-feedback lane and preserves every static gate", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const fastFeedback = workflow?.jobs?.["fast-feedback"];
  assert.equal(fastFeedback?.name, "Fast feedback");
  assert.equal(fastFeedback?.["runs-on"], "ubuntu-latest");
  assert.equal(fastFeedback?.["timeout-minutes"], 15);
  assert.equal(fastFeedback?.needs, undefined, "Fast feedback must not wait for the canonical VSIX.");
  assert.equal(fastFeedback?.if, undefined, "Fast feedback must run on every CI event.");

  assert.deepEqual(
    fastFeedback?.steps,
    [
      { uses: "actions/checkout@v6" },
      {
        uses: "actions/setup-node@v6",
        with: { "node-version": 22, cache: "npm" }
      },
      { run: "npm ci" },
      { name: "Formatting", run: "npm run format:check" },
      { name: "ESLint", run: "npm run lint" },
      { name: "Strict TypeScript", run: "npm run typecheck" },
      { name: "Protocol freshness", run: "npm run protocol:check" },
      { name: "Reference freshness", run: "npm run reference:check" },
      { name: "Documentation freshness", run: "npm run docs:check" },
      { name: "Production license inventory", run: "npm run license:check" },
      { name: "Workflow contracts", run: "npm run test:scripts:workflow" }
    ],
    "The early lane must remain source-only, named, and independently attributable."
  );

  const contractSteps = workflow?.jobs?.["contract-tests"]?.steps;
  assert.ok(Array.isArray(contractSteps));
  for (const command of [
    "npm run lint:python",
    "npm run brand:check",
    "npm run check:remote-jupyter-lock",
    "npm run lock:remote-jupyter:check",
    "npm run test:scripts:portable"
  ]) {
    assert.equal(
      contractSteps.some((step) => step?.run === command),
      true,
      `${command} must remain an authoritative contract gate.`
    );
  }
  for (const duplicate of ["npm run test:ts", "npm run test:python"]) {
    assert.equal(
      contractSteps.some((step) => step?.run === duplicate),
      false,
      `${duplicate} belongs to the stronger coverage lane and must not be repeated by contract-tests.`
    );
  }
  assert.equal(
    workflow?.jobs?.["canonical-vsix"]?.needs,
    "classify",
    "Canonical packaging must remain parallel with fast feedback after bounded classification."
  );
});

test("authoritative CI work is independently attributable before the required aggregate", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);

  const visual = workflow?.jobs?.["visual-accessibility"];
  assert.equal(visual?.name, "Visual and accessibility");
  assert.equal(visual?.needs, "classify");
  assert.equal(visual?.if, FULL_CI_IF);
  assert.equal(
    visual?.steps?.some(
      (step) => step?.uses === "actions/setup-python@v6" && step?.with?.["python-version"] === "3.12"
    ),
    true,
    "Runtime-backed production screenshot fixtures need the exact Python test environment."
  );
  assert.equal(
    visual?.steps?.some((step) => step?.run === 'python -m pip install -e "python[dev]"'),
    true,
    "Visual acceptance must install the Pandas, Polars, DuckDB, and notebook fixture dependencies."
  );
  assert.equal(
    visual?.steps?.some((step) => step?.run === "npm run test:webview-acceptance"),
    true
  );

  const audits = workflow?.jobs?.["production-audits"];
  assert.equal(audits?.name, "Production dependency audits");
  assert.equal(
    audits?.steps?.some((step) => step?.run === "npm audit --omit=dev"),
    true
  );
  assert.equal(
    audits?.steps?.some((step) => step?.run === "npm run audit:python"),
    true
  );

  const linuxPackaged = workflow?.jobs?.["linux-packaged-editor"];
  assert.deepEqual(linuxPackaged?.needs, ["classify", "canonical-vsix"]);
  assert.equal(linuxPackaged?.if, FULL_CI_IF);
  assert.match(
    linuxPackaged?.steps?.find((step) => step?.name === "Require the canonical PR artifact")?.if ?? "",
    /needs\.canonical-vsix\.result != 'success'/u
  );
  assert.equal(
    linuxPackaged?.steps?.some((step) => step?.id === "packaged_editor"),
    true
  );

  const portability = workflow?.jobs?.["native-script-portability"];
  const extensionHost = workflow?.jobs?.["native-extension-host"];
  const vscode = workflow?.jobs?.["native-editor-matrix"];
  const cursor = workflow?.jobs?.["native-cursor-smoke"];
  for (const job of [extensionHost, vscode, cursor]) {
    assert.deepEqual(job?.strategy?.matrix?.os, ["macos-latest", "windows-latest"]);
    assert.equal(job?.strategy?.["fail-fast"], false);
  }
  assert.deepEqual(portability, {
    name: "Native script contracts (Windows)",
    needs: "classify",
    if: FULL_CI_IF,
    "runs-on": "windows-latest",
    "timeout-minutes": 20,
    steps: [
      { uses: "actions/checkout@v6" },
      { uses: "actions/setup-node@v6", with: { "node-version": 22, cache: "npm" } },
      { run: "npm ci" },
      { run: "npm run test:scripts:native" }
    ]
  });
  assert.equal(extensionHost?.needs, "classify");
  assert.equal(extensionHost?.if, FULL_CI_IF);
  assert.equal(
    extensionHost?.steps?.some((step) => step?.run === "npm run test:extension-host"),
    true
  );
  assert.equal(
    vscode?.steps?.some((step) => step?.run?.startsWith("npm run test:scripts")),
    false
  );
  assert.equal(
    vscode?.steps?.some((step) => step?.run === "npm run test:extension-host"),
    false
  );
  assert.equal(
    cursor?.steps?.some((step) => step?.run?.startsWith("npm run test:scripts")),
    false
  );
  assert.equal(
    cursor?.steps?.some((step) => step?.run === "npm run test:extension-host"),
    false
  );

  const ownersByCommand = new Map();
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (
        step?.run === "npm run test:scripts:workflow" ||
        step?.run === "npm run test:scripts:portable" ||
        step?.run === "npm run test:scripts:native"
      ) {
        const owners = ownersByCommand.get(step.run) ?? [];
        owners.push(jobId);
        ownersByCommand.set(step.run, owners);
      }
    }
  }
  assert.deepEqual(ownersByCommand.get("npm run test:scripts:workflow"), ["fast-feedback"]);
  assert.deepEqual(ownersByCommand.get("npm run test:scripts:portable"), ["contract-tests"]);
  assert.deepEqual(ownersByCommand.get("npm run test:scripts:native"), ["native-script-portability"]);
});

test("non-matrix PR tiers preserve direct contexts while substantive changes and protected pushes run full", () => {
  const classifierEnvironment = {
    CI_EVENT_NAME: "${{ github.event_name }}",
    CI_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    CI_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    CI_PR_DRAFT: "${{ github.event.pull_request.draft }}"
  };
  const loadWorkflow = (relativePath) =>
    parseYaml(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
  const assertClassifier = (workflow, name) => {
    const job = workflow?.jobs?.classify;
    assert.equal(job?.name, name);
    assert.equal(job?.["runs-on"], "ubuntu-latest");
    assert.equal(job?.["timeout-minutes"], 5);
    assert.equal(job?.outputs?.documentation_only, "${{ steps.classify.outputs.documentation_only }}");
    assert.equal(job?.outputs?.draft_pull_request, "${{ steps.classify.outputs.draft_pull_request }}");
    assert.equal(job?.outputs?.internal_tooling_only, "${{ steps.classify.outputs.internal_tooling_only }}");
    assert.equal(job?.outputs?.lightweight_only, "${{ steps.classify.outputs.lightweight_only }}");
    assert.equal(job?.outputs?.package_only, "${{ steps.classify.outputs.package_only }}");
    assert.equal(job?.outputs?.full_matrix_required, "${{ steps.classify.outputs.full_matrix_required }}");
    assert.deepEqual(job?.steps?.find((step) => step?.uses === "actions/checkout@v6")?.with, {
      "fetch-depth": 0
    });
    const step = job?.steps?.find((candidate) => candidate?.id === "classify");
    assert.equal(step?.run, "node scripts/ci-path-classification.mjs");
    assert.deepEqual(step?.env, classifierEnvironment);
  };

  const ci = loadWorkflow(".github/workflows/ci.yml");
  assertClassifier(ci, "CI change classification");
  for (const jobId of FULL_MATRIX_CI_JOBS) {
    const job = ci?.jobs?.[jobId];
    const needs = Array.isArray(job?.needs) ? job.needs : [job?.needs];
    assert.equal(needs.includes("classify"), true, `${jobId} must consume the exact classifier result.`);
    assert.equal(job?.if, FULL_CI_IF, `${jobId} must use one fail-closed job-level fast-path condition.`);
    assert.equal(
      (job?.steps ?? []).some((step) => String(step?.if ?? "").includes("documentation_only")),
      false,
      `${jobId} must not duplicate documentation classification across individual steps.`
    );
  }
  const canonical = ci?.jobs?.[PACKAGE_CI_JOBS[0]];
  assert.equal(canonical?.if, CANONICAL_CI_IF);
  const packagedMedia = canonical?.steps?.find((step) => step?.name === "Packaged release-media contracts");
  assert.equal(packagedMedia?.if, "${{ needs.classify.outputs.package_only == 'true' }}");
  assert.equal(packagedMedia?.run, "npm run test:scripts:media");
  assert.equal(ci?.jobs?.["fast-feedback"]?.needs, undefined);
  assert.equal(ci?.jobs?.["fast-feedback"]?.if, undefined);
  const internalTooling = ci?.jobs?.[INTERNAL_TOOLING_CI_JOB];
  assert.equal(internalTooling?.name, "Checkout lifecycle contracts");
  assert.equal(internalTooling?.needs, "classify");
  assert.equal(normalizedCommand(internalTooling?.if), INTERNAL_TOOLING_CI_IF);
  assert.equal(internalTooling?.["runs-on"], "ubuntu-latest");
  assert.equal(internalTooling?.["timeout-minutes"], 15);
  assert.deepEqual(
    internalTooling?.steps?.filter((step) => step?.run !== undefined).map((step) => step.run),
    ["node --test scripts/checkout-lifecycle.test.mjs"]
  );

  for (const [relativePath, classifierName, expectedJobs] of [
    [
      ".github/workflows/cross-platform.yml",
      "Cross-platform change classification",
      {
        runtime: {
          name: undefined,
          matrix: {
            include: [
              { os: "macos-latest", python: "3.12" },
              { os: "windows-latest", python: "3.14" }
            ]
          }
        },
        "dependency-guard-windows": {
          name: "Dependency guard (Windows, Python ${{ matrix.python }})",
          matrix: { python: ["3.10", "3.12", "3.14"] }
        }
      }
    ],
    [
      ".github/workflows/codeql.yml",
      "CodeQL change classification",
      {
        analyze: {
          name: "Analyze (${{ matrix.language }})",
          matrix: { language: ["javascript-typescript", "python"] }
        }
      }
    ]
  ]) {
    const workflow = loadWorkflow(relativePath);
    assertClassifier(workflow, classifierName);
    for (const [jobId, expected] of Object.entries(expectedJobs)) {
      const job = workflow?.jobs?.[jobId];
      assert.equal(job?.needs, "classify");
      assert.equal(job?.if, MATRIX_CONTEXT_IF);
      assert.equal(job?.name, expected.name);
      assert.deepEqual(job?.strategy?.matrix, expected.matrix);
      const gate = job?.steps?.[0];
      assert.equal(gate?.name, "Require exact change classification");
      assert.equal(normalizedCommand(gate?.if), CLASSIFICATION_GATE_IF);
      assert.equal(gate?.run, "exit 1");
      const contextCarrier = job?.steps?.[1];
      assert.equal(contextCarrier?.name, "Preserve required non-matrix context");
      assert.equal(normalizedCommand(contextCarrier?.if), NON_MATRIX_CONTEXT_IF);
      assert.match(contextCarrier?.run ?? "", /preserves? (?:its|this) required check context/u);
      for (const step of job?.steps?.slice(2) ?? []) {
        assert.equal(normalizedCommand(step?.if), SUBSTANTIVE_MATRIX_STEP_IF);
      }
    }
  }
});

test("validate remains the fail-closed required aggregate without a skipped-success path", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const aggregate = workflow?.jobs?.validate;

  assert.equal(aggregate?.name, undefined, "The protected validate context must keep its existing name.");
  assert.deepEqual(REQUIRED_CI_JOBS, EXPECTED_BLOCKING_CI_JOBS);
  assert.deepEqual(aggregate?.needs, [...EXPECTED_BLOCKING_CI_JOBS, CONDITIONAL_CI_JOB, OPTIONAL_CI_JOB]);
  assert.equal(aggregate?.if, "${{ !cancelled() }}");
  assert.equal(aggregate?.["runs-on"], "ubuntu-latest");
  assert.equal(aggregate?.["timeout-minutes"], 5);
  assert.equal(aggregate?.["continue-on-error"], undefined);

  const resultStep = aggregate?.steps?.find((step) => step?.run === "node scripts/require-ci-results.mjs");
  assert.ok(resultStep);
  assert.equal(resultStep?.["continue-on-error"], undefined);
  for (const jobId of EXPECTED_BLOCKING_CI_JOBS) {
    assert.equal(resultStep?.env?.[resultEnvironmentKey(jobId)], `\${{ needs.${jobId}.result }}`);
  }
  assert.equal(resultStep?.env?.[resultEnvironmentKey(CONDITIONAL_CI_JOB)], "${{ needs.released-jupyter.result }}");
  assert.equal(resultStep?.env?.RELEASED_JUPYTER_REQUIRED, "${{ needs.classify.outputs.released_jupyter_required }}");
  assert.equal(resultStep?.env?.DOCUMENTATION_ONLY, "${{ needs.classify.outputs.documentation_only }}");
  assert.equal(resultStep?.env?.DRAFT_PULL_REQUEST, "${{ needs.classify.outputs.draft_pull_request }}");
  assert.equal(resultStep?.env?.INTERNAL_TOOLING_ONLY, "${{ needs.classify.outputs.internal_tooling_only }}");
  assert.equal(resultStep?.env?.LIGHTWEIGHT_ONLY, "${{ needs.classify.outputs.lightweight_only }}");
  assert.equal(resultStep?.env?.PACKAGE_ONLY, "${{ needs.classify.outputs.package_only }}");
  assert.equal(resultStep?.env?.FULL_MATRIX_REQUIRED, "${{ needs.classify.outputs.full_matrix_required }}");
  assert.equal(resultStep?.env?.[resultEnvironmentKey(OPTIONAL_CI_JOB)], "${{ needs.remote-workspace.result }}");
  assert.match(resultStep?.env?.REMOTE_WORKSPACE_REQUIRED ?? "", /acceptance:remote-ssh/u);
});

test("required CI result validation rejects every absent or non-success blocking result", () => {
  const successes = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    [INTERNAL_TOOLING_CI_JOB, "skipped"],
    ...PRODUCT_CI_JOBS.map((jobId) => [jobId, "success"])
  ]);
  const documentationResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    [INTERNAL_TOOLING_CI_JOB, "skipped"],
    ...PRODUCT_CI_JOBS.map((jobId) => [jobId, "skipped"])
  ]);
  const internalToolingResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    [INTERNAL_TOOLING_CI_JOB, "success"],
    ...PRODUCT_CI_JOBS.map((jobId) => [jobId, "skipped"])
  ]);
  const packageResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    [INTERNAL_TOOLING_CI_JOB, "skipped"],
    ...PACKAGE_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...FULL_MATRIX_CI_JOBS.map((jobId) => [jobId, "skipped"])
  ]);
  const validateResults = (configuration) => {
    const normalized = { draftPullRequest: false, internalToolingOnly: false, packageOnly: false, ...configuration };
    normalized.lightweightOnly ??=
      normalized.documentationOnly || normalized.internalToolingOnly || normalized.draftPullRequest;
    normalized.fullMatrixRequired ??=
      !normalized.documentationOnly &&
      !normalized.internalToolingOnly &&
      !normalized.packageOnly &&
      !normalized.draftPullRequest;
    return requireCiResults(normalized);
  };
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: internalToolingResults,
      documentationOnly: false,
      internalToolingOnly: true,
      releasedJupyterResult: "skipped",
      releasedJupyterRequired: false,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: successes,
      documentationOnly: false,
      releasedJupyterResult: "skipped",
      releasedJupyterRequired: false,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: documentationResults,
      documentationOnly: true,
      releasedJupyterResult: "skipped",
      releasedJupyterRequired: false,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: packageResults,
      documentationOnly: false,
      packageOnly: true,
      releasedJupyterResult: "skipped",
      releasedJupyterRequired: false,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: successes,
      documentationOnly: false,
      releasedJupyterResult: "success",
      releasedJupyterRequired: true,
      remoteResult: "success",
      remoteRequired: true
    })
  );
  assert.throws(
    () =>
      validateResults({
        requiredResults: documentationResults,
        documentationOnly: false,
        draftPullRequest: true,
        lightweightOnly: true,
        releasedJupyterResult: "skipped",
        releasedJupyterRequired: false,
        remoteResult: "skipped",
        remoteRequired: false
      }),
    /mergeable validation is deferred until ready_for_review/u
  );
  assert.throws(
    () =>
      validateResults({
        requiredResults: documentationResults,
        documentationOnly: false,
        draftPullRequest: true,
        internalToolingOnly: true,
        releasedJupyterResult: "skipped",
        releasedJupyterRequired: false,
        remoteResult: "skipped",
        remoteRequired: false
      }),
    /mergeable validation is deferred until ready_for_review/u
  );
  assert.throws(
    () =>
      validateResults({
        requiredResults: documentationResults,
        documentationOnly: false,
        draftPullRequest: true,
        packageOnly: true,
        releasedJupyterResult: "skipped",
        releasedJupyterRequired: false,
        remoteResult: "skipped",
        remoteRequired: false
      }),
    /mergeable validation is deferred until ready_for_review/u
  );
  for (const [documentationOnly, draftPullRequest, lightweightOnly] of [
    [false, false, true],
    [true, false, false],
    [false, true, false],
    [true, true, false]
  ]) {
    assert.throws(
      () =>
        validateResults({
          requiredResults: documentationResults,
          documentationOnly,
          draftPullRequest,
          lightweightOnly,
          releasedJupyterResult: "skipped",
          releasedJupyterRequired: false,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      /lightweight classifier is inconsistent/u
    );
  }
  for (const configuration of [
    {
      documentationOnly: true,
      packageOnly: true,
      fullMatrixRequired: false,
      message: /classifiers are mutually exclusive/u
    },
    {
      documentationOnly: false,
      internalToolingOnly: true,
      packageOnly: true,
      fullMatrixRequired: false,
      message: /classifiers are mutually exclusive/u
    },
    {
      documentationOnly: false,
      packageOnly: true,
      fullMatrixRequired: true,
      message: /full-matrix classifier is inconsistent/u
    },
    {
      documentationOnly: false,
      packageOnly: false,
      fullMatrixRequired: false,
      message: /full-matrix classifier is inconsistent/u
    }
  ]) {
    assert.throws(
      () =>
        validateResults({
          requiredResults: documentationResults,
          documentationOnly: configuration.documentationOnly,
          internalToolingOnly: configuration.internalToolingOnly ?? false,
          packageOnly: configuration.packageOnly,
          fullMatrixRequired: configuration.fullMatrixRequired,
          releasedJupyterResult: "skipped",
          releasedJupyterRequired: false,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      configuration.message
    );
  }

  for (const jobId of [...ALWAYS_REQUIRED_CI_JOBS, ...PRODUCT_CI_JOBS]) {
    for (const result of [undefined, "failure", "cancelled", "skipped"]) {
      const candidate = { ...successes };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            releasedJupyterResult: "skipped",
            releasedJupyterRequired: false,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"}`, "u")
      );
    }
  }

  for (const result of [undefined, "success", "failure", "cancelled"]) {
    const candidate = { ...successes };
    if (result === undefined) delete candidate[INTERNAL_TOOLING_CI_JOB];
    else candidate[INTERNAL_TOOLING_CI_JOB] = result;
    assert.throws(
      () =>
        validateResults({
          requiredResults: candidate,
          documentationOnly: false,
          releasedJupyterResult: "skipped",
          releasedJupyterRequired: false,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      new RegExp(`${INTERNAL_TOOLING_CI_JOB}=${result ?? "missing"} \\(expected skipped\\)`, "u")
    );
  }

  for (const result of [undefined, "skipped", "failure", "cancelled"]) {
    const candidate = { ...internalToolingResults };
    if (result === undefined) delete candidate[INTERNAL_TOOLING_CI_JOB];
    else candidate[INTERNAL_TOOLING_CI_JOB] = result;
    assert.throws(
      () =>
        validateResults({
          requiredResults: candidate,
          documentationOnly: false,
          internalToolingOnly: true,
          releasedJupyterResult: "skipped",
          releasedJupyterRequired: false,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      new RegExp(`${INTERNAL_TOOLING_CI_JOB}=${result ?? "missing"} \\(expected success\\)`, "u")
    );
  }

  for (const jobId of ALWAYS_REQUIRED_CI_JOBS) {
    const candidate = { ...documentationResults, [jobId]: "skipped" };
    assert.throws(
      () =>
        validateResults({
          requiredResults: candidate,
          documentationOnly: true,
          releasedJupyterResult: "skipped",
          releasedJupyterRequired: false,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      new RegExp(`${jobId}=skipped`, "u")
    );
  }
  for (const jobId of PRODUCT_CI_JOBS) {
    for (const result of [undefined, "success", "failure", "cancelled"]) {
      const candidate = { ...documentationResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: true,
            releasedJupyterResult: "skipped",
            releasedJupyterRequired: false,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected skipped\\)`, "u")
      );
    }
  }
  for (const jobId of PACKAGE_CI_JOBS) {
    for (const result of [undefined, "skipped", "failure", "cancelled"]) {
      const candidate = { ...packageResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            packageOnly: true,
            releasedJupyterResult: "skipped",
            releasedJupyterRequired: false,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected success\\)`, "u")
      );
    }
  }
  for (const jobId of FULL_MATRIX_CI_JOBS) {
    for (const result of [undefined, "success", "failure", "cancelled"]) {
      const candidate = { ...packageResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            packageOnly: true,
            releasedJupyterResult: "skipped",
            releasedJupyterRequired: false,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected skipped\\)`, "u")
      );
    }
  }
  for (const inconsistent of [
    { releasedJupyterRequired: true, remoteRequired: false, message: /released-jupyter classifier is inconsistent/u },
    { releasedJupyterRequired: false, remoteRequired: true, message: /remote-workspace classifier is inconsistent/u }
  ]) {
    assert.throws(
      () =>
        validateResults({
          requiredResults: documentationResults,
          documentationOnly: true,
          releasedJupyterResult: "skipped",
          releasedJupyterRequired: inconsistent.releasedJupyterRequired,
          remoteResult: "skipped",
          remoteRequired: inconsistent.remoteRequired
        }),
      inconsistent.message
    );
  }

  assert.throws(
    () =>
      validateResults({
        requiredResults: successes,
        documentationOnly: false,
        releasedJupyterResult: "skipped",
        releasedJupyterRequired: false,
        remoteResult: "skipped",
        remoteRequired: true
      }),
    /remote-workspace=skipped \(expected success\)/u
  );
  assert.throws(
    () =>
      validateResults({
        requiredResults: successes,
        documentationOnly: false,
        releasedJupyterResult: "skipped",
        releasedJupyterRequired: false,
        remoteResult: "success",
        remoteRequired: false
      }),
    /remote-workspace=success \(expected skipped\)/u
  );
  for (const [releasedJupyterRequired, releasedJupyterResult, expected] of [
    [true, undefined, "missing"],
    [true, "failure", "failure"],
    [true, "cancelled", "cancelled"],
    [true, "skipped", "skipped"],
    [false, "success", "success"]
  ]) {
    assert.throws(
      () =>
        validateResults({
          requiredResults: successes,
          documentationOnly: false,
          releasedJupyterResult,
          releasedJupyterRequired,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      new RegExp(`released-jupyter=${expected}`, "u")
    );
  }
  assert.equal(parseRequiredFlag("true", "TEST_REQUIRED"), true);
  assert.equal(parseRequiredFlag("false", "TEST_REQUIRED"), false);
  for (const value of [undefined, "", "TRUE", "False", "0", "1"]) {
    assert.throws(() => parseRequiredFlag(value, "TEST_REQUIRED"), /TEST_REQUIRED must be exactly true or false/u);
  }
});

test("opt-in Remote SSH acceptance consumes the same canonical VSIX once", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const job = workflow?.jobs?.["remote-workspace"];
  assert.deepEqual(job?.needs, ["classify", "canonical-vsix"]);
  assert.equal(job?.["runs-on"], "ubuntu-24.04");
  assert.equal(job?.["timeout-minutes"], 90);
  assert.match(job?.if ?? "", /!cancelled\(\)/u);
  assert.match(job?.if ?? "", /needs\.classify\.outputs\.full_matrix_required == 'true'/u);
  assert.match(job?.if ?? "", /github\.event_name == 'pull_request'/u);
  assert.match(job?.if ?? "", /contains\(github\.event\.pull_request\.labels\.\*\.name, 'acceptance:remote-ssh'\)/u);

  const steps = job?.steps;
  assert.ok(Array.isArray(steps), "CI must retain the opt-in Remote SSH acceptance job.");
  const prerequisite = steps.find((step) => step?.name === "Require the canonical PR artifact");
  assert.match(prerequisite?.if ?? "", /needs\.canonical-vsix\.result != 'success'/u);
  assert.equal(prerequisite?.run, "exit 1");

  const host = steps.find((step) => step?.name === "Prepare namespace-capable acceptance host");
  assert.match(host?.run ?? "", /kernel\.apparmor_restrict_unprivileged_userns=0/u);
  assert.match(host?.run ?? "", /kernel\.unprivileged_userns_clone=1/u);
  assert.match(host?.run ?? "", /user\.max_user_namespaces/u);
  assert.match(host?.run ?? "", /coreutils/u);
  assert.match(host?.run ?? "", /libtomcrypt1/u);
  assert.match(host?.run ?? "", /libtommath1/u);
  assert.match(host?.run ?? "", /procps/u);
  assert.equal((host?.run ?? "").includes('runner_uid="$(id -u)"'), true);
  assert.equal((host?.run ?? "").includes('test "$owner" = "0" || test "$owner" = "$runner_uid"'), true);
  assert.equal(
    (host?.run ?? "").includes('sudo chown --no-dereference root:root -- "${system_runtime_ancestors[@]}"'),
    true
  );
  assert.equal((host?.run ?? "").includes('sudo chmod go-w -- "${system_runtime_ancestors[@]}"'), true);
  assert.equal((host?.run ?? "").includes('for directory in / "${system_runtime_ancestors[@]}"; do'), true);
  assert.equal((host?.run ?? "").includes(`test "$(stat --format='%u:%g' "$directory")" = "0:0"`), true);
  assert.equal((host?.run ?? "").includes(`find "$directory" -maxdepth 0 -perm /022 -print -quit`), true);
  assert.equal((host?.run ?? "").includes('test ! -w "$directory"'), true);
  const ancestors = /system_runtime_ancestors=\(\n(?<ancestors>(?: {2}\/[^\n]+\n)+)\)\n/u.exec(host?.run ?? "");
  assert.ok(ancestors?.groups?.ancestors, "Remote SSH CI must retain one explicit system-ancestor array.");
  assert.deepEqual(
    ancestors.groups.ancestors
      .trim()
      .split("\n")
      .map((line) => line.trim()),
    ["/usr", "/etc"]
  );
  assert.equal((host?.run ?? "").includes("sudo chmod go-w -- /usr/share"), true);
  assert.equal((host?.run ?? "").includes("test ! -w /usr/share"), true);
  assert.equal((host?.run ?? "").includes('sudo chmod --recursive go-w -- "${system_runtime_roots[@]}"'), true);
  assert.equal((host?.run ?? "").includes('find "$directory" -xdev'), true);
  assert.equal((host?.run ?? "").includes("! -user root -print -quit"), true);
  assert.equal((host?.run ?? "").includes("-perm /022 -print -quit"), true);
  assert.equal((host?.run ?? "").includes("! -type d ! -type f ! -type l -print -quit"), true);
  const roots = /system_runtime_roots=\(\n(?<roots>(?: {2}\/[^\n]+\n)+)\)\n/u.exec(host?.run ?? "");
  assert.ok(roots?.groups?.roots, "Remote SSH CI must retain one explicit system-runtime root array.");
  assert.deepEqual(
    roots.groups.roots
      .trim()
      .split("\n")
      .map((line) => line.trim()),
    [
      "/usr/share/fontconfig",
      "/usr/share/fonts",
      "/usr/share/glib-2.0",
      "/usr/share/icons",
      "/usr/share/mime",
      "/usr/share/X11",
      "/usr/share/zoneinfo"
    ]
  );
  assert.ok(
    steps.some((step) => step?.run === ".remote-venv/bin/python -m pip install ./python"),
    "Remote SSH CI must install one self-contained runtime environment."
  );

  const download = steps.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/download-artifact@")
  );
  assert.equal(download?.with?.name, "openwrangler-vsix");
  assert.equal(download?.with?.path, "canonical-vsix");

  const candidate = steps.find((step) => step?.id === "candidate");
  assert.match(candidate?.run ?? "", /resolve\("canonical-vsix\/openwrangler\.vsix"\)/u);
  assert.match(candidate?.run ?? "", /path=\$\{candidatePath\}/u);
  assert.match(candidate?.run ?? "", /openwrangler\.vsix\.sha256/u);
  assert.match(candidate?.run ?? "", /GITHUB_OUTPUT/u);

  const acceptance = steps.find((step) => step?.id === "remote_workspace");
  assert.match(acceptance?.run ?? "", /^npm run test:remote-workspace --/u);
  assert.match(acceptance?.run ?? "", /steps\.candidate\.outputs\.path/u);
  assert.equal(acceptance?.env?.OPEN_WRANGLER_EDITOR_DISPLAY, "xvfb");
  assert.equal(acceptance?.env?.OPEN_WRANGLER_REMOTE_PYTHON, "${{ github.workspace }}/.remote-venv/bin/python");
  assert.equal(steps.filter((step) => String(step?.run ?? "").includes("npm run test:remote-workspace --")).length, 1);
});

test("draft fast feedback cannot satisfy merge protection before same-SHA ready validation", () => {
  for (const relativePath of requiredPullRequestWorkflows) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const workflow = parseYaml(source);
    assert.match(source, /\non:\n {2}pull_request:/u, `${relativePath} must retain its pull-request trigger.`);
    assert.deepEqual(
      workflow?.on?.pull_request?.types,
      PULL_REQUEST_ACTIVITY_TYPES,
      `${relativePath} must rerun when the same head becomes ready or returns to draft.`
    );
    const classify = workflow?.jobs?.classify?.steps?.find((step) => step?.id === "classify");
    assert.equal(classify?.env?.CI_PR_DRAFT, "${{ github.event.pull_request.draft }}");
  }
  const aggregateSource = readFileSync(new URL("./require-ci-results.mjs", import.meta.url), "utf8");
  assert.match(aggregateSource, /Draft pull request passed fast feedback/u);
  assert.match(aggregateSource, /ready_for_review reruns its required CI tier/u);
});

test("routine Dependabot work is grouped, bounded, and staggered without grouping security updates", () => {
  const source = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.equal(
    source,
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "03:17"
      timezone: Etc/UTC
    open-pull-requests-limit: 4
    groups:
      npm-production-minor-patch:
        applies-to: version-updates
        dependency-type: production
        patterns:
          - "*"
        update-types:
          - minor
          - patch
      npm-development-minor-patch:
        applies-to: version-updates
        dependency-type: development
        patterns:
          - "*"
        update-types:
          - minor
          - patch
  - package-ecosystem: pip
    directory: /python
    schedule:
      interval: weekly
      day: tuesday
      time: "03:17"
      timezone: Etc/UTC
    open-pull-requests-limit: 4
    groups:
      python-production-minor-patch:
        applies-to: version-updates
        dependency-type: production
        patterns:
          - "*"
        update-types:
          - minor
          - patch
      python-development-minor-patch:
        applies-to: version-updates
        dependency-type: development
        patterns:
          - "*"
        update-types:
          - minor
          - patch
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: wednesday
      time: "03:17"
      timezone: Etc/UTC
    open-pull-requests-limit: 3
    groups:
      actions-minor-patch:
        applies-to: version-updates
        patterns:
          - "*"
        update-types:
          - minor
          - patch
`
  );
});

test("required Linux Python 3.10 owns real discovery while cross-platform keeps distinct native cells", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const job = workflow?.jobs?.["python-matrix"];
  assert.equal(job?.["runs-on"], "ubuntu-latest");
  assert.deepEqual(job?.strategy?.matrix?.python, ["3.10", "3.14"]);
  assert.equal(job?.env, undefined, "The real-discovery job must not inject an interpreter override.");

  const steps = job?.steps;
  assert.ok(Array.isArray(steps), "CI must retain the required Python compatibility matrix.");
  const python310Only = "matrix.python == '3.10'";
  const node = steps.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-node@"));
  assert.equal(node?.if, python310Only);
  assert.equal(node?.with?.["node-version"], 22);
  assert.equal(node?.with?.cache, "npm");

  const npmInstall = steps.find((step) => step?.run === "npm ci");
  assert.equal(npmInstall?.if, python310Only);
  assert.equal(npmInstall?.env, undefined);
  const environmentSmoke = steps.find((step) => step?.run === "npm run test:python-environment-smoke");
  assert.equal(environmentSmoke?.if, python310Only);
  assert.equal(environmentSmoke?.env, undefined);

  const duckdbMinimum = steps.find(
    (step) => step?.run === 'python -m pip install --force-reinstall --no-deps "duckdb==1.5.4"'
  );
  assert.equal(duckdbMinimum?.name, "Pin the declared DuckDB minimum");
  assert.equal(duckdbMinimum?.if, "matrix.python == '3.14'");

  const runtimeSuite = steps.filter((step) => step?.run === "python -m pytest python/tests -q");
  assert.equal(runtimeSuite.length, 1);
  assert.equal(runtimeSuite[0]?.if, undefined, "The runtime suite must execute on both matrix cells.");

  const crossPlatformSource = readFileSync(new URL("../.github/workflows/cross-platform.yml", import.meta.url), "utf8");
  const crossPlatform = parseYaml(crossPlatformSource);
  assert.deepEqual(crossPlatform?.jobs?.runtime?.strategy?.matrix?.include, [
    { os: "macos-latest", python: "3.12" },
    { os: "windows-latest", python: "3.14" }
  ]);
});

test("native R contracts run only in the focused R 4.4 and 4.5 matrix", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const job = workflow?.jobs?.["native-r-contract"];

  assert.equal(job?.name, "Native R contract (R ${{ matrix.r }})");
  assert.equal(job?.needs, "classify");
  assert.equal(job?.if, FULL_CI_IF);
  assert.equal(job?.["runs-on"], "ubuntu-latest");
  assert.equal(job?.["timeout-minutes"], 15);
  assert.deepEqual(job?.strategy, { "fail-fast": false, matrix: { r: ["4.4", "4.5"] } });

  const setup = job?.steps?.find((step) => step?.uses === SETUP_R_ACTION);
  assert.deepEqual(setup?.with, { "r-version": "${{ matrix.r }}", "use-public-rspm": true });
  assert.equal(
    job?.steps?.filter((step) => step?.run === "npm run test:r-contract").length,
    1,
    "The focused R matrix must own the cross-language contract exactly once."
  );
  for (const [jobId, candidate] of Object.entries(workflow?.jobs ?? {})) {
    if (jobId === "native-r-contract") continue;
    assert.equal(
      candidate?.steps?.some((step) => step?.uses === SETUP_R_ACTION || step?.run === "npm run test:r-contract"),
      false,
      `${jobId} must not install or execute R contract tooling.`
    );
  }
});

test("coverage provisions the exact PySpark runtime before enforcing the unchanged floor", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const workflow = parseYaml(source);
  const steps = workflow?.jobs?.coverage?.steps;
  assert.ok(Array.isArray(steps), "CI must retain the required coverage job.");

  const java = steps.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-java@"));
  assert.deepEqual(java?.with, {
    distribution: "temurin",
    "java-version": "17"
  });
  const install = steps.find(
    (step) => step?.run === 'python -m pip install "pandas>=2.2,<3.0" "pyspark[connect]==4.2.0"'
  );
  assert.ok(install);
  const verification = steps.find((step) => step?.name === "Verify exact coverage runtimes");
  assert.equal(verification?.shell, "bash");
  assert.match(verification?.run ?? "", /pyspark\.__version__ == "4\.2\.0"/u);
  assert.match(verification?.run ?? "", /Version\("2\.2"\).*Version\("3"\)/u);
  assert.match(verification?.run ?? "", /java\\\.specification\\\.version = 17/u);

  const coverage = steps.find((step) => step?.run === "npm run test:coverage");
  assert.ok(coverage);
  assert.ok(steps.indexOf(java) < steps.indexOf(coverage));
  assert.ok(steps.indexOf(install) < steps.indexOf(coverage));
  assert.ok(steps.indexOf(verification) < steps.indexOf(coverage));
  assert.equal(
    manifest?.scripts?.["test:coverage"],
    "node scripts/run-heavy-local-command.mjs test:coverage -- npm run test:coverage:run",
    "Coverage must acquire the shared local heavy-command lease."
  );
  assert.equal(
    manifest?.scripts?.["test:coverage:run"],
    "npm run test:coverage:ts && npm run test:coverage:python",
    "Coverage must continue to own both complete instrumented suites."
  );
  assert.equal(manifest?.scripts?.["test:coverage:ts"], "vitest run --coverage");
  assert.match(manifest?.scripts?.["test:coverage:python"] ?? "", /pytest python\/tests .*--cov=openwrangler_runtime/u);
});

test("standalone released-Jupyter acceptance is schedule/manual-only and self-packages", () => {
  const source = readFileSync(new URL("../.github/workflows/released-jupyter.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(Object.keys(workflow?.on ?? {}), ["workflow_dispatch", "schedule"]);
  assert.equal(workflow?.on?.pull_request, undefined);
  assert.deepEqual(workflow?.concurrency, {
    group: "released-jupyter-${{ github.ref }}",
    "cancel-in-progress": false
  });
  assert.equal(
    workflow?.jobs?.vscode?.steps?.some((step) => step?.run === "npm run package -- --out openwrangler.vsix"),
    true,
    "Standalone released-Jupyter acceptance must let package.json select its VSIX channel."
  );
  assert.doesNotMatch(source, /npm run package -- --pre-release/u);
  assert.equal(
    workflow?.jobs?.vscode?.steps?.some((step) => step?.run === 'python -m pip install -e "python[dev]"'),
    true
  );
  assert.deepEqual(
    workflow?.jobs?.vscode?.steps?.find(
      (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-java@")
    )?.with,
    {
      distribution: "temurin",
      "java-version": "17"
    }
  );
});
