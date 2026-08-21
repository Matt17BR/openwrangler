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
  readmeSource: read("README.md"),
  releasingSource: read("docs/releasing.md"),
  architectureSource: read("docs/architecture.md"),
  featureParitySource: read("docs/feature-parity.md"),
  testingSource: read("docs/testing.md")
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

test("the exact Antigravity smoke stays separate and bound to its immutable record", () => {
  assert.match(
    inspect(changedAuthority((candidate) => (candidate.forkSmokes[0].editorVersion = "1.108.0"))).join(" "),
    /exact separate historical record/u
  );
  assert.match(
    inspect({ testingSource: sources.testingSource.replace("Open Wrangler 1.2.0", "Open Wrangler 1.2.1") }).join(" "),
    /Antigravity smoke owner/u
  );
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
    ["readmeSource", "pinned release target `1.130.0`", /README\.md/u],
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
      authoritySource: sources.authoritySource.replace('"schemaVersion": 2,', '"schemaVersion": 2, "schemaVersion": 2,')
    }).join(" "),
    /strict JSON/u
  );
});
