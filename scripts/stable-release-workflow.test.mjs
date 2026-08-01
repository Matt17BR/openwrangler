import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectStableReleaseWorkflow } from "./stable-release-workflow.mjs";

const source = readFileSync(new URL("../.github/workflows/stable-release.yml", import.meta.url), "utf8");

test("ordinary stable release packages once and gates publishing behind exact-artifact consumers", () => {
  assert.deepEqual(inspectStableReleaseWorkflow(source), []);
});

test("stable release inspector rejects unsafe publication and artifact drift", () => {
  const mutations = [
    source.replace("default: false", "default: true"),
    source.replace("permissions:\n  contents: read", "permissions:\n  contents: write"),
    source.replace("\njobs:\n", "\nenv:\n  OPEN_WRANGLER_EDITOR_DISPLAY: current\n\njobs:\n"),
    source.replace("\njobs:\n", "\ndefaults:\n  run:\n    shell: bash\n\njobs:\n"),
    source.replace(
      "  linux-acceptance:\n    name: Linux release acceptance",
      "  linux-acceptance:\n    env:\n      OPEN_WRANGLER_EDITOR_DISPLAY: current\n    name: Linux release acceptance"
    ),
    source.replace(
      "  release:\n    name: Publish GitHub and trigger Marketplace\n    needs: [package, acceptance-gate]\n    if: ${{ inputs.publish == true }}\n    runs-on: ubuntu-24.04",
      "  release:\n    name: Publish GitHub and trigger Marketplace\n    needs: [package, acceptance-gate]\n    if: ${{ inputs.publish == true }}\n    runs-on: self-hosted"
    ),
    source.replace(
      "  acceptance-gate:\n    name: Require every stable acceptance result",
      "  acceptance-gate:\n    continue-on-error: true\n    name: Require every stable acceptance result"
    ),
    source.replace(
      "      - name: Fail closed unless every required job succeeded",
      "      - name: Fail closed unless every required job succeeded\n        continue-on-error: true"
    ),
    source.replace(
      "      - run: npm run test:scripts\n",
      "      - run: npm run test:scripts\n        if: ${{ false }}\n"
    ),
    source.replace('"pyspark[connect]==4.2.0"', '"pyspark[connect]==4.1.0"'),
    source.replace("      - name: Verify exact coverage runtimes", "      - name: Skip exact coverage runtimes"),
    source.replace("--out-dir canonical-release", "--out-dir canonical-release\n          --performance-evidence"),
    source.replace("artifact-ids: ${{ needs.package.outputs.artifact-id }}", "name: openwrangler-stable-release"),
    source.replace(
      "      - id: canonical\n        name: Verify the exact canonical stable artifact",
      "      - id: canonical\n        name: Verify the exact canonical stable artifact\n        if: ${{ false }}"
    ),
    source.replace(
      "      - run: npm run test:python-environment-smoke",
      "      - run: npm run test:python-environment-smoke\n        if: ${{ false }}"
    ),
    source.replace(
      "      - id: packaged_editor\n        name: Test packaged VS Code",
      "      - id: packaged_editor\n        name: Test packaged VS Code\n        if: ${{ false }}"
    ),
    source.replace(
      "      - id: installed_performance\n        name: Test the ordinary stable artifact in pinned editors",
      "      - id: installed_performance\n        name: Test the ordinary stable artifact in pinned editors\n        if: ${{ false }}"
    ),
    source.replace(
      "      - id: packaged_editor\n        name: Test released Jupyter in the exact packaged VSIX",
      "      - id: packaged_editor\n        name: Test released Jupyter in the exact packaged VSIX\n        if: ${{ false }}"
    ),
    source.replace(
      "      - id: remote_workspace\n        name: Test packaged VS Code over Remote SSH",
      "      - id: remote_workspace\n        name: Test packaged VS Code over Remote SSH\n        if: ${{ false }}"
    ),
    source.replace(
      "      - name: Publish or verify the exact GitHub stable release",
      "      - run: node scripts/rewrite-canonical.mjs canonical-release/openwrangler.vsix\n      - name: Publish or verify the exact GitHub stable release"
    ),
    source.replace("    timeout-minutes: 20", "    timeout-minutes: 19"),
    source.replace(
      "        run: node scripts/push-stable-release-tag.mjs",
      "        run: git push --force origin ${{ inputs.release_tag }}"
    ),
    source.replace("          GITHUB_TOKEN: ${{ github.token }}", "          GITHUB_TOKEN: literal-token"),
    source.replace(
      "        run: node scripts/push-stable-release-tag.mjs\n      - name: Publish or verify the exact GitHub stable release",
      "        run: node scripts/push-stable-release-tag.mjs\n      - run: echo intervening\n      - name: Publish or verify the exact GitHub stable release"
    ),
    source.replace('OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1"', 'OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0"'),
    source.replace("OPEN_WRANGLER_PACKAGED_EDITORS: vscode,cursor", "OPEN_WRANGLER_PACKAGED_EDITORS: vscode"),
    source.replace("if: ${{ inputs.publish == true }}", "if: ${{ inputs.publish != false }}"),
    source.replace("environment: publishing", "environment: stable-release"),
    source.replace('test "$REMOTE_SSH_RESULT" = "success"', 'test "$REMOTE_SSH_RESULT" != "failure"'),
    source.replace("npm run check", "npm run check\n      - run: npm run package -- --out rebuilt.vsix"),
    source.replace(
      "node scripts/prepare-stable-candidate-tag.mjs --verify-remote",
      "node scripts/prepare-stable-candidate-tag.mjs --ignore-remote"
    ),
    source.replace(
      "  promote-open-vsx:\n    needs: release\n    if: ${{ inputs.publish == true && needs.release.result == 'success' }}\n    uses: ./.github/workflows/open-vsx-promotion.yml\n    with:\n      release_tag: ${{ inputs.release_tag }}",
      "  promote-open-vsx:\n    needs: acceptance-gate\n    uses: attacker/workflow.yml@main"
    ),
    source.replace(
      '          test "$EVENT_REF_TYPE" = "branch"\n          case "$EVENT_REF" in\n            refs/heads/main|refs/heads/release/1.x) ;;',
      '          true\n          case "$EVENT_REF" in\n            refs/heads/main|refs/heads/release/1.x) ;;'
    ),
    source.replace(
      '          test "$EXPECTED_SOURCE_REF" = "refs/heads/$EXPECTED_SOURCE_BRANCH"\n          test "$EVENT_REF" = "$EXPECTED_SOURCE_REF"',
      "          true\n          true"
    ),
    source.replace("      group: openwrangler-release-publication", "      group: stable-${{ inputs.release_tag }}"),
    source.replace("      queue: max", "      queue: latest"),
    source.replace(
      '          GITHUB_IMMUTABLE_RELEASES_EXPECTED: "false"',
      '          GITHUB_IMMUTABLE_RELEASES_EXPECTED: "true"'
    ),
    source.replace(
      "          EXPECTED_SOURCE_BRANCH: ${{ steps.release_metadata.outputs.source_branch }}",
      "          EXPECTED_SOURCE_BRANCH: main"
    )
  ];
  for (const [index, candidate] of mutations.entries()) {
    assert.notEqual(candidate, source, `mutation ${index + 1} must alter the workflow source`);
    assert.notDeepEqual(inspectStableReleaseWorkflow(candidate), [], `mutation ${index + 1} must be rejected`);
  }
});
