import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  writeFileSync(path.join(pipPackage, "__init__.py"), "", { encoding: "utf8", flag: "wx" });
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
          "import sys",
          "print(json.dumps({",
          "    'executable': sys.executable,",
          "    'prefix': sys.prefix,",
          "    'pandas': importlib.util.find_spec('pandas') is not None,",
          "    'xlrd': importlib.util.find_spec('xlrd') is not None,",
          "    'pip': pip.__file__,",
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
  assert.equal(
    typeof preflight.pip === "string" && sameAcceptanceExecutable(preflight.pip, path.join(pipPackage, "__init__.py")),
    true,
    "The lifecycle-test environment must import only its owned fake pip package."
  );
  return { executable, started, release, completed };
}
