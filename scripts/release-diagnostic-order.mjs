const FAILURE_CONDITION =
  /^\$\{\{ always\(\) && steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outcome == 'failure'( && steps\.\1\.outputs\.evidence_ready == 'true')? \}\}$/u;

function command(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function failureCondition(step) {
  return typeof step?.if === "string" ? FAILURE_CONDITION.exec(step.if) : null;
}

export function isExplicitOutcomeFailureStep(step) {
  const match = failureCondition(step);
  return match !== null && match[2] === undefined && step?.uses === undefined && command(step?.run) === "exit 1";
}

export function inspectDeferredDiagnosticFailures(workflow, uploadAction) {
  const problems = [];
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    const jobSteps = Array.isArray(job?.steps) ? job.steps : [];
    const guardedRunners = new Set();

    for (let index = 0; index < jobSteps.length; index += 1) {
      const upload = jobSteps[index];
      const match = upload?.uses === uploadAction ? failureCondition(upload) : null;
      if (match === null) continue;

      const [, runnerId, evidenceClause] = match;
      const runner = jobSteps[index - 1];
      const failure = jobSteps[index + 1];
      if (
        runner?.id !== runnerId ||
        runner?.["continue-on-error"] !== true ||
        (evidenceClause !== undefined && upload?.with?.path !== `\${{ steps.${runnerId}.outputs.evidence_path }}`) ||
        failure?.if !== `\${{ always() && steps.${runnerId}.outcome == 'failure' }}` ||
        failure?.uses !== undefined ||
        command(failure?.run) !== "exit 1"
      ) {
        problems.push(`${jobName}/${runnerId} must upload diagnostics immediately before reporting failure.`);
        continue;
      }
      guardedRunners.add(runner);
    }

    for (const step of jobSteps) {
      if (step?.["continue-on-error"] !== undefined && !guardedRunners.has(step)) {
        problems.push(`${jobName} may defer failure only while immediately uploading diagnostics.`);
      }
    }
  }
  return problems;
}
