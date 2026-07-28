import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectOpenVsxPromotionWorkflow } from "./open-vsx-promotion-workflow.mjs";

const source = readFileSync(new URL("../.github/workflows/open-vsx-promotion.yml", import.meta.url), "utf8");

test("Open VSX promotion is the protected exact-public-release flow", () => {
  assert.deepEqual(inspectOpenVsxPromotionWorkflow(source), []);
});

test("Open VSX promotion rejects trigger, secret, source, channel, and publication drift", () => {
  const mutations = [
    source.replace("types:\n      - published", "types:\n      - edited"),
    source.replace("  workflow_call:\n", "  not_workflow_call:\n"),
    source.replace("contents: read", "contents: write"),
    source.replace("environment: publishing", "environment: unprotected"),
    source.replace("timeout-minutes: 75", "timeout-minutes: 60"),
    source.replace("ref: main", "ref: ${{ github.ref }}"),
    source.replace("persist-credentials: false", "persist-credentials: true"),
    source.replace(
      "node scripts/download-canonical-github-release.mjs canonical-release",
      "curl -L https://example.com/openwrangler.vsix -o canonical-release/openwrangler.vsix"
    ),
    source.replace(
      "RELEASE_PRERELEASE: ${{ steps.release_source.outputs.release_prerelease }}",
      "RELEASE_PRERELEASE: false"
    ),
    source.replace(
      "node scripts/prepare-stable-candidate-tag.mjs --require-remote release-source",
      "node scripts/prepare-stable-candidate-tag.mjs --verify-remote release-source"
    ),
    source.replace(
      "node scripts/verify-registry-release-artifact.mjs canonical-release",
      "npm run package -- --out canonical-release/openwrangler.vsix"
    ),
    source.replace("OVSX_PAT: ${{ secrets.OVSX_PAT }}", "OVSX_PAT: literal-token"),
    source.replace("npx --no-install ovsx verify-pat Matt17BR", "npx ovsx verify-pat someone"),
    source.replace(
      "npx --no-install ovsx publish --skip-duplicate canonical-release/openwrangler.vsix",
      "npx --no-install ovsx publish --pre-release canonical-release/openwrangler.vsix"
    ),
    source.replace("node scripts/verify-open-vsx-github-release.mjs canonical-release --verify", "echo published"),
    `${source}\n# drift\n`
  ];
  for (const [index, candidate] of mutations.entries()) {
    assert.notEqual(candidate, source, `mutation ${index + 1} must change the workflow`);
    assert.notDeepEqual(inspectOpenVsxPromotionWorkflow(candidate), [], `mutation ${index + 1} must fail`);
  }
});
