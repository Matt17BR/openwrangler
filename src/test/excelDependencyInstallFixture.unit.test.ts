import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
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
      const before = JSON.parse(execFileSync(selectedPython(), ["-I", "-c", probe], { encoding: "utf8" })) as Record<
        string,
        unknown
      >;
      expect(before).toMatchObject({ find_spec: false, missing: "openpyxl", module: null, other: "json" });
      expect(before.version).toEqual(expect.any(String));

      writeFileSync(marker, "openpyxl installed\n", { encoding: "utf8", flag: "wx" });
      const after = JSON.parse(execFileSync(selectedPython(), ["-I", "-c", probe], { encoding: "utf8" })) as Record<
        string,
        unknown
      >;
      expect(after).toMatchObject({ find_spec: true, module: "openpyxl", other: "json", version: before.version });
      expect(after).not.toHaveProperty("missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
