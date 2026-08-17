import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ALWAYS_REQUIRED_CI_JOBS = Object.freeze(["classify", "invariant-core"]);
export const CONDITIONAL_CI_JOBS = Object.freeze({
  rContractRequired: Object.freeze(["r-contract-kernel", "r-contract-protocol", "native-r-contract"]),
  canonicalEditorRequired: Object.freeze(["canonical-editor"]),
  visualAccessibilityRequired: Object.freeze(["visual-accessibility"]),
  windowsUniqueRequired: Object.freeze(["windows-unique"])
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
  throw new Error(`${environmentName} must be exactly true or false.`);
}

export function requireCiResults({ requiredResults, classificationResult, selections }) {
  const failures = [];
  if (classificationResult !== "success") failures.push(`classify=${classificationResult ?? "missing"}`);
  for (const jobId of ALWAYS_REQUIRED_CI_JOBS) {
    if (requiredResults[jobId] !== "success") {
      failures.push(`${jobId}=${requiredResults[jobId] ?? "missing"} (expected success)`);
    }
  }
  for (const [selection, jobIds] of Object.entries(CONDITIONAL_CI_JOBS)) {
    if (typeof selections[selection] !== "boolean") {
      failures.push(`${selection}=missing`);
      continue;
    }
    const expected = selections[selection] ? "success" : "skipped";
    for (const jobId of jobIds) {
      if (requiredResults[jobId] !== expected) {
        failures.push(`${jobId}=${requiredResults[jobId] ?? "missing"} (expected ${expected})`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`Required CI did not pass: ${failures.join(", ")}.`);
}

function main(environment) {
  const requiredResults = Object.fromEntries(
    REQUIRED_CI_JOBS.map((jobId) => [jobId, environment[resultEnvironmentKey(jobId)]])
  );
  requireCiResults({
    requiredResults,
    classificationResult: environment.CLASSIFY_RESULT,
    selections: {
      rContractRequired: parseRequiredFlag(environment.R_CONTRACT_REQUIRED, "R_CONTRACT_REQUIRED"),
      canonicalEditorRequired: parseRequiredFlag(environment.CANONICAL_EDITOR_REQUIRED, "CANONICAL_EDITOR_REQUIRED"),
      visualAccessibilityRequired: parseRequiredFlag(
        environment.VISUAL_ACCESSIBILITY_REQUIRED,
        "VISUAL_ACCESSIBILITY_REQUIRED"
      ),
      windowsUniqueRequired: parseRequiredFlag(environment.WINDOWS_UNIQUE_REQUIRED, "WINDOWS_UNIQUE_REQUIRED")
    }
  });
  process.stdout.write(`Required CI passed ${REQUIRED_CI_JOBS.length} owned job results.\n`);
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
