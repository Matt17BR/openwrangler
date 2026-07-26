const ACTIVE_PYTHON_ENVIRONMENT_KEYS = new Set([
  "__PYVENV_LAUNCHER__",
  "_OLD_VIRTUAL_PATH",
  "_OLD_VIRTUAL_PS1",
  "_OLD_VIRTUAL_PYTHONHOME",
  "CONDA_DEFAULT_ENV",
  "CONDA_PROMPT_MODIFIER",
  "CONDA_SHLVL",
  "PIPENV_ACTIVE",
  "POETRY_ACTIVE",
  "PYENV_VERSION",
  "RYE_ACTIVE",
  "UV_ACTIVE",
  "VIRTUAL_ENV",
  "VIRTUAL_ENV_PROMPT"
]);

const OWNED_PYTHON_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  PYTHON_MANAGER_AUTOMATIC_INSTALL: "0",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONNOUSERSITE: "1",
  PYTHONSAFEPATH: "1",
  PYTHONUNBUFFERED: "1",
  PYTHONUTF8: "1"
});

export function buildPythonProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLocaleUpperCase("en-US");
    if (
      normalized.startsWith("PYTHON") ||
      normalized.startsWith("PYLAUNCHER_") ||
      normalized.startsWith("PYMANAGER_") ||
      normalized.startsWith("PY_") ||
      ACTIVE_PYTHON_ENVIRONMENT_KEYS.has(normalized) ||
      /^CONDA_PREFIX(?:_\d+)?$/.test(normalized)
    ) {
      continue;
    }
    environment[key] = value;
  }
  return {
    ...environment,
    ...OWNED_PYTHON_ENVIRONMENT
  };
}
