export const PACKAGED_PYTHON_JUPYTER_PROFILE_ENV = "OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE";
export const PYSPARK_PRERELEASE_DENIAL_PROFILE = "pyspark-prerelease-denial";
export const PYSPARK_PRERELEASE_DENIAL_SELECTOR = "pyspark-prerelease-denial";

const COMPLETE_PHASES = Object.freeze(["jupyter-deny", "jupyter-allow", "jupyter-pyspark"]);
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
  if (value !== PYSPARK_PRERELEASE_DENIAL_PROFILE) {
    throw new Error(
      `${PACKAGED_PYTHON_JUPYTER_PROFILE_ENV} must be unset or ${JSON.stringify(PYSPARK_PRERELEASE_DENIAL_PROFILE)}.`
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
      `${PACKAGED_PYTHON_JUPYTER_PROFILE_ENV}=${JSON.stringify(
        PYSPARK_PRERELEASE_DENIAL_PROFILE
      )} is valid only for the isolated released-PySpark prerelease-denial journey in VS Code without coexistence or remote Jupyter.`
    );
  }
  return PYSPARK_PRERELEASE_DENIAL_PROFILE;
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
  if (profile === PYSPARK_PRERELEASE_DENIAL_PROFILE) {
    if (editorKey !== "vscode") {
      throw new Error("Released-Python Jupyter acceptance received an ineligible PySpark prerelease-denial profile.");
    }
    return Object.freeze({
      phases: PYSPARK_PRERELEASE_DENIAL_PHASES,
      remote: false,
      allowSelector: undefined,
      pysparkSelector: PYSPARK_PRERELEASE_DENIAL_SELECTOR,
      integrationOnly: true
    });
  }
  throw new Error("Released-Python Jupyter acceptance received an unresolved profile.");
}

export function packagedPythonJupyterPySparkDistribution(profile, prereleaseDistribution) {
  if (profile === undefined) return undefined;
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
