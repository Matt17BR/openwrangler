import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inspectCompatibilityEvidence } from "./compatibility-evidence.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const sources = Object.freeze({
  authoritySource: read("fixtures/compatibility-evidence.json"),
  packageSource: read("package.json"),
  remoteWorkspaceContractSource: read("scripts/remote-workspace-contract.mjs"),
  cursorAcquisitionSource: read("scripts/cursor-acquisition.mjs"),
  candidateWorkflowSource: read(".github/workflows/candidate-acceptance.yml"),
  ciWorkflowSource: read(".github/workflows/ci.yml"),
  crossWorkflowSource: read(".github/workflows/cross-platform.yml"),
  readmeSource: read("README.md"),
  releasingSource: read("docs/releasing.md"),
  architectureSource: read("docs/architecture.md"),
  featureParitySource: read("docs/feature-parity.md"),
  testingSource: read("docs/testing.md"),
  ciDocumentationSource: read("docs/ci.md")
});
const authority = JSON.parse(sources.authoritySource);
const inspect = (changes = {}) => inspectCompatibilityEvidence({ ...sources, ...changes });
const changedAuthority = (change) => {
  const candidate = structuredClone(authority);
  change(candidate);
  return { authoritySource: JSON.stringify(candidate) };
};

test("the current compatibility authority matches immutable sources and public claims", () => {
  assert.deepEqual(inspect(), []);
});

test("tiers and entries are bounded, known, unique, and ordered", () => {
  assert.match(
    inspect(changedAuthority((candidate) => candidate.tiers.reverse())).join(" "),
    /known, unique, and ordered/u
  );
  assert.match(
    inspect(changedAuthority((candidate) => (candidate.editors[0].tier = "future-tier"))).join(" "),
    /known tier/u
  );
  assert.match(
    inspect(changedAuthority((candidate) => candidate.editors.push(...candidate.editors))).join(" "),
    /structural|four ordered/u
  );
  assert.match(
    inspect(changedAuthority((candidate) => (candidate.tiers[0].meaning = "x".repeat(513)))).join(" "),
    /bounds/u
  );
});

test("editor versions and platforms are derived from immutable source owners", () => {
  assert.match(
    inspect({ packageSource: sources.packageSource.replace("^1.106.0", "^1.107.0") }).join(" "),
    /engines\.vscode/u
  );
  assert.match(
    inspect({
      remoteWorkspaceContractSource: sources.remoteWorkspaceContractSource.replace('"1.130.0"', '"1.131.0"')
    }).join(" "),
    /Pinned editor release versions/u
  );
  assert.match(
    inspect({ cursorAcquisitionSource: sources.cursorAcquisitionSource.replace('"3.13.10"', '"3.14.0"') }).join(" "),
    /Pinned editor release versions/u
  );
  assert.match(
    inspect(changedAuthority((candidate) => candidate.editors[1].platforms.push("windows"))).join(" "),
    /rendered version, platform/u
  );
  for (const [index, field, value] of [
    [0, "releaseVersion", "1.131.0"],
    [1, "versionOwner", "scripts/other-owner.mjs#PINNED_CURSOR_VERSION"],
    [2, "platforms", ["linux"]],
    [3, "releaseVersion", "browser-moving"]
  ]) {
    assert.match(
      inspect(changedAuthority((candidate) => (candidate.editors[index][field] = value))).join(" "),
      /rendered version, platform/u
    );
  }
});

test("missing and duplicate Cursor version pins return bounded diagnostics", () => {
  for (const cursorAcquisitionSource of [
    sources.cursorAcquisitionSource.replace('export const PINNED_CURSOR_VERSION = "3.13.10";\n', ""),
    sources.cursorAcquisitionSource.replace(
      'export const PINNED_CURSOR_VERSION = "3.13.10";',
      'export const PINNED_CURSOR_VERSION = "3.13.10";\nexport const PINNED_CURSOR_VERSION = "3.13.10";'
    )
  ]) {
    assert.doesNotThrow(() => {
      assert.match(inspect({ cursorAcquisitionSource }).join(" "), /Pinned Cursor version/u);
    });
  }
});

test("fully qualified VS Code evidence requires the complete candidate fan-in", () => {
  const incomplete = sources.candidateWorkflowSource.replace(
    "needs: [contract, platform, r_platform, linux, performance, jupyter, r_local]",
    "needs: [contract, platform, r_platform, linux, jupyter, r_local]"
  );
  assert.match(inspect({ candidateWorkflowSource: incomplete }).join(" "), /complete VS Code qualification fan-in/u);
  assert.match(
    inspect({
      candidateWorkflowSource: sources.candidateWorkflowSource.replace("--editors vscode", "--editors cursor")
    }).join(" "),
    /installed-performance owner/u
  );
  assert.match(
    inspect({
      candidateWorkflowSource: sources.candidateWorkflowSource.replace(
        "OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE: candidate-one-owner",
        "OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE: stale-owner"
      )
    }).join(" "),
    /released-Jupyter owner/u
  );
});

test("the exact VS Code pin is not attributed to moving stable candidate lanes", () => {
  const pinnedPlatform = sources.candidateWorkflowSource.replace(
    "VSCODE_TEST_VERSION: stable",
    "VSCODE_TEST_VERSION: 1.130.0"
  );
  assert.match(inspect({ candidateWorkflowSource: pinnedPlatform }).join(" "), /effective editor version/u);
  for (const field of ["movingStableWorkflowOwners", "pinnedWorkflowOwners", "fanInWorkflowOwners"]) {
    assert.match(
      inspect(changedAuthority((candidate) => candidate.editors[0][field].pop())).join(" "),
      /evidence lanes must distinguish/u
    );
  }
});

test("every active editor-version assignment is structurally classified", () => {
  const inlineCommentAlias = sources.candidateWorkflowSource.replace(
    "VSCODE_TEST_VERSION: stable",
    "VSCODE_TEST_VERSION: 1.130.0 # VSCODE_TEST_VERSION: stable"
  );
  assert.match(inspect({ candidateWorkflowSource: inlineCommentAlias }).join(" "), /effective editor version/u);

  const mixedRPlatformPhases = sources.candidateWorkflowSource.replace(
    "          VSCODE_TEST_VERSION: stable\n      - name: Upload platform R core failure diagnostics",
    "          VSCODE_TEST_VERSION: 1.130.0\n      - name: Upload platform R core failure diagnostics"
  );
  assert.match(inspect({ candidateWorkflowSource: mixedRPlatformPhases }).join(" "), /effective editor version/u);
});

test("semantic workflow inspection resolves inherited, command, escaped, quoted, and explicit assignments", () => {
  const inheritedPinned = sources.candidateWorkflowSource
    .replace("name: Candidate acceptance\n", "name: Candidate acceptance\nenv:\n  VSCODE_TEST_VERSION: 1.130.0\n")
    .replace(
      "          VSCODE_TEST_VERSION: stable\n      - name: Upload platform native R frame failure diagnostics",
      "      - name: Upload platform native R frame failure diagnostics"
    );
  assert.match(inspect({ candidateWorkflowSource: inheritedPinned }).join(" "), /effective editor version/u);

  const commandOverride = sources.candidateWorkflowSource.replace(
    "run: node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
    "run: VSCODE_TEST_VERSION=1.130.0 node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix"
  );
  assert.match(inspect({ candidateWorkflowSource: commandOverride }).join(" "), /effective editor version/u);
  const quotedCommandOverride = sources.candidateWorkflowSource.replace(
    "run: node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
    'run: env "VSCODE_TEST_VERSION=1.130.0" node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix'
  );
  assert.match(inspect({ candidateWorkflowSource: quotedCommandOverride }).join(" "), /effective editor version/u);

  for (const replacement of [
    '          "VSCODE_TEST_\\u0056ERSION": 1.130.0',
    '          "VSCODE_TEST_VERSION": 1.130.0',
    "          ? VSCODE_TEST_VERSION\n          : 1.130.0"
  ]) {
    const encoded = sources.candidateWorkflowSource.replace(
      "          VSCODE_TEST_VERSION: stable\n      - name: Upload platform native R frame failure diagnostics",
      `${replacement}\n      - name: Upload platform native R frame failure diagnostics`
    );
    assert.match(inspect({ candidateWorkflowSource: encoded }).join(" "), /effective editor version/u);
  }

  const prototypeKey = sources.candidateWorkflowSource.replace(
    "name: Candidate acceptance\n",
    "name: Candidate acceptance\n__proto__:\n  polluted: true\n"
  );
  assert.match(inspect({ candidateWorkflowSource: prototypeKey }).join(" "), /bounded jobs mapping/u);
  assert.equal(Object.prototype.polluted, undefined);
});

test("shell ownership normalizes split, quoted, escaped, and env-prefixed editor assignments", () => {
  const original = "run: node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix";
  for (const command of [
    'VSCODE_TEST_""VERSION=1.130.0 node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix',
    "VSCODE_TEST_\\VERSION=1.130.0 node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
    'env "VSCODE_TEST_VERSION=1.130.0" node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix'
  ]) {
    assert.match(
      inspect({ candidateWorkflowSource: sources.candidateWorkflowSource.replace(original, `run: ${command}`) }).join(
        " "
      ),
      /effective editor version/u
    );
  }

  const exported = sources.candidateWorkflowSource.replace(
    original,
    "run: |\n          export VSCODE_TEST_VERSION=1.130.0\n          node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix"
  );
  assert.match(inspect({ candidateWorkflowSource: exported }).join(" "), /effective editor version/u);

  const editorSelectionOverride = sources.candidateWorkflowSource.replace(
    original,
    "run: OPEN_WRANGLER_PACKAGED_EDITORS=cursor node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix"
  );
  assert.match(inspect({ candidateWorkflowSource: editorSelectionOverride }).join(" "), /VS Code platform owner/u);

  const unsetOverride = sources.candidateWorkflowSource.replace(
    original,
    "run: env --unset=VSCODE_TEST_VERSION node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix"
  );
  assert.match(
    inspect({ candidateWorkflowSource: unsetOverride }).join(" "),
    /unsupported command-level editor-version reference|exact editor runner/u
  );

  const tokenOverflow = sources.candidateWorkflowSource.replace(
    original,
    `run: VSCODE_TEST_VERSION=stable ${"argument ".repeat(2_049)}node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix`
  );
  assert.match(
    inspect({ candidateWorkflowSource: tokenOverflow }).join(" "),
    /unsupported command-level editor-version reference|exact editor runner/u
  );
});

test("runner commands and success ownership must be executable and active", () => {
  const commentedPerformance = sources.candidateWorkflowSource.replace(
    "/usr/bin/dbus-run-session -- npm run benchmark:installed --",
    ": # /usr/bin/dbus-run-session -- npm run benchmark:installed --"
  );
  assert.match(inspect({ candidateWorkflowSource: commentedPerformance }).join(" "), /installed-performance owner/u);

  const disabledOwner = sources.candidateWorkflowSource.replace(
    "  performance:\n    name: Installed performance in pinned editors",
    "  performance:\n    if: false\n    name: Installed performance in pinned editors"
  );
  assert.match(inspect({ candidateWorkflowSource: disabledOwner }).join(" "), /effective condition/u);

  const disabledRunner = sources.candidateWorkflowSource.replace(
    "      - id: packaged_editor\n        name: Test packaged VS Code",
    "      - id: packaged_editor\n        if: false\n        name: Test packaged VS Code"
  );
  assert.match(inspect({ candidateWorkflowSource: disabledRunner }).join(" "), /effective condition/u);

  const skippedOutcomeOwner = sources.candidateWorkflowSource.replace(
    "      - name: Require successful platform R outcomes\n        if: ${{ always() }}",
    "      - name: Require successful platform R outcomes\n        if: false"
  );
  assert.match(inspect({ candidateWorkflowSource: skippedOutcomeOwner }).join(" "), /executable success owner/u);

  const commentedFanIn = sources.candidateWorkflowSource.replace(
    '          test "$PERFORMANCE_RESULT" = "success"',
    '          : # test "$PERFORMANCE_RESULT" = "success"'
  );
  assert.match(inspect({ candidateWorkflowSource: commentedFanIn }).join(" "), /qualification fan-in/u);

  const bypassedFanIn = sources.candidateWorkflowSource.replace(
    '          test "$PERFORMANCE_RESULT" = "success"',
    '          test "$PERFORMANCE_RESULT" = "success" || true'
  );
  assert.match(inspect({ candidateWorkflowSource: bypassedFanIn }).join(" "), /qualification fan-in/u);

  for (const [marker, diagnostic] of [
    ["PERFORMANCE_RESULT", /qualification fan-in/u],
    ["CORE_OUTCOME", /executable success owner/u]
  ]) {
    const assignmentOnlyMarker = sources.candidateWorkflowSource.replace(
      `          test "$${marker}" = "success"`,
      `          ${marker}=success\n          test "$${marker}" = "success"`
    );
    assert.match(inspect({ candidateWorkflowSource: assignmentOnlyMarker }).join(" "), diagnostic);

    const commandPrefixOverride = sources.candidateWorkflowSource.replace(
      `          test "$${marker}" = "success"`,
      `          ${marker}=success test "$${marker}" = "success"`
    );
    assert.match(inspect({ candidateWorkflowSource: commandPrefixOverride }).join(" "), diagnostic);
  }

  const nonFailingOutcomeOwner = sources.candidateWorkflowSource
    .replace(
      "      - name: Require successful platform R outcomes\n        if: ${{ always() }}\n        shell: bash\n        env:",
      "      - name: Require successful platform R outcomes\n        if: ${{ always() }}\n        shell: bash\n        env:"
    )
    .replace(
      '          set -euo pipefail\n          test "$CORE_OUTCOME" = "success"',
      '          set +e\n          test "$CORE_OUTCOME" = "success"'
    );
  assert.match(inspect({ candidateWorkflowSource: nonFailingOutcomeOwner }).join(" "), /executable success owner/u);

  for (const injectedCommand of [
    "readonly CORE_OUTCOME=success",
    "printf -v CORE_OUTCOME success",
    "alias test=true"
  ]) {
    const nonCanonicalOwner = sources.candidateWorkflowSource.replace(
      '          test "$CORE_OUTCOME" = "success"',
      `          ${injectedCommand}\n          test "$CORE_OUTCOME" = "success"`
    );
    assert.match(inspect({ candidateWorkflowSource: nonCanonicalOwner }).join(" "), /executable success owner/u);
  }
});

test("required owners accept only absent or literal-false continue-on-error", () => {
  const literalFalseOwners = sources.ciWorkflowSource
    .replace("  r-contract-kernel:\n", "  r-contract-kernel:\n    continue-on-error: false\n")
    .replace(
      "      - run: npm run test:r-contract -- --shard kernel-agent\n",
      "      - continue-on-error: false\n        run: npm run test:r-contract -- --shard kernel-agent\n"
    );
  assert.deepEqual(inspect({ ciWorkflowSource: literalFalseOwners }), []);

  for (const continueOnError of ["${{ false }}", '"false"', '"true"', "1"]) {
    const jobOwner = sources.ciWorkflowSource.replace(
      "  r-contract-kernel:\n",
      `  r-contract-kernel:\n    continue-on-error: ${continueOnError}\n`
    );
    assert.match(inspect({ ciWorkflowSource: jobOwner }).join(" "), /enabled owners/u);

    const stepOwner = sources.crossWorkflowSource.replace(
      "      - run: npm run test:r-contract\n",
      `      - continue-on-error: ${continueOnError}\n        run: npm run test:r-contract\n`
    );
    assert.match(inspect({ crossWorkflowSource: stepOwner }).join(" "), /enabled owners/u);
  }

  const literalFalseAcceptance = sources.candidateWorkflowSource
    .replace("  acceptance:\n", "  acceptance:\n    continue-on-error: false\n")
    .replace(
      "      - name: Require every candidate acceptance result\n",
      "      - name: Require every candidate acceptance result\n        continue-on-error: false\n"
    );
  assert.deepEqual(inspect({ candidateWorkflowSource: literalFalseAcceptance }), []);
  for (const continueOnError of ["${{ false }}", '"false"', '"true"']) {
    const acceptanceOwner = sources.candidateWorkflowSource.replace(
      "      - name: Require every candidate acceptance result\n",
      `      - name: Require every candidate acceptance result\n        continue-on-error: ${continueOnError}\n`
    );
    assert.match(inspect({ candidateWorkflowSource: acceptanceOwner }).join(" "), /qualification fan-in/u);
  }

  for (const continueOnError of ["${{ true }}", '"true"']) {
    const deferredRunner = sources.candidateWorkflowSource.replace(
      "        continue-on-error: true\n",
      `        continue-on-error: ${continueOnError}\n`
    );
    assert.match(inspect({ candidateWorkflowSource: deferredRunner }).join(" "), /executable success owner/u);
  }
});

test("success fan-ins reject inherited and direct environment additions", () => {
  for (const candidateWorkflowSource of [
    sources.candidateWorkflowSource.replace(
      "          CONTRACT_RESULT: ${{ needs.contract.result }}\n",
      "          CONTRACT_RESULT: ${{ needs.contract.result }}\n          BASH_ENV: /tmp/replace-owner\n"
    ),
    sources.candidateWorkflowSource.replace(
      "  acceptance:\n",
      "  acceptance:\n    env:\n      ENV: /tmp/replace-owner\n"
    ),
    sources.candidateWorkflowSource.replace(
      "name: Candidate acceptance\n",
      "name: Candidate acceptance\nenv:\n  SHELL_STARTUP: /tmp/replace-owner\n"
    ),
    sources.candidateWorkflowSource.replace(
      "          CORE_OUTCOME: ${{ steps.packaged_editor_r_core.outcome }}\n",
      "          CORE_OUTCOME: ${{ steps.packaged_editor_r_core.outcome }}\n          BASH_ENV: /tmp/replace-owner\n"
    )
  ]) {
    assert.match(inspect({ candidateWorkflowSource }).join(" "), /qualification fan-in|executable success owner/u);
  }

  for (const ciWorkflowSource of [
    sources.ciWorkflowSource.replace(
      "          R_CONTRACT_REQUIRED: ${{ needs.classify.outputs.r_contract_required }}\n",
      "          R_CONTRACT_REQUIRED: ${{ needs.classify.outputs.r_contract_required }}\n          BASH_ENV: /tmp/replace-owner\n"
    ),
    sources.ciWorkflowSource.replace("  validate:\n", "  validate:\n    env:\n      ENV: /tmp/replace-owner\n")
  ]) {
    assert.match(inspect({ ciWorkflowSource }).join(" "), /required CI success fan-in/u);
  }
});

test("required runners and fan-ins bind shell, topology, and persistent environment", () => {
  for (const shell of ["bash {0} || true", "${{ matrix.shell }}", "bash -c {0}"]) {
    const candidateWorkflowSource = sources.candidateWorkflowSource.replace(
      "      - name: Require every candidate acceptance result\n        env:",
      `      - name: Require every candidate acceptance result\n        shell: ${shell}\n        env:`
    );
    assert.match(inspect({ candidateWorkflowSource }).join(" "), /qualification fan-in/u);
  }

  const customRunnerShell = sources.candidateWorkflowSource.replace(
    "      - id: packaged_editor\n        name: Test packaged VS Code",
    "      - id: packaged_editor\n        name: Test packaged VS Code\n        shell: bash {0} || true"
  );
  assert.match(inspect({ candidateWorkflowSource: customRunnerShell }).join(" "), /platform owner|editor runner/u);

  const customContractShell = sources.candidateWorkflowSource.replace(
    "      - name: Require one supported candidate invocation\n        env:",
    "      - name: Require one supported candidate invocation\n        shell: bash {0} || true\n        env:"
  );
  assert.match(inspect({ candidateWorkflowSource: customContractShell }).join(" "), /input contract/u);

  for (const candidateWorkflowSource of [
    sources.candidateWorkflowSource.replace(
      "  acceptance:\n    name:",
      "  acceptance:\n    container:\n      image: ubuntu:24.04\n      env:\n        BASH_ENV: /tmp/replace-owner\n    name:"
    ),
    sources.candidateWorkflowSource.replace(
      "  acceptance:\n    name:",
      "  acceptance:\n    defaults:\n      run:\n        shell: bash {0} || true\n    name:"
    ),
    sources.candidateWorkflowSource.replace(
      "  platform:\n    name:",
      "  platform:\n    container:\n      image: ubuntu:24.04\n      env:\n        NODE_OPTIONS: --require=/tmp/replace-owner.cjs\n    name:"
    ),
    sources.candidateWorkflowSource.replace(
      "      - id: packaged_editor\n        name: Test packaged VS Code",
      '      - name: Persist runner replacement\n        run: echo "NODE_OPTIONS=--require=/tmp/replace-owner.cjs" >> "$GITHUB_ENV"\n      - id: packaged_editor\n        name: Test packaged VS Code'
    ),
    sources.candidateWorkflowSource.replace(
      "      - name: Require successful platform R outcomes\n",
      '      - name: Persist owner replacement\n        shell: bash\n        run: echo "BASH_ENV=/tmp/replace-owner" >> "$GITHUB_ENV"\n      - name: Require successful platform R outcomes\n'
    ),
    sources.candidateWorkflowSource.replace(
      "      - name: Require successful platform R outcomes\n",
      '      - name: Persist path replacement\n        shell: bash\n        run: echo "/tmp/replace-owner" >> "$GITHUB_PATH"\n      - name: Require successful platform R outcomes\n'
    ),
    sources.candidateWorkflowSource.replace(
      "      - name: Require successful platform R outcomes\n",
      "      - name: Persist command replacement\n        shell: bash\n        run: alias test=true\n      - name: Require successful platform R outcomes\n"
    )
  ]) {
    assert.match(
      inspect({ candidateWorkflowSource }).join(" "),
      /qualification fan-in|executable success owner|persistent environment/u
    );
  }

  for (const ciWorkflowSource of [
    sources.ciWorkflowSource.replace(
      "      - name: Require every owned CI result\n",
      '      - name: Persist CI owner replacement\n        run: echo "BASH_ENV=/tmp/replace-owner" >> "$GITHUB_ENV"\n      - name: Require every owned CI result\n'
    ),
    sources.ciWorkflowSource.replace(
      "  validate:\n    name:",
      "  validate:\n    container:\n      image: ubuntu:24.04\n    name:"
    ),
    sources.ciWorkflowSource.replace(
      "      - name: Require every owned CI result\n",
      "      - name: Require every owned CI result\n        shell: bash {0} || true\n"
    )
  ]) {
    assert.match(inspect({ ciWorkflowSource }).join(" "), /required CI success fan-in/u);
  }
});

test("every preceding owner step has one admitted action, shell, and executable environment", () => {
  const runner = "      - id: packaged_editor\n        name: Test packaged VS Code";
  for (const preceding of [
    "      - uses: hostile/replace-owner@0123456789012345678901234567890123456789\n",
    "      - name: Suppress the next owner\n        shell: bash {0} || true\n        run: echo ready\n",
    "      - name: Preload the next owner\n        env:\n          LD_PRELOAD: /tmp/replace-owner.so\n        run: echo ready\n"
  ]) {
    const candidateWorkflowSource = sources.candidateWorkflowSource.replace(runner, `${preceding}${runner}`);
    assert.match(
      inspect({ candidateWorkflowSource }).join(" "),
      /platform owner|editor runner|preceding owner topology|persistent environment/u
    );
  }
});

test("workflow execution environments cannot replace the required shell", () => {
  const crossWorkflowSource = sources.crossWorkflowSource.replace(
    "\njobs:\n",
    "\nenv:\n  NPM_CONFIG_SCRIPT_SHELL: /tmp/replace-owner\n\njobs:\n"
  );
  assert.match(inspect({ crossWorkflowSource }).join(" "), /Native R source ownership|execution environment/u);
});

test("workflow execution environments use an exact empty authority and reject imported tools", () => {
  for (const [key, value] of [
    ["UNPROVED_OWNER_SETTING", "enabled"],
    ["R_LIBS_USER", "/tmp/replace-r-library"],
    ["BASH_FUNC_npm%%", "() { printf hostile-npm; }"]
  ]) {
    const candidateWorkflowSource = sources.candidateWorkflowSource.replace(
      "\njobs:\n",
      `\nenv:\n  "${key}": "${value}"\n\njobs:\n`
    );
    assert.match(inspect({ candidateWorkflowSource }).join(" "), /qualification|execution environment|owner/u);
  }

  if (process.platform !== "win32") {
    const resolution = spawnSync("bash", ["--noprofile", "--norc", "-c", "type -t npm; npm"], {
      encoding: "utf8",
      env: { "BASH_FUNC_npm%%": "() { printf hostile-npm; }", PATH: process.env.PATH }
    });
    assert.equal(resolution.status, 0);
    assert.equal(resolution.stdout, "function\nhostile-npm");
  }
});

test("every workflow owner retains its own effective editor-version authority", () => {
  const pinnedExtensionHost = sources.ciWorkflowSource.replace(
    "          VSCODE_TEST_VERSION: stable",
    "          VSCODE_TEST_VERSION: 1.130.0"
  );
  assert.match(inspect({ ciWorkflowSource: pinnedExtensionHost }).join(" "), /ci\.yml owner canonical-editor/u);

  const packagedMarker = "          OPEN_WRANGLER_PACKAGED_EDITORS: vscode\n          VSCODE_TEST_VERSION: stable";
  const pinnedPackagedOwner = sources.ciWorkflowSource.replace(
    packagedMarker,
    "          OPEN_WRANGLER_PACKAGED_EDITORS: vscode\n          VSCODE_TEST_VERSION: 1.130.0"
  );
  assert.match(inspect({ ciWorkflowSource: pinnedPackagedOwner }).join(" "), /ci\.yml owner canonical-editor/u);
});

test("the exact Antigravity smoke stays separate and bound to its immutable record", () => {
  for (const [field, value] of [
    ["editorVersion", "1.108.0"],
    ["architecture", "arm64"],
    ["installedExtension", "Matt17BR.openwrangler@1.2.1"],
    ["activationCommand", "openWrangler.openUrl"],
    ["openedFormat", "comma CSV through Pandas"],
    ["sourceImmutability", "unverified"],
    ["cleanup", "best effort"]
  ]) {
    assert.match(
      inspect(changedAuthority((candidate) => (candidate.forkSmokes[0][field] = value))).join(" "),
      /exact separate historical record/u
    );
  }
  assert.match(
    inspect({ testingSource: sources.testingSource.replace("Open Wrangler 1.2.0", "Open Wrangler 1.2.1") }).join(" "),
    /canonical Antigravity smoke record/u
  );
  for (const marker of [
    "The shipped product configuration selected Open VSX.",
    "The public `openWrangler.openFile` command activated the installed extension",
    "opened the exact schema through native Polars.",
    "The source digest was unchanged.",
    "no surviving editor process; the downloaded archive and private test roots were removed."
  ]) {
    assert.match(
      inspect({ testingSource: sources.testingSource.replace(marker, "") }).join(" "),
      /canonical Antigravity smoke record/u
    );
  }
});

test("public testing and CI claims cannot contradict exact and moving editor evidence", () => {
  assert.match(
    inspect({
      testingSource: sources.testingSource.replace(
        "official VS Code 1.130.0 Linux x64",
        "the moving VS Code stable channel on Linux x64"
      )
    }).join(" "),
    /canonical docs\/testing\.md pinned-editor record/u
  );
  assert.match(
    inspect({
      ciDocumentationSource: sources.ciDocumentationSource.replace(
        "installed performance in pinned VS Code",
        "installed performance in moving stable VS Code"
      )
    }).join(" "),
    /canonical docs\/ci\.md compatibility ownership record/u
  );
  assert.match(
    inspect({
      ciDocumentationSource: sources.ciDocumentationSource.replace(
        "one full generic packaged journey in Linux VS Code",
        "one pinned 1.130.0 packaged journey in Linux VS Code"
      )
    }).join(" "),
    /canonical docs\/ci\.md compatibility ownership record/u
  );
});

test("canonical smoke and public ownership records reject coexistence contradictions", () => {
  assert.match(
    inspect({
      testingSource: sources.testingSource.replace(
        "The source digest was unchanged.",
        "The source digest was unchanged. A later check found that the source digest changed."
      )
    }).join(" "),
    /canonical Antigravity smoke record/u
  );
  assert.match(
    inspect({
      ciDocumentationSource: sources.ciDocumentationSource.replace(
        "Cursor owns no Jupyter or R phase",
        "Cursor owns every Jupyter and R phase"
      )
    }).join(" "),
    /canonical docs\/ci\.md compatibility ownership record/u
  );
});

test("visible records reject hidden or appended compatibility contradictions anywhere in public text", () => {
  const parityStart = sources.featureParitySource.indexOf("The compatibility authority records VS Code on");
  const parityEnd = sources.featureParitySource.indexOf("\n\n", parityStart);
  assert.ok(parityStart >= 0 && parityEnd > parityStart);
  const parityRecord = sources.featureParitySource.slice(parityStart, parityEnd);
  assert.match(
    inspect({
      featureParitySource: sources.featureParitySource.replace(
        parityRecord,
        `<!-- hidden compatibility claim\n${parityRecord}\n-->`
      )
    }).join(" "),
    /docs\/feature-parity\.md/u
  );

  for (const source of [
    "readmeSource",
    "releasingSource",
    "architectureSource",
    "featureParitySource",
    "testingSource",
    "ciDocumentationSource"
  ]) {
    assert.match(
      inspect({
        [source]: `${sources[source]}\nCursor owns every released-Jupyter, Native R, and installed-performance lane.\n`
      }).join(" "),
      /compatibility-sensitive Cursor ownership/u
    );
  }
});

test("canonical ownership records must remain visible top-level Markdown", () => {
  const architectureBlock = sources.architectureSource.match(
    /<!-- open-wrangler-current-compatibility-owners:start -->[\s\S]*?<!-- open-wrangler-current-compatibility-owners:end -->/u
  )?.[0];
  assert.ok(architectureBlock);
  for (const hiddenBlock of [
    `\`\`\`markdown\n${architectureBlock}\n\`\`\``,
    `<pre>\n${architectureBlock}\n</pre>`,
    `<script type="text/plain">\n${architectureBlock}\n</script>`,
    `<style>\n${architectureBlock}\n</style>`,
    `<section hidden>\n${architectureBlock}\n</section>`
  ]) {
    assert.match(
      inspect({ architectureSource: sources.architectureSource.replace(architectureBlock, hiddenBlock) }).join(" "),
      /top-level structured record/u
    );
  }

  for (const hiddenBlock of [
    `<section hidden>\n<section>decoy</section>\n${architectureBlock}\n</section>`,
    `<section\n hidden>\n${architectureBlock}\n</section>`,
    `<section style=display:none>\n${architectureBlock}\n</section>`,
    `<section style=" DISPLAY : none !IMPORTANT ">\n${architectureBlock}\n</section>`,
    `<section style='color: red; visibility : "hidden" ! important'>\n${architectureBlock}\n</section>`,
    `<section style="display/**/:none">\n${architectureBlock}\n</section>`,
    `<section style="d\\69 splay:none">\n${architectureBlock}\n</section>`,
    `<section style="d&#105;splay&#58;none">\n${architectureBlock}\n</section>`,
    `<section style="opacity:0">\n${architectureBlock}\n</section>`,
    `<section style="content-visibility:hidden">\n${architectureBlock}\n</section>`,
    `<section aria-hidden="tr&#117;e">\n${architectureBlock}\n</section>`,
    `<section aria-hidden="&#x74;rue">\n${architectureBlock}\n</section>`
  ]) {
    assert.match(
      inspect({ architectureSource: sources.architectureSource.replace(architectureBlock, hiddenBlock) }).join(" "),
      /top-level structured record/u
    );
  }

  assert.match(
    inspect({
      architectureSource: sources.architectureSource.replace(
        architectureBlock,
        `<section style="position:absolute">\n${architectureBlock}\n</section>`
      )
    }).join(" "),
    /unproven inline style/u
  );

  for (const style of [
    "display: block !important",
    "display:block;visibility:visible;opacity:1;content-visibility:visible"
  ]) {
    assert.deepEqual(
      inspect({
        architectureSource: sources.architectureSource.replace(
          architectureBlock,
          `<section style="${style}">\n${architectureBlock}\n</section>`
        )
      }),
      []
    );
  }
});

test("browser HTML slash and semicolonless entity rules cannot expose a hidden authority", () => {
  const architectureBlock = sources.architectureSource.match(
    /<!-- open-wrangler-current-compatibility-owners:start -->[\s\S]*?<!-- open-wrangler-current-compatibility-owners:end -->/u
  )?.[0];
  assert.ok(architectureBlock);
  for (const hiddenBlock of [
    `<section aria-hidden="true"/>\n${architectureBlock}\n</section>`,
    `<section aria-hidden="&#116rue">\n${architectureBlock}\n</section>`,
    `<section aria-hidden="&#x74rue">\n${architectureBlock}\n</section>`
  ]) {
    assert.match(
      inspect({ architectureSource: sources.architectureSource.replace(architectureBlock, hiddenBlock) }).join(" "),
      /top-level structured record/u
    );
  }

  assert.deepEqual(
    inspect({
      architectureSource: sources.architectureSource.replace(
        architectureBlock,
        `<input aria-hidden="true"/>\n${architectureBlock}`
      )
    }),
    []
  );
});

test("raw HTML visibility and final CSS cascade follow rendered browser semantics", () => {
  const contradiction = "Cursor guarantees released-Jupyter and Native R qualification.";
  for (const visible of [
    `<details open><summary>Compatibility evidence</summary>${contradiction}</details>`,
    `<details><summary>${contradiction}</summary></details>`
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${visible}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership/u
    );
  }

  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n<script type="text/plain"\n${contradiction}\n</script>\n`
    }),
    []
  );
  for (const malformedTag of [
    `<section data-owner=<broken>>${contradiction}</section>`,
    `<section =broken>${contradiction}</section>`,
    `<section data-owner=>${contradiction}</section>`
  ]) {
    const escapedMalformedTagProblems = inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n${malformedTag}\n`
    });
    assert.match(escapedMalformedTagProblems.join(" "), /compatibility-sensitive Cursor ownership/u, malformedTag);
    assert.doesNotMatch(escapedMalformedTagProblems.join(" "), /malformed or unsupported raw HTML/u);
  }

  const architectureBlock = sources.architectureSource.match(
    /<!-- open-wrangler-current-compatibility-owners:start -->[\s\S]*?<!-- open-wrangler-current-compatibility-owners:end -->/u
  )?.[0];
  assert.ok(architectureBlock);
  assert.deepEqual(
    inspect({
      architectureSource: sources.architectureSource.replace(
        architectureBlock,
        `<section style="display:none;display:block">\n${architectureBlock}\n</section>`
      )
    }),
    []
  );

  for (const style of ["display:none;display:block !important", "display:none !important;display:block !important"]) {
    assert.deepEqual(
      inspect({
        architectureSource: sources.architectureSource.replace(
          architectureBlock,
          `<section style="${style}">\n${architectureBlock}\n</section>`
        )
      }),
      []
    );
  }
  for (const style of ["display:none !important;display:block", "display:block !important;display:none !important"]) {
    assert.match(
      inspect({
        architectureSource: sources.architectureSource.replace(
          architectureBlock,
          `<section style="${style}">\n${architectureBlock}\n</section>`
        )
      }).join(" "),
      /top-level structured record/u
    );
  }
});

test("fenced code owns literal comment markers before HTML comment stripping", () => {
  const adversary = [
    "```text",
    "<!-- this opener is literal fenced code",
    "```",
    "-->",
    "Cursor governs released-Jupyter.",
    ""
  ].join("\n");
  assert.match(
    inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${adversary}` }).join(" "),
    /compatibility-sensitive Cursor ownership/u
  );

  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n> \`\`\`text\n> Cursor governs released-Jupyter.\n> \`\`\`\n`
    }),
    []
  );
  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n> Cursor governs released-Jupyter.\n`
    }).join(" "),
    /compatibility-sensitive Cursor ownership/u
  );

  for (const escapedContainer of [
    "> ```text\n> literal fenced text\nCursor governs released-Jupyter.\n",
    "> > ~~~text\n> > literal nested fenced text\n> Cursor governs released-Jupyter.\n",
    "> <!-- hidden only while this quote remains open\nCursor governs released-Jupyter.\n",
    "> > <!-- hidden only while this nested quote remains open\n> Cursor governs released-Jupyter.\n"
  ]) {
    const problems = inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n${escapedContainer}`
    });
    assert.match(problems.join(" "), /compatibility-sensitive Cursor ownership/u, escapedContainer);
    assert.doesNotMatch(problems.join(" "), /unterminated fenced code block|unterminated HTML comment/u);
  }

  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n> \`\`\`text\n> > \`\`\`\n> Cursor governs released-Jupyter.\n> \`\`\`\n`
    }),
    []
  );
});

test("indented code owns literal comment openers before comment state", () => {
  for (const indent of ["    ", "\t"]) {
    assert.match(
      inspect({
        ciDocumentationSource: `${sources.ciDocumentationSource}\n${indent}<!--\nCursor governs released-Jupyter.\n-->\n`
      }).join(" "),
      /compatibility-sensitive Cursor ownership/u
    );
  }

  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nA visible compatibility paragraph\n    Cursor governs released-Jupyter.\n`
    }).join(" "),
    /compatibility-sensitive Cursor ownership/u
  );
  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n> A visible compatibility paragraph\n>     Cursor governs released-Jupyter.\n`
    }).join(" "),
    /compatibility-sensitive Cursor ownership/u
  );
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n\n    Cursor governs released-Jupyter.\n`
    }),
    []
  );
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n>\n>     Cursor governs released-Jupyter.\n`
    }),
    []
  );
});

test("synonym and passive compatibility claims cannot escape the canonical records", () => {
  for (const outsideClaim of [
    "Cursor certifies released-Jupyter and Native R phases.",
    "Installed-performance and released-Jupyter are certified by Cursor.",
    "R 4.4 source qualification is certified by protected pull-request CI.",
    "Installed performance is attributed to moving stable VS Code."
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership|direct R 4\.4 source qualification|installed-performance record/u
    );
  }

  const historicalRecord =
    "The dedicated Linux restart phase passed in both VS Code and Cursor, value and categorical editing passed, and both native-R platform journeys passed with their then-embedded restart coverage.";
  assert.match(
    inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${historicalRecord}\n` }).join(" "),
    /allowlisted compatibility claim once/u
  );
});

test("named product and editor claims require canonical case", () => {
  for (const outsideClaim of [
    "cursor owns every released-Jupyter, Native R, and installed-performance lane.",
    "CURSOR certifies the pinned Linux platform smoke.",
    "Moving stable vs code owns installed performance.",
    "open wrangler certifies the editor compatibility matrix."
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /exact canonical case/u
    );
  }

  for (const outsideClaim of [
    "C&#117;rsor owns every released-Jupyter, Native R, and installed-performance lane.",
    "C**u**rsor owns every released-Jupyter, Native R, and installed-performance lane.",
    "VSCode owns installed performance.",
    "OpenWrangler certifies the editor compatibility matrix.",
    "OpenVSX supports registry evidence."
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /exact canonical case|compatibility-sensitive Cursor ownership/u
    );
  }

  for (const outsideClaim of [
    "C<strong>u</strong>rsor owns every released-Jupyter, Native R, and installed-performance lane.",
    "C<span>u</span>rsor owns every released-Jupyter, Native R, and installed-performance lane.",
    "C<wbr>ursor owns every released-Jupyter, Native R, and installed-performance lane.",
    "C[urs](https://example.com/editor)or owns every released-Jupyter, Native R, and installed-performance lane.",
    "Cursοr owns every released-Jupyter, Native R, and installed-performance lane.",
    "Сursor owns every released-Jupyter, Native R, and installed-performance lane.",
    "Ｃursor owns every released-Jupyter, Native R, and installed-performance lane.",
    "open&NoBreak;wrangler certifies the editor compatibility matrix.",
    "open&ZeroWidthSpace;wrangler certifies the editor compatibility matrix.",
    "open&InvisibleTimes;wrangler certifies the editor compatibility matrix."
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /exact canonical case|compatibility-sensitive Cursor ownership/u
    );
  }

  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nThe literal \`cursor\` supports no installed performance mode.\n`
    }),
    []
  );
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nThe literal <code>cursor owns installed performance</code> is not a product claim.\nSee [the source](https://example.com/cursor-owns-native-r).\n`
    }),
    []
  );
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n. The Greek word κόσμος appears in ordinary prose.\n`
    }),
    []
  );
});

test("reference links and escaped backticks retain their rendered evidence text", () => {
  for (const outsideClaim of [
    "C[urs][editor]or owns every released-Jupyter, Native R, and installed-performance lane.\n\n[editor]: https://example.com/editor",
    String.raw`\`Cursor\` owns every released-Jupyter, Native R, and installed-performance lane.`
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership/u
    );
  }

  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nSee [the source][renderer].\n\n[renderer]: https://example.com/Cursℴr-owns-native-r\n`
    }),
    []
  );

  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n[Cursor](https://example.com owns every released-Jupyter, Native R, and installed-performance lane.\n`
    }).join(" "),
    /supported structural bounds/u
  );

  const excessiveReferences = Array.from(
    { length: 257 },
    (_, index) => `[reference-${index}]: https://example.com/${index}`
  ).join("\n");
  assert.match(
    inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${excessiveReferences}\n` }).join(" "),
    /invalid, duplicate, or unbounded Markdown references/u
  );
});

test("reference definitions are linear and continuation titles remain metadata", () => {
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nSee [the evidence][owner].\n\n[owner]: https://example.com/evidence\n  "Cursor owns Native R only inside this title"\n`
    }),
    []
  );

  const adversary = `[${String.raw`\a`.repeat(2_000)}`;
  const started = performance.now();
  const problems = inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${adversary}\n` });
  assert.ok(performance.now() - started < 2_000, "escaped unterminated reference parsing must stay bounded");
  assert.deepEqual(problems, []);
});

test("raw reference labels are rejected before any unbounded iteration or slice", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      String.raw`
        import { readFileSync } from "node:fs";
        import { inspectCompatibilityEvidence } from "./scripts/compatibility-evidence.mjs";
        const read = (path) => readFileSync(path, "utf8");
        const sources = {
          authoritySource: read("fixtures/compatibility-evidence.json"),
          packageSource: read("package.json"),
          remoteWorkspaceContractSource: read("scripts/remote-workspace-contract.mjs"),
          cursorAcquisitionSource: read("scripts/cursor-acquisition.mjs"),
          candidateWorkflowSource: read(".github/workflows/candidate-acceptance.yml"),
          ciWorkflowSource: read(".github/workflows/ci.yml"),
          crossWorkflowSource: read(".github/workflows/cross-platform.yml"),
          readmeSource: read("README.md"),
          releasingSource: read("docs/releasing.md"),
          architectureSource: read("docs/architecture.md"),
          featureParitySource: read("docs/feature-parity.md"),
          testingSource: read("docs/testing.md"),
          ciDocumentationSource: read("docs/ci.md")
        };
        const originalIterator = String.prototype[Symbol.iterator];
        Object.defineProperty(String.prototype, Symbol.iterator, {
          configurable: true,
          value: function () {
            if (this.length > 4 * 1024) throw new Error("unbounded raw-label iteration");
            return originalIterator.call(this);
          }
        });
        const label = "a".repeat(1024 * 1024);
        for (const addition of [
          "[" + label + "]: https://example.com/editor",
          "C[urs][" + label + "]or governs released-Jupyter."
        ]) {
          const problems = inspectCompatibilityEvidence({
            ...sources,
            ciDocumentationSource: sources.ciDocumentationSource + "\n" + addition + "\n"
          });
          if (!problems.some((problem) => /invalid, duplicate, or unbounded Markdown references|structural bounds/u.test(problem))) {
            throw new Error("oversized raw label was not rejected");
          }
        }
      `
    ],
    { cwd: root, encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("CommonMark autolinks remain visible and reference labels stop at 999 characters", () => {
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nSee <https://example.com/compatibility>.\n`
    }),
    []
  );
  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n<Cursor@example.com> governs released-Jupyter.\n`
    }).join(" "),
    /compatibility-sensitive Cursor ownership/u
  );
  for (const malformed of [
    "<Cursor@example.com data-owner=wrong> governs released-Jupyter.",
    "<Cursor@example.com data-owner> governs released-Jupyter."
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${malformed}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership/u,
      malformed
    );
  }

  const maximumLabel = "a".repeat(999);
  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nC[urs][${maximumLabel}]or governs released-Jupyter.\n\n[${maximumLabel}]: https://example.com/editor\n`
    }).join(" "),
    /compatibility-sensitive Cursor ownership/u
  );
  const oversizedLabel = "a".repeat(1_000);
  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n[${oversizedLabel}]: https://example.com/editor\n`
    }).join(" "),
    /invalid, duplicate, or unbounded Markdown references/u
  );
  const oversizedUseLabel = `${maximumLabel} `;
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nC[urs][${oversizedUseLabel}]or governs released-Jupyter.\n\n[${maximumLabel}]: https://example.com/editor\n`
    }),
    []
  );
});

test("CommonMark literal and reference semantics retain evidence-sensitive text", () => {
  for (const outsideClaim of [
    "```invalid`info\nCursor owns every released-Jupyter, Native R, and installed-performance lane.\n```",
    "[Evidence](Cursor owns every released-Jupyter, Native R, and installed-performance lane.)",
    "C[urs][ed&#105;tor]or owns every released-Jupyter, Native R, and installed-performance lane.\n\n[editor]: https://example.com/editor"
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership/u
    );
  }

  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n\`\`\`text\nCursor owns every released-Jupyter, Native R, and installed-performance lane.\n\`\`\`\n`
    }),
    []
  );
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n~~~invalid\`info\nCursor owns every released-Jupyter, Native R, and installed-performance lane.\n~~~\n`
    }),
    []
  );
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nSee [the source](<https://example.com/a_(b)> "Cursor literal destination").\nSee [the source][ed&#105;tor].\n\n[editor]: https://example.com/Cursor-literal-destination "ordinary title"\n`
    }),
    []
  );

  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\n[Evidence]: Cursor owns every released-Jupyter, Native R, and installed-performance lane.\n`
    }).join(" "),
    /compatibility-sensitive Cursor ownership/u
  );
});

test("Unicode checks are localized to rendered product-name spans", () => {
  for (const productName of ["Cursℴr", "Curs͏or"]) {
    assert.match(
      inspect({
        ciDocumentationSource: `${sources.ciDocumentationSource}\n${productName} owns every released-Jupyter, Native R, and installed-performance lane.\n`
      }).join(" "),
      /exact canonical case|compatibility-sensitive Cursor ownership/u
    );
  }

  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nOpen Wrangler supports compatibility evidence while the Greek word κόσμος remains ordinary prose.\nThe literal \`Cursℴr owns installed performance\` is not a product claim.\n`
    }),
    []
  );
});

test("HTML entities and reviewed Unicode confusables cannot forge Cursor", () => {
  for (const productName of [
    "Curs&omicron;r",
    "C&upsilon;rsor",
    "Cursօr",
    "Ϲursor",
    "Cυrsor",
    "Ꮯursor",
    "CursᎤr",
    "Curs&#x13A4;r"
  ]) {
    assert.match(
      inspect({
        ciDocumentationSource: `${sources.ciDocumentationSource}\n${productName} guarantees every released-Jupyter, Native R, and installed-performance lane.\n`
      }).join(" "),
      /exact canonical case|compatibility-sensitive Cursor ownership/u
    );
  }

  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nOpen Wrangler supports compatibility evidence while հայերեն remains unrelated prose.\n`
    }),
    []
  );
});

test("decoded sigma and lowercase Cherokee product confusables are independently rejected", () => {
  for (const productName of [
    "&#x3A3;ursor",
    "&#x3C2;ursor",
    "&#x3C3;ursor",
    "ꮯursor",
    "Cursꭴr",
    "Cuꭱsor",
    "Cꮜrsor",
    "Curꮪor"
  ]) {
    assert.match(
      inspect({
        ciDocumentationSource: `${sources.ciDocumentationSource}\n${productName} guarantees released-Jupyter.\n`
      }).join(" "),
      /exact canonical case|compatibility-sensitive Cursor ownership/u,
      productName
    );
  }
});

test("authority and guarantee wording remains ownership-sensitive", () => {
  const isolatedClaims = [
    "Cursor is the authority for released-Jupyter.",
    "Cursor guarantees released-Jupyter.",
    "Cursor governs released-Jupyter.",
    "Cursor controls released-Jupyter.",
    "Cursor is in charge of released-Jupyter.",
    "Cursor is accountable for released-Jupyter.",
    "Cursor warrants released-Jupyter.",
    "Cursor assures released-Jupyter.",
    "Cursor manages released-Jupyter.",
    "Cursor govεrns released-Jupyter.",
    "Cursor gοverns released-Jupyter.",
    "Cursor cοntrols released-Jupyter.",
    "Cursor is in chargе of released-Jupyter.",
    "Cursor is accοuntable for released-Jupyter.",
    "Cursor wаrrants released-Jupyter.",
    "Cursor assυres released-Jupyter."
  ];
  for (const outsideClaim of isolatedClaims) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership/u,
      outsideClaim
    );
  }
  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\ncursor govεrns the release matrix.\n`
    }).join(" "),
    /exact canonical case/u
  );
  assert.deepEqual(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nOpen Wrangler documents the Greek words μέγεθος and ελευθερία as unrelated prose.\n`
    }),
    []
  );
});

test("bounded ownership grammar recognizes modifiers, quantifiers, passive voice, and future forms", () => {
  for (const outsideClaim of [
    "Cursor will actively manage every released-Jupyter lane.",
    "Cursor routinely manages all protected released-Jupyter lanes.",
    "Every released-Jupyter lane will be managed by Cursor.",
    "Native R qualification would remain under Cursor's authority."
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership/u,
      outsideClaim
    );
  }

  for (const neutralClaim of [
    "Cursor precedes released-Jupyter in this document.",
    "Cursor does not manage released-Jupyter qualification.",
    "Cursor provides no Native R qualification evidence."
  ]) {
    assert.deepEqual(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${neutralClaim}\n` }),
      [],
      neutralClaim
    );
  }
});

test("ownership grammar binds product, relation, target, and negation to one clause", () => {
  for (const outsideClaim of [
    "Cursor is the owner of released-Jupyter qualification.",
    "Responsibility for Native R qualification belongs to Cursor.",
    "Native R qualification would remain under Cursor's authority.",
    "Cursor does not document previews but owns released-Jupyter.",
    "Cursor does not manage platform smoke but owns Native R.",
    "Cursor owns Native R, not VS Code.",
    `Cursor owns ${"explicit bounded evidence ".repeat(20)}released-Jupyter.`
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership/u,
      outsideClaim
    );
  }

  for (const neutralClaim of [
    "VS Code owns released-Jupyter, but Cursor documents platform smoke.",
    "Cursor documents platform smoke, while VS Code owns released-Jupyter.",
    "Cursor provides platform-smoke evidence, while VS Code owns Native R.",
    "Cursor provides platform smoke and VS Code documents Native R.",
    "Cursor supports platform smoke and does not certify Native R.",
    "Cursor supports platform smoke, does not certify Native R.",
    "Cursor does not own Native R qualification.",
    "Cursor provides no Native R qualification evidence."
  ]) {
    assert.deepEqual(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${neutralClaim}\n` }),
      [],
      neutralClaim
    );
  }
});

test("invalid Markdown brackets preserve visible ownership text within bounded work", () => {
  for (const outsideClaim of [
    "[broken Cursor owns released-Jupyter.",
    "[[[[[[[[[broken Cursor owns released-Jupyter.",
    "prefix [unclosed label before Cursor owns Native R."
  ]) {
    assert.match(
      inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${outsideClaim}\n` }).join(" "),
      /compatibility-sensitive Cursor ownership/u,
      outsideClaim
    );
  }

  const boundedClauses = `Cursor owns released-Jupyter ${"but ordinary prose ".repeat(257)}`;
  const started = performance.now();
  const problems = inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${boundedClauses}.\n` });
  assert.ok(performance.now() - started < 2_000, "ownership clause parsing must remain bounded");
  assert.match(problems.join(" "), /supported structural bounds/u);
});

test("headings and thematic breaks reset paragraph state before indented code", () => {
  for (const block of [
    "# Compatibility evidence\n    Cursor owns released-Jupyter.",
    "Compatibility evidence\n---\n    Cursor owns released-Jupyter.",
    "Compatibility evidence\n===\n    Cursor owns released-Jupyter.",
    "***\n    Cursor owns released-Jupyter."
  ]) {
    assert.deepEqual(inspect({ ciDocumentationSource: `${sources.ciDocumentationSource}\n${block}\n` }), [], block);
  }

  assert.match(
    inspect({
      ciDocumentationSource: `${sources.ciDocumentationSource}\nA visible paragraph\n    Cursor owns released-Jupyter.\n`
    }).join(" "),
    /compatibility-sensitive Cursor ownership/u
  );
});

test("visible HTML tag inspection rejects before retaining tag 4,097", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=96",
      "--input-type=module",
      "--eval",
      String.raw`
        import { readFileSync } from "node:fs";
        import { inspectCompatibilityEvidence } from "./scripts/compatibility-evidence.mjs";
        const read = (path) => readFileSync(path, "utf8");
        const inputs = {
          authoritySource: read("fixtures/compatibility-evidence.json"),
          packageSource: read("package.json"),
          remoteWorkspaceContractSource: read("scripts/remote-workspace-contract.mjs"),
          cursorAcquisitionSource: read("scripts/cursor-acquisition.mjs"),
          candidateWorkflowSource: read(".github/workflows/candidate-acceptance.yml"),
          ciWorkflowSource: read(".github/workflows/ci.yml"),
          crossWorkflowSource: read(".github/workflows/cross-platform.yml"),
          readmeSource: read("README.md"),
          releasingSource: read("docs/releasing.md"),
          architectureSource: read("docs/architecture.md"),
          featureParitySource: read("docs/feature-parity.md"),
          testingSource: read("docs/testing.md"),
          ciDocumentationSource: "<span></span>".repeat(Math.floor(3_500_000 / 13))
        };
        const problems = inspectCompatibilityEvidence(inputs);
        if (!problems.some((problem) => problem.includes("too many HTML tags"))) process.exit(2);
      `
    ],
    { cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 }
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("Native R source and installed-artifact ownership are independently exact", () => {
  const wrongArchitectureOwnership = sources.architectureSource.replace(
    "Enabled scheduled/manual Cross owns the direct R 4.4 source qualification, while protected pull-request CI's required `validate` fan-in owns the direct R 4.5 source contracts.",
    "Protected pull-request CI solely owns the direct R 4.4/4.5 contract."
  );
  assert.match(
    inspect({ architectureSource: wrongArchitectureOwnership }).join(" "),
    /Native R source ownership|direct R 4\.4/u
  );
  assert.match(
    inspect({
      crossWorkflowSource: sources.crossWorkflowSource.replace('r-version: "4.4"', 'r-version: "4.5"')
    }).join(" "),
    /Native R source ownership/u
  );
  assert.match(
    inspect({ candidateWorkflowSource: sources.candidateWorkflowSource.replace('r: "4.4.3"', 'r: "4.5.2"') }).join(" "),
    /installed-artifact matrix|Native R platform owner/u
  );
  assert.match(
    inspect({
      crossWorkflowSource: sources.crossWorkflowSource.replace("    if: ${{ !cancelled() }}", "    if: false")
    }).join(" "),
    /enabled owners/u
  );
  assert.match(
    inspect({
      crossWorkflowSource: sources.crossWorkflowSource.replace(
        "      - run: npm run test:r-contract\n",
        '      - run: "true"\n'
      )
    }).join(" "),
    /enabled owners/u
  );
  assert.match(
    inspect({
      ciWorkflowSource: sources.ciWorkflowSource.replace(
        "      - r-contract-kernel\n      - r-contract-protocol",
        "      - r-contract-protocol"
      )
    }).join(" "),
    /required CI success fan-in/u
  );

  for (const ciWorkflowSource of [
    sources.ciWorkflowSource.replace(
      "      - run: npm run test:r-contract -- --shard kernel-agent\n",
      "      - continue-on-error: true\n        run: npm run test:r-contract -- --shard kernel-agent\n"
    ),
    sources.ciWorkflowSource.replace(
      "      - name: Run both independent protocol shards fail-complete\n        run: npm run test:r-contract:protocol",
      "      - name: Run both independent protocol shards fail-complete\n        continue-on-error: true\n        run: npm run test:r-contract:protocol"
    ),
    sources.ciWorkflowSource.replace(
      "      - name: Require every owned CI result\n        run: node scripts/require-ci-results.mjs",
      "      - name: Require every owned CI result\n        continue-on-error: true\n        run: node scripts/require-ci-results.mjs"
    )
  ]) {
    assert.match(inspect({ ciWorkflowSource }).join(" "), /enabled owners|required CI success fan-in/u);
  }

  for (const crossWorkflowSource of [
    sources.crossWorkflowSource.replace("  workflow_dispatch:\n", ""),
    sources.crossWorkflowSource.replace('  schedule:\n    - cron: "17 4 * * 1"\n', ""),
    sources.crossWorkflowSource.replace(
      "      - run: npm run test:r-contract\n",
      "      - continue-on-error: true\n        run: npm run test:r-contract\n"
    )
  ]) {
    assert.match(inspect({ crossWorkflowSource }).join(" "), /enabled owners|required CI success fan-in/u);
  }
});

test("the compatibility authority does not couple PR 802 operation-catalog prose", () => {
  assert.deepEqual(
    inspect({
      architectureSource: sources.architectureSource.replace(
        "exact ordered 32 operations",
        "exact ordered thirty-two operations"
      )
    }),
    []
  );
});

test("public claims assign Cursor only its exact Linux compatibility seam", () => {
  assert.doesNotMatch(sources.architectureSource, /macOS\/Windows VS Code\/Cursor/u);
  assert.doesNotMatch(sources.architectureSource, /runs both in VS Code and Cursor/u);
  assert.doesNotMatch(sources.ciDocumentationSource, /local R runs in VS Code\s+and Cursor/u);
  assert.doesNotMatch(sources.ciDocumentationSource, /installed performance in pinned VS Code and Cursor/u);
  assert.doesNotMatch(sources.ciDocumentationSource, /Linux executes those selectors in\s+VS Code and Cursor/u);
});

test("near-cap duplicate workflow jobs fail semantically with bounded diagnostics", () => {
  const duplicateJob = "  repeated_lane:\n    runs-on: ubuntu-24.04\n";
  const targetBytes = 1_900_000;
  const repeats = Math.floor(
    (targetBytes - Buffer.byteLength(sources.candidateWorkflowSource, "utf8")) / Buffer.byteLength(duplicateJob, "utf8")
  );
  const diagnostics = inspect({
    candidateWorkflowSource: `${sources.candidateWorkflowSource}${duplicateJob.repeat(repeats)}`
  });
  assert.ok(diagnostics.length <= 64, `retained ${diagnostics.length} diagnostics`);
  assert.ok(Buffer.byteLength(diagnostics.join("\n"), "utf8") <= 16 * 1024);
  assert.match(diagnostics.join(" "), /valid semantic YAML/u);
});

test("malformed or missing CI and Cross workflow structure returns bounded diagnostics", () => {
  for (const changes of [
    { ciWorkflowSource: "jobs: [" },
    { ciWorkflowSource: "{}\n" },
    { crossWorkflowSource: "jobs: [" },
    { crossWorkflowSource: "{}\n" }
  ]) {
    assert.doesNotThrow(() => {
      const diagnostics = inspect(changes);
      assert.ok(diagnostics.length <= 64);
      assert.ok(Buffer.byteLength(diagnostics.join("\n"), "utf8") <= 16 * 1024);
      assert.match(diagnostics.join(" "), /valid semantic YAML|bounded jobs mapping/u);
    });
  }
});

test("workflow ownership and Native R release seams fail closed on drift", () => {
  assert.match(
    inspect(changedAuthority((candidate) => candidate.editors[0].workflowOwners.splice(0))).join(" "),
    /workflow owner/u
  );
  assert.match(
    inspect(changedAuthority((candidate) => candidate.editors[0].workflowOwners.reverse())).join(" "),
    /complete, unique, and ordered/u
  );
  assert.match(
    inspect(changedAuthority((candidate) => (candidate.editors[0].tier = "smoke-tested"))).join(" "),
    /rendered version, platform, tier, or support fields are unpinned/u
  );
  assert.match(
    inspect({ candidateWorkflowSource: sources.candidateWorkflowSource.replace('r: "4.4.3"', 'r: "4.4.2"') }).join(" "),
    /Native R platform owner/u
  );
  assert.match(
    inspect({
      candidateWorkflowSource: sources.candidateWorkflowSource.replace("  r_local:\n", "  retired_r_local:\n")
    }).join(" "),
    /workflow owner/u
  );
  assert.match(
    inspect(changedAuthority((candidate) => (candidate.nativeR.promotionIssue = "https://example.com/87"))).join(" "),
    /issue #87/u
  );
});

test("every generated public compatibility block rejects stale or duplicate claims", () => {
  for (const [key, marker, expected] of [
    ["readmeSource", "pinned performance `1.130.0`; moving stable candidate lanes", /README\.md/u],
    ["releasingSource", "Antigravity 1.107.0 Linux x64", /docs\/releasing\.md/u],
    ["architectureSource", "candidate-acceptance.yml#platform", /docs\/architecture\.md/u],
    ["featureParitySource", "Antigravity 1.107.0 Linux x64", /docs\/feature-parity\.md/u]
  ]) {
    assert.match(inspect({ [key]: sources[key].replace(marker, `${marker}-stale`) }).join(" "), expected);
  }
  const block = sources.readmeSource.match(
    /<!-- open-wrangler-compatibility-evidence:start -->[\s\S]*?<!-- open-wrangler-compatibility-evidence:end -->/u
  )?.[0];
  assert.match(inspect({ readmeSource: `${sources.readmeSource}\n${block}` }).join(" "), /README\.md/u);
});

test("strict JSON rejects duplicate authority members", () => {
  assert.match(
    inspect({
      authoritySource: sources.authoritySource.replace('"schemaVersion": 3,', '"schemaVersion": 3, "schemaVersion": 3,')
    }).join(" "),
    /strict JSON/u
  );
});
