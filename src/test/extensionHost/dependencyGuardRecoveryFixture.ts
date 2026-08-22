import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { sameAcceptanceExecutable } from "./dependencyInstallLifecycleFixture";

export const DEPENDENCY_GUARD_PROTOCOL = "openwrangler-dependency-guard-v1";
export const DEPENDENCY_GUARD_ACCEPTANCE_TOKEN = "22222222-2222-4222-8222-222222222222";
export const DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE = 197;
export const DEPENDENCY_GUARD_FIXTURE_IMPORT_MODULE = "openwrangler_guard_fixture";
export const DEPENDENCY_GUARD_FIXTURE_IMPORT_FILE = `${DEPENDENCY_GUARD_FIXTURE_IMPORT_MODULE}/__init__.py`;
export const DEPENDENCY_GUARD_FIXTURE_DISTRIBUTION = "openwrangler-guard-fixture";
export const DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY = "openwrangler_guard_fixture-1.0.0.dist-info";

export interface DependencyGuardAcceptanceEnvironment {
  executable: string;
  executableIdentity: {
    device: string;
    inode: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
  };
  packageRoot: string;
  packageRootIdentity: {
    device: string;
    inode: string;
  };
  pythonVersion: string;
}

export interface DependencyGuardAcceptanceDependency {
  importModule: string;
  distribution: string;
  installSpec: string;
  exactVersion: string | null;
  minimumVersion: string | null;
  maximumVersionExclusive: string | null;
}

export interface DependencyGuardRecoveryFixture {
  directory: string;
  executable: string;
  helperPath: string;
  environment: DependencyGuardAcceptanceEnvironment;
  dependency: DependencyGuardAcceptanceDependency;
  marker: string;
  pipStarted: string;
  pipRelease: string;
  pipCompleted: string;
  parentScript: string;
  parentState: string;
  parentAuthorized: string;
  parentCrashFrame: string;
  invocationLog: string;
  dependencyProbeLog: string;
}

export function dependencyGuardInvocationRecorderSource(invocationLog: string): string {
  return [
    "import json, os, sys; ",
    `stream = open(${JSON.stringify(invocationLog)}, "a", encoding="utf-8"); `,
    "stream.write(json.dumps(sys.argv, separators=(',', ':')) + '\\n'); ",
    "stream.flush(); os.fsync(stream.fileno()); stream.close()"
  ].join("");
}

export function dependencyGuardProbeRecorderSource(dependencyProbeLog: string): string {
  return [
    "import importlib.util",
    "import json",
    "import os",
    "",
    `_log_path = ${JSON.stringify(dependencyProbeLog)}`,
    "_original_find_spec = importlib.util.find_spec",
    "",
    "def _recording_find_spec(name, *args, **kwargs):",
    "    with open(_log_path, 'a', encoding='utf-8') as stream:",
    "        stream.write(json.dumps({'module': name}, separators=(',', ':')) + '\\n')",
    "        stream.flush()",
    "        os.fsync(stream.fileno())",
    "    return _original_find_spec(name, *args, **kwargs)",
    "",
    "importlib.util.find_spec = _recording_find_spec",
    ""
  ].join("\n");
}

export function dependencyGuardFixtureRecordSource(): string {
  return [
    `${DEPENDENCY_GUARD_FIXTURE_IMPORT_FILE},,`,
    `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/METADATA,,`,
    `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/RECORD,,`,
    ""
  ].join("\n");
}

export function createDependencyGuardFixtureDistribution(environmentSitePackages: string): void {
  const fixturePackage = path.join(environmentSitePackages, DEPENDENCY_GUARD_FIXTURE_IMPORT_MODULE);
  mkdirSync(fixturePackage);
  writeFileSync(path.join(fixturePackage, "__init__.py"), "", { encoding: "utf8", flag: "wx" });
  const fixtureMetadata = path.join(environmentSitePackages, DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY);
  mkdirSync(fixtureMetadata);
  writeFileSync(
    path.join(fixtureMetadata, "METADATA"),
    ["Metadata-Version: 2.1", `Name: ${DEPENDENCY_GUARD_FIXTURE_DISTRIBUTION}`, "Version: 1.0.0", ""].join("\n"),
    { encoding: "utf8", flag: "wx" }
  );
  writeFileSync(path.join(fixtureMetadata, "RECORD"), dependencyGuardFixtureRecordSource(), {
    encoding: "utf8",
    flag: "wx"
  });
}

export function dependencyGuardFakePipSource(started: string, release: string, completed: string): string {
  return [
    "import json",
    "import os",
    "import sys",
    "import time",
    "",
    `started_path = ${JSON.stringify(started)}`,
    `release_path = ${JSON.stringify(release)}`,
    `completed_path = ${JSON.stringify(completed)}`,
    "if sys.argv[1:] == ['check', '--disable-pip-version-check']:",
    "    from pip._internal.cli.main import main as pip_main",
    "    raise SystemExit(pip_main(sys.argv[1:]))",
    "def publish_json(path, value):",
    "    temporary_path = f'{path}.{os.getpid()}.tmp'",
    "    with open(temporary_path, 'x', encoding='utf-8') as stream:",
    "        json.dump(value, stream, sort_keys=True)",
    "        stream.flush()",
    "        os.fsync(stream.fileno())",
    "    os.replace(temporary_path, path)",
    "",
    "publish_json(started_path, {'args': sys.argv[1:]})",
    "deadline = time.monotonic() + 60",
    "while not os.path.exists(release_path):",
    "    if time.monotonic() >= deadline:",
    "        raise SystemExit(91)",
    "    time.sleep(0.025)",
    "publish_json(completed_path, {'completed': True})",
    ""
  ].join("\n");
}

export function dependencyGuardProtocolFrames(
  environment: DependencyGuardAcceptanceEnvironment,
  dependency: DependencyGuardAcceptanceDependency
): { readonly install: string; readonly go: string; readonly crash: string } {
  return {
    install: `${JSON.stringify({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "install",
      token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN,
      environment,
      dependencies: [dependency]
    })}\n`,
    go: `${JSON.stringify({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "go",
      token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
    })}\n`,
    crash: `${JSON.stringify({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "crash",
      token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
    })}\n`
  };
}

export interface DependencyGuardParentSourceOptions {
  readonly directory: string;
  readonly helperPath: string;
  readonly parentState: string;
  readonly parentAuthorized: string;
  readonly pipRelease: string;
  readonly installFrame: string;
  readonly goFrame: string;
  readonly parentCrashFrame: string;
}

export function dependencyGuardParentSource(options: DependencyGuardParentSourceOptions): string {
  return [
    "import json",
    "import os",
    "import subprocess",
    "import sys",
    "",
    `helper_path = ${JSON.stringify(options.helperPath)}`,
    `working_directory = ${JSON.stringify(options.directory)}`,
    `state_path = ${JSON.stringify(options.parentState)}`,
    `authorized_path = ${JSON.stringify(options.parentAuthorized)}`,
    `release_path = ${JSON.stringify(options.pipRelease)}`,
    `install_frame = ${JSON.stringify(options.installFrame)}.encode('ascii')`,
    `go_frame = ${JSON.stringify(options.goFrame)}.encode('ascii')`,
    `crash_frame = ${JSON.stringify(options.parentCrashFrame)}.encode('ascii')`,
    `expected_token = ${JSON.stringify(DEPENDENCY_GUARD_ACCEPTANCE_TOKEN)}`,
    `protocol = ${JSON.stringify(DEPENDENCY_GUARD_PROTOCOL)}`,
    `crash_exit_code = ${DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE}`,
    "",
    "def publish(path, payload):",
    "    temporary_path = f'{path}.{os.getpid()}.tmp'",
    "    with open(temporary_path, 'x', encoding='utf-8') as stream:",
    "        json.dump(payload, stream, separators=(',', ':'), sort_keys=True)",
    "        stream.flush()",
    "        os.fsync(stream.fileno())",
    "    os.replace(temporary_path, path)",
    "",
    "guard = None",
    "authorized = False",
    "try:",
    "    creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)",
    "    guard = subprocess.Popen(",
    "        [sys.executable, '-I', helper_path, 'install'],",
    "        cwd=working_directory,",
    "        env=os.environ.copy(),",
    "        stdin=subprocess.PIPE,",
    "        stdout=subprocess.PIPE,",
    "        stderr=subprocess.DEVNULL,",
    "        close_fds=True,",
    "        creationflags=creationflags,",
    "    )",
    "    publish(state_path, {'guardPid': guard.pid, 'parentPid': os.getpid()})",
    "    if guard.stdin is None or guard.stdout is None:",
    "        raise RuntimeError('guard pipes were unavailable')",
    "    guard.stdin.write(install_frame)",
    "    guard.stdin.flush()",
    "    ready_raw = guard.stdout.readline(65537)",
    "    if not ready_raw or len(ready_raw) > 65536 or not ready_raw.endswith(b'\\n') or ready_raw.endswith(b'\\r\\n'):",
    "        raise RuntimeError('guard READY frame was not exact')",
    "    ready = json.loads(ready_raw[:-1].decode('ascii'))",
    "    if ready != {'kind': 'ready', 'protocol': protocol, 'token': expected_token}:",
    "        raise RuntimeError('guard READY frame did not match')",
    "    guard.stdin.write(go_frame)",
    "    guard.stdin.flush()",
    "    guard.stdin.close()",
    "    authorized = True",
    "    publish(authorized_path, {",
    "        'guardPid': guard.pid,",
    "        'kind': 'authorized',",
    "        'parentPid': os.getpid(),",
    "        'protocol': protocol,",
    "        'token': expected_token,",
    "    })",
    "    crash_request = sys.stdin.buffer.read(len(crash_frame) + 1)",
    "    if crash_request != crash_frame:",
    "        raise RuntimeError('parent crash frame did not match')",
    "    os._exit(crash_exit_code)",
    "except BaseException:",
    "    if guard is not None and guard.poll() is None:",
    "        if authorized:",
    "            try:",
    "                with open(release_path, 'x', encoding='utf-8') as stream:",
    "                    stream.write('release\\n')",
    "            except FileExistsError:",
    "                pass",
    "        elif guard.stdin is not None:",
    "            guard.stdin.close()",
    "        try:",
    "            guard.wait(timeout=10)",
    "        except subprocess.TimeoutExpired:",
    "            guard.kill()",
    "            guard.wait(timeout=10)",
    "    raise",
    ""
  ].join("\n");
}

export function createDependencyGuardRecoveryFixture(
  directory: string,
  dependencyPython: string,
  helperPath: string
): DependencyGuardRecoveryFixture {
  assert.equal(existsSync(helperPath), true, "The bundled dependency guard must exist in the installed extension.");
  const environmentRoot = path.join(directory, "environment");
  execFileSync(dependencyPython, ["-m", "venv", "--without-pip", environmentRoot], {
    stdio: "pipe",
    timeout: 60_000,
    windowsHide: true
  });
  const executable =
    process.platform === "win32"
      ? path.join(environmentRoot, "Scripts", "python.exe")
      : path.join(environmentRoot, "bin", "python");
  assert.equal(existsSync(executable), true, "The dependency-recovery environment is missing its interpreter.");

  const dependencyParent = JSON.parse(
    execFileSync(
      dependencyPython,
      [
        "-I",
        "-c",
        [
          "import json",
          "import importlib.metadata",
          "import pip",
          "import pip._vendor.packaging.specifiers",
          "import pip._vendor.packaging.version",
          "import sysconfig",
          "print(json.dumps({",
          "    'purelib': sysconfig.get_path('purelib'),",
          "    'pip': pip.__file__,",
          "    'pipDistributionVersion': importlib.metadata.version('pip'),",
          "    'pipSpecifiers': pip._vendor.packaging.specifiers.__file__,",
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
  const dependencySitePackages = String(dependencyParent.purelib);
  const environmentSitePackages = execFileSync(
    executable,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  assert.ok(path.isAbsolute(dependencySitePackages) && path.isAbsolute(environmentSitePackages));
  assert.doesNotMatch(dependencySitePackages, /[\r\n]/u);
  assert.equal(typeof dependencyParent.pip === "string" && path.isAbsolute(dependencyParent.pip), true);
  assert.equal(
    typeof dependencyParent.pipSpecifiers === "string" && path.isAbsolute(dependencyParent.pipSpecifiers),
    true
  );
  assert.equal(typeof dependencyParent.pipVersion === "string" && path.isAbsolute(dependencyParent.pipVersion), true);
  assert.equal(
    typeof dependencyParent.pipDistributionVersion === "string" && dependencyParent.pipDistributionVersion.length > 0,
    true
  );
  const dependencyPipPackage = path.dirname(String(dependencyParent.pip));
  const dependencyPipRelative = path.relative(dependencySitePackages, dependencyPipPackage);
  assert.equal(
    dependencyPipRelative.length > 0 &&
      dependencyPipRelative !== ".." &&
      !dependencyPipRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(dependencyPipRelative),
    true,
    "The recovery PEP 440 authority must belong to the selected parent interpreter's package root."
  );
  assert.equal(lstatSync(dependencyPipPackage).isDirectory(), true);
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler-acceptance-dependencies.pth"),
    `${dependencySitePackages}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  const invocationLog = path.join(directory, "python-invocations.jsonl");
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler-acceptance-invocations.pth"),
    dependencyGuardInvocationRecorderSource(invocationLog),
    { encoding: "utf8", flag: "wx" }
  );
  const dependencyProbeLog = path.join(directory, "dependency-probes.jsonl");
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler_acceptance_probe_recorder.py"),
    dependencyGuardProbeRecorderSource(dependencyProbeLog),
    { encoding: "utf8", flag: "wx" }
  );
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler-acceptance-probe-recorder.pth"),
    "import openwrangler_acceptance_probe_recorder\n",
    { encoding: "utf8", flag: "wx" }
  );

  createDependencyGuardFixtureDistribution(environmentSitePackages);

  const pipStarted = path.join(directory, "guarded-pip-started.json");
  const pipRelease = path.join(directory, "release-guarded-pip");
  const pipCompleted = path.join(directory, "guarded-pip-completed");
  const pipPackage = path.join(environmentSitePackages, "pip");
  mkdirSync(pipPackage);
  writeFileSync(
    path.join(pipPackage, "__init__.py"),
    [
      `__version__ = ${JSON.stringify(String(dependencyParent.pipDistributionVersion))}`,
      `__path__.append(${JSON.stringify(dependencyPipPackage)})`,
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx" }
  );
  writeFileSync(
    path.join(pipPackage, "__main__.py"),
    dependencyGuardFakePipSource(pipStarted, pipRelease, pipCompleted),
    { encoding: "utf8", flag: "wx" }
  );

  const preflight = JSON.parse(
    execFileSync(
      executable,
      [
        "-I",
        "-c",
        [
          "import importlib.metadata",
          "import json",
          "import openwrangler_guard_fixture",
          "import pip",
          "import pip._vendor.packaging.specifiers",
          "import pip._vendor.packaging.version",
          "import polars",
          "print(json.dumps({",
          "    'fixtureVersion': importlib.metadata.version('openwrangler-guard-fixture'),",
          "    'pip': pip.__file__,",
          "    'pipSpecifiers': pip._vendor.packaging.specifiers.__file__,",
          "    'pipVersion': pip._vendor.packaging.version.__file__,",
          "    'fixtureSupported': pip._vendor.packaging.specifiers.SpecifierSet('==1.0.0').contains(",
          "        pip._vendor.packaging.version.Version(",
          "            importlib.metadata.version('openwrangler-guard-fixture')",
          "        ),",
          "        prereleases=True,",
          "    ),",
          "    'polarsVersion': polars.__version__,",
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
  assert.equal(preflight.fixtureVersion, "1.0.0");
  assert.equal(preflight.fixtureSupported, true, "Recovery must retain exact PEP 440 validation authority.");
  assert.equal(typeof preflight.polarsVersion, "string");
  assert.equal(
    typeof preflight.pipSpecifiers === "string" &&
      sameAcceptanceExecutable(preflight.pipSpecifiers, String(dependencyParent.pipSpecifiers)),
    true,
    "Recovery must use the selected parent interpreter's exact SpecifierSet implementation."
  );
  assert.equal(
    typeof preflight.pipVersion === "string" &&
      sameAcceptanceExecutable(preflight.pipVersion, String(dependencyParent.pipVersion)),
    true,
    "Recovery must use the selected parent interpreter's exact Version implementation."
  );
  assert.equal(
    typeof preflight.pip === "string" && sameAcceptanceExecutable(preflight.pip, path.join(pipPackage, "__init__.py")),
    true,
    "The dependency-recovery fixture must resolve only its local no-network pip implementation."
  );
  execFileSync(executable, ["-I", "-m", "pip", "check", "--disable-pip-version-check"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true
  });

  const environment = JSON.parse(
    execFileSync(
      executable,
      [
        "-I",
        "-c",
        [
          "import json",
          "import os",
          "import sys",
          "executable = os.path.abspath(sys.executable)",
          "executable_stat = os.stat(executable)",
          "package_root = os.path.realpath(os.path.abspath(sys.prefix))",
          "package_root_stat = os.stat(package_root)",
          "print(json.dumps({",
          "    'executable': executable,",
          "    'executableIdentity': {",
          "        'device': str(executable_stat.st_dev),",
          "        'inode': str(executable_stat.st_ino),",
          "        'size': str(executable_stat.st_size),",
          "        'mtimeNs': str(executable_stat.st_mtime_ns),",
          "        'ctimeNs': str(executable_stat.st_ctime_ns),",
          "    },",
          "    'packageRoot': package_root,",
          "    'packageRootIdentity': {",
          "        'device': str(package_root_stat.st_dev),",
          "        'inode': str(package_root_stat.st_ino),",
          "    },",
          "    'pythonVersion': '.'.join(str(part) for part in sys.version_info[:3]),",
          "}, separators=(',', ':')))"
        ].join("\n")
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true
      }
    )
  ) as DependencyGuardAcceptanceEnvironment;
  assert.equal(sameAcceptanceExecutable(environment.executable, executable), true);
  assert.equal(sameAcceptanceExecutable(environment.packageRoot, environmentRoot), true);

  const dependency: DependencyGuardAcceptanceDependency = {
    importModule: DEPENDENCY_GUARD_FIXTURE_IMPORT_MODULE,
    distribution: DEPENDENCY_GUARD_FIXTURE_DISTRIBUTION,
    installSpec: `${DEPENDENCY_GUARD_FIXTURE_DISTRIBUTION}>=1.0.0,<2.0.0`,
    exactVersion: null,
    minimumVersion: "1.0.0",
    maximumVersionExclusive: "2.0.0"
  };
  const parentState = path.join(directory, "guard-parent-state.json");
  const parentAuthorized = path.join(directory, "guard-parent-authorized.json");
  const parentScript = path.join(directory, "guard_parent.py");
  const frames = dependencyGuardProtocolFrames(environment, dependency);
  const installFrame = frames.install;
  const goFrame = frames.go;
  const parentCrashFrame = frames.crash;
  writeFileSync(
    parentScript,
    dependencyGuardParentSource({
      directory,
      helperPath,
      parentState,
      parentAuthorized,
      pipRelease,
      installFrame,
      goFrame,
      parentCrashFrame
    }),
    { encoding: "utf8", flag: "wx" }
  );
  const marker = path.join(
    environment.packageRoot,
    ".openwrangler-dependency-journal-v1",
    `mutation-${DEPENDENCY_GUARD_ACCEPTANCE_TOKEN}.json`
  );
  return {
    directory,
    executable,
    helperPath,
    environment,
    dependency,
    marker,
    pipStarted,
    pipRelease,
    pipCompleted,
    parentScript,
    parentState,
    parentAuthorized,
    parentCrashFrame,
    invocationLog,
    dependencyProbeLog
  };
}
