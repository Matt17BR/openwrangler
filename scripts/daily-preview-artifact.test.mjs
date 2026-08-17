import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load as parseYaml } from "js-yaml";
import {
  createDailyPreviewArtifact,
  dailyPreviewIdentity,
  prepareDailyPreviewSource,
  verifyDailyPreviewArtifact
} from "./daily-preview-artifact.mjs";

const environment = Object.freeze({
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "Matt17BR/openwrangler",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "123456789",
  GITHUB_RUN_NUMBER: "42",
  GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567"
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ow-daily-preview-"));
  const directory = join(root, "daily-preview");
  mkdirSync(directory, { mode: 0o700 });
  const candidatePath = join(directory, "openwrangler.vsix");
  const packageJsonPath = join(root, "package.json");
  const runtimeVersionPath = join(root, "version.py");
  const sourcePackageJson = `${JSON.stringify(
    { name: "openwrangler", publisher: "Matt17BR", version: "1.99.7", preview: true },
    null,
    2
  )}\n`;
  const sourceRuntimeVersion = '__version__ = "1.99.7"\n';
  writeFileSync(candidatePath, "deterministic preview bytes\n", { flag: "wx" });
  writeFileSync(packageJsonPath, sourcePackageJson, { flag: "wx" });
  writeFileSync(runtimeVersionPath, sourceRuntimeVersion, { flag: "wx" });
  const prepared = prepareDailyPreviewSource({
    packageJsonPath,
    runtimeVersionPath,
    sourcePackageJson,
    sourceRuntimeVersion,
    environment
  });
  return { candidatePath, directory, packageJsonPath, prepared, root, runtimeVersionPath };
}

test("creates and verifies a first-attempt protected-main daily preview", async () => {
  const value = fixture();
  try {
    const created = createDailyPreviewArtifact({
      candidatePath: value.candidatePath,
      packageJsonPath: value.packageJsonPath,
      sourceVersion: value.prepared.sourceVersion,
      environment
    });
    assert.equal(created.id, "main-0123456789ab");
    assert.equal(created.version, dailyPreviewIdentity(environment).version);
    assert.notEqual(created.version, "1.99.7");
    assert.deepEqual(await verifyDailyPreviewArtifact({ directory: value.directory, environment }), created);
    const provenance = JSON.parse(readFileSync(join(value.directory, "openwrangler.vsix.provenance.json"), "utf8"));
    assert.equal(provenance.kind, "daily-preview");
    assert.equal(provenance.disposable, true);
    assert.equal(provenance.source.version, "1.99.7");
    assert.equal(provenance.extension.version, created.version);
    assert.equal(provenance.extension.preview, true);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects non-main sources, reruns, dirty metadata, and changed artifacts", async () => {
  for (const override of [
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_SHA: "not-a-sha" }
  ]) {
    assert.throws(
      () => dailyPreviewIdentity({ ...environment, ...override }),
      /main|first workflow attempt|commit SHA/u
    );
  }

  const dirty = fixture();
  try {
    assert.throws(
      () =>
        prepareDailyPreviewSource({
          packageJsonPath: dirty.packageJsonPath,
          runtimeVersionPath: dirty.runtimeVersionPath,
          sourcePackageJson: readFileSync(dirty.packageJsonPath, "utf8"),
          sourceRuntimeVersion: '__version__ = "1.99.7"\n',
          environment
        }),
      /exact unmodified protected-main/u
    );
  } finally {
    rmSync(dirty.root, { recursive: true, force: true });
  }

  const changed = fixture();
  try {
    createDailyPreviewArtifact({
      candidatePath: changed.candidatePath,
      packageJsonPath: changed.packageJsonPath,
      sourceVersion: changed.prepared.sourceVersion,
      environment
    });
    writeFileSync(changed.candidatePath, "changed bytes\n");
    await assert.rejects(
      verifyDailyPreviewArtifact({ directory: changed.directory, environment }),
      /checksum does not match/u
    );
  } finally {
    rmSync(changed.root, { recursive: true, force: true });
  }
});

test("derives a reproducible source identity without sharing released version bytes", () => {
  const first = dailyPreviewIdentity(environment);
  assert.equal(first.version, dailyPreviewIdentity(environment).version);
  assert.notEqual(
    first.version,
    dailyPreviewIdentity({ ...environment, GITHUB_SHA: `1${environment.GITHUB_SHA.slice(1)}` }).version
  );
  assert.match(first.version, /^0\.[1-9]\d*\.(?:0|[1-9]\d*)$/u);
});

test("daily preview is disposable, packages once, and has no publication authority", () => {
  const workflow = parseYaml(readFileSync(new URL("../.github/workflows/daily-preview.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "13 3 * * *" }]);
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(workflow.on.push, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "representative-editor", "result"]);

  const allText = JSON.stringify(workflow);
  assert.doesNotMatch(allText, /publishing|ovsx|publish-github|push-release-tag|push-stable-release-tag/u);
  const buildRuns = workflow.jobs.build.steps.map((step) => step.run).filter((run) => typeof run === "string");
  assert.equal(buildRuns.filter((run) => run.includes("package:prepared")).length, 1);
  assert.ok(buildRuns.includes("npm run check:pr"));
  assert.ok(buildRuns.includes("npm run verify:vsix -- daily-preview/openwrangler.vsix"));
  const upload = workflow.jobs.build.steps.find((step) => step.id === "upload");
  assert.equal(upload.with["retention-days"], 14);
  assert.equal(upload.with["compression-level"], 0);
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    "daily-preview/openwrangler.vsix",
    "daily-preview/openwrangler.vsix.sha256",
    "daily-preview/openwrangler.vsix.provenance.json"
  ]);

  const editorSteps = workflow.jobs["representative-editor"].steps;
  const download = editorSteps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with["artifact-ids"], "${{ needs.build.outputs.artifact_id }}");
  const editor = editorSteps.find((step) => step.id === "vscode");
  assert.equal(editor.env.OPEN_WRANGLER_PACKAGED_EDITORS, "vscode");
  assert.equal(editor.env.OPEN_WRANGLER_PACKAGED_MODE, "platform-smoke");
  assert.deepEqual(workflow.jobs.result.needs, ["build", "representative-editor"]);
  assert.equal(workflow.jobs.result.if, "${{ always() }}");
});
