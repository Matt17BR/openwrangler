import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load as parseYaml } from "js-yaml";

const replaceablePendingWorkflows = [
  [".github/workflows/ci.yml", "ci"],
  [".github/workflows/cross-platform.yml", "cross-platform"],
  [".github/workflows/codeql.yml", "codeql"]
];

const requiredPullRequestWorkflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/cross-platform.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/released-jupyter.yml"
];

test("PR workflows replace only superseded pending runs", () => {
  for (const [relativePath, groupPrefix] of replaceablePendingWorkflows) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    assert.match(
      source,
      new RegExp(
        String.raw`\nconcurrency:\n  group: ${groupPrefix}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n`
      ),
      `${relativePath} must retain running work while collapsing superseded pending runs.`
    );
    assert.doesNotMatch(
      source,
      /cancel-in-progress:\s*true/u,
      `${relativePath} must never interrupt an in-progress editor or analysis run.`
    );
  }
});

test("native VS Code and Cursor smoke consume the same downloaded canonical VSIX", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const steps = workflow?.jobs?.["native-editor-matrix"]?.steps;
  assert.ok(Array.isArray(steps), "CI must retain the native editor matrix.");

  const download = steps.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/download-artifact@")
  );
  assert.equal(download?.with?.name, "openwrangler-vsix");
  assert.equal(download?.with?.path, "canonical-vsix");

  const expectedCommand = "node scripts/run-packaged-editor-tests.mjs canonical-vsix/openwrangler.vsix";
  assert.equal(steps.find((step) => step?.id === "packaged_editor")?.run, expectedCommand);
  assert.equal(steps.find((step) => step?.id === "cursor_smoke")?.run, expectedCommand);
});

test("opt-in Remote SSH acceptance consumes the same canonical VSIX once", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const job = workflow?.jobs?.["remote-workspace"];
  assert.equal(job?.needs, "canonical-vsix");
  assert.equal(job?.["runs-on"], "ubuntu-24.04");
  assert.equal(job?.["timeout-minutes"], 90);
  assert.match(job?.if ?? "", /always\(\)/u);
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

test("PR evidence jobs never turn draft work into successful skipped checks", () => {
  for (const relativePath of requiredPullRequestWorkflows) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    assert.match(source, /\non:\n {2}pull_request:/u, `${relativePath} must retain its pull-request trigger.`);
    assert.doesNotMatch(
      source,
      /github\.event\.pull_request\.draft/u,
      `${relativePath} must not skip PR evidence jobs for draft pull requests because GitHub treats skipped jobs as successful checks.`
    );
  }
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

test("released-Jupyter PR paths include every consumed dependency manifest", () => {
  const source = readFileSync(new URL("../.github/workflows/released-jupyter.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const paths = workflow?.on?.pull_request?.paths;
  assert.ok(Array.isArray(paths));
  for (const manifest of ["package.json", "package-lock.json", "python/pyproject.toml"]) {
    assert.equal(paths.includes(manifest), true, `Released Jupyter acceptance must run when ${manifest} changes.`);
  }
  assert.equal(
    workflow?.jobs?.vscode?.steps?.some((step) => step?.run === 'python -m pip install -e "python[dev]"'),
    true
  );
});
