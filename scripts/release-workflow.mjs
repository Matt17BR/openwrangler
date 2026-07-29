import { isDeepStrictEqual } from "node:util";
import { load as parseYaml } from "js-yaml";

const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const EVENT_SHA = "${{ github.sha }}";
const EVENT_TAG = "${{ github.ref_name }}";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const CHECKOUT_ACTION = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE_ACTION = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const SETUP_PYTHON_ACTION = "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1";
const SETUP_JAVA_ACTION = "actions/setup-java@f2beeb24e141e01a676f977032f5a29d81c9e27e";
const RELEASE_ACTION = "softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65";
const PYSPARK_COVERAGE_VERIFY_RUN = `python - <<'PY'
import pandas
import pyspark
from packaging.version import Version

assert pyspark.__version__ == "4.2.0", pyspark.__version__
assert Version("2.2") <= Version(pandas.__version__) < Version("3"), pandas.__version__
PY
java -XshowSettings:properties -version 2>&1 |
  grep -Eq '^[[:space:]]*java\\.specification\\.version = 17$'
`;
const PREVIEW_RELEASE_JOB_NAMES = [
  "preview-metadata",
  "build",
  "validate",
  "release-acceptance",
  "release",
  "promote-open-vsx"
];
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
const PREVIEW_CHECKSUM_RUN = `const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");

const digest = createHash("sha256").update(readFileSync("openwrangler.vsix")).digest("hex");
writeFileSync("openwrangler.vsix.sha256", \`\${digest}  openwrangler.vsix\\n\`);
`;
const PREVIEW_SOURCE_CHECK_RUN = `test "$(git rev-parse HEAD)" = "$(git rev-parse "\${EXPECTED_SHA}^{commit}")"
git update-index -q --refresh
git diff-index --quiet HEAD --
`;
const PREVIEW_BUILD_STEPS = [
  { uses: CHECKOUT_ACTION },
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
    run: 'python -m pip install --no-deps "https://files.pythonhosted.org/packages/90/b0/114463d056b6b328d45557001e848b8ab15539bd8f4fa7a457ccb83e2b5d/uv-0.11.32-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl#sha256=3da76cd4e2697de30928b8a8524bd39183ac1e08cb7e72833807c022b7cba6c4"'
  },
  { run: "npm run lock:remote-jupyter:check" },
  {
    name: "Package canonical preview VSIX",
    run: "npm run package -- --pre-release --out openwrangler.vsix"
  },
  {
    name: "Verify exact tagged source after packaging",
    shell: "bash",
    env: {
      EXPECTED_SHA: EVENT_SHA
    },
    run: PREVIEW_SOURCE_CHECK_RUN
  },
  {
    name: "Verify canonical preview VSIX",
    run: "npm run verify:vsix -- openwrangler.vsix"
  },
  {
    name: "Create canonical preview checksum",
    shell: "node {0}",
    run: PREVIEW_CHECKSUM_RUN
  },
  {
    uses: UPLOAD_ACTION,
    with: {
      name: "openwrangler-release",
      path: "openwrangler.vsix\nopenwrangler.vsix.sha256\n",
      "if-no-files-found": "error",
      "compression-level": 0
    }
  }
];
const PREVIEW_BUILD_JOB = {
  needs: "preview-metadata",
  "runs-on": "ubuntu-latest",
  steps: PREVIEW_BUILD_STEPS
};
const CANONICAL_CHECKSUM_RUN = `const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const expectedLine = readFileSync("release/openwrangler.vsix.sha256", "utf8").trim();
const match = /^([0-9a-f]{64})\\s+\\*?openwrangler\\.vsix$/iu.exec(expectedLine);
if (!match) throw new Error(\`Malformed canonical checksum: \${expectedLine}\`);
const actual = createHash("sha256")
  .update(readFileSync("release/openwrangler.vsix"))
  .digest("hex");
if (actual !== match[1].toLowerCase()) {
  throw new Error(\`Canonical VSIX checksum mismatch: expected \${match[1]}, received \${actual}\`);
}
`;
const PREVIEW_VALIDATE_JOB = {
  needs: "build",
  "timeout-minutes": 60,
  strategy: {
    "fail-fast": false,
    matrix: {
      include: [
        { os: "ubuntu-latest", python: "3.10" },
        { os: "macos-latest", python: "3.12" },
        { os: "windows-latest", python: "3.14" }
      ]
    }
  },
  "runs-on": "${{ matrix.os }}",
  steps: [
    { uses: CHECKOUT_ACTION },
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
        "python-version": "${{ matrix.python }}",
        cache: "pip"
      }
    },
    { run: "npm ci" },
    { run: "python -m pip install --upgrade pip" },
    { run: 'python -m pip install -e "python[dev]"' },
    {
      uses: DOWNLOAD_ACTION,
      with: {
        name: "openwrangler-release",
        path: "release"
      }
    },
    {
      name: "Verify canonical checksum",
      shell: "node {0}",
      run: CANONICAL_CHECKSUM_RUN
    },
    { run: "npm run check" },
    { run: "npm test" },
    { run: "npm run verify:vsix -- release/openwrangler.vsix" },
    {
      if: "${{ runner.os != 'Linux' }}",
      run: "npm run test:extension-host",
      env: {
        VSCODE_TEST_VERSION: "stable"
      }
    },
    {
      if: "${{ runner.os != 'Linux' }}",
      run: "npm run build:test-extension"
    },
    {
      if: "${{ runner.os != 'Linux' }}",
      id: "packaged_editor",
      name: "Test packaged editor",
      run: "node scripts/run-packaged-editor-tests.mjs release/openwrangler.vsix",
      env: {
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    {
      name: "Upload packaged-editor failure diagnostics",
      if: "${{ always() && runner.os != 'Linux' && steps.packaged_editor.outcome == 'failure' && steps.packaged_editor.outputs.evidence_ready == 'true' }}",
      uses: UPLOAD_ACTION,
      with: {
        name: "release-packaged-editor-diagnostics-vscode-${{ runner.os }}-${{ github.run_attempt }}",
        path: "${{ steps.packaged_editor.outputs.evidence_path }}",
        "if-no-files-found": "error",
        "retention-days": 7,
        "compression-level": 9,
        "include-hidden-files": false
      }
    },
    {
      if: "${{ runner.os != 'Linux' }}",
      id: "cursor_smoke",
      name: "Test pinned Cursor platform smoke",
      run: "node scripts/run-packaged-editor-tests.mjs release/openwrangler.vsix",
      env: {
        OPEN_WRANGLER_PACKAGED_EDITORS: "cursor",
        OPEN_WRANGLER_PACKAGED_MODE: "platform-smoke"
      }
    },
    {
      name: "Upload Cursor-smoke failure diagnostics",
      if: "${{ always() && runner.os != 'Linux' && steps.cursor_smoke.outcome == 'failure' && steps.cursor_smoke.outputs.evidence_ready == 'true' }}",
      uses: UPLOAD_ACTION,
      with: {
        name: "release-packaged-editor-diagnostics-cursor-${{ runner.os }}-${{ github.run_attempt }}",
        path: "${{ steps.cursor_smoke.outputs.evidence_path }}",
        "if-no-files-found": "error",
        "retention-days": 7,
        "compression-level": 9,
        "include-hidden-files": false
      }
    }
  ]
};
const PREVIEW_RELEASE_ACCEPTANCE_JOB = {
  needs: ["build", "validate"],
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 60,
  steps: [
    { uses: CHECKOUT_ACTION },
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
      uses: SETUP_JAVA_ACTION,
      with: {
        distribution: "temurin",
        "java-version": "17"
      }
    },
    { run: "npm ci" },
    { run: "npx playwright-core install --with-deps chromium" },
    { run: "python -m pip install --upgrade pip" },
    { run: 'python -m pip install -e "python[dev]"' },
    { run: 'python -m pip install "pandas>=2.2,<3.0" "pyspark[connect]==4.2.0"' },
    {
      name: "Verify exact coverage runtimes",
      shell: "bash",
      run: PYSPARK_COVERAGE_VERIFY_RUN
    },
    {
      uses: DOWNLOAD_ACTION,
      with: {
        name: "openwrangler-release",
        path: "release"
      }
    },
    {
      name: "Verify canonical checksum",
      shell: "node {0}",
      run: CANONICAL_CHECKSUM_RUN
    },
    { run: "npm run verify:vsix -- release/openwrangler.vsix" },
    { run: "npm run test:webview-acceptance" },
    {
      if: "failure()",
      uses: UPLOAD_ACTION,
      with: {
        name: "release-webview-visual-evidence",
        path: "tmp/screenshots-actual/\ntmp/screenshots-diff/\n",
        "if-no-files-found": "ignore"
      }
    },
    { run: "npm run test:coverage" },
    { run: "npm audit --omit=dev" },
    { run: "npm run audit:python" },
    { run: "npm run benchmark:runtime" },
    { run: "npm run build:test-extension" },
    {
      id: "packaged_editor",
      name: "Test packaged editor",
      run: "node scripts/run-packaged-editor-tests.mjs release/openwrangler.vsix",
      env: {
        OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
        VSCODE_TEST_VERSION: "stable"
      }
    },
    {
      name: "Upload packaged-editor failure diagnostics",
      if: "${{ always() && steps.packaged_editor.outcome == 'failure' && steps.packaged_editor.outputs.evidence_ready == 'true' }}",
      uses: UPLOAD_ACTION,
      with: {
        name: "release-packaged-editor-diagnostics-vscode-${{ runner.os }}-${{ github.run_attempt }}",
        path: "${{ steps.packaged_editor.outputs.evidence_path }}",
        "if-no-files-found": "error",
        "retention-days": 7,
        "compression-level": 9,
        "include-hidden-files": false
      }
    }
  ]
};
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

function uniqueNamedStep(steps, name, problems, jobName = "build") {
  const matches = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => isRecord(step) && step.name === name);
  if (matches.length !== 1) {
    problems.push(`release.yml ${jobName} job must contain exactly one "${name}" step; found ${matches.length}.`);
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
    workflow.on.push.tags[0] !== "v0.*[13579].*"
  ) {
    problems.push('release.yml must trigger only from numeric preview-channel "v0.*[13579].*" tags.');
  }
  if (!hasExactPermissions(workflow.permissions, { contents: "read" })) {
    problems.push("release.yml default permissions must be exactly contents: read.");
  }
  if (hasOwn(workflow, "env") || hasOwn(workflow, "defaults")) {
    problems.push("release.yml must not override workflow environment or run defaults.");
  }
  const jobNames = Object.keys(workflow.jobs);
  if (
    jobNames.length !== PREVIEW_RELEASE_JOB_NAMES.length ||
    PREVIEW_RELEASE_JOB_NAMES.some((name) => !hasOwn(workflow.jobs, name))
  ) {
    problems.push(
      "release.yml jobs must be exactly preview-metadata, build, validate, release-acceptance, release, and promote-open-vsx."
    );
  }

  const previewMetadataJob = workflow.jobs["preview-metadata"];
  if (!isRecord(previewMetadataJob)) {
    problems.push("release.yml must contain one preview-only metadata gate job.");
  } else {
    problems.push(...inspectJobExecutionControls(previewMetadataJob, "preview-metadata"));
    if (hasOwn(previewMetadataJob, "needs") || hasOwn(previewMetadataJob, "outputs")) {
      problems.push("release.yml preview-metadata job must run independently and publish no channel outputs.");
    }
    const metadataSteps = previewMetadataJob.steps;
    if (!Array.isArray(metadataSteps) || metadataSteps.length !== 3 || metadataSteps.some((step) => !isRecord(step))) {
      problems.push(
        "release.yml preview-metadata job must contain exactly checkout, Node setup, and the preview-only metadata gate."
      );
    } else {
      const [checkout, setupNode] = metadataSteps;
      if (
        checkout.uses !== CHECKOUT_ACTION ||
        Object.keys(checkout).length !== 1 ||
        setupNode.uses !== SETUP_NODE_ACTION ||
        !isRecord(setupNode.with) ||
        Object.keys(setupNode).length !== 2 ||
        Object.keys(setupNode.with).length !== 2 ||
        setupNode.with["node-version"] !== 22 ||
        setupNode.with.cache !== "npm"
      ) {
        problems.push(
          "release.yml preview-metadata job must begin with only canonical checkout and Node setup actions."
        );
      } else {
        requireDefaultActionControls(checkout, "preview-metadata checkout", problems);
        requireDefaultActionControls(setupNode, "preview-metadata Node setup", problems);
      }
      const metadata = uniqueNamedStep(
        metadataSteps,
        "Validate preview release tag and manifest channel",
        problems,
        "preview-metadata"
      );
      requireExactStep(
        metadata,
        {
          env: { RELEASE_TAG: EVENT_TAG },
          id: "release_metadata",
          run: "node scripts/release-metadata.mjs --preview-only"
        },
        problems
      );
      if (metadata !== undefined && metadata.index !== 2) {
        problems.push("release.yml preview-only metadata gate must be the final preview-metadata step.");
      }
    }
  }

  problems.push(...inspectJobExecutionControls(workflow.jobs.build, "build"));
  if (!isDeepStrictEqual(workflow.jobs.build, PREVIEW_BUILD_JOB)) {
    problems.push(
      "release.yml build job must retain exactly its canonical controls and ordered preview-only step/action allowlist."
    );
  }
  if (workflow.jobs.build.needs !== "preview-metadata" || hasOwn(workflow.jobs.build, "outputs")) {
    problems.push(
      "release.yml build job must depend only on the successful preview-metadata gate and publish no channel outputs."
    );
  }
  const steps = workflow.jobs.build.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 128) {
    return [...problems, "release.yml build job must contain a bounded non-empty steps array."];
  }

  const previewPackage = uniqueNamedStep(steps, "Package canonical preview VSIX", problems);
  const sourceCheck = uniqueNamedStep(steps, "Verify exact tagged source after packaging", problems);
  const previewVerification = uniqueNamedStep(steps, "Verify canonical preview VSIX", problems);
  const previewChecksum = uniqueNamedStep(steps, "Create canonical preview checksum", problems);

  requireExactStep(
    previewPackage,
    {
      run: "npm run package -- --pre-release --out openwrangler.vsix"
    },
    problems
  );
  requireExactStep(
    sourceCheck,
    {
      env: { EXPECTED_SHA: EVENT_SHA },
      shell: "bash",
      run: PREVIEW_SOURCE_CHECK_RUN
    },
    problems
  );
  requireExactStep(
    previewVerification,
    {
      run: "npm run verify:vsix -- openwrangler.vsix"
    },
    problems
  );
  requireExactStep(
    previewChecksum,
    {
      shell: "node {0}",
      run: PREVIEW_CHECKSUM_RUN
    },
    problems
  );

  const ordered = [previewPackage, sourceCheck, previewVerification, previewChecksum];
  if (
    ordered.every((entry) => entry !== undefined) &&
    ordered.some((entry, index) => index > 0 && entry.index <= ordered[index - 1].index)
  ) {
    problems.push("release.yml build release-gate steps must remain in canonical order.");
  }
  const forbiddenStableSteps = new Set([
    "Package stable VSIX candidate",
    "Verify stable VSIX candidate",
    "Enforce stable release readiness and publish immutable snapshot"
  ]);
  if (steps.some((step) => isRecord(step) && forbiddenStableSteps.has(step.name))) {
    problems.push("release.yml preview build must not contain stable packaging, verification, or readiness steps.");
  }

  const uploads = steps
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => isRecord(step) && step.uses === UPLOAD_ACTION);
  if (uploads.length !== 1) {
    problems.push(`release.yml build job must contain exactly one canonical release upload; found ${uploads.length}.`);
  } else {
    const upload = uploads[0];
    requireDefaultActionControls(upload.step, "canonical upload", problems);
    if (previewVerification !== undefined && previewChecksum !== undefined) {
      if (previewChecksum.index !== previewVerification.index + 1 || upload.index !== previewChecksum.index + 1) {
        problems.push(
          "release.yml preview verification, checksum, and canonical upload must be one exact final chain."
        );
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

  if (!isDeepStrictEqual(workflow.jobs.validate, PREVIEW_VALIDATE_JOB)) {
    problems.push(
      "release.yml validate job must retain exactly its canonical read-only controls, matrix, and ordered step/action allowlist."
    );
  }
  if (!isDeepStrictEqual(workflow.jobs["release-acceptance"], PREVIEW_RELEASE_ACCEPTANCE_JOB)) {
    problems.push(
      "release.yml release-acceptance job must retain exactly its canonical read-only controls and ordered step/action allowlist."
    );
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
      options.prerelease !== true ||
      options.generate_release_notes !== true ||
      options.fail_on_unmatched_files !== true ||
      normalizeLines(options.files).join("\n") !== "release/openwrangler.vsix\nrelease/openwrangler.vsix.sha256"
    ) {
      problems.push("release.yml GitHub Release action must publish only the validated canonical files.");
    }
  }

  const openVsxPromotionJob = workflow.jobs["promote-open-vsx"];
  if (
    !isRecord(openVsxPromotionJob) ||
    !isDeepStrictEqual(openVsxPromotionJob, {
      needs: "release",
      uses: "./.github/workflows/open-vsx-promotion.yml",
      with: {
        release_tag: EVENT_TAG
      }
    })
  ) {
    problems.push(
      "release.yml must directly call the protected Open VSX promotion workflow after GitHub preview publication."
    );
  }

  return problems;
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
