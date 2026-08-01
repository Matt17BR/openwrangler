import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const ALWAYS_REQUIRED_CI_JOBS = Object.freeze(["classify", "fast-feedback"]);

export const PRODUCT_CI_JOBS = Object.freeze([
  "contract-tests",
  "visual-accessibility",
  "production-audits",
  "canonical-vsix",
  "linux-packaged-editor",
  "coverage",
  "python-matrix",
  "extension-host",
  "native-script-portability",
  "native-extension-host",
  "native-editor-matrix",
  "native-cursor-smoke"
]);

export const REQUIRED_CI_JOBS = Object.freeze([...ALWAYS_REQUIRED_CI_JOBS, ...PRODUCT_CI_JOBS]);

export const OPTIONAL_CI_JOB = "remote-workspace";
export const CONDITIONAL_CI_JOB = "released-jupyter";

export function resultEnvironmentKey(jobId) {
  return `${jobId.replaceAll("-", "_").toUpperCase()}_RESULT`;
}

export function requireCiResults({
  requiredResults,
  documentationOnly,
  releasedJupyterResult,
  releasedJupyterRequired,
  remoteResult,
  remoteRequired
}) {
  const failures = [];
  for (const jobId of ALWAYS_REQUIRED_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== "success") {
      failures.push(`${jobId}=${result ?? "missing"}`);
    }
  }

  const expectedProductResult = documentationOnly ? "skipped" : "success";
  for (const jobId of PRODUCT_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== expectedProductResult) {
      failures.push(`${jobId}=${result ?? "missing"} (expected ${expectedProductResult})`);
    }
  }

  const expectedReleasedJupyterResult = !documentationOnly && releasedJupyterRequired ? "success" : "skipped";
  if (documentationOnly && releasedJupyterRequired) {
    failures.push("released-jupyter classifier is inconsistent with documentation-only mode");
  }
  if (releasedJupyterResult !== expectedReleasedJupyterResult) {
    failures.push(
      `${CONDITIONAL_CI_JOB}=${releasedJupyterResult ?? "missing"} (expected ${expectedReleasedJupyterResult})`
    );
  }

  const expectedRemoteResult = !documentationOnly && remoteRequired ? "success" : "skipped";
  if (documentationOnly && remoteRequired) {
    failures.push("remote-workspace classifier is inconsistent with documentation-only mode");
  }
  if (remoteResult !== expectedRemoteResult) {
    failures.push(`${OPTIONAL_CI_JOB}=${remoteResult ?? "missing"} (expected ${expectedRemoteResult})`);
  }

  if (failures.length > 0) {
    throw new Error(`Required CI did not pass: ${failures.join(", ")}.`);
  }
}

export function parseRequiredFlag(value, environmentName) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${environmentName} must be exactly true or false.`);
}

function main(environment) {
  const requiredResults = Object.fromEntries(
    REQUIRED_CI_JOBS.map((jobId) => [jobId, environment[resultEnvironmentKey(jobId)]])
  );
  requireCiResults({
    requiredResults,
    documentationOnly: parseRequiredFlag(environment.DOCUMENTATION_ONLY, "DOCUMENTATION_ONLY"),
    releasedJupyterResult: environment[resultEnvironmentKey(CONDITIONAL_CI_JOB)],
    releasedJupyterRequired: parseRequiredFlag(environment.RELEASED_JUPYTER_REQUIRED, "RELEASED_JUPYTER_REQUIRED"),
    remoteResult: environment[resultEnvironmentKey(OPTIONAL_CI_JOB)],
    remoteRequired: parseRequiredFlag(environment.REMOTE_WORKSPACE_REQUIRED, "REMOTE_WORKSPACE_REQUIRED")
  });
  process.stdout.write(`Required CI passed ${REQUIRED_CI_JOBS.length} blocking jobs.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    main(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Required CI failed."}\n`);
    process.exitCode = 1;
  }
}
