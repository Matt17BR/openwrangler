import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("runtime workflows retain one Linux owner and only distinct native OS/version cells", () => {
  const ciSource = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ciSource, /python: \["3\.10", "3\.14"\]/u);
  assert.match(ciSource, /- run: python -m pytest python\/tests -q/u);

  const source = readFileSync(new URL("../.github/workflows/cross-platform.yml", import.meta.url), "utf8");
  assert.match(
    source,
    /matrix:\n {8}include:\n {10}- os: macos-latest\n {12}python: "3\.12"\n {10}- os: windows-latest\n {12}python: "3\.14"\n/u
  );
  assert.doesNotMatch(
    source,
    /- os: ubuntu-latest\n {12}python: "3\.10"/u,
    "Ubuntu/Python 3.10 already belongs to the required CI python-matrix and must not run the full suite twice."
  );
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

test("released-Jupyter PR paths include every consumed dependency manifest", () => {
  const source = readFileSync(new URL("../.github/workflows/released-jupyter.yml", import.meta.url), "utf8");
  for (const manifest of ["package.json", "package-lock.json", "python/pyproject.toml"]) {
    assert.match(
      source,
      new RegExp(String.raw`^ {6}- "${manifest.replaceAll(".", String.raw`\.`)}"$`, "mu"),
      `.github/workflows/released-jupyter.yml must run when ${manifest} changes.`
    );
  }
  assert.match(source, /- run: python -m pip install -e "python\[dev\]"/u);
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
