import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load as parseYaml } from "js-yaml";
import { dailyPreviewIdentity, prepareDailyPreviewSource } from "./daily-preview-artifact.mjs";

const environment = Object.freeze({
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567"
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ow-daily-preview-"));
  const packageJsonPath = join(root, "package.json");
  const runtimeVersionPath = join(root, "version.py");
  const sourcePackageJson = `${JSON.stringify(
    { name: "openwrangler", publisher: "Matt17BR", version: "1.99.7", preview: true },
    null,
    2
  )}\n`;
  const sourceRuntimeVersion = '__version__ = "1.99.7"\n';
  writeFileSync(packageJsonPath, sourcePackageJson, { flag: "wx" });
  writeFileSync(runtimeVersionPath, sourceRuntimeVersion, { flag: "wx" });
  return { packageJsonPath, root, runtimeVersionPath, sourcePackageJson, sourceRuntimeVersion };
}

test("stamps a deterministic disposable version into both package manifests", () => {
  const value = fixture();
  try {
    const prepared = prepareDailyPreviewSource({ ...value, environment });
    assert.equal(prepared.id, "main-0123456789ab");
    assert.equal(prepared.version, dailyPreviewIdentity(environment).version);
    assert.notEqual(prepared.version, "1.99.7");
    assert.equal(JSON.parse(readFileSync(value.packageJsonPath, "utf8")).version, prepared.version);
    assert.equal(readFileSync(value.runtimeVersionPath, "utf8"), `__version__ = "${prepared.version}"\n`);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects the wrong ref, invalid commits, and changed version files", () => {
  assert.throws(() => dailyPreviewIdentity({ ...environment, GITHUB_REF: "refs/heads/feature" }), /main/u);
  assert.throws(() => dailyPreviewIdentity({ ...environment, GITHUB_SHA: "not-a-sha" }), /commit SHA/u);

  const value = fixture();
  try {
    writeFileSync(value.runtimeVersionPath, '__version__ = "1.99.8"\n');
    assert.throws(() => prepareDailyPreviewSource({ ...value, environment }), /unchanged source version files/u);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("daily preview builds, tests, and uploads one disposable VSIX in one job", () => {
  const workflow = parseYaml(readFileSync(new URL("../.github/workflows/daily-preview.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "13 3 * * *" }]);
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(workflow.on.push, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["preview"]);

  const steps = workflow.jobs.preview.steps;
  const allText = JSON.stringify(workflow);
  assert.doesNotMatch(
    allText,
    /check:pr|download-artifact|candidate_sha256|provenance|publish-github|push-release-tag|push-stable-release-tag/u
  );
  assert.doesNotMatch(allText, /RUN_ATTEMPT|refs\/remotes\/origin\/main|fetch-depth/u);
  for (const action of ["actions/checkout@", "actions/setup-node@", "actions/setup-python@"]) {
    assert.equal(steps.filter((step) => step.uses?.startsWith(action)).length, 1);
  }
  assert.equal(steps.filter((step) => step.run === "npm ci --ignore-scripts").length, 1);
  assert.equal(steps.filter((step) => step.run === 'python -m pip install -e "python[dev]"').length, 1);
  assert.equal(steps.filter((step) => step.run?.includes("package:prepared")).length, 1);
  assert.equal(steps.filter((step) => step.run?.includes("verify:vsix")).length, 1);

  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], false);
  const editor = steps.find((step) => step.id === "vscode");
  assert.equal(editor["continue-on-error"], undefined);
  assert.equal(editor.env.OPEN_WRANGLER_PACKAGED_EDITORS, "vscode");
  assert.equal(editor.env.OPEN_WRANGLER_PACKAGED_MODE, "platform-smoke");
  assert.equal(editor.env.OPEN_WRANGLER_TEST_SELECTOR, "daily-core");
  assert.equal(editor.env.VSCODE_TEST_VERSION, "stable");

  const diagnostics = steps.find((step) => step.name === "Upload failure diagnostics");
  assert.equal(diagnostics.if, "${{ failure() && steps.vscode.outputs.evidence_ready == 'true' }}");
  assert.equal(diagnostics.with["retention-days"], 7);
  const upload = steps.find((step) => step.name === "Upload the working preview");
  assert.equal(upload.if, "${{ success() }}");
  assert.equal(upload.with.path, "daily-preview/openwrangler.vsix");
  assert.equal(upload.with["retention-days"], 14);
});
