import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { sameAcceptanceExecutable } from "./dependencyInstallLifecycleFixture";

export interface ExcelDependencyInstallFixture {
  readonly executable: string;
  readonly marker: string;
  readonly invocation: string;
}

export function packagedExcelDependencyWorkbookSource(): string {
  return [
    "import sys",
    "from openpyxl import Workbook",
    "workbook = Workbook()",
    "sheet = workbook.active",
    "sheet.title = 'Regional orders'",
    "sheet.append(['order_id', 'market', 'revenue', 'fulfilled', 'order_date', 'account_status'])",
    "markets = ['DACH', 'Nordics', 'Iberia', 'France', 'Italy', 'Benelux', 'UK & Ireland']",
    "statuses = ['Active', 'Expansion', 'Renewal review']",
    "for index in range(64):",
    "    sheet.append([",
    "        f'OW-{240001 + index}',",
    "        markets[index % len(markets)],",
    "        round(620.5 + index * 79.19, 2),",
    "        index % 5 != 2,",
    "        f'2026-01-{(index % 28) + 1:02d}',",
    "        statuses[index % len(statuses)],",
    "    ])",
    "workbook.save(sys.argv[1])"
  ].join("\n");
}

export function excelDependencyGateSource(marker: string): string {
  return [
    "import importlib.util as _openwrangler_importlib_util",
    "import os as _openwrangler_os",
    `_openwrangler_marker = ${JSON.stringify(marker)}`,
    "_openwrangler_find_spec_original = _openwrangler_importlib_util.find_spec",
    "def _openwrangler_find_spec(name, package=None):",
    "    if name == 'openpyxl' and not _openwrangler_os.path.exists(_openwrangler_marker):",
    "        return None",
    "    return _openwrangler_find_spec_original(name, package)",
    "_openwrangler_importlib_util.find_spec = _openwrangler_find_spec",
    ""
  ].join("\n");
}

export function excelDependencyPipSource(marker: string, invocation: string): string {
  return [
    "import json",
    "import os",
    "import sys",
    "",
    `marker_path = ${JSON.stringify(marker)}`,
    `invocation_path = ${JSON.stringify(invocation)}`,
    "expected = ['install', '--no-input', '--no-user', '--', 'openpyxl>=3.1.5']",
    "if sys.argv[1:] != expected:",
    "    raise SystemExit(91)",
    "environment_keys = {key.upper() for key in os.environ}",
    "details = {",
    "    'args': sys.argv[1:],",
    "    'cwd': os.getcwd(),",
    "    'pipNoInput': os.environ.get('PIP_NO_INPUT'),",
    "    'pipConfigFile': os.environ.get('PIP_CONFIG_FILE'),",
    "    'pipUser': os.environ.get('PIP_USER'),",
    "    'pythonPathPresent': 'PYTHONPATH' in environment_keys,",
    "    'pythonHomePresent': 'PYTHONHOME' in environment_keys,",
    "}",
    "invocation_temporary = f'{invocation_path}.{os.getpid()}.tmp'",
    "with open(invocation_temporary, 'x', encoding='utf-8') as stream:",
    "    json.dump(details, stream, sort_keys=True)",
    "    stream.flush()",
    "    os.fsync(stream.fileno())",
    "os.replace(invocation_temporary, invocation_path)",
    "marker_temporary = f'{marker_path}.{os.getpid()}.tmp'",
    "with open(marker_temporary, 'xb') as stream:",
    "    stream.write(b'openpyxl>=3.1.5\\n')",
    "    stream.flush()",
    "    os.fsync(stream.fileno())",
    "os.replace(marker_temporary, marker_path)",
    ""
  ].join("\n");
}

export function createPackagedExcelDependencyWorkbook(workbookPath: string, python: string): void {
  execFileSync(python, ["-I", "-c", packagedExcelDependencyWorkbookSource(), workbookPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true
  });
  const metadata = lstatSync(workbookPath);
  assert.ok(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
    "The XLSX dependency-install fixture must be one exclusively owned regular file."
  );
}

export function createExcelDependencyInstallPython(directory: string, python: string): ExcelDependencyInstallFixture {
  const parent = JSON.parse(
    execFileSync(
      python,
      [
        "-I",
        "-c",
        [
          "import importlib.metadata",
          "import json",
          "import pip",
          "import pip._vendor.packaging.specifiers",
          "import pip._vendor.packaging.version",
          "import sys",
          "import sysconfig",
          "print(json.dumps({",
          "    'executable': sys.executable,",
          "    'purelib': sysconfig.get_path('purelib'),",
          "    'pip': pip.__file__,",
          "    'pipSpecifiers': pip._vendor.packaging.specifiers.__file__,",
          "    'pipVersion': pip._vendor.packaging.version.__file__,",
          "    'pandas': importlib.metadata.version('pandas'),",
          "    'openpyxl': importlib.metadata.version('openpyxl'),",
          "}, sort_keys=True))"
        ].join("\n")
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true
      }
    )
  ) as Record<string, unknown>;
  assert.equal(
    typeof parent.executable === "string" && path.isAbsolute(parent.executable),
    true,
    "The XLSX dependency fixture requires an absolute parent interpreter."
  );
  assert.equal(
    typeof parent.purelib === "string" && path.isAbsolute(parent.purelib),
    true,
    "The XLSX dependency fixture requires an absolute parent package root."
  );
  assert.equal(typeof parent.pandas === "string" && parent.pandas.length > 0, true);
  assert.equal(typeof parent.openpyxl === "string" && parent.openpyxl.length > 0, true);
  assert.equal(typeof parent.pip === "string" && path.isAbsolute(parent.pip), true);
  assert.equal(typeof parent.pipSpecifiers === "string" && path.isAbsolute(parent.pipSpecifiers), true);
  assert.equal(typeof parent.pipVersion === "string" && path.isAbsolute(parent.pipVersion), true);
  assert.equal(
    lstatSync(String(parent.purelib)).isDirectory(),
    true,
    "The XLSX dependency fixture parent package root must remain a directory."
  );
  assert.doesNotMatch(String(parent.purelib), /[\r\n]/u, "A Python package root must not contain line breaks.");
  const parentPipPackage = path.dirname(String(parent.pip));
  const parentPipRelative = path.relative(String(parent.purelib), parentPipPackage);
  assert.equal(
    parentPipRelative.length > 0 &&
      parentPipRelative !== ".." &&
      !parentPipRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(parentPipRelative),
    true,
    "The fixture PEP 440 authority must belong to the selected parent interpreter's package root."
  );
  assert.equal(lstatSync(parentPipPackage).isDirectory(), true);

  const environment = path.join(directory, "environment");
  execFileSync(python, ["-m", "venv", "--without-pip", environment], {
    stdio: "pipe",
    timeout: 30_000,
    windowsHide: true
  });
  const executable =
    process.platform === "win32"
      ? path.join(environment, "Scripts", "python.exe")
      : path.join(environment, "bin", "python");
  assert.ok(existsSync(executable), "The XLSX dependency-test environment is missing its interpreter.");
  const sitePackages = execFileSync(
    executable,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  assert.ok(path.isAbsolute(sitePackages), "The XLSX dependency-test environment returned invalid site-packages.");

  const marker = path.join(directory, "openpyxl-installed");
  const invocation = path.join(directory, "pip-invocation.json");
  writeFileSync(path.join(sitePackages, "00-openwrangler-parent-packages.pth"), `${String(parent.purelib)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  writeFileSync(path.join(sitePackages, "openwrangler_dependency_gate.py"), excelDependencyGateSource(marker), {
    encoding: "utf8",
    flag: "wx"
  });
  writeFileSync(
    path.join(sitePackages, "01-openwrangler-dependency-gate.pth"),
    "import openwrangler_dependency_gate\n",
    { encoding: "utf8", flag: "wx" }
  );

  const pipPackage = path.join(sitePackages, "pip");
  mkdirSync(pipPackage);
  writeFileSync(path.join(pipPackage, "__init__.py"), `__path__.append(${JSON.stringify(parentPipPackage)})\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  writeFileSync(path.join(pipPackage, "__main__.py"), excelDependencyPipSource(marker, invocation), {
    encoding: "utf8",
    flag: "wx"
  });

  const preflight = JSON.parse(
    execFileSync(
      executable,
      [
        "-I",
        "-c",
        [
          "import importlib.metadata",
          "import importlib.util",
          "import json",
          "import pip",
          "import pip._vendor.packaging.specifiers",
          "import pip._vendor.packaging.version",
          "import sys",
          "print(json.dumps({",
          "    'executable': sys.executable,",
          "    'prefix': sys.prefix,",
          "    'pandas': importlib.util.find_spec('pandas') is not None,",
          "    'pandasVersion': importlib.metadata.version('pandas'),",
          "    'openpyxl': importlib.util.find_spec('openpyxl') is not None,",
          "    'pip': pip.__file__,",
          "    'pipSpecifiers': pip._vendor.packaging.specifiers.__file__,",
          "    'pipVersion': pip._vendor.packaging.version.__file__,",
          "    'pandasSupported': pip._vendor.packaging.specifiers.SpecifierSet('').contains(",
          "        pip._vendor.packaging.version.Version(importlib.metadata.version('pandas')), prereleases=True",
          "    ),",
          "}, sort_keys=True))"
        ].join("\n")
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true
      }
    )
  ) as Record<string, unknown>;
  assert.equal(
    typeof preflight.executable === "string" && sameAcceptanceExecutable(preflight.executable, executable),
    true,
    "The XLSX dependency-test interpreter must report the exact selected virtual-environment executable."
  );
  assert.equal(
    typeof preflight.prefix === "string" && sameAcceptanceExecutable(preflight.prefix, environment),
    true,
    "The XLSX dependency-test interpreter must retain its isolated virtual-environment prefix."
  );
  assert.equal(preflight.pandas, true, "The XLSX dependency-test environment must retain Pandas.");
  assert.equal(preflight.pandasVersion, parent.pandas);
  assert.equal(preflight.pandasSupported, true, "The selected PEP 440 authority must accept installed Pandas.");
  assert.equal(
    typeof preflight.pipSpecifiers === "string" &&
      sameAcceptanceExecutable(preflight.pipSpecifiers, String(parent.pipSpecifiers)),
    true,
    "The fixture must use the selected parent interpreter's exact SpecifierSet implementation."
  );
  assert.equal(
    typeof preflight.pipVersion === "string" &&
      sameAcceptanceExecutable(preflight.pipVersion, String(parent.pipVersion)),
    true,
    "The fixture must use the selected parent interpreter's exact Version implementation."
  );
  assert.equal(preflight.openpyxl, false, "The XLSX dependency-test environment must initially hide openpyxl.");
  assert.equal(
    typeof preflight.pip === "string" && sameAcceptanceExecutable(preflight.pip, path.join(pipPackage, "__init__.py")),
    true,
    "The XLSX dependency-test environment must import only its owned fake pip package."
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(invocation), false);
  return { executable, marker, invocation };
}
