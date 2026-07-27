import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load as parseYaml } from "js-yaml";

const replaceablePendingWorkflows = [
  [".github/workflows/ci.yml", "ci"],
  [".github/workflows/cross-platform.yml", "cross-platform"],
  [".github/workflows/codeql.yml", "codeql"]
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
