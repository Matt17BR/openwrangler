import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertNoRawReleaseCutoverVersions,
  assertReleaseCutoverDocumentationCurrent,
  checkReleaseCutoverRepository,
  parseReleaseCutoverManifest,
  releaseCutover,
  releaseCutoverApplies,
  RELEASE_CUTOVER_BOUNDARY_TEST_PATHS,
  RELEASE_CUTOVER_MANIFEST,
  renderReleaseCutoverDocumentation,
  renderReleaseCutoverManifest,
  replaceReleaseCutoverDocumentation,
  validateReleaseCutoverManifest
} from "./release-cutovers.mjs";

const manifest = JSON.parse(JSON.stringify(RELEASE_CUTOVER_MANIFEST));

function changedManifest(change) {
  const candidate = JSON.parse(JSON.stringify(manifest));
  change(candidate);
  return candidate;
}

test("the release-cutover manifest owns the complete public-media boundary contract", () => {
  assert.deepEqual(RELEASE_CUTOVER_MANIFEST, {
    schemaVersion: 1,
    cutovers: [
      {
        id: "public-media-render-verification",
        affectedCapability: "rendered public-media verification for immutable release README assets",
        firstApplicableVersion: "1.2.1",
        rationale:
          "This was the first release whose exact source carried the reviewed public-media inventory and remote rendering contract.",
        recoveryBehavior:
          "Earlier exact tags skip browser installation and rendered public-media verification; recovery uses each tag's own files and never imports the current inventory or package requirements.",
        executableOwner: "scripts/public-media-surface-contract.mjs"
      },
      {
        id: "public-media-prepublication",
        affectedCapability: "browser-free public-media verification before registry authentication",
        firstApplicableVersion: "1.99.4",
        rationale:
          "This was the first release whose exact source and lockfile carried the browser-free prepublication verifier used by recovery promotion.",
        recoveryBehavior:
          "Earlier exact tags retain their historical recovery behavior; this version and later run the verifier from the exact release checkout without applying current package requirements retroactively.",
        executableOwner: "scripts/public-media-surface-contract.mjs"
      }
    ]
  });
  assert.equal(Object.isFrozen(RELEASE_CUTOVER_MANIFEST), true);
  assert.equal(Object.isFrozen(RELEASE_CUTOVER_MANIFEST.cutovers), true);
  assert.equal(Object.isFrozen(RELEASE_CUTOVER_MANIFEST.cutovers[0]), true);
  assert.equal(releaseCutover("public-media-prepublication").firstApplicableVersion, "1.99.4");
  assert.throws(() => releaseCutover("missing-cutover"), /Unknown release cutover/u);
});

test("every release cutover is exact immediately before, at, and after its boundary", () => {
  assert.equal(releaseCutoverApplies("public-media-render-verification", "1.2.0"), false);
  assert.equal(releaseCutoverApplies("public-media-render-verification", "1.2.1"), true);
  assert.equal(releaseCutoverApplies("public-media-render-verification", "2.0.0"), true);
  assert.equal(releaseCutoverApplies("public-media-prepublication", "1.99.3"), false);
  assert.equal(releaseCutoverApplies("public-media-prepublication", "1.99.4"), true);
  assert.equal(releaseCutoverApplies("public-media-prepublication", "2.0.0"), true);
  for (const invalid of ["v1.2.1", "01.2.1", "1.2", "not-a-version", ""]) {
    assert.throws(() => releaseCutoverApplies("public-media-render-verification", invalid), /must be semantic/u);
  }
});

test("malformed release-cutover manifests fail closed", () => {
  const cases = [
    changedManifest((value) => (value.schemaVersion = 2)),
    changedManifest((value) => value.cutovers.push({ ...value.cutovers[0] })),
    changedManifest((value) => (value.cutovers[1].id = value.cutovers[0].id)),
    changedManifest((value) => (value.cutovers[1].firstApplicableVersion = value.cutovers[0].firstApplicableVersion)),
    changedManifest((value) => (value.cutovers[0].firstApplicableVersion = "1.2.1-preview.1")),
    changedManifest((value) => (value.cutovers[0].executableOwner = "../outside.mjs")),
    changedManifest((value) => (value.cutovers[0].rationale = "first line\nsecond line")),
    changedManifest((value) => delete value.cutovers[0].recoveryBehavior),
    changedManifest((value) => (value.cutovers[0].unexpected = true))
  ];
  for (const candidate of cases) assert.throws(() => validateReleaseCutoverManifest(candidate));
  assert.throws(() => parseReleaseCutoverManifest('{"schemaVersion":1,"schemaVersion":1,"cutovers":[]}'));
  assert.throws(() => parseReleaseCutoverManifest("{"));
});

test("raw cutover versions are allowed only in the two explicit boundary-test owners", () => {
  assert.deepEqual(RELEASE_CUTOVER_BOUNDARY_TEST_PATHS, [
    "scripts/public-media-surfaces.test.mjs",
    "scripts/release-cutovers.test.mjs"
  ]);
  assert.doesNotThrow(() =>
    assertNoRawReleaseCutoverVersions(
      new Map([
        ["scripts/public-media-surfaces.test.mjs", 'test("1.2.1 and 1.99.4", () => {});'],
        ["scripts/release-cutovers.test.mjs", 'const versions = ["1.2.1", "1.99.4"];']
      ])
    )
  );
  assert.throws(
    () =>
      assertNoRawReleaseCutoverVersions(
        new Map([["scripts/duplicate-cutover.mjs", 'const first = "1.2.1"; const second = "1.2.1";']])
      ),
    /duplicates raw release cutover public-media-render-verification/u
  );
  assert.throws(
    () => assertNoRawReleaseCutoverVersions(new Map([["scripts/not-allowlisted.test.mjs", 'test("1.99.4")']])),
    /duplicates raw release cutover public-media-prepublication/u
  );
  assert.throws(
    () =>
      assertNoRawReleaseCutoverVersions(new Map(), RELEASE_CUTOVER_MANIFEST, [
        ...RELEASE_CUTOVER_BOUNDARY_TEST_PATHS,
        "scripts/not-allowlisted.test.mjs"
      ]),
    /allowlist drifted/u
  );
});

test("the manifest and generated historical recovery documentation are current", () => {
  const manifestSource = readFileSync(new URL("../fixtures/release-cutovers.v1.json", import.meta.url), "utf8");
  const documentation = readFileSync(new URL("../docs/releasing.md", import.meta.url), "utf8");
  assert.equal(manifestSource, renderReleaseCutoverManifest(RELEASE_CUTOVER_MANIFEST));
  assert.doesNotThrow(() => assertReleaseCutoverDocumentationCurrent(documentation));
  assert.equal(replaceReleaseCutoverDocumentation(documentation), documentation);
  assert.match(renderReleaseCutoverDocumentation(), /never imports the current inventory or package requirements/u);
  assert.deepEqual(checkReleaseCutoverRepository(), { cutovers: 2, checkedPaths: 4 });
});
