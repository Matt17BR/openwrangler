import assert from "node:assert/strict";
import test from "node:test";
import {
  activationEventClassifications,
  activationBudgetFailures,
  activationTriggerBudgets,
  dynamicEdgeClassifications,
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
  assert.equal(report.dynamicEdges.discovered.length, Object.keys(dynamicEdgeClassifications).length);
  assert.deepEqual(report.dynamicEdges.unclassified, []);
  assert.deepEqual(report.dynamicEdges.staleClassifications, []);
  assert.deepEqual(report.dynamicEdges.occurrenceMismatches, []);
  assert.equal(report.activationEvents.discovered.length, Object.keys(activationEventClassifications).length);
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

test("the gate rejects unclassified, stale, duplicated, and unknown production edges and events", () => {
  const report = completeInventoryReport({ measurements: {} });
  report.dynamicEdges.unclassified.push("src/extension/newOwner.ts|import|./runtime.js");
  report.dynamicEdges.staleClassifications.push("src/extension/removedOwner.ts|require|./removed");
  report.dynamicEdges.occurrenceMismatches.push({ key: "duplicate-edge", expected: 1, actual: 2 });
  report.dynamicEdges.unknownTriggerClasses.push("implicit-owner");
  report.activationEvents.unclassified.push("onCommand:openWrangler.unclassified");
  report.activationEvents.staleClassifications.push("onView:openWrangler.removed");
  report.activationEvents.occurrenceMismatches.push({ event: "onCommand:openWrangler.duplicate", actual: 2 });
  report.activationEvents.unknownTriggerClasses.push("implicit-event-owner");

  const failures = activationBudgetFailures(report, {});

  assert.equal(failures.length, 8);
  assert.match(failures[0], /dynamic edge: unclassified/u);
  assert.match(failures[1], /dynamic edge: stale/u);
  assert.match(failures[2], /occurs 2 times instead of 1/u);
  assert.match(failures[3], /unknown trigger class implicit-owner/u);
  assert.match(failures[4], /activation event: unclassified/u);
  assert.match(failures[5], /activation event: stale/u);
  assert.match(failures[6], /occurs 2 times instead of 1/u);
  assert.match(failures[7], /unknown trigger class implicit-event-owner/u);
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
      unknownTriggerClasses: []
    }
  };
}
