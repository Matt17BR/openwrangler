import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const ALWAYS_REQUIRED_CI_JOBS = Object.freeze(["classify", "fast-feedback"]);

export const INTERNAL_TOOLING_CI_JOB = "checkout-lifecycle-contracts";

export const PACKAGE_CI_JOBS = Object.freeze(["canonical-vsix"]);

export const FULL_MATRIX_CI_JOBS = Object.freeze([
  "contract-tests",
  "visual-accessibility",
  "production-audits",
  "linux-packaged-editor",
  "coverage",
  "python-matrix",
  "native-r-contract",
  "extension-host",
  "native-script-portability",
  "native-extension-host",
  "native-editor-matrix",
  "native-cursor-smoke"
]);

export const PRODUCT_CI_JOBS = Object.freeze([
  ...FULL_MATRIX_CI_JOBS.slice(0, 3),
  ...PACKAGE_CI_JOBS,
  ...FULL_MATRIX_CI_JOBS.slice(3)
]);

export const REQUIRED_CI_JOBS = Object.freeze([
  ...ALWAYS_REQUIRED_CI_JOBS,
  INTERNAL_TOOLING_CI_JOB,
  ...PRODUCT_CI_JOBS
]);

export const OPTIONAL_CI_JOB = "remote-workspace";
export const CONDITIONAL_CI_JOB = "released-jupyter";

export function resultEnvironmentKey(jobId) {
  return `${jobId.replaceAll("-", "_").toUpperCase()}_RESULT`;
}

export function requireCiResults({
  requiredResults,
  documentationOnly,
  draftPullRequest,
  internalToolingOnly,
  lightweightOnly,
  packageOnly,
  fullMatrixRequired,
  releasedJupyterResult,
  releasedJupyterRequired,
  remoteResult,
  remoteRequired
}) {
  const failures = [];
  if (lightweightOnly !== (documentationOnly || internalToolingOnly || draftPullRequest)) {
    failures.push("lightweight classifier is inconsistent with documentation, internal-tooling, and draft state");
  }
  if (
    (documentationOnly && packageOnly) ||
    (documentationOnly && internalToolingOnly) ||
    (packageOnly && internalToolingOnly)
  ) {
    failures.push("documentation-only, internal-tooling-only, and package-only classifiers are mutually exclusive");
  }
  if (fullMatrixRequired !== (!documentationOnly && !internalToolingOnly && !packageOnly && !draftPullRequest)) {
    failures.push(
      "full-matrix classifier is inconsistent with documentation, internal-tooling, package, and draft state"
    );
  }
  for (const jobId of ALWAYS_REQUIRED_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== "success") {
      failures.push(`${jobId}=${result ?? "missing"}`);
    }
  }

  const expectedInternalToolingResult = internalToolingOnly && !draftPullRequest ? "success" : "skipped";
  const internalToolingResult = requiredResults[INTERNAL_TOOLING_CI_JOB];
  if (internalToolingResult !== expectedInternalToolingResult) {
    failures.push(
      `${INTERNAL_TOOLING_CI_JOB}=${internalToolingResult ?? "missing"} (expected ${expectedInternalToolingResult})`
    );
  }

  const expectedPackageResult = !draftPullRequest && (packageOnly || fullMatrixRequired) ? "success" : "skipped";
  for (const jobId of PACKAGE_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== expectedPackageResult) {
      failures.push(`${jobId}=${result ?? "missing"} (expected ${expectedPackageResult})`);
    }
  }

  const expectedFullMatrixResult = fullMatrixRequired ? "success" : "skipped";
  for (const jobId of FULL_MATRIX_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== expectedFullMatrixResult) {
      failures.push(`${jobId}=${result ?? "missing"} (expected ${expectedFullMatrixResult})`);
    }
  }

  const expectedReleasedJupyterResult = fullMatrixRequired && releasedJupyterRequired ? "success" : "skipped";
  if (!fullMatrixRequired && releasedJupyterRequired) {
    failures.push("released-jupyter classifier is inconsistent with full-matrix mode");
  }
  if (releasedJupyterResult !== expectedReleasedJupyterResult) {
    failures.push(
      `${CONDITIONAL_CI_JOB}=${releasedJupyterResult ?? "missing"} (expected ${expectedReleasedJupyterResult})`
    );
  }

  const expectedRemoteResult = fullMatrixRequired && remoteRequired ? "success" : "skipped";
  if (!fullMatrixRequired && remoteRequired) {
    failures.push("remote-workspace classifier is inconsistent with full-matrix mode");
  }
  if (remoteResult !== expectedRemoteResult) {
    failures.push(`${OPTIONAL_CI_JOB}=${remoteResult ?? "missing"} (expected ${expectedRemoteResult})`);
  }

  if (failures.length > 0) {
    throw new Error(`Required CI did not pass: ${failures.join(", ")}.`);
  }
  if (draftPullRequest) {
    throw new Error(
      "Draft pull request passed fast feedback; mergeable validation is deferred until ready_for_review reruns its required CI tier."
    );
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
    draftPullRequest: parseRequiredFlag(environment.DRAFT_PULL_REQUEST, "DRAFT_PULL_REQUEST"),
    internalToolingOnly: parseRequiredFlag(environment.INTERNAL_TOOLING_ONLY, "INTERNAL_TOOLING_ONLY"),
    lightweightOnly: parseRequiredFlag(environment.LIGHTWEIGHT_ONLY, "LIGHTWEIGHT_ONLY"),
    packageOnly: parseRequiredFlag(environment.PACKAGE_ONLY, "PACKAGE_ONLY"),
    fullMatrixRequired: parseRequiredFlag(environment.FULL_MATRIX_REQUIRED, "FULL_MATRIX_REQUIRED"),
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
