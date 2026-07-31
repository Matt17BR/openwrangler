import assert from "node:assert/strict";
import test from "node:test";
import {
  packagedEditorPythonProbeSourceForTesting,
  preflightPackagedEditorPython
} from "./packaged-python-preflight.mjs";

test("packaged editor Python preflight checks the exact ordinary acceptance dependencies", () => {
  let invocation;
  preflightPackagedEditorPython("prepared-python", (executable, args, options) => {
    invocation = { executable, args, options };
  });

  assert.deepEqual(invocation, {
    executable: "prepared-python",
    args: ["-I", "-c", packagedEditorPythonProbeSourceForTesting],
    options: {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true
    }
  });
  for (const moduleName of ["pandas", "polars", "duckdb", "openpyxl"]) {
    assert.match(packagedEditorPythonProbeSourceForTesting, new RegExp(`'${moduleName}'`, "u"));
  }
  assert.match(packagedEditorPythonProbeSourceForTesting, /\(3, 10\).*\(3, 14\)/u);
});

test("packaged editor Python preflight fails before editor launch with actionable fixed copy", () => {
  assert.throws(
    () =>
      preflightPackagedEditorPython("missing-python", () => {
        throw new Error("host-specific child failure");
      }),
    {
      message:
        "Packaged editor acceptance needs Python 3.10-3.14 with pandas, polars, duckdb, and openpyxl. " +
        "Set OPEN_WRANGLER_TEST_PYTHON to an absolute prepared interpreter before launching an editor."
    }
  );
});
