import assert from "node:assert/strict";
import test from "node:test";
import * as diagnostic from "./run-data-wrangler-comparison-diagnostic.mjs";

test("diagnostic CLI requires exactly one manifest and prepared input", () => {
  assert.deepEqual(
    diagnostic.parseDataWranglerComparisonDiagnosticArguments(
      ["--manifest", "study/manifest.json", "--prepared", "study/prepared.json"],
      "/private"
    ),
    {
      manifestPath: "/private/study/manifest.json",
      preparationPath: "/private/study/prepared.json"
    }
  );
  assert.throws(
    () => diagnostic.parseDataWranglerComparisonDiagnosticArguments(["--manifest", "manifest.json"]),
    /--prepared/u
  );
  assert.throws(
    () =>
      diagnostic.parseDataWranglerComparisonDiagnosticArguments([
        "--manifest",
        "manifest.json",
        "--prepared",
        "prepared.json",
        "--out",
        "result.json"
      ]),
    /Usage/u
  );
});

test("diagnostic entry point exposes no legacy unprepared execution path", () => {
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL",
    "parseDataWranglerComparisonDiagnosticArguments"
  ]);
});
