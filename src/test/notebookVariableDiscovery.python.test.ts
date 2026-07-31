import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNotebookVariableDiscoveryCode,
  parseNotebookVariableDiscoveryOutput
} from "../extension/notebooks/notebookVariableDiscovery";

const DISCOVERY_MARKER = "0123456789abcdef0123456789abcdef";
const FACTS_MARKER = "__OPEN_WRANGLER_PANDAS_FACTS__";

interface PandasFacts {
  readonly version: string;
  readonly frameModule: string;
  readonly seriesModule: string;
}

describe("notebook variable discovery Python contract", () => {
  it("executes the emitted code against the installed Pandas DataFrame and Series types", () => {
    const { discovery, facts } = executeDiscovery(`
import pandas as pd
pandas_frame = pd.DataFrame({"value": [1, 2]})
pandas_series = pd.Series([3, 4], name="value")
`);

    const majorVersion = Number.parseInt(facts.version.split(".", 1)[0] ?? "", 10);
    expect(majorVersion).toBeGreaterThanOrEqual(2);
    if (majorVersion >= 3) {
      expect(facts.frameModule).toBe("pandas");
      expect(facts.seriesModule).toBe("pandas");
    }
    expect(discovery).toEqual({
      truncated: false,
      variables: [
        {
          name: "pandas_frame",
          type: `${facts.frameModule}.DataFrame`,
          backend: "pandas"
        },
        {
          name: "pandas_series",
          type: `${facts.seriesModule}.Series`,
          backend: "pandas"
        }
      ]
    });
  });

  it("rejects canonical and legacy Pandas lookalikes that do not match the module-owned type", () => {
    const { discovery } = executeDiscovery(`
import pandas as pd
CanonicalDataFrameSpoof = type("DataFrame", (), {"__module__": "pandas"})
CanonicalSeriesSpoof = type("Series", (), {"__module__": "pandas"})
LegacyDataFrameSpoof = type("DataFrame", (), {"__module__": "pandas.core.frame"})
LegacySeriesSpoof = type("Series", (), {"__module__": "pandas.core.series"})
canonical_frame_spoof = CanonicalDataFrameSpoof()
canonical_series_spoof = CanonicalSeriesSpoof()
legacy_frame_spoof = LegacyDataFrameSpoof()
legacy_series_spoof = LegacySeriesSpoof()
`);

    expect(discovery).toEqual({ truncated: false, variables: [] });
  });
});

function executeDiscovery(prelude: string): {
  readonly discovery: ReturnType<typeof parseNotebookVariableDiscoveryOutput>;
  readonly facts: PandasFacts;
} {
  const discoveryCode = buildNotebookVariableDiscoveryCode(DISCOVERY_MARKER);
  const script = `${prelude}
${discoveryCode}
print("${FACTS_MARKER}" + __import__("json").dumps({
    "version": pd.__version__,
    "frameModule": pd.DataFrame.__module__,
    "seriesModule": pd.Series.__module__,
}, sort_keys=True))
`;
  const result = spawnSync(testPythonExecutable(), ["-I", "-c", script], {
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: 30_000,
    windowsHide: true
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  const factsLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith(FACTS_MARKER));
  expect(factsLine).toBeDefined();
  const facts = JSON.parse(factsLine!.slice(FACTS_MARKER.length)) as PandasFacts;
  return {
    discovery: parseNotebookVariableDiscoveryOutput(result.stdout, DISCOVERY_MARKER),
    facts
  };
}

function testPythonExecutable(): string {
  const configured = process.env.OPEN_WRANGLER_TEST_PYTHON ?? process.env.OPEN_WRANGLER_PYTHON;
  if (configured) return configured;
  const repositoryVenv = resolve(
    process.cwd(),
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python"
  );
  if (existsSync(repositoryVenv)) return repositoryVenv;
  return process.platform === "win32" ? "python" : "python3";
}
