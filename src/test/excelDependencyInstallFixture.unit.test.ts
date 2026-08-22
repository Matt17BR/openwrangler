import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  excelDependencyGateSource,
  excelDependencyPipSource,
  packagedExcelDependencyWorkbookSource
} from "./extensionHost/excelDependencyInstallFixture";
import {
  PYTHON_PROBE_MAX_OUTPUT_BYTES,
  PYTHON_PROBE_MAX_TIMEOUT_MS,
  PythonProbeProcessError,
  pythonProbeSpawnContract,
  runOwnedPythonProbe,
  terminateOwnedPythonProbeTree,
  windowsPythonProbeTreeKillCommand,
  type PythonProbeReadiness,
  type PythonProbeTreeTerminator,
  type RunOwnedPythonProbeOptions
} from "./pythonProbeProcessOwner";

describe("Excel dependency-install fixture", () => {
  it("builds the exact bounded workbook schema and deterministic row family", () => {
    const source = packagedExcelDependencyWorkbookSource();

    expect(source).toContain("sheet.title = 'Regional orders'");
    expect(source).toContain(
      "sheet.append(['order_id', 'market', 'revenue', 'fulfilled', 'order_date', 'account_status'])"
    );
    expect(source).toContain("for index in range(64):");
    expect(source).toContain("f'OW-{240001 + index}'");
    expect(source).toContain("round(620.5 + index * 79.19, 2)");
    expect(source).toContain("f'2026-01-{(index % 28) + 1:02d}'");
    expect(source).toContain("workbook.save(sys.argv[1])");
  });

  it("hides only openpyxl until the exact safely quoted marker exists", () => {
    const marker = '/fixture/openpyxl "installed"';
    const source = excelDependencyGateSource(marker);

    expect(source).toContain(`_openwrangler_marker = ${JSON.stringify(marker)}`);
    expect(source).toContain("if name == 'openpyxl' and not _openwrangler_os.path.exists(_openwrangler_marker):");
    expect(source).toContain("return _openwrangler_find_spec_original(name, package)");
    expect(source).toContain("class _OpenWranglerDependencyGate(_openwrangler_importlib_abc.MetaPathFinder):");
    expect(source).toContain("_openwrangler_sys.meta_path.insert(0, _OpenWranglerDependencyGate())");
    expect(source.endsWith("\n")).toBe(true);
  });

  it("blocks the production-shaped module probe only until the install marker exists", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-excel-gate-"));
    const marker = path.join(directory, 'openpyxl "installed"');
    const gate = excelDependencyGateSource(marker);
    const probe = [
      gate,
      "import importlib",
      "import importlib.metadata",
      "import importlib.util",
      "import json",
      "distribution = importlib.metadata.distribution('openpyxl')",
      "result = {'version': distribution.version, 'other': importlib.import_module('json').__name__}",
      "result['find_spec'] = importlib.util.find_spec('openpyxl') is not None",
      "try:",
      "    result['module'] = importlib.import_module('openpyxl').__name__",
      "except ModuleNotFoundError as error:",
      "    result['module'] = None",
      "    result['missing'] = error.name",
      "print(json.dumps(result, sort_keys=True))"
    ].join("\n");

    try {
      const before = await runPythonProbe(probe);
      expect(before).toMatchObject({ find_spec: false, missing: "openpyxl", module: null, other: "json" });
      expect(before.version).toEqual(expect.any(String));

      writeFileSync(marker, "openpyxl installed\n", { encoding: "utf8", flag: "wx" });
      const after = await runPythonProbe(probe);
      expect(after).toMatchObject({ find_spec: true, module: "openpyxl", other: "json", version: before.version });
      expect(after).not.toHaveProperty("missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("owns the production deadline and one owner for both Python probes", async () => {
    const calls: RunOwnedPythonProbeOptions[] = [];
    const execute: PythonProbeRunner = async (options) => {
      calls.push(options);
      return "{}";
    };

    await expect(runPythonProbe("pass", execute)).resolves.toEqual({});
    await expect(runPythonProbe("pass", execute)).resolves.toEqual({});
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.executable).toBe(selectedPython());
      expect(call.source).toBe("pass");
      expect(call.timeoutMs).toBe(PYTHON_PROBE_MAX_TIMEOUT_MS);
      expect(call.readiness).toBeUndefined();
    }
  });

  it("binds ignored stdin, bounded pipes, isolated POSIX groups, and Windows tree termination", () => {
    expect(pythonProbeSpawnContract("linux")).toEqual({
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    expect(pythonProbeSpawnContract("win32")).toEqual({
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    expect(windowsPythonProbeTreeKillCommand("C:\\Windows", 4217)).toEqual({
      executable: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4217", "/T", "/F"]
    });
  });

  it("starts the short canary only after readiness and settles a real descendant tree", async () => {
    const fixture = createTreeFixture("delayed-ready", { readinessDelaySeconds: 0.5 });
    const timeoutMs = 250;

    try {
      const startedAt = performance.now();
      const observed = await captureFailure(
        runPythonProbe(fixture.source, runOwnedPythonProbe, {
          readiness: PROBE_READINESS,
          timeoutMs
        })
      );
      const elapsedMs = performance.now() - startedAt;

      expect(observed.message).toBe(`The Excel dependency Python probe exceeded its ${timeoutMs} ms deadline.`);
      expect(elapsedMs).toBeGreaterThanOrEqual(500);
      expect(elapsedMs).toBeLessThan(10_000);
      expectFixtureTreeGone(fixture);
    } finally {
      fixture.dispose();
    }
  }, 15_000);

  it("fails missing readiness and settles the owned process tree without starting the canary", async () => {
    const fixture = createTreeFixture("missing-ready", { emitReadiness: false });
    const readiness = { ...PROBE_READINESS, timeoutMs: 1_000 };
    try {
      const observed = await captureFailure(
        runPythonProbe(fixture.source, runOwnedPythonProbe, { readiness, timeoutMs: 250 })
      );

      expect(observed.message).toBe(
        `The Excel dependency Python probe did not become ready within its ${readiness.timeoutMs} ms deadline.`
      );
      expectFixtureTreeGone(fixture);
    } finally {
      fixture.dispose();
    }
  }, 15_000);

  it.each(["stdout", "stderr"] as const)(
    "settles the real descendant tree after independent %s overflow",
    async (stream) => {
      const fixture = createTreeFixture(`${stream}-overflow`, { overflowStream: stream });
      try {
        const observed = await captureFailure(
          runPythonProbe(fixture.source, runOwnedPythonProbe, {
            readiness: PROBE_READINESS,
            timeoutMs: 5_000
          })
        );

        expect(observed.message).toBe(
          `The Excel dependency Python probe exceeded its ${PYTHON_PROBE_MAX_OUTPUT_BYTES}-byte output limit.`
        );
        expectFixtureTreeGone(fixture);
      } finally {
        fixture.dispose();
      }
    },
    15_000
  );

  it("reports cleanup uncertainty after still settling the real descendant tree exactly once", async () => {
    const fixture = createTreeFixture("uncertain-cleanup");
    let terminationCalls = 0;
    const terminateTree: PythonProbeTreeTerminator = async (request) => {
      terminationCalls += 1;
      await terminateOwnedPythonProbeTree(request);
      throw new Error("private process-tree receipt");
    };
    try {
      const observed = await captureFailure(
        runPythonProbe(fixture.source, runOwnedPythonProbe, {
          readiness: PROBE_READINESS,
          terminateTree,
          timeoutMs: 250
        })
      );

      expect(observed.message).toBe("The Excel dependency Python probe process tree could not be verified empty.");
      expect(observed.message).not.toContain("private");
      expect(terminationCalls).toBe(1);
      expectFixtureTreeGone(fixture);
    } finally {
      fixture.dispose();
    }
  }, 15_000);

  it.each([
    ["ETIMEDOUT", `The Excel dependency Python probe exceeded its ${PYTHON_PROBE_MAX_TIMEOUT_MS} ms deadline.`],
    ["ENOBUFS", `The Excel dependency Python probe exceeded its ${PYTHON_PROBE_MAX_OUTPUT_BYTES}-byte output limit.`],
    ["ETREE", "The Excel dependency Python probe process tree could not be verified empty."],
    ["EPROBE", "The Excel dependency Python probe failed."]
  ] as const)("classifies a bounded %s child-process failure without private diagnostics", async (code, expected) => {
    const execute: PythonProbeRunner = async () => {
      throw new PythonProbeProcessError(code);
    };

    const observed = await captureFailure(runPythonProbe("pass", execute));
    expect(observed.message).toBe(expected);
    expect(observed.message.length).toBeLessThanOrEqual(128);
    expect(observed.message).not.toContain("private");
  });

  it("builds an exact isolated pip invocation and publishes evidence before installation", () => {
    const marker = "/fixture/openpyxl-installed";
    const invocation = "/fixture/pip-invocation.json";
    const integrityChecks = "/fixture/pip-integrity-checks.txt";
    const source = excelDependencyPipSource(marker, invocation, integrityChecks);

    expect(source).toContain(`marker_path = ${JSON.stringify(marker)}`);
    expect(source).toContain(`invocation_path = ${JSON.stringify(invocation)}`);
    expect(source).toContain(`integrity_checks_path = ${JSON.stringify(integrityChecks)}`);
    expect(source).toContain("from pip._internal.cli.main import main as pip_main");
    expect(source).toContain("stream.write('clean\\n')");
    expect(source).toContain("expected = ['install', '--no-input', '--no-user', '--', 'openpyxl>=3.1.5,<4']");
    expect(source).toContain("raise SystemExit(91)");
    for (const field of [
      "'args': sys.argv[1:]",
      "'cwd': os.getcwd()",
      "'pipNoInput': os.environ.get('PIP_NO_INPUT')",
      "'pipConfigFile': os.environ.get('PIP_CONFIG_FILE')",
      "'pipUser': os.environ.get('PIP_USER')",
      "'pythonPathPresent': 'PYTHONPATH' in environment_keys",
      "'pythonHomePresent': 'PYTHONHOME' in environment_keys"
    ]) {
      expect(source).toContain(field);
    }
    expect(source).toContain("with open(invocation_temporary, 'x', encoding='utf-8') as stream:");
    expect(source).toContain("with open(marker_temporary, 'xb') as stream:");
    expect(source.match(/stream\.flush\(\)\n {4}os\.fsync\(stream\.fileno\(\)\)/gu)).toHaveLength(2);
    expect(source.indexOf("os.replace(invocation_temporary, invocation_path)")).toBeLessThan(
      source.indexOf("with open(marker_temporary, 'xb') as stream:")
    );
    expect(source.indexOf("if sys.argv[1:] == ['check', '--disable-pip-version-check']:")).toBeLessThan(
      source.indexOf("expected = ['install', '--no-input', '--no-user', '--', 'openpyxl>=3.1.5,<4']")
    );
    expect(source).toContain("stream.write(b'openpyxl>=3.1.5,<4\\n')");
    expect(source.endsWith("\n")).toBe(true);
  });
});

function selectedPython(): string {
  return (
    process.env.OPEN_WRANGLER_TEST_PYTHON ??
    process.env.OPEN_WRANGLER_PYTHON ??
    (process.platform === "win32" ? "python" : "python3")
  );
}

type PythonProbeRunner = (options: RunOwnedPythonProbeOptions) => Promise<string>;

interface PythonProbeRunOverrides {
  readonly readiness?: PythonProbeReadiness;
  readonly terminateTree?: PythonProbeTreeTerminator;
  readonly timeoutMs?: number;
}

interface TreeFixture {
  readonly directory: string;
  readonly pidsPath: string;
  readonly source: string;
  readonly dispose: () => void;
}

const PROBE_READINESS: PythonProbeReadiness = {
  marker: "OPEN_WRANGLER_PYTHON_PROBE_READY_V1\n",
  timeoutMs: 5_000
};

async function runPythonProbe(
  source: string,
  execute: PythonProbeRunner = runOwnedPythonProbe,
  overrides: PythonProbeRunOverrides = {}
): Promise<Record<string, unknown>> {
  const timeoutMs = overrides.timeoutMs ?? PYTHON_PROBE_MAX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PYTHON_PROBE_MAX_TIMEOUT_MS) {
    throw new Error("The Excel dependency Python probe needs a positive bounded deadline.");
  }
  let output: string;
  try {
    output = await execute({
      executable: selectedPython(),
      source,
      timeoutMs,
      readiness: overrides.readiness,
      terminateTree: overrides.terminateTree
    });
  } catch (error) {
    const code = error instanceof PythonProbeProcessError ? error.code : undefined;
    if (code === "ETIMEDOUT") {
      throw new Error(`The Excel dependency Python probe exceeded its ${timeoutMs} ms deadline.`);
    }
    if (code === "ENOBUFS") {
      throw new Error(
        `The Excel dependency Python probe exceeded its ${PYTHON_PROBE_MAX_OUTPUT_BYTES}-byte output limit.`
      );
    }
    if (code === "EREADINESS") {
      throw new Error(
        `The Excel dependency Python probe did not become ready within its ${overrides.readiness?.timeoutMs ?? 0} ms deadline.`
      );
    }
    if (code === "ETREE") {
      throw new Error("The Excel dependency Python probe process tree could not be verified empty.");
    }
    throw new Error("The Excel dependency Python probe failed.");
  }

  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error("The Excel dependency Python probe returned malformed output.");
  }
}

function createTreeFixture(
  label: string,
  options: {
    readonly emitReadiness?: boolean;
    readonly overflowStream?: "stderr" | "stdout";
    readonly readinessDelaySeconds?: number;
  } = {}
): TreeFixture {
  const directory = mkdtempSync(path.join(tmpdir(), `openwrangler-excel-probe-${label}-`));
  const pidsPath = path.join(directory, "pids");
  const emitReadiness = options.emitReadiness ?? true;
  const source = [
    "import os",
    "import signal",
    "import subprocess",
    "import sys",
    "import time",
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    `time.sleep(${options.readinessDelaySeconds ?? 0})`,
    'descendant_source = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"',
    "descendant = subprocess.Popen([sys.executable, '-I', '-c', descendant_source])",
    `with open(${JSON.stringify(pidsPath)}, 'x', encoding='utf-8') as stream:`,
    "    stream.write(f'{os.getpid()}\\n{descendant.pid}\\n')",
    "    stream.flush()",
    ...(emitReadiness ? [`sys.stderr.write(${JSON.stringify(PROBE_READINESS.marker)})`, "sys.stderr.flush()"] : []),
    ...(options.overflowStream
      ? [
          `sys.${options.overflowStream}.write('x' * ${PYTHON_PROBE_MAX_OUTPUT_BYTES + 1})`,
          `sys.${options.overflowStream}.flush()`
        ]
      : []),
    "time.sleep(30)",
    "print('{}')"
  ].join("\n");
  return {
    directory,
    pidsPath,
    source,
    dispose: () => rmSync(directory, { force: true, recursive: true })
  };
}

function expectFixtureTreeGone(fixture: TreeFixture): void {
  const pids = readFileSync(fixture.pidsPath, "utf8")
    .trim()
    .split("\n")
    .map((value) => Number.parseInt(value, 10));
  expect(pids).toHaveLength(2);
  for (const pid of pids) {
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(processExists(pid)).toBe(false);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH";
  }
}

async function captureFailure(value: Promise<unknown>): Promise<Error> {
  try {
    await value;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected the Python probe to fail.");
}
