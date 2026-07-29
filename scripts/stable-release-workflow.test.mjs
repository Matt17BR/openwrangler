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
    source.replace("Publish to GitHub and Open VSX and trigger Marketplace promotion", "Validation-only workflow"),
    source.replace("default: false", "default: true"),
    source.replace("permissions:\n  contents: read", "permissions:\n  contents: write"),
    source.replace("\njobs:\n", "\nenv:\n  OPEN_WRANGLER_EDITOR_DISPLAY: current\n\njobs:\n"),
    source.replace("\njobs:\n", "\ndefaults:\n  run:\n    shell: bash\n\njobs:\n"),
    source.replace(
      "  linux-acceptance:\n    name: Linux release acceptance",
      "  linux-acceptance:\n    env:\n      OPEN_WRANGLER_EDITOR_DISPLAY: current\n    name: Linux release acceptance"
    ),
    source.replace(
      "  linux-acceptance:\n    name: Linux release acceptance",
      "  linux-acceptance:\n    defaults:\n      run:\n        shell: bash\n    name: Linux release acceptance"
    ),
    source.replace(
      "  package:\n    runs-on: ubuntu-24.04",
      "  package:\n    container:\n      image: node:22\n      env:\n        NODE_OPTIONS: --require=/tmp/release-hook.cjs\n    runs-on: ubuntu-24.04"
    ),
    source.replace(
      "  release:\n    name: Publish GitHub/Open VSX and trigger Marketplace\n    needs: [package, acceptance-gate]\n    if: ${{ inputs.publish == true }}\n    runs-on: ubuntu-24.04",
      "  release:\n    name: Publish GitHub/Open VSX and trigger Marketplace\n    needs: [package, acceptance-gate]\n    if: ${{ inputs.publish == true }}\n    runs-on: self-hosted"
    ),
    source.replace(
      "  acceptance-gate:\n    name: Require every stable acceptance result",
      "  acceptance-gate:\n    continue-on-error: true\n    name: Require every stable acceptance result"
    ),
    source.replace(
      "      - name: Fail closed unless every required job succeeded",
      "      - name: Fail closed unless every required job succeeded\n        continue-on-error: true"
    ),
    source.replace("      - run: npm test\n", "      - run: npm test\n        continue-on-error: true\n"),
    source.replace("      - run: npm test\n", "      - run: npm test\n        if: ${{ false }}\n"),
    source.replace('"pyspark[connect]==4.2.0"', '"pyspark[connect]==4.1.0"'),
    source.replace("      - name: Verify exact coverage runtimes", "      - name: Skip exact coverage runtimes"),
    source.replace(
      "      - run: npm ci\n",
      '      - run: npm ci && echo "NODE_OPTIONS=--require=/tmp/release-hook.cjs" >> "$GITHUB_ENV"\n'
    ),
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
      "      - run: npm run test:extension-host\n        env:",
      "      - run: npm run test:extension-host\n        shell: bash {0}\n        env:"
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
      "          --out ${{ runner.temp }}/openwrangler-installed-performance-${{ github.run_id }}-${{ github.run_attempt }}.json",
      "          --out ${{ runner.temp }}/openwrangler-installed-performance-${{ github.run_id }}-${{ github.run_attempt }}.json || true"
    ),
    source.replace(
      "      - id: packaged_editor\n        name: Test released Jupyter in the exact packaged VSIX",
      "      - id: packaged_editor\n        name: Test released Jupyter in the exact packaged VSIX\n        if: ${{ false }}"
    ),
    source.replace(
      "      - id: prepare_xvfb\n        name: Prepare pinned private Xvfb",
      "      - id: prepare_xvfb\n        name: Prepare pinned private Xvfb\n        if: ${{ false }}"
    ),
    source.replace(
      "      - id: remote_workspace\n        name: Test packaged VS Code over Remote SSH",
      "      - id: remote_workspace\n        name: Test packaged VS Code over Remote SSH\n        if: ${{ false }}"
    ),
    source.replace(
      "      - id: canonical_artifact\n        name: Upload the canonical stable artifact set",
      "      - run: node scripts/rewrite-canonical.mjs canonical-release/openwrangler.vsix\n      - id: canonical_artifact\n        name: Upload the canonical stable artifact set"
    ),
    source.replace(
      "      - id: packaged_editor\n        name: Test packaged VS Code",
      "      - run: node scripts/rewrite-canonical.mjs canonical-release/openwrangler.vsix\n      - id: packaged_editor\n        name: Test packaged VS Code"
    ),
    source.replace(
      "      - id: cursor_smoke\n        name: Test pinned Cursor platform smoke",
      "      - run: node scripts/rewrite-canonical.mjs canonical-release/openwrangler.vsix\n      - id: cursor_smoke\n        name: Test pinned Cursor platform smoke"
    ),
    source.replace(
      "      - id: installed_performance\n        name: Test the ordinary stable artifact in pinned editors",
      "      - run: node scripts/rewrite-canonical.mjs canonical-release/openwrangler.vsix\n      - id: installed_performance\n        name: Test the ordinary stable artifact in pinned editors"
    ),
    source.replace(
      "      - id: packaged_editor\n        name: Test released Jupyter in the exact packaged VSIX",
      "      - run: node scripts/rewrite-canonical.mjs canonical-release/openwrangler.vsix\n      - id: packaged_editor\n        name: Test released Jupyter in the exact packaged VSIX"
    ),
    source.replace(
      "      - id: remote_workspace\n        name: Test packaged VS Code over Remote SSH",
      "      - run: node scripts/rewrite-canonical.mjs canonical-release/openwrangler.vsix\n      - id: remote_workspace\n        name: Test packaged VS Code over Remote SSH"
    ),
    source.replace(
      "      - id: canonical_cursor\n        name: Reverify the exact canonical stable artifact for Cursor",
      '      - run: printf replaced > "${{ steps.prepare_cursor_xvfb.outputs.executable }}"\n      - id: canonical_cursor\n        name: Reverify the exact canonical stable artifact for Cursor'
    ),
    source.replace(
      "      - name: Publish or verify the exact GitHub stable release",
      "      - run: node scripts/rewrite-canonical.mjs canonical-release/openwrangler.vsix\n      - name: Publish or verify the exact GitHub stable release"
    ),
    source.replace("    timeout-minutes: 40", "    timeout-minutes: 20"),
    source.replace(
      "      - name: Publish or verify the exact lightweight release tag\n        env:\n          EXPECTED_SHA: ${{ github.sha }}\n          GITHUB_REPOSITORY: ${{ github.repository }}\n          GITHUB_TOKEN: ${{ github.token }}\n          RELEASE_TAG: ${{ inputs.release_tag }}\n        run: node scripts/push-stable-release-tag.mjs\n",
      ""
    ),
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
    source.replace(
      "name: Test the full package in headless VS Code\n        run: /usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix\n        env:\n          OPEN_WRANGLER_PACKAGED_EDITORS: vscode",
      "name: Test the full package in headless VS Code\n        run: /usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix\n        env:\n          OPEN_WRANGLER_PACKAGED_EDITORS: cursor"
    ),
    source.replace(
      "      - id: packaged_vscode\n        name: Test the full package in headless VS Code",
      "      - id: packaged_vscode\n        continue-on-error: true\n        name: Test the full package in headless VS Code"
    ),
    source.replace(
      "      - id: packaged_cursor\n        name: Test the full package in private-display Cursor",
      "      - id: packaged_cursor\n        continue-on-error: true\n        name: Test the full package in private-display Cursor"
    ),
    source.replace(
      "OPEN_WRANGLER_EDITOR_DISPLAY: xvfb\n          OPEN_WRANGLER_XVFB_EXECUTABLE: ${{ steps.prepare_cursor_xvfb.outputs.executable }}",
      "OPEN_WRANGLER_EDITOR_DISPLAY: current\n          OPEN_WRANGLER_XVFB_EXECUTABLE: ${{ steps.prepare_cursor_xvfb.outputs.executable }}"
    ),
    source.replace(
      "OPEN_WRANGLER_XVFB_EXECUTABLE: ${{ steps.prepare_cursor_xvfb.outputs.executable }}",
      "OPEN_WRANGLER_XVFB_EXECUTABLE: /usr/bin/Xvfb"
    ),
    source.replace(
      'appendFileSync(process.env.GITHUB_OUTPUT, `executable=${executable}\\n`, "utf8");',
      'appendFileSync(process.env.GITHUB_OUTPUT, "executable=/usr/bin/Xvfb\\n", "utf8");'
    ),
    source.replace("id: prepare_cursor_xvfb", "id: prepare_unverified_cursor_display"),
    source.replace("id: canonical_vscode", "id: stale_canonical_vscode"),
    source.replace("id: canonical_cursor", "id: stale_canonical_cursor"),
    source.replace(
      "path: ${{ steps.packaged_cursor.outputs.evidence_path }}",
      "path: ${{ steps.packaged_vscode.outputs.evidence_path }}"
    ),
    source.replace("if: ${{ inputs.publish == true }}", "if: ${{ inputs.publish != false }}"),
    source.replace("environment: publishing", "environment: stable-release"),
    source.replace('test "$REMOTE_SSH_RESULT" = "success"', 'test "$REMOTE_SSH_RESULT" != "failure"'),
    source.replace("npm run check", "npm run check\n      - run: npm run package -- --out rebuilt.vsix"),
    source.replace(
      "node scripts/prepare-stable-candidate-tag.mjs --verify-remote",
      "node scripts/prepare-stable-candidate-tag.mjs --ignore-remote"
    ),
    source.replace(
      '          test "$EVENT_REF_TYPE" = "branch"\n          test "$EVENT_REF" = "refs/heads/main"',
      "          true\n          true"
    ),
    source.replace(
      '          test "$(git rev-parse --verify HEAD^{commit})" = "$EXPECTED_SHA"\n          test -z "$(git status --porcelain --untracked-files=no)"\n          test "$(git rev-parse --verify refs/remotes/origin/main^{commit})" = "$EXPECTED_SHA"',
      "          true\n          true\n          true"
    ),
    source.replace(
      "npx --no-install ovsx publish --skip-duplicate canonical-release/openwrangler.vsix",
      "npx ovsx publish --skip-duplicate canonical-release/openwrangler.vsix"
    ),
    source.replace(
      "npx --no-install ovsx publish --skip-duplicate canonical-release/openwrangler.vsix",
      "npx --no-install ovsx publish --pre-release --skip-duplicate canonical-release/openwrangler.vsix"
    ),
    source.replace("          OVSX_PAT: ${{ secrets.OVSX_PAT }}", "          OVSX_PAT: exposed-token"),
    source.replace(
      "      - name: Verify the exact public Open VSX release\n        env:\n          EXPECTED_SHA: ${{ github.sha }}\n          RELEASE_TAG: ${{ inputs.release_tag }}\n        run: node scripts/verify-open-vsx-release.mjs canonical-release --verify\n",
      ""
    ),
    source.replace(
      "          GITHUB_REPOSITORY: ${{ github.repository }}",
      "          GITHUB_REPOSITORY: attacker/example"
    ),
    source.replace(
      "      - name: Upload installed-performance evidence\n        if: ${{ steps.installed_performance.outcome == 'success' }}\n        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: stable-release-installed-performance\n          path: ${{ runner.temp }}/openwrangler-installed-performance-${{ github.run_id }}-${{ github.run_attempt }}.json\n          if-no-files-found: error\n          retention-days: 90\n          compression-level: 9\n          include-hidden-files: false\n",
      ""
    ),
    source.replace(
      "      - run: npm run test:coverage\n",
      "      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a\n        with:\n          name: private-workspace\n          path: .\n      - run: npm run test:coverage\n"
    ),
    source.replace(
      "  package:\n    runs-on: ubuntu-24.04",
      "  package:\n    runs-on: ubuntu-24.04\n    container: &loop\n      loop: *loop"
    ),
    source.replace("    timeout-minutes: 60", "    timeout-minutes: .nan")
  ];
  for (const [index, candidate] of mutations.entries()) {
    assert.notEqual(candidate, source, `mutation ${index + 1} must alter the workflow source`);
    assert.notDeepEqual(inspectStableReleaseWorkflow(candidate), [], `mutation ${index + 1} must be rejected`);
  }
});
