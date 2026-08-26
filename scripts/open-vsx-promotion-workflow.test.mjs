import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectOpenVsxPromotionWorkflow } from "./open-vsx-promotion-workflow.mjs";

const source = readFileSync(new URL("../.github/workflows/open-vsx-promotion.yml", import.meta.url), "utf8");

test("Open VSX promotion is one protected exact-byte publisher", () => {
  assert.deepEqual(inspectOpenVsxPromotionWorkflow(source), []);
});

test("Open VSX accepts routine action commit updates", () => {
  const repinned = source.replace(/@[0-9a-f]{40}/gu, `@${"a".repeat(40)}`);
  assert.notEqual(repinned, source);
  assert.deepEqual(inspectOpenVsxPromotionWorkflow(repinned), []);
});

test("Open VSX rejects unpinned and unexpected external actions", () => {
  for (const reference of ["actions/checkout@v7", "actions/checkout@deadbeef", "actions/checkout"]) {
    const candidate = source.replace(/actions\/checkout@[0-9a-f]{40}/u, reference);
    assert.notEqual(candidate, source);
    assert.match(inspectOpenVsxPromotionWorkflow(candidate).join("\n"), /full 40-character hexadecimal commit SHA/u);
  }
  const unexpected = source.replace(
    "      - uses: actions/setup-node@",
    `      - uses: example/unexpected-action@${"b".repeat(40)}\n      - uses: actions/setup-node@`
  );
  assert.notEqual(unexpected, source);
  assert.match(inspectOpenVsxPromotionWorkflow(unexpected).join("\n"), /is not allowed in this workflow/u);
});

test("Open VSX uses idempotent publication and verifies the public bytes afterward", () => {
  assert.match(source, /ovsx publish --skip-duplicate canonical-release\/openwrangler\.vsix/u);
  assert.match(source, /verify-open-vsx-github-release\.mjs canonical-release --verify/u);
  assert.doesNotMatch(source, /Published Matt17BR|already published\. Skipping|grep -Fq/u);
});

test("Open VSX checks release identity, permissions, credentials, and exact bytes without freezing labels", () => {
  const unsafe = [
    source.replace("  workflow_call:\n", "  release:\n    types: [published]\n  workflow_call:\n"),
    source.replace("  workflow_dispatch:\n", "  not_workflow_dispatch:\n"),
    source.replace("contents: read", "contents: write"),
    source.replace("group: openwrangler-release-publication", "group: release-${{ inputs.release_tag }}"),
    source.replace("  queue: max", "  queue: single"),
    source.replace("  queue: max", "  queue: max\n  unsupported: true"),
    source.replace("environment: publishing", "environment: unprotected"),
    source.replace("timeout-minutes: 75", "timeout-minutes: 180"),
    source.replace("ref: main", "ref: ${{ github.ref }}"),
    source.replace("persist-credentials: false", "persist-credentials: true"),
    source.replace("OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS: 12", "OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS: 120"),
    source.replace(
      "OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS: 90000",
      "OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS: 3600000"
    ),
    source.replace(
      "node scripts/download-canonical-github-release.mjs canonical-release",
      "curl -L https://example.com/openwrangler.vsix -o canonical-release/openwrangler.vsix"
    ),
    source.replace(
      "RELEASE_PRERELEASE: ${{ steps.release_source.outputs.release_prerelease }}",
      "RELEASE_PRERELEASE: false"
    ),
    source.replace("node scripts/verify-registry-release-artifact.mjs canonical-release", "echo artifact-not-verified"),
    source.replace("--require-remote release-source", "--verify-remote release-source"),
    source.replace("OVSX_PAT: ${{ secrets.OVSX_PAT }}", "OVSX_PAT: literal-token"),
    source.replace("ovsx verify-pat Matt17BR", "ovsx verify-pat unknown"),
    source.replace("ovsx publish --skip-duplicate", "ovsx publish"),
    source.replace("verify-open-vsx-github-release.mjs canonical-release --verify", "echo published"),
    source.replace(
      "      - run: npm ci --ignore-scripts",
      "      - run: npm ci --ignore-scripts\n      - run: npm run build"
    ),
    source.replace(/actions\/checkout@[0-9a-f]{40}/u, "actions/checkout@v7")
  ];
  for (const [index, candidate] of unsafe.entries()) {
    assert.notEqual(candidate, source, `unsafe mutation ${index + 1} must change the workflow`);
    assert.notDeepEqual(inspectOpenVsxPromotionWorkflow(candidate), [], `unsafe mutation ${index + 1} must fail`);
  }

  const plainLabelChange = source.replace(
    "name: Download the exact public GitHub release",
    "name: Download public release files"
  );
  assert.deepEqual(inspectOpenVsxPromotionWorkflow(plainLabelChange), []);
});
