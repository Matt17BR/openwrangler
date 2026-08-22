import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The native generator exposes focused test helpers without a separate declaration surface.
import { parsePySparkVersionContract, readPySparkPolicyText } from "../../scripts/generate-pyspark-version-policy.mjs";
import {
  buildNotebookVariableDiscoveryCode,
  buildPySparkNotebookPreflightCode,
  isSupportedPySparkVersion,
  parseNotebookVariableDiscoveryOutput,
  parsePySparkNotebookPreflightOutput
} from "../extension/notebooks/notebookVariableDiscovery";
import {
  classifyPySparkVersion,
  safePySparkVersionDiagnostic
} from "../extension/notebooks/pysparkVersionPolicy.generated";

const DISCOVERY_MARKER = "0123456789abcdef0123456789abcdef";
const FACTS_MARKER = "__OPEN_WRANGLER_PANDAS_FACTS__";

interface PandasFacts {
  readonly version: string;
  readonly frameModule: string;
  readonly seriesModule: string;
}

interface PySparkVersionContract {
  readonly acceptancePrereleaseDenial: string[];
  readonly acceptedFinal: string[];
  readonly rejected: Readonly<Record<string, string[]>>;
}

const PYSPARK_VERSION_CONTRACT = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures", "pyspark-version-contract.json"), "utf8")
) as PySparkVersionContract;
const REPRESENTATIVE_REJECTED_DISCOVERY_VERSIONS = [
  ...PYSPARK_VERSION_CONTRACT.acceptancePrereleaseDenial,
  ...Object.values(PYSPARK_VERSION_CONTRACT.rejected).map((versions) => versions[0]!)
];

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

  it("reads policy authority and generated outputs through bounded no-follow identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwrangler-pyspark-policy-read-"));
    const policy = join(root, "policy.json");
    const alias = join(root, "policy-alias.json");
    try {
      await writeFile(policy, '{"policy":true}\n', { mode: 0o600 });
      expect(readPySparkPolicyText(policy, 64, "test PySpark policy", { containedBy: root })).toBe('{"policy":true}\n');
      await symlink(policy, alias);
      expect(() => readPySparkPolicyText(alias, 64, "test PySpark policy", { containedBy: root })).toThrow(
        /no-follow regular file/u
      );
      expect(() =>
        readPySparkPolicyText(policy, 64, "test PySpark policy", {
          containedBy: root,
          afterOpenForTest() {
            writeFileSync(policy, '{"policy":false}');
          }
        })
      ).toThrow(/changed during its descriptor-bound read/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate JSON keys in the single generated PySpark policy authority", () => {
    expect(() => parsePySparkVersionContract('{"policy":{},"policy":{}}')).toThrow(/duplicate keys/u);
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

  it.each(REPRESENTATIVE_REJECTED_DISCOVERY_VERSIONS)(
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

  it("recomputes PySpark qualification when a later discovery supersedes a rejected result", () => {
    const firstMarker = DISCOVERY_MARKER;
    const secondMarker = "fedcba9876543210fedcba9876543210";
    const firstCode = buildNotebookVariableDiscoveryCode(firstMarker);
    const secondCode = buildNotebookVariableDiscoveryCode(secondMarker);
    const script = `
import sys
import types

pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = "4.2.0rc1"
pyspark_frame_module = types.ModuleType("pyspark.sql.classic.dataframe")
PySparkFrame = type("DataFrame", (), {"__module__": "pyspark.sql.classic.dataframe"})
pyspark_frame_module.__dict__["DataFrame"] = PySparkFrame
sys.modules["pyspark"] = pyspark_module
sys.modules["pyspark.sql.classic.dataframe"] = pyspark_frame_module
pyspark_frame = PySparkFrame()
${firstCode}
pyspark_module.__dict__["__version__"] = "4.2.8+vendor.1"
${secondCode}
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
    expect(parseNotebookVariableDiscoveryOutput(result.stdout, firstMarker)).toEqual({
      truncated: false,
      variables: []
    });
    expect(parseNotebookVariableDiscoveryOutput(result.stdout, secondMarker)).toEqual({
      truncated: false,
      variables: [{ name: "pyspark_frame", type: "pyspark.sql.classic.dataframe.DataFrame", backend: "pyspark" }]
    });
  });

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
    const liveHandle = "__openwrangler_live_result_0123456789abcdef0123456789abcdef";
    const probeCode = buildPySparkNotebookPreflightCode(DISCOVERY_MARKER, liveHandle, "pyspark");
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
import json
accesses = []
pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = "4.2.0rc1"
notebook_module = types.ModuleType("openwrangler_runtime.notebook")
notebook_module.__dict__["is_live_result_handle"] = lambda name: accesses.append("live:" + name) or True
notebook_module.__dict__["resolve_live_result"] = lambda name: accesses.append("resolve:" + name)
sys.modules["pyspark"] = pyspark_module
sys.modules["openwrangler_runtime.notebook"] = notebook_module
${probeCode}
print("__OPEN_WRANGLER_PINNED_PREFLIGHT_FACTS__" + json.dumps(accesses))
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
    expect(result.stdout).toContain("__OPEN_WRANGLER_PINNED_PREFLIGHT_FACTS__[]");
  });

  it("requires a supported pinned target to remain the exact module-owned PySpark DataFrame", () => {
    const markers = [
      DISCOVERY_MARKER,
      "11111111111111111111111111111111",
      "22222222222222222222222222222222",
      "33333333333333333333333333333333",
      "44444444444444444444444444444444"
    ] as const;
    const liveHandle = "__openwrangler_live_result_0123456789abcdef0123456789abcdef";
    const probes = [
      buildPySparkNotebookPreflightCode(markers[0], "missing_frame", "pyspark"),
      buildPySparkNotebookPreflightCode(markers[1], "scalar_frame", "pyspark"),
      buildPySparkNotebookPreflightCode(markers[2], "non_spark_frame", "pyspark"),
      buildPySparkNotebookPreflightCode(markers[3], liveHandle, "pyspark"),
      buildPySparkNotebookPreflightCode(markers[4], "spark_frame", "pyspark")
    ];
    const result = spawnSync(
      testPythonExecutable(),
      [
        "-I",
        "-c",
        `
import json
import sys
import types
accesses = []
pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = "4.2.7+vendor.1"
classic_module = types.ModuleType("pyspark.sql.classic.dataframe")
class DataFrame:
    __module__ = "pyspark.sql.classic.dataframe"
    def __getattribute__(self, name):
        if name in ("columns", "isStreaming", "schema", "withColumn"):
            accesses.append("frame:" + name)
            raise AssertionError("preflight inspected PySpark frame capability " + name)
        return object.__getattribute__(self, name)
classic_module.__dict__["DataFrame"] = DataFrame
notebook_module = types.ModuleType("openwrangler_runtime.notebook")
live_values = [DataFrame(), 42]
notebook_module.__dict__["is_live_result_handle"] = lambda name: accesses.append("live:" + name) or True
notebook_module.__dict__["resolve_live_result"] = lambda name: accesses.append("resolve:" + name) or live_values.pop(0)
sys.modules["pyspark"] = pyspark_module
sys.modules["pyspark.sql.classic.dataframe"] = classic_module
sys.modules["openwrangler_runtime.notebook"] = notebook_module
scalar_frame = 42
non_spark_frame = type("DataFrame", (), {"__module__": "example"})()
spark_frame = DataFrame()
${probes.join("\n")}
print("__OPEN_WRANGLER_PINNED_TARGET_FACTS__" + json.dumps(accesses))
`
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 30_000, windowsHide: true }
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    for (const marker of markers.slice(0, 4)) {
      expect(parsePySparkNotebookPreflightOutput(result.stdout, marker)).toEqual({
        isPySpark: false,
        version: null
      });
    }
    expect(parsePySparkNotebookPreflightOutput(result.stdout, markers[4])).toEqual({
      isPySpark: true,
      version: "4.2.7+vendor.1"
    });
    expect(result.stdout).toContain(
      `__OPEN_WRANGLER_PINNED_TARGET_FACTS__["live:${liveHandle}", "resolve:${liveHandle}", "live:${liveHandle}", "resolve:${liveHandle}"]`
    );
  });

  it("does not reject non-PySpark or missing automatic targets merely because unsupported PySpark is loaded", () => {
    const secondMarker = "fedcba9876543210fedcba9876543210";
    const pandasProbeCode = buildPySparkNotebookPreflightCode(DISCOVERY_MARKER, "pandas_frame");
    const missingProbeCode = buildPySparkNotebookPreflightCode(secondMarker, "missing_frame");
    const result = spawnSync(
      testPythonExecutable(),
      [
        "-I",
        "-c",
        `
import json
import sys
import types
accesses = []
pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = "4.2.0rc1"
notebook_module = types.ModuleType("openwrangler_runtime.notebook")
notebook_module.__dict__["is_live_result_handle"] = lambda name: accesses.append("live:" + name) or False
notebook_module.__dict__["resolve_live_result"] = lambda name: accesses.append("resolve:" + name)
sys.modules["pyspark"] = pyspark_module
sys.modules["openwrangler_runtime.notebook"] = notebook_module
pandas_frame = type("DataFrame", (), {"__module__": "pandas.core.frame"})()
${pandasProbeCode}
${missingProbeCode}
print("__OPEN_WRANGLER_AUTO_PREFLIGHT_FACTS__" + json.dumps(accesses))
`
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 30_000, windowsHide: true }
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(parsePySparkNotebookPreflightOutput(result.stdout, DISCOVERY_MARKER)).toEqual({
      isPySpark: false,
      version: null
    });
    expect(parsePySparkNotebookPreflightOutput(result.stdout, secondMarker)).toEqual({
      isPySpark: false,
      version: null
    });
    expect(result.stdout).toContain("__OPEN_WRANGLER_AUTO_PREFLIGHT_FACTS__[]");
  });

  it("rejects an actual automatic PySpark trap frame without inspecting dataframe capabilities", () => {
    const probeCode = buildPySparkNotebookPreflightCode(DISCOVERY_MARKER, "spark_frame");
    const result = spawnSync(
      testPythonExecutable(),
      [
        "-I",
        "-c",
        `
import json
import sys
import types
accesses = []
pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = "4.2.0.dev5"
classic_module = types.ModuleType("pyspark.sql.classic.dataframe")
class DataFrame:
    __module__ = "pyspark.sql.classic.dataframe"
    def __getattribute__(self, name):
        if name in ("columns", "isStreaming", "schema", "withColumn"):
            accesses.append(name)
            raise AssertionError("preflight inspected PySpark frame capability " + name)
        return object.__getattribute__(self, name)
classic_module.__dict__["DataFrame"] = DataFrame
sys.modules["pyspark"] = pyspark_module
sys.modules["pyspark.sql.classic.dataframe"] = classic_module
spark_frame = DataFrame()
${probeCode}
print("__OPEN_WRANGLER_AUTO_TRAP_FACTS__" + json.dumps(accesses))
`
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 30_000, windowsHide: true }
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(parsePySparkNotebookPreflightOutput(result.stdout, DISCOVERY_MARKER)).toEqual({
      isPySpark: true,
      version: "4.2.0.dev5"
    });
    expect(result.stdout).toContain("__OPEN_WRANGLER_AUTO_TRAP_FACTS__[]");
  });

  it.each(["x".repeat(65), "4.2.0\n", "4.2.0\t", "4.2.0\u0000"])(
    "suppresses an unsafe emitted PySpark version diagnostic before namespace access",
    (version) => {
      const probeCode = buildPySparkNotebookPreflightCode(DISCOVERY_MARKER, "missing_spark_frame", "pyspark");
      const result = spawnSync(
        testPythonExecutable(),
        [
          "-I",
          "-c",
          `
import sys
import types
pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = ${JSON.stringify(version)}
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
        version: null
      });
    }
  );

  it("retains an exact 64-character printable rejected version only inside the bounded preflight envelope", () => {
    const version = "x".repeat(64);
    const probeCode = buildPySparkNotebookPreflightCode(DISCOVERY_MARKER, "missing_spark_frame", "pyspark");
    const result = spawnSync(
      testPythonExecutable(),
      [
        "-I",
        "-c",
        `
import sys
import types
pyspark_module = types.ModuleType("pyspark")
pyspark_module.__dict__["__version__"] = ${JSON.stringify(version)}
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
      version
    });
  });

  it("matches the shared strict PySpark 4.2 version contract", () => {
    const rejected = [
      ...PYSPARK_VERSION_CONTRACT.acceptancePrereleaseDenial,
      ...Object.values(PYSPARK_VERSION_CONTRACT.rejected).flat()
    ];

    expect(PYSPARK_VERSION_CONTRACT.acceptedFinal.every(isSupportedPySparkVersion)).toBe(true);
    expect(rejected.some(isSupportedPySparkVersion)).toBe(false);
    expect(
      PYSPARK_VERSION_CONTRACT.acceptedFinal.every((version) => classifyPySparkVersion(version) === "supported-final")
    ).toBe(true);
    expect(
      PYSPARK_VERSION_CONTRACT.acceptancePrereleaseDenial.every(
        (version) => classifyPySparkVersion(version) === "acceptance-denial"
      )
    ).toBe(true);
    expect(
      Object.values(PYSPARK_VERSION_CONTRACT.rejected)
        .flat()
        .every((version) => classifyPySparkVersion(version) === "unsupported")
    ).toBe(true);
  });

  it("bounds the generated printable version diagnostic at the exact 64-character contract", () => {
    expect(safePySparkVersionDiagnostic("x".repeat(64))).toBe("x".repeat(64));
    for (const version of ["x".repeat(65), "4.2.0\n", "4.2.0\t", "4.2.0\u0000", "4.2.0-β", 420]) {
      expect(safePySparkVersionDiagnostic(version)).toBeNull();
    }
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
