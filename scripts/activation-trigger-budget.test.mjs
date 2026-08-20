import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activationEventClassifications,
  activationBudgetFailures,
  activationTriggerBudgets,
  dynamicEdgeClassifications,
  measureActivationInventory,
  measureActivationTriggers,
  measureTransitiveRuntimeSources
} from "./activation-trigger-budget.mjs";

test("production activation trigger classes stay within their dependency-free cold-load budgets", async () => {
  const report = await measureActivationTriggers();

  assert.deepEqual(activationBudgetFailures(report), []);
  assert.equal(report.measurements.unrelated.modules <= 3, true);
  assert.equal(report.measurements.unrelated.files.includes("src/extension/lazyActivationOwners.ts"), true);
  assert.equal(report.measurements.runtime.files.includes("src/extension/pythonBridge.ts"), true);
  assert.equal(
    report.measurements["trusted-pickle"].files.includes("src/extension/files/trustedPickleWorker.ts"),
    true
  );
  assert.equal(report.measurements.r.files.includes("src/extension/r/rInteractiveCommands.ts"), true);
  assert.equal(report.measurements["r-document"].files.includes("src/extension/r/rDocumentCommands.ts"), true);
  assert.equal(
    report.measurements.notebook.files.includes("src/extension/notebooks/pythonInteractiveCommands.ts"),
    true
  );
  assert.equal(report.measurements["custom-editor"].files.includes("src/extension/files/fileOpen.ts"), true);
  assert.equal(report.measurements["native-view"].files.includes("src/extension/nativeViews.ts"), true);
  assert.equal(
    report.measurements["native-view"].files.includes("src/extension/notebooks/pythonInteractiveCommands.ts"),
    false
  );
  // NativeViews still imports R command constants through the #744-owned seam;
  // the independent lazy edge below is what distinguishes R owner discovery.
  assert.equal(report.measurements["native-view"].files.includes("src/extension/r/rInteractiveCommands.ts"), true);
  assert.equal(
    report.measurements["native-live"].files.includes("src/extension/notebooks/pythonInteractiveCommands.ts"),
    true
  );
  assert.equal(report.measurements["native-live"].files.includes("src/extension/r/rInteractiveCommands.ts"), true);
  assert.equal(report.dynamicEdges.discovered.length, Object.keys(dynamicEdgeClassifications).length);
  assert.deepEqual(report.dynamicEdges.unclassified, []);
  assert.deepEqual(report.dynamicEdges.staleClassifications, []);
  assert.deepEqual(report.dynamicEdges.occurrenceMismatches, []);
  assert.equal(report.activationEvents.discovered.length, Object.keys(activationEventClassifications).length);
  assert.equal(report.activationEvents.explicit.length, 51);
  assert.equal(report.activationEvents.contributedCommands.length, 43);
  assert.deepEqual(
    report.activationEvents.contributionDerived.filter((event) => !report.activationEvents.explicit.includes(event)),
    ["onCommand:openWrangler.openCachedNotebookVariable"]
  );
  assert.deepEqual(report.activationEvents.unclassified, []);
  assert.deepEqual(report.activationEvents.staleClassifications, []);
  assert.deepEqual(report.activationEvents.occurrenceMismatches, []);
});

test("the gate rejects byte, module, and owner-isolation regressions", () => {
  const report = completeInventoryReport({
    measurements: {
      unrelated: {
        modules: activationTriggerBudgets.unrelated.maximumModules + 1,
        bytes: activationTriggerBudgets.unrelated.maximumBytes + 1,
        files: ["src/extension/pythonBridge.ts"],
        forbiddenMatches: [{ needle: "pythonBridge.ts", file: "src/extension/pythonBridge.ts" }]
      }
    }
  });
  const failures = activationBudgetFailures(report, { unrelated: activationTriggerBudgets.unrelated });

  assert.equal(failures.length, 3);
  assert.match(failures[0], /modules exceeds/u);
  assert.match(failures[1], /bytes exceeds/u);
  assert.match(failures[2], /unexpectedly loads/u);
});

test("the audit discovers aliased loaders and contribution-derived activation through mutated fixtures", async () => {
  await withInventoryFixture(
    `
      import { createRequire as makeRequire } from "node:module";
      const loadModule = (specifier) => import(specifier);
      const aliasedLoad = loadModule;
      const directRequire = require;
      const aliasedRequire = directRequire;
      const localRequire = makeRequire(import.meta.url);
      aliasedLoad("./dynamic-owner.js");
      aliasedRequire("./required-owner.js");
      localRequire("./created-owner.js");
      // require("./commented-line.js");
      /* import("./commented-block.js"); */
    `,
    {
      activationEvents: ["onCommand:fixture.explicit"],
      contributes: { commands: [{ command: "fixture.explicit" }, { command: "fixture.implicit" }] }
    },
    async (report) => {
      assert.deepEqual(
        report.dynamicEdges.discovered.map(({ key }) => key),
        [
          "src/extension/fixture.ts|import|./dynamic-owner.js",
          "src/extension/fixture.ts|require|./created-owner.js",
          "src/extension/fixture.ts|require|./required-owner.js"
        ]
      );
      assert.equal(
        report.dynamicEdges.discovered.some(({ key }) => key.includes("commented")),
        false
      );
      assert.deepEqual(report.activationEvents.explicit, ["onCommand:fixture.explicit"]);
      assert.deepEqual(report.activationEvents.contributionDerived, [
        "onCommand:fixture.explicit",
        "onCommand:fixture.implicit"
      ]);
      assert.deepEqual(report.activationEvents.discovered, [
        "onCommand:fixture.explicit",
        "onCommand:fixture.implicit"
      ]);
    }
  );
});

test("the syntax authority accepts parenthesized loaders and rejects regex, template, and string text", async () => {
  const source = [
    "const loadModule = (specifier) => import(specifier);",
    "const directRequire = require;",
    '(loadModule)("./parenthesized-import.js");',
    '(directRequire)("./parenthesized-require.js");',
    "const stringText = 'require(\"./string-text.js\")';",
    'const templateText = `import("./template-text.js")`;',
    'const regexText = /require\\("\\.\\/regex-text\\.js"\\)/u;'
  ].join("\n");
  await withInventoryFixture(source, { activationEvents: [], contributes: { commands: [] } }, async (report) => {
    assert.deepEqual(
      report.dynamicEdges.discovered.map(({ key }) => key),
      [
        "src/extension/fixture.ts|import|./parenthesized-import.js",
        "src/extension/fixture.ts|require|./parenthesized-require.js"
      ]
    );
  });
});

test("transitive source discovery rejects symlinks before reading them", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./linked.js";\n', "utf8");
    await writeFile(path.join(sourceRoot, "target.ts"), "export const value = 1;\n", "utf8");
    await symlink("target.ts", path.join(sourceRoot, "linked.ts"));

    await assert.rejects(
      measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"]),
      /resolved through a symlink/u
    );
  });
});

test("transitive source discovery rejects a path replacement between identity check and descriptor open", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    const dependency = path.join(sourceRoot, "dependency.ts");
    await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./dependency.js";\n', "utf8");
    await writeFile(dependency, "export const value = 1;\n", "utf8");
    let replaced = false;

    await assert.rejects(
      measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"], {
        beforeDescriptorOpen: async (file) => {
          if (file !== dependency || replaced) return;
          replaced = true;
          await rename(dependency, `${dependency}.previous`);
          await writeFile(dependency, "export const value = 2;\n", "utf8");
        }
      }),
      /changed identity before read/u
    );
  });
});

test("transitive source discovery rejects aggregate overflow before the next read", async () => {
  await withSourceFixture(async (root) => {
    const sourceRoot = path.join(root, "src/extension");
    await writeFile(path.join(sourceRoot, "entry.ts"), 'import "./dependency.js";\nexport const entry = 1;\n', "utf8");
    await writeFile(
      path.join(sourceRoot, "dependency.ts"),
      'export const dependency = "a bounded fixture that crosses the aggregate cap";\n',
      "utf8"
    );

    await assert.rejects(
      measureTransitiveRuntimeSources(root, ["src/extension/entry.ts"], { maximumAggregateBytes: 96 }),
      /aggregate source bound/u
    );
  });
});

function completeInventoryReport(report) {
  return {
    ...report,
    dynamicEdges: {
      discovered: [],
      classified: [],
      unclassified: [],
      staleClassifications: [],
      occurrenceMismatches: [],
      unknownTriggerClasses: []
    },
    activationEvents: {
      discovered: [],
      classified: [],
      unclassified: [],
      staleClassifications: [],
      occurrenceMismatches: [],
      contributedCommandOccurrenceMismatches: [],
      unknownTriggerClasses: []
    }
  };
}

async function withInventoryFixture(source, manifest, inspect) {
  const root = await mkdtemp(path.join(tmpdir(), "ow-activation-audit-"));
  try {
    await mkdir(path.join(root, "src/extension"), { recursive: true });
    await writeFile(path.join(root, "src/extension/fixture.ts"), source, "utf8");
    await writeFile(path.join(root, "package.json"), JSON.stringify(manifest), "utf8");
    await inspect(await measureActivationInventory(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withSourceFixture(inspect) {
  const root = await mkdtemp(path.join(tmpdir(), "ow-activation-source-audit-"));
  try {
    await mkdir(path.join(root, "src/extension"), { recursive: true });
    await inspect(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
