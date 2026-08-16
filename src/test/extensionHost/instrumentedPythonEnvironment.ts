import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export interface InstrumentedPythonEnvironment {
  readonly executable: string;
  readonly runtimeMarkerDirectory: string;
}

export function instrumentedRuntimeMarkerImportLine(runtimeMarkerDirectory: string): string {
  return [
    "import os, sys, uuid; ",
    "os.path.isfile(os.path.join(os.environ.get('PYTHONPATH', '').split(os.pathsep, 1)[0], ",
    "'openwrangler_runtime', 'server.py')) and not hasattr(sys, '_openwrangler_acceptance_runtime_marked') and ",
    `(setattr(sys, '_openwrangler_acceptance_runtime_marked', True), open(os.path.join(${JSON.stringify(runtimeMarkerDirectory)}, `,
    "'runtime-' + uuid.uuid4().hex + '.marker'), 'x').close())"
  ].join("");
}

export function createInstrumentedPythonEnvironment(
  environmentRoot: string,
  dependencyPython: string,
  label: string
): InstrumentedPythonEnvironment {
  execFileSync(dependencyPython, ["-m", "venv", "--without-pip", environmentRoot], {
    stdio: "pipe",
    timeout: 60_000,
    windowsHide: true
  });
  const executable =
    process.platform === "win32"
      ? path.join(environmentRoot, "Scripts", "python.exe")
      : path.join(environmentRoot, "bin", "python");
  assert.equal(existsSync(executable), true, `Instrumented Python environment ${label} must be executable.`);
  const dependencySitePackages = execFileSync(
    dependencyPython,
    ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  const environmentSitePackages = execFileSync(
    executable,
    ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    }
  ).trim();
  assert.ok(dependencySitePackages && environmentSitePackages);
  const runtimeMarkerDirectory = path.join(environmentRoot, "runtime-starts");
  mkdirSync(runtimeMarkerDirectory);
  writeFileSync(
    path.join(environmentSitePackages, "openwrangler-acceptance-dependencies.pth"),
    `${dependencySitePackages}\n${instrumentedRuntimeMarkerImportLine(runtimeMarkerDirectory)}\n`,
    "utf8"
  );
  return { executable, runtimeMarkerDirectory };
}

export function verifyInstrumentedPythonEnvironmentMarker(
  environment: InstrumentedPythonEnvironment,
  runtimeRoot: string
): void {
  assert.deepEqual(instrumentedRuntimeMarkers(environment), []);
  execFileSync(environment.executable, ["-c", "pass"], {
    env: { ...process.env, PYTHONPATH: runtimeRoot },
    stdio: "pipe",
    timeout: 30_000,
    windowsHide: true
  });
  const markers = instrumentedRuntimeMarkers(environment);
  assert.equal(markers.length, 1, "The executable .pth marker must identify one runtime-root launch.");
  const markerPath = path.join(environment.runtimeMarkerDirectory, markers[0]!);
  const metadata = lstatSync(markerPath);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
  rmSync(markerPath);
  assert.deepEqual(instrumentedRuntimeMarkers(environment), []);
}

export function instrumentedRuntimeStarts(environment: InstrumentedPythonEnvironment): number {
  return instrumentedRuntimeMarkers(environment).length;
}

export function instrumentedRuntimeMarkers(environment: InstrumentedPythonEnvironment): string[] {
  const entries = readdirSync(environment.runtimeMarkerDirectory);
  assert.ok(entries.length <= 16, "Instrumented Python runtime markers exceeded their fixed bound.");
  return entries.filter((entry) => /^runtime-[0-9a-f]{32}\.marker$/u.test(entry));
}
