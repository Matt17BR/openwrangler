import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activationEventClassifications,
  activationBudgetFailures,
  activationTriggerBudgets,
  dynamicEdgeClassifications,
  measureActivationInventory,
  measureActivationTriggers
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
