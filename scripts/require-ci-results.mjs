import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ALWAYS_REQUIRED_CI_JOBS = Object.freeze(["changes", "javascript"]);
export const CONDITIONAL_CI_JOBS = Object.freeze({
  pythonRequired: Object.freeze(["python"]),
  rRequired: Object.freeze(["r"]),
  packageEditorRequired: Object.freeze(["package-editor"]),
  webRequired: Object.freeze(["web"]),
  windowsRequired: Object.freeze(["windows"])
});
export const REQUIRED_CI_JOBS = Object.freeze([
  ...ALWAYS_REQUIRED_CI_JOBS,
  ...Object.values(CONDITIONAL_CI_JOBS).flat()
]);

export function resultEnvironmentKey(jobId) {
  return `${jobId.replaceAll("-", "_").toUpperCase()}_RESULT`;
}

export function parseRequiredFlag(value, environmentName) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${environmentName} must be true or false.`);
}

const KNOWN_RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);

function label(jobId) {
  return {
    changes: "Change detection",
    javascript: "JavaScript / TypeScript",
    python: "Python",
    r: "R",
    "package-editor": "Package and editor",
    web: "Web UI and accessibility",
    windows: "Windows"
  }[jobId];
}

export function requireCiResults({ requiredResults, selections }) {
  const failures = [];
  for (const jobId of REQUIRED_CI_JOBS) {
    const result = requiredResults[jobId];
    if (!KNOWN_RESULTS.has(result)) {
      failures.push(`${label(jobId)} returned an unknown result (${result ?? "missing"})`);
    }
  }
  if (failures.length > 0) throw new Error(`CI could not be validated: ${failures.join("; ")}.`);
  for (const jobId of ALWAYS_REQUIRED_CI_JOBS) {
    if (requiredResults[jobId] !== "success") {
      failures.push(`${label(jobId)} ${requiredResults[jobId]}`);
    }
  }
  for (const [selection, jobIds] of Object.entries(CONDITIONAL_CI_JOBS)) {
    if (typeof selections[selection] !== "boolean") {
      failures.push(`${selection}=missing`);
      continue;
    }
    for (const jobId of jobIds) {
      if (selections[selection] && requiredResults[jobId] !== "success") {
        failures.push(`${label(jobId)} ${requiredResults[jobId]}`);
      }
      if (!selections[selection] && requiredResults[jobId] !== "skipped") {
        failures.push(`${label(jobId)} ran even though it was not selected`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`CI failed: ${failures.join("; ")}.`);
}

function main(environment) {
  const requiredResults = Object.fromEntries(
    REQUIRED_CI_JOBS.map((jobId) => [jobId, environment[resultEnvironmentKey(jobId)]])
  );
  const selections =
    requiredResults.changes === "success"
      ? {
          pythonRequired: parseRequiredFlag(environment.PYTHON_REQUIRED, "PYTHON_REQUIRED"),
          rRequired: parseRequiredFlag(environment.R_REQUIRED, "R_REQUIRED"),
          packageEditorRequired: parseRequiredFlag(environment.PACKAGE_EDITOR_REQUIRED, "PACKAGE_EDITOR_REQUIRED"),
          webRequired: parseRequiredFlag(environment.WEB_REQUIRED, "WEB_REQUIRED"),
          windowsRequired: parseRequiredFlag(environment.WINDOWS_REQUIRED, "WINDOWS_REQUIRED")
        }
      : Object.fromEntries(Object.keys(CONDITIONAL_CI_JOBS).map((name) => [name, true]));
  requireCiResults({
    requiredResults,
    selections
  });
  process.stdout.write("All selected CI jobs passed.\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    main(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CI validation failed."}\n`);
    process.exitCode = 1;
  }
}
