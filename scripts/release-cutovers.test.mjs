import assert from "node:assert/strict";
import {
  closeSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertNoRawReleaseCutoverVersions,
  assertReleaseCutoverConsumerInventory,
  assertReleaseCutoverDocumentationCurrent,
  assertReleaseCutoverTestInventory,
  checkReleaseCutoverRepository,
  discoverReleaseCutoverConsumers,
  parseReleaseCutoverManifest,
  readReleaseCutoverUtf8File,
  readStableReleaseCutoverSources,
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
    consumerInventory: [
      {
        path: ".github/workflows/open-vsx-promotion.yml",
        cutoverIds: ["public-media-prepublication", "public-media-render-verification"]
      },
      { path: "azure-pipelines-marketplace.yml", cutoverIds: ["public-media-prepublication"] },
      {
        path: "docs/media-spec-v1.2.md",
        cutoverIds: ["public-media-prepublication", "public-media-render-verification"]
      },
      {
        path: "docs/releasing.md",
        cutoverIds: ["public-media-prepublication", "public-media-render-verification"]
      },
      {
        path: "docs/testing.md",
        cutoverIds: ["public-media-prepublication", "public-media-render-verification"]
      },
      { path: "scripts/marketplace-promotion-workflow.mjs", cutoverIds: ["public-media-prepublication"] },
      { path: "scripts/marketplace-promotion-workflow.test.mjs", cutoverIds: ["public-media-prepublication"] },
      {
        path: "scripts/open-vsx-promotion-workflow.mjs",
        cutoverIds: ["public-media-prepublication", "public-media-render-verification"]
      },
      {
        path: "scripts/open-vsx-promotion-workflow.test.mjs",
        cutoverIds: ["public-media-prepublication", "public-media-render-verification"]
      },
      {
        path: "scripts/public-media-surface-contract.mjs",
        cutoverIds: ["public-media-prepublication", "public-media-render-verification"]
      },
      {
        path: "scripts/public-media-surfaces.test.mjs",
        cutoverIds: ["public-media-prepublication", "public-media-render-verification"]
      },
      { path: "scripts/verify-public-media-surfaces.mjs", cutoverIds: ["public-media-render-verification"] }
    ],
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
  assert.equal(Object.isFrozen(RELEASE_CUTOVER_MANIFEST.consumerInventory), true);
  assert.equal(Object.isFrozen(RELEASE_CUTOVER_MANIFEST.consumerInventory[0]), true);
  assert.equal(Object.isFrozen(RELEASE_CUTOVER_MANIFEST.consumerInventory[0].cutoverIds), true);
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

  const exactLargeVersion = changedManifest((value) => {
    value.cutovers[0].firstApplicableVersion = "9007199254740993.0.0";
  });
  assert.equal(
    releaseCutoverApplies("public-media-render-verification", "9007199254740992.999.999", exactLargeVersion),
    false
  );
  assert.equal(
    releaseCutoverApplies("public-media-render-verification", "9007199254740993.0.0-rc.1", exactLargeVersion),
    false
  );
  assert.equal(
    releaseCutoverApplies("public-media-render-verification", "9007199254740993.0.0", exactLargeVersion),
    true
  );
  assert.equal(
    releaseCutoverApplies("public-media-render-verification", "9007199254740994.0.0-rc.1", exactLargeVersion),
    true
  );
  assert.throws(
    () => releaseCutoverApplies("public-media-render-verification", `${"9".repeat(129)}.0.0`, exactLargeVersion),
    /oversized numeric component/u
  );
});

test("malformed release-cutover manifests fail closed", () => {
  const aliasManifest = (alias) =>
    changedManifest((value) => {
      for (const cutover of value.cutovers) {
        cutover.consumers = cutover.consumers.map((path) => (path === "docs/testing.md" ? alias : path)).sort();
      }
      value.consumerInventory = value.consumerInventory
        .map((consumer) => ({
          ...consumer,
          path: consumer.path === "docs/testing.md" ? alias : consumer.path
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
    });
  const cases = [
    changedManifest((value) => (value.schemaVersion = 2)),
    changedManifest((value) => value.cutovers.push({ ...value.cutovers[0] })),
    changedManifest((value) => (value.cutovers[1].id = value.cutovers[0].id)),
    changedManifest((value) => (value.cutovers[1].firstApplicableVersion = value.cutovers[0].firstApplicableVersion)),
    changedManifest((value) => (value.cutovers[0].firstApplicableVersion = "1.2.1-preview.1")),
    changedManifest((value) => (value.cutovers[0].firstApplicableVersion = `${"9".repeat(129)}.0.0`)),
    changedManifest((value) => (value.cutovers[0].executableOwner = "../outside.mjs")),
    changedManifest((value) => (value.cutovers[0].consumers = [])),
    changedManifest((value) => (value.cutovers[0].consumers = [...value.cutovers[0].consumers].reverse())),
    changedManifest((value) => value.cutovers[0].consumers.push(value.cutovers[0].consumers[0])),
    changedManifest((value) => (value.cutovers[0].consumers[0] = "../outside.md")),
    aliasManifest("docs/./testing.md"),
    aliasManifest("docs/a/../testing.md"),
    aliasManifest("docs//testing.md"),
    aliasManifest("docs\\testing.md"),
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
    changedManifest((value) => (value.cutovers[0].unexpected = true)),
    changedManifest((value) => value.consumerInventory.pop()),
    changedManifest((value) => value.consumerInventory.push({ ...value.consumerInventory[0] })),
    changedManifest((value) => value.consumerInventory.reverse()),
    changedManifest((value) => (value.consumerInventory[0].cutoverIds = ["missing-cutover"])),
    changedManifest((value) => (value.consumerInventory[0].unexpected = true))
  ];
  for (const candidate of cases) assert.throws(() => validateReleaseCutoverManifest(candidate));
  assert.throws(() => parseReleaseCutoverManifest('{"schemaVersion":1,"schemaVersion":1,"cutovers":[]}'));
  assert.throws(() => parseReleaseCutoverManifest("{"));
});

test("the manifest consumer inventory is complete and every consumer names its cutover", () => {
  const paths = releaseCutoverConsumerPaths();
  const sources = new Map(paths.map((path) => [path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8")]));
  assert.doesNotThrow(() => assertReleaseCutoverConsumerInventory(sources));
  assert.doesNotThrow(() => assertReleaseCutoverConsumerInventory(new Map([...sources].reverse())));

  const missing = new Map(sources);
  missing.delete(paths[0]);
  assert.throws(() => assertReleaseCutoverConsumerInventory(missing), /exactly match the independent inventory/u);

  const drifted = new Map(sources);
  const workflowPath = ".github/workflows/open-vsx-promotion.yml";
  drifted.set(
    workflowPath,
    drifted.get(workflowPath).replace("public-media-render-verification", "missing-render-cutover")
  );
  assert.throws(() => assertReleaseCutoverConsumerInventory(drifted), /exactly match the independent inventory/u);

  const decorativeOnly = new Map(sources);
  decorativeOnly.set(
    workflowPath,
    '# releaseCutoverVersion("public-media-render-verification")\n# releaseCutoverVersion("public-media-prepublication")\n'
  );
  assert.throws(
    () => assertReleaseCutoverConsumerInventory(decorativeOnly),
    /exactly match the independent inventory/u
  );

  const unlisted = new Map(sources);
  unlisted.set(
    "scripts/unlisted-release-consumer.mjs",
    'import { releaseCutover } from "./release-cutovers.mjs";\nreleaseCutover("public-media-render-verification");\n'
  );
  assert.throws(() => assertReleaseCutoverConsumerInventory(unlisted), /exactly match the independent inventory/u);

  const omittedManifest = changedManifest((value) => {
    for (const cutover of value.cutovers) {
      cutover.consumers = cutover.consumers.filter((path) => path !== "docs/media-spec-v1.2.md");
    }
    value.consumerInventory = value.consumerInventory.filter(({ path }) => path !== "docs/media-spec-v1.2.md");
  });
  assert.doesNotThrow(() => validateReleaseCutoverManifest(omittedManifest));
  assert.throws(
    () => assertReleaseCutoverConsumerInventory(sources, omittedManifest),
    /exactly match the independent inventory/u
  );
  assert.deepEqual([...discoverReleaseCutoverConsumers(sources).keys()], paths);
});

test("JavaScript consumers require a live call through the imported release authority", () => {
  const path = "scripts/example-release-consumer.mjs";
  const discoveredIds = (source) => discoverReleaseCutoverConsumers(new Map([[path, source]])).get(path) ?? [];
  assert.deepEqual(
    discoveredIds(
      'import { releaseCutover } from "./release-cutovers.mjs";\nreleaseCutover("public-media-render-verification");\n'
    ),
    ["public-media-render-verification"]
  );
  assert.deepEqual(
    discoveredIds(
      'import { releaseCutoverVersion as boundary } from "./release-cutovers.mjs";\nboundary("public-media-prepublication");\n'
    ),
    ["public-media-prepublication"]
  );
  assert.deepEqual(discoveredIds("const decoration = 'releaseCutover(\"public-media-render-verification\")';\n"), []);
  assert.deepEqual(
    discoveredIds(
      'import { releaseCutover } from "./release-cutovers.mjs";\nexport function inspect() { return releaseCutover("public-media-render-verification"); }\n'
    ),
    ["public-media-render-verification"]
  );
  assert.deepEqual(
    discoveredIds(
      'import { test } from "node:test";\nimport { releaseCutover } from "./release-cutovers.mjs";\ntest("owner", () => releaseCutover("public-media-render-verification"));\n'
    ),
    ["public-media-render-verification"]
  );
  assert.deepEqual(
    discoveredIds(
      'import { releaseCutover } from "./release-cutovers.mjs";\nfunction inspect() { return releaseCutover("public-media-render-verification"); }\ninspect();\n'
    ),
    ["public-media-render-verification"]
  );
  for (const source of [
    'import { releaseCutover } from "./release-cutovers.mjs";\nfunction inspect(releaseCutover) { releaseCutover("public-media-render-verification"); }\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nif (false) { releaseCutover("public-media-render-verification"); }\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nif (0) { releaseCutover("public-media-render-verification"); }\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nif (null) { releaseCutover("public-media-render-verification"); }\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nwhile (false) { releaseCutover("public-media-render-verification"); }\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nfor (; false; ) { releaseCutover("public-media-render-verification"); }\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nfalse && releaseCutover("public-media-render-verification");\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nfalse ? releaseCutover("public-media-render-verification") : undefined;\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nswitch (1) { case 0: releaseCutover("public-media-render-verification"); break; default: break; }\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nfunction neverCalled() { releaseCutover("public-media-render-verification"); }\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nBoolean(() => releaseCutover("public-media-render-verification"));\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nif (() => releaseCutover("public-media-render-verification")) {}\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nconst test = (_name, _owner) => undefined;\ntest("owner", () => releaseCutover("public-media-render-verification"));\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nexport function inspect() { return; releaseCutover("public-media-render-verification"); }\n',
    'import { releaseCutover as } from "./release-cutovers.mjs";\nreleaseCutover("public-media-render-verification");\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nconst = ; releaseCutover("public-media-render-verification");\n',
    'import { releaseCutover } from "./release-cutovers.mjs";\nreleaseCutover("public-media-render-verification", forgedManifest);\n'
  ]) {
    assert.throws(() => discoveredIds(source), /could not prove its bounded release-cutover semantics/u);
  }
});

test("JavaScript release authority analysis stays bounded and approximately linear", () => {
  const path = "scripts/scaling-release-consumer.mjs";
  const source = (count) =>
    `import { releaseCutover } from "./release-cutovers.mjs";\n${Array.from({ length: count }, () => `releaseCutover("public-media-render-verification");`).join("\n")}\n`;
  const elapsed = (count) => {
    const started = performance.now();
    const discovered = discoverReleaseCutoverConsumers(new Map([[path, source(count)]]));
    assert.deepEqual(discovered.get(path), ["public-media-render-verification"]);
    return performance.now() - started;
  };
  elapsed(256);
  const small = elapsed(6_400);
  const large = elapsed(12_800);
  assert.ok(large < Math.max(2_000, small * 6), `analysis scaled from ${small}ms to ${large}ms`);
});

test("the release-cutover owner runs in the canonical portable package inventory", () => {
  const source = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  assert.doesNotThrow(() => assertReleaseCutoverTestInventory(source));
  const packageJson = JSON.parse(source);
  packageJson.scripts["test:scripts:portable:run"] = packageJson.scripts["test:scripts:portable:run"].replace(
    " scripts/release-cutovers.test.mjs",
    ""
  );
  assert.throws(() => assertReleaseCutoverTestInventory(`${JSON.stringify(packageJson)}\n`), /exactly once/u);
  packageJson.scripts["test:scripts:portable:run"] +=
    " scripts/release-cutovers.test.mjs scripts/release-cutovers.test.mjs";
  assert.throws(() => assertReleaseCutoverTestInventory(`${JSON.stringify(packageJson)}\n`), /exactly once/u);

  for (const command of [
    "echo scripts/release-cutovers.test.mjs",
    "printf '%s\\n' scripts/release-cutovers.test.mjs",
    "node -e 'console.log(\"scripts/release-cutovers.test.mjs\")'",
    "false && node --test scripts/release-cutovers.test.mjs",
    "true || node --test scripts/release-cutovers.test.mjs",
    "exit 0; node --test scripts/release-cutovers.test.mjs"
  ]) {
    packageJson.scripts["test:scripts:portable:run"] = command;
    assert.throws(
      () => assertReleaseCutoverTestInventory(`${JSON.stringify(packageJson)}\n`),
      /exact node --test argument/u
    );
  }
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

test("one repository-root identity owns both bounded source-scan passes", (context) => {
  const parent = mkdtempSync(join(tmpdir(), "ow-release-root-"));
  context.after(() => rmSync(parent, { recursive: true }));
  const root = join(parent, "repository");
  const replacement = join(parent, "replacement");
  const displaced = join(parent, "displaced");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(replacement, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "consumer.mjs"), 'releaseCutover("public-media-render-verification");\n');
  writeFileSync(join(replacement, "scripts", "consumer.mjs"), 'releaseCutover("public-media-prepublication");\n');

  assert.throws(
    () =>
      readStableReleaseCutoverSources(root, ["scripts/consumer.mjs"], {
        betweenPassesForTest: () => {
          renameSync(root, displaced);
          renameSync(replacement, root);
          return () => {
            renameSync(root, replacement);
            renameSync(displaced, root);
          };
        }
      }),
    /repository root changed|repository namespace changed|repository view changed/u
  );
  assert.equal(
    readFileSync(join(root, "scripts", "consumer.mjs"), "utf8"),
    'releaseCutover("public-media-render-verification");\n'
  );
});

test("the complete repository namespace remains bound during file reads", (context) => {
  const parent = mkdtempSync(join(tmpdir(), "ow-release-read-namespace-"));
  context.after(() => rmSync(parent, { recursive: true }));
  const root = join(parent, "repository");
  const replacement = join(parent, "replacement");
  const displaced = join(parent, "displaced");
  for (const directory of [root, replacement]) {
    mkdirSync(join(directory, "scripts"), { recursive: true });
    writeFileSync(join(directory, "scripts", "consumer.mjs"), 'releaseCutover("public-media-render-verification");\n');
  }
  let replaced = false;
  assert.throws(
    () =>
      readStableReleaseCutoverSources(root, ["scripts/consumer.mjs"], {
        afterOpenForTest: () => {
          if (replaced) return;
          replaced = true;
          renameSync(root, displaced);
          renameSync(replacement, root);
          renameSync(root, replacement);
          renameSync(displaced, root);
        }
      }),
    /repository namespace changed/u
  );
  assert.equal(replaced, true);
});

test("every descendant component remains bound across file and directory ABA replacement", (context) => {
  const parent = mkdtempSync(join(tmpdir(), "ow-release-descendant-"));
  context.after(() => rmSync(parent, { recursive: true }));
  const root = join(parent, "repository");
  mkdirSync(join(root, "scripts", "nested"), { recursive: true });
  const source = 'releaseCutover("public-media-render-verification");\n';
  const target = join(root, "scripts", "nested", "consumer.mjs");
  writeFileSync(target, source);
  const assertDescendantFailure = (operation) => {
    let failure;
    try {
      operation();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    const pending = [failure];
    const messages = [];
    while (pending.length > 0) {
      const error = pending.pop();
      messages.push(error.message);
      if (error instanceof AggregateError) pending.push(...error.errors);
      if (error.cause instanceof Error) pending.push(error.cause);
    }
    assert.match(messages.join("\n"), /repository descendant component/u);
  };

  let fileReplaced = false;
  assertDescendantFailure(() =>
    readStableReleaseCutoverSources(root, ["scripts/nested/consumer.mjs"], {
      afterOpenForTest: () => {
        if (fileReplaced) return;
        fileReplaced = true;
        const displaced = `${target}.displaced`;
        renameSync(target, displaced);
        writeFileSync(target, source);
        rmSync(target);
        renameSync(displaced, target);
      }
    })
  );
  assert.equal(fileReplaced, true);

  let directoryReplaced = false;
  assertDescendantFailure(() =>
    readStableReleaseCutoverSources(root, ["scripts/nested/consumer.mjs"], {
      afterOpenForTest: () => {
        if (directoryReplaced) return;
        directoryReplaced = true;
        const nested = join(root, "scripts", "nested");
        const displaced = join(root, "scripts", "nested-displaced");
        renameSync(nested, displaced);
        mkdirSync(nested);
        writeFileSync(join(nested, "consumer.mjs"), source);
        rmSync(nested, { recursive: true });
        renameSync(displaced, nested);
      }
    })
  );
  assert.equal(directoryReplaced, true);
});

test("directory discovery remains bound to the complete repository namespace", (context) => {
  const parent = mkdtempSync(join(tmpdir(), "ow-release-discovery-namespace-"));
  context.after(() => rmSync(parent, { recursive: true }));
  const root = join(parent, "repository");
  const replacement = join(parent, "replacement");
  const displaced = join(parent, "displaced");
  mkdirSync(root);
  for (const path of [".github", "docs", "fixtures", "scripts"]) {
    cpSync(new URL(`../${path}`, import.meta.url), join(root, path), { recursive: true });
  }
  for (const path of ["azure-pipelines-marketplace.yml", "package.json"]) {
    cpSync(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  cpSync(root, replacement, { recursive: true });
  let replaced = false;
  assert.throws(
    () =>
      checkReleaseCutoverRepository({
        root,
        afterDirectoryOpenForTest: () => {
          if (replaced) return;
          replaced = true;
          renameSync(root, displaced);
          renameSync(replacement, root);
          renameSync(root, replacement);
          renameSync(displaced, root);
        }
      }),
    /repository namespace changed/u
  );
  assert.equal(replaced, true);

  let descendantReplaced = false;
  assert.throws(
    () =>
      checkReleaseCutoverRepository({
        root,
        afterDirectoryOpenForTest: ({ path }) => {
          if (descendantReplaced || path !== "scripts") return;
          descendantReplaced = true;
          const nested = join(root, "scripts", "soak");
          const displacedNested = join(root, "scripts", "soak-displaced");
          renameSync(nested, displacedNested);
          mkdirSync(nested);
          rmSync(nested, { recursive: true });
          renameSync(displacedNested, nested);
        }
      }),
    /repository descendant component/u
  );
  assert.equal(descendantReplaced, true);

  const primary = new Error("directory discovery failure");
  let directoryCloses = 0;
  let error;
  try {
    checkReleaseCutoverRepository({
      root,
      afterDirectoryOpenForTest: ({ handle }) => {
        if (directoryCloses > 0) return;
        directoryCloses += 1;
        handle.closeSync();
        throw primary;
      }
    });
  } catch (failure) {
    error = failure;
  }
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[0], primary);
  assert.match(error.errors[1].message, /closed|directory handle/u);
  assert.equal(directoryCloses, 1);
});

test("repository cleanup is exact-once, fail-complete, and primary-first", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-cleanup-"));
  context.after(() => rmSync(root, { recursive: true }));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "consumer.mjs"), 'releaseCutover("public-media-render-verification");\n');
  const primary = new Error("primary scan failure");
  const restoreFailure = new Error("restore failure");
  let restoreCalls = 0;
  let openCalls = 0;
  let error;
  try {
    readStableReleaseCutoverSources(root, ["scripts/consumer.mjs"], {
      afterOpenForTest: () => {
        openCalls += 1;
        if (openCalls === 2) throw primary;
      },
      betweenPassesForTest:
        ({ rootDescriptor }) =>
        () => {
          restoreCalls += 1;
          closeSync(rootDescriptor);
          throw restoreFailure;
        }
    });
  } catch (failure) {
    error = failure;
  }
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[0].cause, primary);
  assert.equal(error.errors[1], restoreFailure);
  assert.equal(error.errors.length, 4);
  assert.equal(error.errors[2].syscall, "fstat");
  assert.equal(error.errors[3].syscall, "close");
  assert.equal(restoreCalls, 1);
});

test("canonical repository paths and file identities cannot alias the scan", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-alias-"));
  context.after(() => rmSync(root, { recursive: true }));
  mkdirSync(join(root, "scripts"));
  const sourcePath = join(root, "scripts", "consumer.mjs");
  writeFileSync(sourcePath, 'releaseCutover("public-media-render-verification");\n');
  linkSync(sourcePath, join(root, "scripts", "alias.mjs"));

  for (const alias of ["scripts/./consumer.mjs", "scripts/a/../consumer.mjs", "scripts//consumer.mjs"]) {
    assert.throws(() => readStableReleaseCutoverSources(root, [alias]), /byte-canonical|dot|canonical/u);
  }
  assert.throws(
    () => readStableReleaseCutoverSources(root, ["scripts/alias.mjs", "scripts/consumer.mjs"]),
    /no-follow regular file|aliases another/u
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
  assert.deepEqual(checkReleaseCutoverRepository(), { cutovers: 2, checkedPaths: 14 });
});
