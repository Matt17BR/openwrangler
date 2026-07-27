import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
