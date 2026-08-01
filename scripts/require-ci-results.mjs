import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const REQUIRED_CI_JOBS = Object.freeze([
  "fast-feedback",
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

export const OPTIONAL_CI_JOB = "remote-workspace";

export function resultEnvironmentKey(jobId) {
  return `${jobId.replaceAll("-", "_").toUpperCase()}_RESULT`;
}

export function requireCiResults({ requiredResults, remoteResult, remoteRequired }) {
  const failures = [];
  for (const jobId of REQUIRED_CI_JOBS) {
    const result = requiredResults[jobId];
    if (result !== "success") {
      failures.push(`${jobId}=${result ?? "missing"}`);
    }
  }

  const expectedRemoteResult = remoteRequired ? "success" : "skipped";
  if (remoteResult !== expectedRemoteResult) {
    failures.push(`${OPTIONAL_CI_JOB}=${remoteResult ?? "missing"} (expected ${expectedRemoteResult})`);
  }

  if (failures.length > 0) {
    throw new Error(`Required CI did not pass: ${failures.join(", ")}.`);
  }
}

function parseRemoteRequired(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("REMOTE_WORKSPACE_REQUIRED must be exactly true or false.");
}

function main(environment) {
  const requiredResults = Object.fromEntries(
    REQUIRED_CI_JOBS.map((jobId) => [jobId, environment[resultEnvironmentKey(jobId)]])
  );
  requireCiResults({
    requiredResults,
    remoteResult: environment[resultEnvironmentKey(OPTIONAL_CI_JOB)],
    remoteRequired: parseRemoteRequired(environment.REMOTE_WORKSPACE_REQUIRED)
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
