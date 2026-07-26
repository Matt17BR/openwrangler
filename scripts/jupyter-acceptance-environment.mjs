import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createEditorAcceptanceEnvironment, runBoundedEditorCommand } from "./editor-acceptance.mjs";
import {
  assertEditorAcceptancePrivateRootReceipt,
  createEditorAcceptancePrivateRootReceipt
} from "./packaged-editor-orchestration.mjs";

const DEPENDENCIES = Object.freeze(["ipykernel", "pandas", "polars"]);
const BOUNDED_PYTHON_VERSION =
  /^(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:(?:\.post|\.dev)[0-9]+)*(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/iu;

export function acceptancePythonForPhase(phase, testPython, jupyterKernelPython) {
  if (phase === "jupyter-deny" || phase === "jupyter-allow") {
    if (
      typeof jupyterKernelPython !== "string" ||
      !isAbsolute(jupyterKernelPython) ||
      /[\0\r\n]/u.test(jupyterKernelPython)
    ) {
      throw new Error("Released-Jupyter acceptance requires its dedicated private kernel interpreter.");
    }
    return jupyterKernelPython;
  }
  return testPython;
}

export async function createJupyterAcceptanceKernelPython(
  directory,
  basePython,
  {
    containedBy,
    environment = createEditorAcceptanceEnvironment(),
    platform = process.platform,
    runCommand = runBoundedEditorCommand
  } = {}
) {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    /[\0\r\n]/u.test(directory) ||
    existsSync(directory) ||
    typeof containedBy !== "string" ||
    !isAbsolute(containedBy) ||
    /[\0\r\n]/u.test(containedBy) ||
    typeof basePython !== "string" ||
    !isAbsolute(basePython) ||
    /[\0\r\n]/u.test(basePython) ||
    !existsSync(basePython) ||
    typeof runCommand !== "function"
  ) {
    throw new Error(
      "Released-Jupyter acceptance requires a new contained private environment and an existing absolute base interpreter."
    );
  }

  const versions = await probeJupyterAcceptancePython(basePython, {
    environment,
    label: "Released-Jupyter base dependency version probe",
    requireRuntimeAbsent: false,
    runCommand
  });
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const directoryReceipt = createEditorAcceptancePrivateRootReceipt(directory, { containedBy });
  const venvDirectory = resolve(directory, "v");
  await runCommand(
    {
      executable: basePython,
      args: ["-I", "-m", "venv", venvDirectory],
      environment,
      label: "Released-Jupyter private kernel environment creation"
    },
    { timeoutMs: 60_000 }
  );
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  const kernelPython =
    platform === "win32" ? resolve(venvDirectory, "Scripts", "python.exe") : resolve(venvDirectory, "bin", "python");
  if (!existsSync(kernelPython)) {
    throw new Error("Released-Jupyter private kernel environment did not create its interpreter.");
  }
  await runCommand(
    {
      executable: kernelPython,
      args: [
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-warn-script-location",
        "--only-binary=:all:",
        ...DEPENDENCIES.map((dependency) => `${dependency}==${versions[dependency]}`)
      ],
      environment,
      label: "Released-Jupyter private kernel dependency installation"
    },
    { timeoutMs: 240_000 }
  );
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  await probeJupyterAcceptancePython(kernelPython, {
    environment,
    label: "Released-Jupyter private kernel dependency probe",
    requireRuntimeAbsent: true,
    runCommand
  });
  assertEditorAcceptancePrivateRootReceipt(directoryReceipt);
  return kernelPython;
}

export function writeJupyterAcceptanceEnvironment(directory, python) {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    /[\0\r\n]/u.test(directory) ||
    typeof python !== "string" ||
    !isAbsolute(python) ||
    /[\0\r\n]/u.test(python) ||
    !existsSync(python)
  ) {
    throw new Error("Released-Jupyter acceptance requires absolute private directories and an existing interpreter.");
  }
  const dataDir = resolve(directory, "d");
  const runtimeDir = resolve(directory, "r");
  const configDir = resolve(directory, "c");
  const pathDir = resolve(directory, "p");
  const ipythonDir = resolve(directory, "i");
  const kernelDirectory = resolve(dataDir, "kernels", "openwrangler-acceptance");
  for (const path of [dataDir, runtimeDir, configDir, pathDir, ipythonDir, kernelDirectory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    resolve(kernelDirectory, "kernel.json"),
    `${JSON.stringify(
      {
        argv: [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name: "Open Wrangler Acceptance",
        language: "python",
        metadata: { debugger: false },
        env: { IPYTHONDIR: ipythonDir }
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  return { dataDir, runtimeDir, configDir, path: pathDir };
}

export function writeRemoteJupyterAcceptanceEnvironment(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory) || /[\0\r\n]/u.test(directory)) {
    throw new Error("Remote Jupyter acceptance requires one absolute private environment directory.");
  }
  const dataDir = resolve(directory, "d");
  const runtimeDir = resolve(directory, "r");
  const configDir = resolve(directory, "c");
  const pathDir = resolve(directory, "p");
  for (const path of [dataDir, runtimeDir, configDir, pathDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return { dataDir, runtimeDir, configDir, path: pathDir };
}

export async function probeJupyterAcceptancePython(
  python,
  {
    environment = createEditorAcceptanceEnvironment(),
    label = "Released-Jupyter Python dependency probe",
    requireRuntimeAbsent = true,
    runCommand = runBoundedEditorCommand
  } = {}
) {
  if (typeof requireRuntimeAbsent !== "boolean") {
    throw new Error("Released-Jupyter Python dependency probing requires an explicit runtime-absence policy.");
  }
  const probe = [
    "import importlib.metadata",
    "import importlib.util",
    "import json",
    "import ipykernel",
    "import pandas",
    "import polars",
    "print(json.dumps({",
    '  "ipykernel": importlib.metadata.version("ipykernel"),',
    '  "pandas": importlib.metadata.version("pandas"),',
    '  "polars": importlib.metadata.version("polars"),',
    '  "openwranglerRuntimePresent": importlib.util.find_spec("openwrangler_runtime") is not None,',
    "}, sort_keys=True))"
  ].join("\n");
  const { stdout } = await runCommand(
    {
      executable: python,
      args: ["-I", "-c", probe],
      environment,
      label
    },
    { timeoutMs: 30_000 }
  );
  let versions;
  try {
    versions = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Released-Jupyter Python dependency probe did not return its bounded JSON version report.");
  }
  for (const dependency of DEPENDENCIES) {
    const version = versions?.[dependency];
    if (
      typeof version !== "string" ||
      version.length === 0 ||
      version.length > 128 ||
      !BOUNDED_PYTHON_VERSION.test(version)
    ) {
      throw new Error(`Released-Jupyter Python dependency probe did not report a safe ${dependency} version.`);
    }
  }
  if (typeof versions?.openwranglerRuntimePresent !== "boolean") {
    throw new Error("Released-Jupyter Python dependency probe did not report runtime visibility.");
  }
  if (requireRuntimeAbsent && versions.openwranglerRuntimePresent) {
    throw new Error("Released-Jupyter private kernel environment exposes openwrangler_runtime.");
  }
  return versions;
}
