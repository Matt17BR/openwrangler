import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
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

  it("blocks the production-shaped module probe only until the install marker exists", () => {
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
      const before = runPythonProbe(probe);
      expect(before).toMatchObject({ find_spec: false, missing: "openpyxl", module: null, other: "json" });
      expect(before.version).toEqual(expect.any(String));

      writeFileSync(marker, "openpyxl installed\n", { encoding: "utf8", flag: "wx" });
      const after = runPythonProbe(probe);
      expect(after).toMatchObject({ find_spec: true, module: "openpyxl", other: "json", version: before.version });
      expect(after).not.toHaveProperty("missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("owns a finite deadline and output bound for both synchronous Python probes", () => {
    const calls: { readonly args: readonly string[]; readonly options: ExecFileSyncOptionsWithStringEncoding }[] = [];
    const execute: PythonProbeExecutor = (_file, args, options) => {
      calls.push({ args, options });
      return "{}";
    };

    expect(runPythonProbe("pass", execute)).toEqual({});
    expect(runPythonProbe("pass", execute)).toEqual({});
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toEqual(["-I", "-c", "pass"]);
      expect(call.options).toEqual({
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: PYTHON_PROBE_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PYTHON_PROBE_TIMEOUT_MS,
        windowsHide: true
      });
    }
  });

  it("hard-terminates a real Python probe that ignores SIGTERM", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-excel-probe-settlement-"));
    const ready = path.join(directory, "ready");
    const timeoutMs = 250;
    const maximumSettlementMs = 1_500;
    const source = [
      "import signal",
      "import time",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      `with open(${JSON.stringify(ready)}, 'x', encoding='utf-8') as stream:`,
      "    stream.write('ready\\n')",
      "    stream.flush()",
      "time.sleep(3)",
      "print('{}')"
    ].join("\n");

    try {
      const startedAt = performance.now();
      let observed: unknown;
      try {
        runPythonProbe(source, executePythonProbe, timeoutMs);
      } catch (error) {
        observed = error;
      }
      const elapsedMs = performance.now() - startedAt;

      expect(readFileSync(ready, "utf8")).toBe("ready\n");
      expect(observed).toBeInstanceOf(Error);
      expect((observed as Error).message).toBe(
        `The Excel dependency Python probe exceeded its ${timeoutMs} ms deadline.`
      );
      expect(elapsedMs).toBeLessThan(maximumSettlementMs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 5_000);

  it.each([
    ["ETIMEDOUT", `The Excel dependency Python probe exceeded its ${PYTHON_PROBE_TIMEOUT_MS} ms deadline.`],
    ["ENOBUFS", `The Excel dependency Python probe exceeded its ${PYTHON_PROBE_MAX_BUFFER_BYTES}-byte output limit.`]
  ])("classifies a bounded %s child-process failure without private diagnostics", (code, expected) => {
    const execute: PythonProbeExecutor = () => {
      throw Object.assign(new Error("private interpreter and marker path"), { code });
    };

    let observed: unknown;
    try {
      runPythonProbe("pass", execute);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toBe(expected);
    expect((observed as Error).message.length).toBeLessThanOrEqual(128);
    expect((observed as Error).message).not.toContain("private");
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

const PYTHON_PROBE_TIMEOUT_MS = 30_000;
const PYTHON_PROBE_MAX_BUFFER_BYTES = 64 * 1024;

type PythonProbeExecutor = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding
) => string;

const executePythonProbe: PythonProbeExecutor = (file, args, options) => execFileSync(file, [...args], options);

function runPythonProbe(
  source: string,
  execute: PythonProbeExecutor = executePythonProbe,
  timeoutMs = PYTHON_PROBE_TIMEOUT_MS
): Record<string, unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PYTHON_PROBE_TIMEOUT_MS) {
    throw new Error("The Excel dependency Python probe needs a positive bounded deadline.");
  }
  let output: string;
  try {
    output = execute(selectedPython(), ["-I", "-c", source], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: PYTHON_PROBE_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ETIMEDOUT") {
      throw new Error(`The Excel dependency Python probe exceeded its ${timeoutMs} ms deadline.`);
    }
    if (code === "ENOBUFS") {
      throw new Error(
        `The Excel dependency Python probe exceeded its ${PYTHON_PROBE_MAX_BUFFER_BYTES}-byte output limit.`
      );
    }
    throw new Error("The Excel dependency Python probe failed.");
  }

  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error("The Excel dependency Python probe returned malformed output.");
  }
}
