export const PACKAGED_PYTHON_JUPYTER_PROFILE_ENV = "OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE";
export const PYTHON_NOTEBOOKS_PROFILE = "python-notebooks";
export const PYSPARK_PRERELEASE_DENIAL_PROFILE = "pyspark-prerelease-denial";
export const PYSPARK_PRERELEASE_DENIAL_SELECTOR = "pyspark-prerelease-denial";

const PYTHON_NOTEBOOK_PHASES = Object.freeze(["jupyter-deny", "jupyter-allow"]);
const COMPLETE_PHASES = Object.freeze([...PYTHON_NOTEBOOK_PHASES, "jupyter-pyspark"]);
const PYSPARK_PRERELEASE_DENIAL_PHASES = Object.freeze(["jupyter-pyspark"]);

export function resolvePackagedPythonJupyterProfile({
  value,
  acceptanceMode,
  jupyterExtensionEnabled,
  dataWranglerCoexistenceEnabled,
  remoteJupyterEnabled,
  requestedEditors
}) {
  if (value === undefined) return undefined;
  if (value !== PYTHON_NOTEBOOKS_PROFILE && value !== PYSPARK_PRERELEASE_DENIAL_PROFILE) {
    throw new Error(
      `${PACKAGED_PYTHON_JUPYTER_PROFILE_ENV} must be unset, ${JSON.stringify(PYTHON_NOTEBOOKS_PROFILE)}, or ${JSON.stringify(PYSPARK_PRERELEASE_DENIAL_PROFILE)}.`
    );
  }
  if (
    acceptanceMode !== "full" ||
    !jupyterExtensionEnabled ||
    dataWranglerCoexistenceEnabled ||
    remoteJupyterEnabled ||
    !sameEditors(requestedEditors, ["vscode"])
  ) {
    throw new Error(
      `${PACKAGED_PYTHON_JUPYTER_PROFILE_ENV}=${JSON.stringify(value)} requires full mode and released Jupyter in VS Code without coexistence or remote Jupyter.`
    );
  }
  return value;
}

export function packagedPythonJupyterEditorPlan(profile, editorKey, remoteJupyterEnabled) {
  if (editorKey !== "vscode" && editorKey !== "cursor") {
    throw new Error("Released-Python Jupyter acceptance requires a supported editor key.");
  }
  if (typeof remoteJupyterEnabled !== "boolean") {
    throw new Error("Released-Python Jupyter acceptance requires an explicit remote-Jupyter decision.");
  }
  if (profile === undefined) {
    return Object.freeze({
      phases: COMPLETE_PHASES,
      remote: remoteJupyterEnabled,
      allowSelector: undefined,
      pysparkSelector: undefined,
      integrationOnly: false
    });
  }
  if (profile === PYTHON_NOTEBOOKS_PROFILE || profile === PYSPARK_PRERELEASE_DENIAL_PROFILE) {
    if (editorKey !== "vscode") {
      throw new Error("Focused released-Python Jupyter acceptance requires VS Code.");
    }
    return Object.freeze({
      phases: profile === PYTHON_NOTEBOOKS_PROFILE ? PYTHON_NOTEBOOK_PHASES : PYSPARK_PRERELEASE_DENIAL_PHASES,
      remote: false,
      allowSelector: undefined,
      pysparkSelector: profile === PYTHON_NOTEBOOKS_PROFILE ? undefined : PYSPARK_PRERELEASE_DENIAL_SELECTOR,
      integrationOnly: true
    });
  }
  throw new Error("Released-Python Jupyter acceptance received an unresolved profile.");
}

export function packagedPythonJupyterPySparkDistribution(profile, prereleaseDistribution) {
  if (profile === undefined || profile === PYTHON_NOTEBOOKS_PROFILE) return undefined;
  if (profile !== PYSPARK_PRERELEASE_DENIAL_PROFILE) {
    throw new Error("Released-Python Jupyter acceptance received an unresolved PySpark distribution profile.");
  }
  if (!Object.isFrozen(prereleaseDistribution) || prereleaseDistribution?.mode !== "prerelease-denial") {
    throw new Error("The PySpark prerelease-denial journey requires its immutable repository distribution receipt.");
  }
  return prereleaseDistribution;
}

function sameEditors(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((editor, index) => editor === expected[index])
  );
}
