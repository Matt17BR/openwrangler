import assert from "node:assert/strict";
import test from "node:test";
import {
  activationBudgetFailures,
  activationTriggerBudgets,
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
});

test("the gate rejects byte, module, and owner-isolation regressions", () => {
  const report = {
    measurements: {
      unrelated: {
        modules: activationTriggerBudgets.unrelated.maximumModules + 1,
        bytes: activationTriggerBudgets.unrelated.maximumBytes + 1,
        files: ["src/extension/pythonBridge.ts"],
        forbiddenMatches: [{ needle: "pythonBridge.ts", file: "src/extension/pythonBridge.ts" }]
      }
    }
  };
  const failures = activationBudgetFailures(report, { unrelated: activationTriggerBudgets.unrelated });

  assert.equal(failures.length, 3);
  assert.match(failures[0], /modules exceeds/u);
  assert.match(failures[1], /bytes exceeds/u);
  assert.match(failures[2], /unexpectedly loads/u);
});
