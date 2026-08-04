import { execFileSync } from "node:child_process";

const PROBE_SOURCE = [
  "import importlib",
  "import sys",
  "supported = (3, 10) <= sys.version_info[:2] <= (3, 14)",
  "modules = ('pandas', 'polars', 'duckdb', 'openpyxl', 'pyarrow')",
  "raise SystemExit(0 if supported and all(importlib.import_module(name) for name in modules) else 1)"
].join("\n");

export function preflightPackagedEditorPython(python, execute = execFileSync) {
  try {
    execute(python, ["-I", "-c", PROBE_SOURCE], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true
    });
  } catch {
    throw new Error(
      "Packaged editor acceptance needs Python 3.10-3.14 with pandas, polars, duckdb, openpyxl, and pyarrow. " +
        "Set OPEN_WRANGLER_TEST_PYTHON to an absolute prepared interpreter before launching an editor."
    );
  }
}

export const packagedEditorPythonProbeSourceForTesting = PROBE_SOURCE;
