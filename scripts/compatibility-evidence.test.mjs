import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  assert.match(inspect({ candidateWorkflowSource: pinnedPlatform }).join(" "), /moving stable candidate lane/u);
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
  assert.match(
    inspect({ candidateWorkflowSource: quotedCommandOverride }).join(" "),
    /unsupported command-level editor-version reference/u
  );

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
      /Cursor may not own/u
    );
  }
});

test("Native R source and installed-artifact ownership are independently exact", () => {
  const wrongArchitectureOwnership = sources.architectureSource.replace(
    "Scheduled/manual Cross owns the direct R 4.4 source qualification, while protected pull-request CI owns the direct R 4.5 source contracts.",
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
