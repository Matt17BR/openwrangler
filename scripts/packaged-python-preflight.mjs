import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ACCEPTANCE_PYTHON_INTERPRETER_ERROR = "OW_ACCEPTANCE_PYTHON_INTERPRETER";
export const ACCEPTANCE_PYTHON_DEPENDENCY_ERROR = "OW_ACCEPTANCE_PYTHON_DEPENDENCIES";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERPRETER_FAILURE_EXIT = 10;
const DEPENDENCY_FAILURE_EXIT = 20;
const PROFILES = Object.freeze({
  "interpreter-only": Object.freeze([]),
  "repository-command": Object.freeze([]),
  editor: Object.freeze(["pandas", "polars", "duckdb", "fsspec", "openpyxl", "pyarrow"]),
  "editor-jupyter": Object.freeze(["pandas", "polars", "duckdb", "fsspec", "openpyxl", "pyarrow", "ipykernel"]),
  "jupyter-bootstrap": Object.freeze(["ipykernel", "pandas", "polars", "duckdb", "fsspec"]),
  "jupyter-host": Object.freeze(["jupyter_client"]),
  "jupyter-host-literate": Object.freeze(["jupyter_client", "ipykernel", "pandas", "polars", "duckdb", "fsspec"]),
  visual: Object.freeze([
    "pandas",
    "polars",
    "duckdb",
    "fsspec",
    "nbformat",
    "nbclient",
    "ipykernel",
    "jupyter_client",
    "openwrangler_runtime"
  ])
});
const PROFILE_LABELS = Object.freeze({
  "interpreter-only": "Remote-only packaged R acceptance",
  "repository-command": "Repository Python command",
  editor: "Editor acceptance",
  "editor-jupyter": "Editor and released-Jupyter acceptance",
  "jupyter-bootstrap": "Released-Jupyter bootstrap acceptance",
  "jupyter-host": "Local R Jupyter acceptance",
  "jupyter-host-literate": "Local R and Quarto Jupyter acceptance",
  visual: "Webview visual acceptance"
});
const PROBE_SOURCE = [
  "import importlib",
  "import importlib.metadata",
  "import sys",
  `if not ((3, 10) <= sys.version_info[:2] <= (3, 14)): raise SystemExit(${INTERPRETER_FAILURE_EXIT})`,
  "sys.path.insert(0, sys.argv.pop(1))",
  "for name in sys.argv[1:]:",
  "    try:",
  "        importlib.import_module(name)",
  '        if name == "fsspec" and importlib.metadata.version(name) != "2026.7.0": raise ValueError',
  `    except BaseException: raise SystemExit(${DEPENDENCY_FAILURE_EXIT})`
].join("\n");

export function packagedEditorPythonPreflightProfile({
  acceptanceMode,
  jupyterExtensionEnabled,
  remoteOnly,
  literateDocuments
}) {
  if (acceptanceMode === "r-jupyter") {
    if (remoteOnly) return "interpreter-only";
    return literateDocuments ? "jupyter-host-literate" : "jupyter-host";
  }
  if (acceptanceMode === "data-wrangler-coexistence") return "jupyter-bootstrap";
  return jupyterExtensionEnabled ? "editor-jupyter" : "editor";
}

export function resolveAcceptancePython({
  profile,
  repositoryRoot = root,
  environment = process.env,
  platform = process.platform
}) {
  dependenciesFor(profile);
  const override =
    profile === "repository-command" || profile === "visual" ? "OPEN_WRANGLER_PYTHON" : "OPEN_WRANGLER_TEST_PYTHON";
  const exactRepositoryRoot = absoluteRoot(repositoryRoot, profile, override);
  let python;
  if (environment[override] !== undefined) {
    python = environment[override];
  } else if (environment.pythonLocation !== undefined) {
    const location = absoluteRoot(environment.pythonLocation, profile, override);
    python = resolve(location, platform === "win32" ? "python.exe" : join("bin", "python"));
  } else if (environment.VIRTUAL_ENV !== undefined) {
    const location = absoluteRoot(environment.VIRTUAL_ENV, profile, override);
    python = resolve(location, platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python"));
  } else {
    python = resolve(
      exactRepositoryRoot,
      ".venv",
      platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python")
    );
  }
  return exactFile(python, profile, override);
}

export function preflightAcceptancePython(python, profile, execute = execFileSync, repositoryRoot = root) {
  const modules = dependenciesFor(profile);
  const override =
    profile === "repository-command" || profile === "visual" ? "OPEN_WRANGLER_PYTHON" : "OPEN_WRANGLER_TEST_PYTHON";
  const exactPython = exactFile(python, profile, override);
  try {
    execute(exactPython, ["-I", "-c", PROBE_SOURCE, resolve(repositoryRoot, "python"), ...modules], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true
    });
  } catch (error) {
    throw prerequisiteError(error?.status === DEPENDENCY_FAILURE_EXIT ? "dependencies" : "interpreter", profile);
  }
  return exactPython;
}

export function resolveAndPreflightAcceptancePython(options, execute = execFileSync) {
  const python = resolveAcceptancePython(options);
  return preflightAcceptancePython(python, options.profile, execute, options.repositoryRoot ?? root);
}

export function runAcceptancePythonPreflightCli(
  args,
  { repositoryRoot = root, environment = process.env, platform = process.platform, execute = execFileSync } = {}
) {
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== "visual") {
    throw new Error("Acceptance Python preflight usage: node scripts/packaged-python-preflight.mjs visual");
  }
  return resolveAndPreflightAcceptancePython({ profile: "visual", repositoryRoot, environment, platform }, execute);
}

export function acceptancePythonProfileModulesForTesting(profile) {
  return [...dependenciesFor(profile)];
}

export const acceptancePythonProbeSourceForTesting = PROBE_SOURCE;

function dependenciesFor(profile) {
  if (typeof profile !== "string" || !Object.hasOwn(PROFILES, profile)) {
    throw new TypeError("Acceptance Python preflight requires one supported dependency profile.");
  }
  return PROFILES[profile];
}

function absoluteRoot(value, profile, override) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw prerequisiteError("interpreter", profile, override);
  }
  return value;
}

function exactFile(value, profile, override) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw prerequisiteError("interpreter", profile, override);
  }
  try {
    if (!statSync(value).isFile()) throw new Error("not a file");
  } catch {
    throw prerequisiteError("interpreter", profile, override);
  }
  return value;
}

function prerequisiteError(
  kind,
  profile,
  override = profile === "repository-command" || profile === "visual"
    ? "OPEN_WRANGLER_PYTHON"
    : "OPEN_WRANGLER_TEST_PYTHON"
) {
  const code = kind === "dependencies" ? ACCEPTANCE_PYTHON_DEPENDENCY_ERROR : ACCEPTANCE_PYTHON_INTERPRETER_ERROR;
  const detail =
    kind === "dependencies"
      ? `${PROFILE_LABELS[profile]} requires these modules in the selected interpreter: ${PROFILES[profile].join(", ")}. ` +
        "Install the prepared acceptance dependencies before running this command."
      : `${PROFILE_LABELS[profile]} requires one existing absolute Python 3.10-3.14 interpreter. ` +
        `Set ${override}, use an absolute setup-python pythonLocation or VIRTUAL_ENV, or prepare the repository .venv.`;
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runAcceptancePythonPreflightCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
