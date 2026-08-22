import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export interface DependencyInstallLifecycleFixture {
  readonly executable: string;
  readonly started: string;
  readonly release: string;
  readonly completed: string;
}

export interface DependencyInstallLifecycleSources {
  readonly fakePip: string;
  readonly siteCustomize: string;
}

export interface DependencyInstallParentPipAuthority {
  readonly packagePath: string;
  readonly packagingRequirementsPath: string;
  readonly packagingSpecifiersPath: string;
  readonly packagingUtilsPath: string;
  readonly packagingVersionPath: string;
  readonly version: string;
}

export type DependencyInstallCommandOutcome =
  { readonly status: "fulfilled"; readonly value: boolean } | { readonly status: "rejected"; readonly error: unknown };

interface DependencyInstallParentPipReceipt {
  readonly executable?: unknown;
  readonly pipImportRoot?: unknown;
  readonly pip?: unknown;
  readonly pipDistributionVersion?: unknown;
  readonly pipRequirements?: unknown;
  readonly pipSpecifiers?: unknown;
  readonly pipUtils?: unknown;
  readonly pipVersion?: unknown;
}

interface DirectoryStatus {
  isDirectory(): boolean;
}

interface WaitForDependencyInstallStartOptions {
  readonly pendingCommand: PromiseLike<DependencyInstallCommandOutcome>;
  readonly started: string;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, description: string) => Promise<void>;
}

const DEPENDENCY_INSTALL_START_TIMEOUT_MS = 10_000;
const DEPENDENCY_INSTALL_START_DESCRIPTION = "the disposable fake pip process to publish its start marker";

export function sameAcceptanceExecutable(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

export function dependencyIsolatedInvocationSource(invocationLog: string): string {
  return `import builtins; builtins.open(${JSON.stringify(invocationLog)}, "a", encoding="utf-8").write("invoked\\n")\n`;
}

function requireAbsoluteReceiptPath(value: unknown, label: string): string {
  assert.equal(
    typeof value === "string" && path.isAbsolute(value) && !/[\r\n]/u.test(value),
    true,
    `${label} must be one absolute path without line breaks.`
  );
  return value as string;
}

function pathBelongsTo(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

export function validateDependencyInstallParentPipAuthority(
  receipt: DependencyInstallParentPipReceipt,
  readStatus: (candidate: string) => DirectoryStatus = lstatSync
): DependencyInstallParentPipAuthority {
  requireAbsoluteReceiptPath(receipt.executable, "The lifecycle fixture parent interpreter");
  const pipImportRoot = requireAbsoluteReceiptPath(
    receipt.pipImportRoot,
    "The lifecycle fixture parent pip import root"
  );
  const pipPath = requireAbsoluteReceiptPath(receipt.pip, "The lifecycle fixture parent pip module");
  const packagingRequirementsPath = requireAbsoluteReceiptPath(
    receipt.pipRequirements,
    "The lifecycle fixture parent packaging Requirement implementation"
  );
  const packagingSpecifiersPath = requireAbsoluteReceiptPath(
    receipt.pipSpecifiers,
    "The lifecycle fixture parent packaging SpecifierSet implementation"
  );
  const packagingUtilsPath = requireAbsoluteReceiptPath(
    receipt.pipUtils,
    "The lifecycle fixture parent packaging name implementation"
  );
  const packagingVersionPath = requireAbsoluteReceiptPath(
    receipt.pipVersion,
    "The lifecycle fixture parent packaging Version implementation"
  );
  const version = receipt.pipDistributionVersion;
  assert.equal(
    typeof version === "string" && version.length > 0 && version.length <= 128 && !/[\r\n]/u.test(version),
    true,
    "The lifecycle fixture parent pip version must be bounded text."
  );
  assert.equal(readStatus(pipImportRoot).isDirectory(), true, "The parent pip import root must be a directory.");

  const packagePath = path.dirname(pipPath);
  assert.equal(
    pathBelongsTo(pipImportRoot, packagePath),
    true,
    "The lifecycle fixture PEP 440 authority must belong to the selected parent interpreter's import root."
  );
  assert.equal(
    readStatus(packagePath).isDirectory(),
    true,
    "The lifecycle fixture parent pip package must be a directory."
  );

  const packagingPath = path.join(packagePath, "_vendor", "packaging");
  for (const [label, candidate, name] of [
    ["Requirement", packagingRequirementsPath, "requirements.py"],
    ["SpecifierSet", packagingSpecifiersPath, "specifiers.py"],
    ["canonical name", packagingUtilsPath, "utils.py"],
    ["Version", packagingVersionPath, "version.py"]
  ] as const) {
    assert.equal(
      sameAcceptanceExecutable(candidate, path.join(packagingPath, name)),
      true,
      `The lifecycle fixture ${label} implementation must belong to the verified parent pip packaging owner.`
    );
  }
  assert.equal(
    readStatus(packagingPath).isDirectory(),
    true,
    "The lifecycle fixture parent pip packaging owner must be a directory."
  );

  return {
    packagePath,
    packagingRequirementsPath,
    packagingSpecifiersPath,
    packagingUtilsPath,
    packagingVersionPath,
    version: version as string
  };
}

export function dependencyInstallPipInitSource(authority: DependencyInstallParentPipAuthority): string {
  return [
    `__version__ = ${JSON.stringify(authority.version)}`,
    `__path__.append(${JSON.stringify(authority.packagePath)})`,
    ""
  ].join("\n");
}

export async function waitForDependencyInstallLifecycleStart({
  pendingCommand,
  started,
  waitFor
}: WaitForDependencyInstallStartOptions): Promise<void> {
  const marker = waitFor(
    () => existsSync(started),
    DEPENDENCY_INSTALL_START_TIMEOUT_MS,
    DEPENDENCY_INSTALL_START_DESCRIPTION
  ).then(
    () => ({ kind: "started" as const }),
    (error: unknown) => ({ kind: "marker-rejected" as const, error })
  );
  const command = pendingCommand.then((outcome) => ({ kind: "command-settled" as const, outcome }));
  const result = await Promise.race([marker, command]);
  if (result.kind === "started") return;
  if (result.kind === "marker-rejected") throw result.error;
  if (result.outcome.status === "rejected") throw result.outcome.error;
  throw new Error(
    `The dependency install command fulfilled with ${String(result.outcome.value)} before the disposable fake pip process published its start marker.`
  );
}

export function dependencyInstallLifecycleSources(
  started: string,
  release: string,
  completed: string
): DependencyInstallLifecycleSources {
  return {
    fakePip: [
      "import json",
      "import os",
      "import sys",
      "import time",
      "",
      `started_path = ${JSON.stringify(started)}`,
      `release_path = ${JSON.stringify(release)}`,
      `completed_path = ${JSON.stringify(completed)}`,
      "if sys.argv[1:] == ['check', '--disable-pip-version-check']:",
      "    raise SystemExit(0)",
      "environment_keys = {key.upper() for key in os.environ}",
      "def publish_json(path, value):",
      "    temporary_path = f'{path}.{os.getpid()}.tmp'",
      "    with open(temporary_path, 'x', encoding='utf-8') as stream:",
      "        json.dump(value, stream, sort_keys=True)",
      "        stream.flush()",
      "        os.fsync(stream.fileno())",
      "    os.replace(temporary_path, path)",
      "",
      "details = {",
      '    "args": sys.argv[1:],',
      '    "cwd": os.getcwd(),',
      '    "pipNoInput": os.environ.get("PIP_NO_INPUT"),',
      '    "pipConfigFile": os.environ.get("PIP_CONFIG_FILE"),',
      '    "pipUser": os.environ.get("PIP_USER"),',
      '    "pythonPathPresent": "PYTHONPATH" in environment_keys,',
      '    "pythonHomePresent": "PYTHONHOME" in environment_keys,',
      "}",
      "publish_json(started_path, details)",
      "deadline = time.monotonic() + 30",
      "while not os.path.exists(release_path):",
      "    if time.monotonic() >= deadline:",
      "        raise SystemExit(92)",
      "    time.sleep(0.025)",
      "publish_json(completed_path, {**details, 'released': True})",
      ""
    ].join("\n"),
    siteCustomize: [
      "import os",
      "import sys",
      'sys.path[:] = [entry for entry in sys.path if entry != ""]',
      "cwd = os.path.normcase(os.path.abspath(os.getcwd()))",
      "sys.path[:] = [",
      "    entry",
      "    for entry in sys.path",
      "    if os.path.normcase(os.path.abspath(entry)) != cwd",
      "]",
      ""
    ].join("\n")
  };
}

export function createDependencyIsolatedPython(directory: string, python: string, invocationLog: string): string {
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
  assert.ok(existsSync(executable), "The dependency-isolated Python environment is missing its interpreter.");
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
  assert.ok(path.isAbsolute(sitePackages), "The dependency-isolated environment returned an invalid site-packages.");
  writeFileSync(
    path.join(sitePackages, "openwrangler-acceptance-invocations.pth"),
    dependencyIsolatedInvocationSource(invocationLog),
    { encoding: "utf8", flag: "wx" }
  );
  return executable;
}

export function createDependencyInstallLifecyclePython(
  directory: string,
  dependencyPython: string
): DependencyInstallLifecycleFixture {
  const started = path.join(directory, "pip-started.json");
  const release = path.join(directory, "release-pip");
  const completed = path.join(directory, "pip-completed.json");
  const sources = dependencyInstallLifecycleSources(started, release, completed);

  const parentPip = validateDependencyInstallParentPipAuthority(
    JSON.parse(
      execFileSync(
        dependencyPython,
        [
          "-I",
          "-c",
          [
            "import importlib.metadata",
            "import json",
            "import os",
            "import pip",
            "import pip._vendor.packaging.requirements",
            "import pip._vendor.packaging.specifiers",
            "import pip._vendor.packaging.utils",
            "import pip._vendor.packaging.version",
            "import sys",
            "def owns(root, candidate):",
            "    try:",
            "        normalized_root = os.path.abspath(root)",
            "        return os.path.commonpath((normalized_root, os.path.abspath(candidate))) == normalized_root",
            "    except ValueError:",
            "        return False",
            "pip_roots = [os.path.abspath(entry) for entry in sys.path if entry and owns(entry, pip.__file__)]",
            "print(json.dumps({",
            "    'executable': sys.executable,",
            "    'pipImportRoot': max(pip_roots, key=len) if pip_roots else None,",
            "    'pip': pip.__file__,",
            "    'pipDistributionVersion': importlib.metadata.version('pip'),",
            "    'pipRequirements': pip._vendor.packaging.requirements.__file__,",
            "    'pipSpecifiers': pip._vendor.packaging.specifiers.__file__,",
            "    'pipUtils': pip._vendor.packaging.utils.__file__,",
            "    'pipVersion': pip._vendor.packaging.version.__file__,",
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
    ) as DependencyInstallParentPipReceipt
  );

  const environment = path.join(directory, "environment");
  execFileSync(dependencyPython, ["-m", "venv", "--without-pip", environment], {
    stdio: "pipe",
    timeout: 30_000,
    windowsHide: true
  });
  const executable =
    process.platform === "win32"
      ? path.join(environment, "Scripts", "python.exe")
      : path.join(environment, "bin", "python");
  assert.ok(existsSync(executable), "The lifecycle-test Python environment is missing its interpreter.");
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
  assert.ok(path.isAbsolute(sitePackages), "The lifecycle-test environment returned invalid site-packages.");
  writeFileSync(path.join(sitePackages, "sitecustomize.py"), sources.siteCustomize, {
    encoding: "utf8",
    flag: "wx"
  });
  const pipPackage = path.join(sitePackages, "pip");
  mkdirSync(pipPackage);
  writeFileSync(path.join(pipPackage, "__init__.py"), dependencyInstallPipInitSource(parentPip), {
    encoding: "utf8",
    flag: "wx"
  });
  writeFileSync(path.join(pipPackage, "__main__.py"), sources.fakePip, { encoding: "utf8", flag: "wx" });
  const preflight = JSON.parse(
    execFileSync(
      executable,
      [
        "-I",
        "-c",
        [
          "import importlib.util",
          "import json",
          "import pip",
          "import pip._vendor.packaging.requirements",
          "import pip._vendor.packaging.specifiers",
          "import pip._vendor.packaging.utils",
          "import pip._vendor.packaging.version",
          "import sys",
          "print(json.dumps({",
          "    'executable': sys.executable,",
          "    'prefix': sys.prefix,",
          "    'pandas': importlib.util.find_spec('pandas') is not None,",
          "    'xlrd': importlib.util.find_spec('xlrd') is not None,",
          "    'pip': pip.__file__,",
          "    'pipRequirements': pip._vendor.packaging.requirements.__file__,",
          "    'pipSpecifiers': pip._vendor.packaging.specifiers.__file__,",
          "    'pipUtils': pip._vendor.packaging.utils.__file__,",
          "    'pipVersion': pip._vendor.packaging.version.__file__,",
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
    "The lifecycle-test interpreter must report the exact selected virtual-environment executable."
  );
  assert.equal(
    typeof preflight.prefix === "string" && sameAcceptanceExecutable(preflight.prefix, environment),
    true,
    "The lifecycle-test interpreter must retain its isolated virtual-environment prefix."
  );
  assert.equal(preflight.pandas, false, "The lifecycle-test environment must not expose pandas.");
  assert.equal(preflight.xlrd, false, "The lifecycle-test environment must not expose xlrd.");
  for (const [field, expected, label] of [
    ["pipRequirements", parentPip.packagingRequirementsPath, "Requirement"],
    ["pipSpecifiers", parentPip.packagingSpecifiersPath, "SpecifierSet"],
    ["pipUtils", parentPip.packagingUtilsPath, "canonical name"],
    ["pipVersion", parentPip.packagingVersionPath, "Version"]
  ] as const) {
    assert.equal(
      typeof preflight[field] === "string" && sameAcceptanceExecutable(preflight[field], expected),
      true,
      `The lifecycle-test environment must use the selected parent interpreter's exact ${label} implementation.`
    );
  }
  assert.equal(
    typeof preflight.pip === "string" && sameAcceptanceExecutable(preflight.pip, path.join(pipPackage, "__init__.py")),
    true,
    "The lifecycle-test environment must import only its owned fake pip package."
  );
  return { executable, started, release, completed };
}
