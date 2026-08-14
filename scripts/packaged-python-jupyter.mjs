export const PACKAGED_PYTHON_JUPYTER_PROFILE_ENV = "OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE";
export const CANDIDATE_PYTHON_JUPYTER_PROFILE = "candidate-one-owner";
export const CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR = "candidate-compatibility-seam";

const COMPLETE_PHASES = Object.freeze(["jupyter-deny", "jupyter-allow", "jupyter-pyspark"]);
const CURSOR_CANDIDATE_PHASES = Object.freeze(["jupyter-allow"]);

export function resolvePackagedPythonJupyterProfile({
  value,
  acceptanceMode,
  jupyterExtensionEnabled,
  dataWranglerCoexistenceEnabled,
  remoteJupyterEnabled,
  requestedEditors
}) {
  if (value === undefined) return undefined;
  if (value !== CANDIDATE_PYTHON_JUPYTER_PROFILE) {
    throw new Error(
      `${PACKAGED_PYTHON_JUPYTER_PROFILE_ENV} must be unset or ${JSON.stringify(CANDIDATE_PYTHON_JUPYTER_PROFILE)}.`
    );
  }
  if (
    acceptanceMode !== "full" ||
    !jupyterExtensionEnabled ||
    dataWranglerCoexistenceEnabled ||
    !remoteJupyterEnabled ||
    !sameEditors(requestedEditors, ["vscode", "cursor"])
  ) {
    throw new Error(
      `${PACKAGED_PYTHON_JUPYTER_PROFILE_ENV}=${JSON.stringify(
        CANDIDATE_PYTHON_JUPYTER_PROFILE
      )} is valid only for ordinary released-Python Jupyter acceptance with real remote Jupyter and exactly VS Code plus Cursor.`
    );
  }
  return CANDIDATE_PYTHON_JUPYTER_PROFILE;
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
      integrationOnly: false
    });
  }
  if (profile !== CANDIDATE_PYTHON_JUPYTER_PROFILE) {
    throw new Error("Released-Python Jupyter acceptance received an unresolved candidate profile.");
  }
  if (editorKey === "vscode") {
    return Object.freeze({
      phases: COMPLETE_PHASES,
      remote: true,
      allowSelector: undefined,
      integrationOnly: true
    });
  }
  return Object.freeze({
    phases: CURSOR_CANDIDATE_PHASES,
    remote: false,
    allowSelector: CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
    integrationOnly: true
  });
}

function sameEditors(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((editor, index) => editor === expected[index])
  );
}
