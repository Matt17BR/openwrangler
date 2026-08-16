import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load as parseYaml } from "js-yaml";
import { canaryIdentity, createCanaryArtifact, prepareCanarySource, verifyCanaryArtifact } from "./canary-artifact.mjs";

const environment = Object.freeze({
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "Matt17BR/openwrangler",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "123456789",
  GITHUB_RUN_NUMBER: "42",
  GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567"
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ow-canary-artifact-"));
  const directory = join(root, "canary");
  mkdirSync(directory, { mode: 0o700 });
  const candidatePath = join(directory, "openwrangler-canary.vsix");
  const packageJsonPath = join(root, "package.json");
  const runtimeVersionPath = join(root, "version.py");
  const sourcePackageJson = '{"version":"1.99.7","preview":true}\n';
  const sourceRuntimeVersion = '__version__ = "1.99.7"\n';
  writeFileSync(candidatePath, "canonical canary bytes\n", { flag: "wx" });
  writeFileSync(packageJsonPath, sourcePackageJson, { flag: "wx" });
  writeFileSync(runtimeVersionPath, sourceRuntimeVersion, { flag: "wx" });
  const prepared = prepareCanarySource({
    packageJsonPath,
    runtimeVersionPath,
    sourcePackageJson,
    sourceRuntimeVersion,
    environment
  });
  return { candidatePath, directory, packageJsonPath, prepared, root, runtimeVersionPath };
}

test("creates and verifies a bounded first-attempt protected-main canary receipt", () => {
  const value = fixture();
  try {
    const created = createCanaryArtifact({
      candidatePath: value.candidatePath,
      packageJsonPath: value.packageJsonPath,
      sourceVersion: value.prepared.sourceVersion,
      environment
    });
    assert.equal(created.canaryId, "main-0123456789ab");
    assert.equal(created.version, canaryIdentity(environment).canaryVersion);
    assert.notEqual(created.version, "1.99.7");
    const verified = verifyCanaryArtifact({ directory: value.directory, environment });
    assert.deepEqual(verified, created);
    const provenance = JSON.parse(
      readFileSync(join(value.directory, "openwrangler-canary.vsix.provenance.json"), "utf8")
    );
    assert.equal(provenance.channel, "canary");
    assert.equal(provenance.disposable, true);
    assert.equal(provenance.source.version, "1.99.7");
    assert.equal(provenance.extension.version, created.version);
    assert.equal(provenance.extension.preview, true);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects non-main sources, reruns, mutations, and unexpected provenance fields", () => {
  for (const override of [
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_SHA: "not-a-sha" }
  ]) {
    const value = fixture();
    try {
      assert.throws(
        () =>
          createCanaryArtifact({
            candidatePath: value.candidatePath,
            packageJsonPath: value.packageJsonPath,
            sourceVersion: value.prepared.sourceVersion,
            environment: { ...environment, ...override }
          }),
        /main|first workflow attempt|commit SHA/u
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  const mutated = fixture();
  try {
    createCanaryArtifact({
      candidatePath: mutated.candidatePath,
      packageJsonPath: mutated.packageJsonPath,
      sourceVersion: mutated.prepared.sourceVersion,
      environment
    });
    writeFileSync(mutated.candidatePath, "changed bytes\n");
    assert.throws(
      () => verifyCanaryArtifact({ directory: mutated.directory, environment }),
      /checksum receipt does not match/u
    );
  } finally {
    rmSync(mutated.root, { recursive: true, force: true });
  }

  const expanded = fixture();
  try {
    createCanaryArtifact({
      candidatePath: expanded.candidatePath,
      packageJsonPath: expanded.packageJsonPath,
      sourceVersion: expanded.prepared.sourceVersion,
      environment
    });
    const path = join(expanded.directory, "openwrangler-canary.vsix.provenance.json");
    const provenance = JSON.parse(readFileSync(path, "utf8"));
    provenance.unreviewed = true;
    writeFileSync(path, `${JSON.stringify(provenance)}\n`);
    assert.throws(() => verifyCanaryArtifact({ directory: expanded.directory, environment }), /unexpected shape/u);
  } finally {
    rmSync(expanded.root, { recursive: true, force: true });
  }
});

test("derives a stable disposable version from source identity and rejects dirty source metadata", () => {
  assert.equal(canaryIdentity(environment).canaryVersion, canaryIdentity(environment).canaryVersion);
  assert.notEqual(
    canaryIdentity(environment).canaryVersion,
    canaryIdentity({ ...environment, GITHUB_SHA: `1${environment.GITHUB_SHA.slice(1)}` }).canaryVersion
  );
  const value = fixture();
  try {
    assert.throws(
      () =>
        prepareCanarySource({
          packageJsonPath: value.packageJsonPath,
          runtimeVersionPath: value.runtimeVersionPath,
          sourcePackageJson: '{"version":"1.99.7","preview":true}\n',
          sourceRuntimeVersion: '__version__ = "1.99.7"\n',
          environment
        }),
      /exact unmodified protected-main metadata/u
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("daily canary packages once, expires, and has no publication authority", () => {
  const workflow = parseYaml(readFileSync(new URL("../.github/workflows/canary.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "13 3 * * *" }]);
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.permissions.contents, "read");
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "representative-editor", "result"]);

  const buildSteps = workflow.jobs.build.steps;
  const buildRuns = buildSteps.map((step) => step.run).filter((run) => typeof run === "string");
  assert.equal(buildRuns.filter((run) => run.includes("package:prepared")).length, 1);
  assert.ok(buildRuns.includes("npm run check:pr"));
  assert.ok(buildRuns.includes("npm run verify:vsix -- canary-artifact/openwrangler-canary.vsix"));
  assert.doesNotMatch(buildRuns.join("\n"), /ovsx|publish-github|push-release-tag|push-stable-release-tag/u);
  const upload = buildSteps.find((step) => step.id === "upload");
  assert.equal(upload.with["retention-days"], 14);
  assert.equal(upload.with["compression-level"], 0);
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    "canary-artifact/openwrangler-canary.vsix",
    "canary-artifact/openwrangler-canary.vsix.sha256",
    "canary-artifact/openwrangler-canary.vsix.provenance.json"
  ]);

  const editorSteps = workflow.jobs["representative-editor"].steps;
  const download = editorSteps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with["artifact-ids"], "${{ needs.build.outputs.artifact_id }}");
  const editor = editorSteps.find((step) => step.id === "vscode");
  assert.equal(editor.env.OPEN_WRANGLER_PACKAGED_EDITORS, "vscode");
  assert.equal(editor.env.OPEN_WRANGLER_PACKAGED_MODE, "platform-smoke");
  assert.doesNotMatch(
    editorSteps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n"),
    /package:prepared|create-canonical-release-artifact/u
  );
  assert.deepEqual(workflow.jobs.result.needs, ["build", "representative-editor"]);
  assert.equal(workflow.jobs.result.if, "${{ always() }}");
});
