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
  featureParitySource: read("docs/feature-parity.md")
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
    /platforms are unsupported/u
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
    /tier, or support status is unsupported/u
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
    ["releasingSource", "API-compatible", /docs\/releasing\.md/u],
    ["architectureSource", "candidate-acceptance.yml#platform", /docs\/architecture\.md/u],
    ["featureParitySource", "Native R 4.4.3 and 4.5.2", /docs\/feature-parity\.md/u]
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
      authoritySource: sources.authoritySource.replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,')
    }).join(" "),
    /strict JSON/u
  );
});
