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
    source.replace("--out-dir canonical-release", "--out-dir canonical-release\n          --performance-evidence"),
    source.replace("artifact-ids: ${{ needs.package.outputs.artifact-id }}", "name: openwrangler-stable-release"),
    source.replace('OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1"', 'OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0"'),
    source.replace("OPEN_WRANGLER_PACKAGED_EDITORS: vscode,cursor", "OPEN_WRANGLER_PACKAGED_EDITORS: vscode"),
    source.replace(
      "name: Test the full package in headless VS Code\n        run: /usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix\n        env:\n          OPEN_WRANGLER_PACKAGED_EDITORS: vscode",
      "name: Test the full package in headless VS Code\n        run: /usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix\n        env:\n          OPEN_WRANGLER_PACKAGED_EDITORS: cursor"
    ),
    source.replace(
      "OPEN_WRANGLER_EDITOR_DISPLAY: xvfb\n          OPEN_WRANGLER_XVFB_EXECUTABLE: ${{ steps.prepare_cursor_xvfb.outputs.executable }}",
      "OPEN_WRANGLER_EDITOR_DISPLAY: current\n          OPEN_WRANGLER_XVFB_EXECUTABLE: ${{ steps.prepare_cursor_xvfb.outputs.executable }}"
    ),
    source.replace(
      "OPEN_WRANGLER_XVFB_EXECUTABLE: ${{ steps.prepare_cursor_xvfb.outputs.executable }}",
      "OPEN_WRANGLER_XVFB_EXECUTABLE: /usr/bin/Xvfb"
    ),
    source.replace("id: prepare_cursor_xvfb", "id: prepare_unverified_cursor_display"),
    source.replace(
      "path: ${{ steps.packaged_cursor.outputs.evidence_path }}",
      "path: ${{ steps.packaged_vscode.outputs.evidence_path }}"
    ),
    source.replace("if: ${{ inputs.publish == true }}", "if: ${{ inputs.publish != false }}"),
    source.replace("environment: publishing", "environment: stable-release"),
    source.replace('test "$REMOTE_SSH_RESULT" = "success"', 'test "$REMOTE_SSH_RESULT" != "failure"'),
    source.replace("npm run check", "npm run check\n      - run: npm run package -- --out rebuilt.vsix"),
    source.replace(
      'git ls-remote --exit-code --refs origin "refs/tags/$RELEASE_TAG"',
      'git ls-remote --exit-code --refs origin "refs/tags/ignored"'
    ),
    source.replace(
      "softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65",
      "softprops/action-gh-release@v2"
    ),
    `${source}\n# ovsX publish must never appear in this workflow\n`
  ];
  for (const candidate of mutations) {
    assert.notDeepEqual(inspectStableReleaseWorkflow(candidate), []);
  }
});
