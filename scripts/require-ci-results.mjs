import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const ALWAYS_REQUIRED_CI_JOBS = Object.freeze(["classify", "fast-feedback"]);

export const BENCHMARK_HARNESS_CI_JOBS = Object.freeze(["benchmark-harness"]);

export const PACKAGE_CI_JOBS = Object.freeze(["canonical-vsix"]);

export const DEPENDENCY_LOCK_CI_JOBS = Object.freeze(["dependency-lock-validation"]);

export const FULL_MATRIX_CI_JOBS = Object.freeze([
  "contract-tests",
  "visual-accessibility",
  "production-audits",
  "linux-packaged-editor",
  "coverage",
  "python-matrix",
  "native-r-contract",
  "extension-host"
]);

export const PRODUCT_CI_JOBS = Object.freeze([
  ...BENCHMARK_HARNESS_CI_JOBS,
  ...FULL_MATRIX_CI_JOBS.slice(0, 3),
  ...DEPENDENCY_LOCK_CI_JOBS,
  ...PACKAGE_CI_JOBS,
  ...FULL_MATRIX_CI_JOBS.slice(3)
]);

export const REQUIRED_CI_JOBS = Object.freeze([...ALWAYS_REQUIRED_CI_JOBS, ...PRODUCT_CI_JOBS]);

export const OPTIONAL_CI_JOB = "remote-workspace";

export function resultEnvironmentKey(jobId) {
  return `${jobId.replaceAll("-", "_").toUpperCase()}_RESULT`;
}

export function requireCiResults({
  requiredResults,
  benchmarkHarnessOnly,
  dependencyLockOnly,
  documentationOnly,
  draftPullRequest,
  lightweightOnly,
  packageOnly,
  fullMatrixRequired,
  remoteResult,
  remoteRequired
}) {
  const failures = [];
  if (lightweightOnly !== (documentationOnly || draftPullRequest)) {
    failures.push("lightweight classifier is inconsistent with documentation and draft state");
  }
  if ([benchmarkHarnessOnly, documentationOnly, packageOnly, dependencyLockOnly].filter(Boolean).length > 1) {
    failures.push(
      "benchmark-harness-only, documentation-only, package-only, and dependency-lock-only classifiers are mutually exclusive"
    );
  }
  if (
    fullMatrixRequired !==
    (!benchmarkHarnessOnly && !documentationOnly && !packageOnly && !dependencyLockOnly && !draftPullRequest)
  ) {
    failures.push(
      "full-matrix classifier is inconsistent with benchmark harness, documentation, package, dependency lock, and draft state"
    );
  }
  for (const jobId of ALWAYS_REQUIRED_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== "success") {
      failures.push(`${jobId}=${result ?? "missing"}`);
    }
  }

  const expectedBenchmarkHarnessResult = benchmarkHarnessOnly ? "success" : "skipped";
  for (const jobId of BENCHMARK_HARNESS_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== expectedBenchmarkHarnessResult) {
      failures.push(`${jobId}=${result ?? "missing"} (expected ${expectedBenchmarkHarnessResult})`);
    }
  }

  const expectedDependencyLockResult = dependencyLockOnly && !draftPullRequest ? "success" : "skipped";
  for (const jobId of DEPENDENCY_LOCK_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== expectedDependencyLockResult) {
      failures.push(`${jobId}=${result ?? "missing"} (expected ${expectedDependencyLockResult})`);
    }
  }

  const expectedPackageResult =
    !draftPullRequest && (packageOnly || dependencyLockOnly || fullMatrixRequired) ? "success" : "skipped";
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
  if (draftPullRequest)
    process.stdout.write("Draft feedback passed. Mark the pull request ready to start merge checks.\n");
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
    benchmarkHarnessOnly: parseRequiredFlag(environment.BENCHMARK_HARNESS_ONLY, "BENCHMARK_HARNESS_ONLY"),
    dependencyLockOnly: parseRequiredFlag(environment.DEPENDENCY_LOCK_ONLY, "DEPENDENCY_LOCK_ONLY"),
    documentationOnly: parseRequiredFlag(environment.DOCUMENTATION_ONLY, "DOCUMENTATION_ONLY"),
    draftPullRequest: parseRequiredFlag(environment.DRAFT_PULL_REQUEST, "DRAFT_PULL_REQUEST"),
    lightweightOnly: parseRequiredFlag(environment.LIGHTWEIGHT_ONLY, "LIGHTWEIGHT_ONLY"),
    packageOnly: parseRequiredFlag(environment.PACKAGE_ONLY, "PACKAGE_ONLY"),
    fullMatrixRequired: parseRequiredFlag(environment.FULL_MATRIX_REQUIRED, "FULL_MATRIX_REQUIRED"),
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
