import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertNoRawReleaseCutoverVersions,
  assertReleaseCutoverConsumerInventory,
  assertReleaseCutoverDocumentationCurrent,
  checkReleaseCutoverRepository,
  parseReleaseCutoverManifest,
  readReleaseCutoverUtf8File,
  releaseCutover,
  releaseCutoverApplies,
  RELEASE_CUTOVER_BOUNDARY_TEST_PATHS,
  RELEASE_CUTOVER_MANIFEST,
  releaseCutoverConsumerPaths,
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
        consumers: [
          ".github/workflows/open-vsx-promotion.yml",
          "docs/media-spec-v1.2.md",
          "docs/releasing.md",
          "docs/testing.md",
          "scripts/open-vsx-promotion-workflow.mjs",
          "scripts/open-vsx-promotion-workflow.test.mjs",
          "scripts/public-media-surface-contract.mjs",
          "scripts/public-media-surfaces.test.mjs",
          "scripts/verify-public-media-surfaces.mjs"
        ],
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
        consumers: [
          ".github/workflows/open-vsx-promotion.yml",
          "azure-pipelines-marketplace.yml",
          "docs/media-spec-v1.2.md",
          "docs/releasing.md",
          "docs/testing.md",
          "scripts/marketplace-promotion-workflow.mjs",
          "scripts/marketplace-promotion-workflow.test.mjs",
          "scripts/open-vsx-promotion-workflow.mjs",
          "scripts/open-vsx-promotion-workflow.test.mjs",
          "scripts/public-media-surface-contract.mjs",
          "scripts/public-media-surfaces.test.mjs"
        ],
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
  assert.equal(Object.isFrozen(RELEASE_CUTOVER_MANIFEST.cutovers[0].consumers), true);
  assert.equal(releaseCutover("public-media-prepublication").firstApplicableVersion, "1.99.4");
  assert.throws(() => releaseCutover("missing-cutover"), /Unknown release cutover/u);
});

test("every release cutover is exact immediately before, at, and after its boundary", () => {
  assert.equal(releaseCutoverApplies("public-media-render-verification", "1.2.0"), false);
  assert.equal(releaseCutoverApplies("public-media-render-verification", "1.2.1-preview.1"), false);
  assert.equal(releaseCutoverApplies("public-media-render-verification", "1.2.1-0+build.1"), false);
  assert.equal(releaseCutoverApplies("public-media-render-verification", "1.2.1"), true);
  assert.equal(releaseCutoverApplies("public-media-render-verification", "1.2.1+build.1"), true);
  assert.equal(releaseCutoverApplies("public-media-render-verification", "1.2.2-preview.1"), true);
  assert.equal(releaseCutoverApplies("public-media-render-verification", "2.0.0"), true);
  assert.equal(releaseCutoverApplies("public-media-prepublication", "1.99.3"), false);
  assert.equal(releaseCutoverApplies("public-media-prepublication", "1.99.4-preview.1"), false);
  assert.equal(releaseCutoverApplies("public-media-prepublication", "1.99.4"), true);
  assert.equal(releaseCutoverApplies("public-media-prepublication", "1.99.4+recovery.1"), true);
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
    changedManifest((value) => (value.cutovers[0].consumers = [])),
    changedManifest((value) => (value.cutovers[0].consumers = [...value.cutovers[0].consumers].reverse())),
    changedManifest((value) => value.cutovers[0].consumers.push(value.cutovers[0].consumers[0])),
    changedManifest((value) => (value.cutovers[0].consumers[0] = "../outside.md")),
    changedManifest(
      (value) =>
        (value.cutovers[0].consumers = Array.from({ length: 17 }, (_, index) => `scripts/consumer-${index}.mjs`))
    ),
    changedManifest((value) => (value.cutovers[0].rationale = "first line\nsecond line")),
    ...[
      "Cafe\u0301",
      "private \uE000",
      "surrogate \uD800",
      "hidden \u200B",
      "bidi \u202E",
      "*Markdown*",
      "{Markdown}",
      "<html>",
      "entity &copy;"
    ].map((unsafe) => changedManifest((value) => (value.cutovers[0].rationale = unsafe))),
    changedManifest((value) => delete value.cutovers[0].recoveryBehavior),
    changedManifest((value) => (value.cutovers[0].unexpected = true))
  ];
  for (const candidate of cases) assert.throws(() => validateReleaseCutoverManifest(candidate));
  assert.throws(() => parseReleaseCutoverManifest('{"schemaVersion":1,"schemaVersion":1,"cutovers":[]}'));
  assert.throws(() => parseReleaseCutoverManifest("{"));
});

test("the manifest consumer inventory is complete and every consumer names its cutover", () => {
  const paths = releaseCutoverConsumerPaths();
  const sources = new Map(paths.map((path) => [path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8")]));
  assert.doesNotThrow(() => assertReleaseCutoverConsumerInventory(sources));

  const missing = new Map(sources);
  missing.delete(paths[0]);
  assert.throws(() => assertReleaseCutoverConsumerInventory(missing), /exactly match the manifest inventory/u);

  const drifted = new Map(sources);
  const workflowPath = ".github/workflows/open-vsx-promotion.yml";
  drifted.set(
    workflowPath,
    drifted.get(workflowPath).replace("public-media-render-verification", "missing-render-cutover")
  );
  assert.throws(
    () => assertReleaseCutoverConsumerInventory(drifted),
    /must consume release cutover public-media-render-verification/u
  );
});

test("release-cutover file reads are bounded, fatal UTF-8, and identity stable", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-cutovers-"));
  context.after(() => rmSync(root, { recursive: true }));

  const validPath = join(root, "valid.json");
  writeFileSync(validPath, '{"value":"ok"}\n');
  assert.equal(
    readReleaseCutoverUtf8File(validPath, 64, { containedBy: root, label: "Test cutover" }),
    '{"value":"ok"}\n'
  );
  assert.throws(
    () => readReleaseCutoverUtf8File(validPath, 4, { containedBy: root, label: "Test cutover" }),
    /stable file identity/u
  );

  const invalidPath = join(root, "invalid.json");
  writeFileSync(invalidPath, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
  assert.throws(
    () => readReleaseCutoverUtf8File(invalidPath, 64, { containedBy: root, label: "Invalid cutover" }),
    /valid UTF-8/u
  );

  const replacedPath = join(root, "replaced.json");
  const originalPath = join(root, "original.json");
  writeFileSync(replacedPath, '{"value":"same"}\n');
  assert.throws(
    () =>
      readReleaseCutoverUtf8File(replacedPath, 64, {
        containedBy: root,
        label: "Replaced cutover",
        afterOpenForTest: () => {
          renameSync(replacedPath, originalPath);
          writeFileSync(replacedPath, '{"value":"same"}\n');
        }
      }),
    /stable file identity/u
  );
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
  assert.deepEqual(checkReleaseCutoverRepository(), { cutovers: 2, checkedPaths: 13 });
});
