import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectOpenVsxPromotionWorkflow, OPEN_VSX_PUBLISH_RUN } from "./open-vsx-promotion-workflow.mjs";

const source = readFileSync(new URL("../.github/workflows/open-vsx-promotion.yml", import.meta.url), "utf8");

test("Open VSX promotion is the protected exact-public-release flow", () => {
  assert.deepEqual(inspectOpenVsxPromotionWorkflow(source), []);
});

test("Open VSX duplicate publication accepts the registry's exact message", () => {
  assert.match(
    OPEN_VSX_PUBLISH_RUN,
    /duplicate="Extension Matt17BR\.openwrangler \$RELEASE_VERSION is already published\. Skipping publish\."/u
  );
  assert.doesNotMatch(OPEN_VSX_PUBLISH_RUN, /openwrangler version \$RELEASE_VERSION/u);
});

test("Open VSX promotion rejects trigger, secret, source, channel, and publication drift", () => {
  const mutations = [
    source.replace("types:\n      - published", "types:\n      - edited"),
    source.replace("  workflow_dispatch:\n", "  not_workflow_dispatch:\n"),
    source.replace("contents: read", "contents: write"),
    source.replace("group: openwrangler-release-publication", "group: open-vsx-${{ inputs.release_tag }}"),
    source.replace("queue: max", "queue: latest"),
    source.replace("environment: publishing", "environment: unprotected"),
    source.replace("timeout-minutes: 105", "timeout-minutes: 75"),
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
    source.replace(
      "      - name: Revalidate the lightweight tag source before publication\n        run: node scripts/registry-release-source.mjs release-source",
      "      - name: Skip protected source revalidation\n        run: echo skipped"
    ),
    source.replace("OVSX_PAT: ${{ secrets.OVSX_PAT }}", "OVSX_PAT: literal-token"),
    source.replace('if [ -z "${OVSX_PAT:-}" ]; then', "if false; then"),
    source.replace("PAT valid to publish at Matt17BR", "PAT accepted"),
    source.replace("npx --no-install ovsx verify-pat Matt17BR", "npx ovsx verify-pat someone"),
    source.replace('case "$RELEASE_PRERELEASE" in', "case stable in"),
    source.replace("--skip-duplicate canonical-release/openwrangler.vsix", "canonical-release/openwrangler.vsix"),
    source.replace("Published Matt17BR.openwrangler v$RELEASE_VERSION", "Published something"),
    source.replace("node scripts/verify-open-vsx-github-release.mjs canonical-release --verify", "echo published"),
    source.replace("npx --no-install playwright-core install --with-deps chromium", "echo browser-skipped"),
    source.replace(
      "release-source/node_modules/.bin/playwright-core install --with-deps chromium",
      "npx --no-install playwright-core install --with-deps chromium"
    ),
    source.replace(
      "PREPUBLICATION_REQUIRED: ${{ steps.public_media_prepublish.outputs.required }}",
      "PREPUBLICATION_REQUIRED: false"
    ),
    source.replace('printf \'required=%s\\n\' "$required" >> "$GITHUB_OUTPUT"', "echo output-skipped"),
    source.replace("publicMediaPrepublicationRequired(process.env.RELEASE_VERSION)", "false"),
    source.replace("npm ci --ignore-scripts --prefix release-source", "npm ci --ignore-scripts"),
    source.replace(
      "node release-source/scripts/verify-public-media-surfaces.mjs",
      "node scripts/verify-public-media-surfaces.mjs"
    ),
    source.replace("Prepublication public-media verification starts with v1.99.4", "starts whenever"),
    source.replace(" --prepublish", ""),
    source.replace(
      "        name: Preflight immutable public README media\n",
      "        name: Preflight immutable public README media too late\n"
    ),
    source.replace("steps.public_media_contract.outputs.required == 'true'", "always()"),
    source.replace(
      "publicMediaVerificationRequired(process.env.RELEASE_VERSION)",
      "publicMediaVerificationRequired('1.2.1')"
    ),
    source.replace(" --wait-for-propagation", ""),
    source.replace(
      "RELEASE_SOURCE_SHA: ${{ steps.release_source.outputs.release_commit }}",
      "RELEASE_SOURCE_SHA: ${{ steps.automation_source.outputs.automation_commit }}"
    ),
    source.replace(
      "RELEASE_VERSION: ${{ steps.release_source.outputs.release_version }}",
      "OVSX_PAT: ${{ secrets.OVSX_PAT }}\n          RELEASE_VERSION: ${{ steps.release_source.outputs.release_version }}"
    ),
    source.replace(
      "node release-source/scripts/verify-public-media-surfaces.mjs",
      "node scripts/verify-public-media-surfaces.mjs"
    )
  ];
  for (const [index, candidate] of mutations.entries()) {
    assert.notEqual(candidate, source, `mutation ${index + 1} must change the workflow`);
    assert.notDeepEqual(inspectOpenVsxPromotionWorkflow(candidate), [], `mutation ${index + 1} must fail`);
  }
});
