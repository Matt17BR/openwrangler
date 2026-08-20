import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNotebookVariableDiscoveryCode,
  buildPySparkNotebookPreflightCode,
  isSupportedPySparkVersion,
  parseNotebookVariableDiscoveryOutput,
  parsePySparkNotebookPreflightOutput
} from "../extension/notebooks/notebookVariableDiscovery";

const DISCOVERY_MARKER = "0123456789abcdef0123456789abcdef";
const FACTS_MARKER = "__OPEN_WRANGLER_PANDAS_FACTS__";

interface PandasFacts {
  readonly version: string;
  readonly frameModule: string;
  readonly seriesModule: string;
}

interface PySparkVersionContract {
  readonly acceptedFinal: string[];
  readonly rejected: Readonly<Record<string, string[]>>;
}

describe("notebook variable discovery Python contract", () => {
  it("keeps both generated runtime validators byte-for-byte current with the declarative policy", () => {
    const result = spawnSync(process.execPath, ["scripts/generate-pyspark-version-policy.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      timeout: 30_000,
      windowsHide: true
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Generated PySpark version policies are current.\n");
  });

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

  it.each(["4.2.0rc1", "4.2.0.dev1"])(
    "omits PySpark %s frames during real emitted discovery while retaining other backends",
    (version) => {
      const discovery = executeDiscoveryOnly(`
import sys
import types

pandas_module = types.ModuleType("pandas")
PandasFrame = type("DataFrame", (), {"__module__": "pandas"})
pandas_module.__dict__["DataFrame"] = PandasFrame
sys.modules["pandas"] = pandas_module
pandas_frame = PandasFrame()

pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = ${JSON.stringify(version)}
pyspark_frame_module = types.ModuleType("pyspark.sql.classic.dataframe")
PySparkFrame = type("DataFrame", (), {"__module__": "pyspark.sql.classic.dataframe"})
pyspark_frame_module.__dict__["DataFrame"] = PySparkFrame
sys.modules["pyspark"] = pyspark_module
sys.modules["pyspark.sql.classic.dataframe"] = pyspark_frame_module
pyspark_frame = PySparkFrame()
`);

      expect(discovery).toEqual({
        truncated: false,
        variables: [{ name: "pandas_frame", type: "pandas.DataFrame", backend: "pandas" }]
      });
    }
  );

  it("publishes a final local-version PySpark frame from real emitted discovery", () => {
    const discovery = executeDiscoveryOnly(`
import sys
import types

pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = "4.2.7+Vendor_01"
pyspark_frame_module = types.ModuleType("pyspark.sql.connect.dataframe")
PySparkFrame = type("DataFrame", (), {"__module__": "pyspark.sql.connect.dataframe"})
pyspark_frame_module.__dict__["DataFrame"] = PySparkFrame
sys.modules["pyspark"] = pyspark_module
sys.modules["pyspark.sql.connect.dataframe"] = pyspark_frame_module
pyspark_frame = PySparkFrame()
`);

    expect(discovery).toEqual({
      truncated: false,
      variables: [{ name: "pyspark_frame", type: "pyspark.sql.connect.dataframe.DataFrame", backend: "pyspark" }]
    });
  });

  it("preflights in isolated locals without mutating collisions or invoking module __getattr__", () => {
    const probeCode = buildPySparkNotebookPreflightCode(DISCOVERY_MARKER, "spark_frame");
    const script = `
import sys
import types
import json

getattr_calls = []
pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__getattr__"] = lambda name: getattr_calls.append(name) or (_ for _ in ()).throw(AttributeError(name))
classic_module = types.ModuleType("pyspark.sql.classic.dataframe")
DataFrame = type("DataFrame", (), {"__module__": "pyspark.sql.classic.dataframe"})
classic_module.__dict__["DataFrame"] = DataFrame
sys.modules["pyspark"] = pyspark_module
sys.modules["pyspark.sql.classic.dataframe"] = classic_module
spark_frame = DataFrame()

collision_names = (
    "__ow_builtin_module",
    "__ow_user_namespace",
    "__ow_scope",
    "__ow_json",
    "__ow_sys",
    "__ow_module",
    "__ow_version",
    "__ow_pyspark_version_v1",
)
for collision_name in collision_names:
    globals()[collision_name] = "preserve:" + collision_name
collision_before = {name: globals()[name] for name in collision_names}
${probeCode}
print("__OPEN_WRANGLER_PYSPARK_FACTS__" + json.dumps({
    "collisionsPreserved": collision_before == {name: globals()[name] for name in collision_names},
    "getattrCalls": getattr_calls,
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
    expect(parsePySparkNotebookPreflightOutput(result.stdout, DISCOVERY_MARKER)).toEqual({
      isPySpark: true,
      version: null
    });
    const factsLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith("__OPEN_WRANGLER_PYSPARK_FACTS__"));
    expect(factsLine).toBeDefined();
    expect(JSON.parse(factsLine!.slice("__OPEN_WRANGLER_PYSPARK_FACTS__".length))).toEqual({
      collisionsPreserved: true,
      getattrCalls: []
    });
  });

  it("checks a pinned PySpark version before emitted notebook addressability logic", () => {
    const probeCode = buildPySparkNotebookPreflightCode(DISCOVERY_MARKER, "missing_spark_frame", "pyspark");
    const versionIndex = probeCode.indexOf("__ow_module =");
    const namespaceIndex = probeCode.indexOf("__ow_user_ns.get");

    expect(versionIndex).toBeGreaterThanOrEqual(0);
    expect(namespaceIndex).toBeGreaterThan(versionIndex);
    const result = spawnSync(
      testPythonExecutable(),
      [
        "-I",
        "-c",
        `
import sys
import types
pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = "4.2.0rc1"
sys.modules["pyspark"] = pyspark_module
${probeCode}
`
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 30_000, windowsHide: true }
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(parsePySparkNotebookPreflightOutput(result.stdout, DISCOVERY_MARKER)).toEqual({
      isPySpark: true,
      version: "4.2.0rc1"
    });
  });

  it("matches the shared strict PySpark 4.2 version contract", () => {
    const contract = JSON.parse(
      readFileSync(resolve(process.cwd(), "fixtures", "pyspark-version-contract.json"), "utf8")
    ) as PySparkVersionContract;
    const rejected = Object.values(contract.rejected).flat();

    expect(contract.acceptedFinal.every(isSupportedPySparkVersion)).toBe(true);
    expect(rejected.some(isSupportedPySparkVersion)).toBe(false);
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

function executeDiscoveryOnly(prelude: string): ReturnType<typeof parseNotebookVariableDiscoveryOutput> {
  const discoveryCode = buildNotebookVariableDiscoveryCode(DISCOVERY_MARKER);
  const result = spawnSync(testPythonExecutable(), ["-I", "-c", `${prelude}\n${discoveryCode}`], {
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: 30_000,
    windowsHide: true
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return parseNotebookVariableDiscoveryOutput(result.stdout, DISCOVERY_MARKER);
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
