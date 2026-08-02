export function repositoryPythonNoBytecodeEnvironment(environment = process.env) {
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toUpperCase() !== "PYTHONDONTWRITEBYTECODE")
  );
  return {
    ...childEnvironment,
    PYTHONDONTWRITEBYTECODE: "1"
  };
}

export function repositoryPythonEnvironment(pythonPath, environment = process.env) {
  const childEnvironment = Object.fromEntries(
    Object.entries(repositoryPythonNoBytecodeEnvironment(environment)).filter(
      ([key]) => key.toUpperCase() !== "PYTHONPATH"
    )
  );
  return { ...childEnvironment, PYTHONPATH: pythonPath };
}
