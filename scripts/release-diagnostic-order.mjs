const FAILURE_CONDITION =
  /^\$\{\{ always\(\) && steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outcome == 'failure'( && steps\.\1\.outputs\.evidence_ready == 'true')? \}\}$/u;
const AGGREGATE_FAILURE_PREFIX = "${{ always() && (";
const AGGREGATE_FAILURE_SUFFIX = ") }}";
const AGGREGATE_FAILURE_CLAUSE = /^steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outcome == 'failure'$/u;

function command(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function failureCondition(step) {
  return typeof step?.if === "string" ? FAILURE_CONDITION.exec(step.if) : null;
}

function usesPinnedAction(step, action) {
  return (
    typeof step?.uses === "string" && step.uses.startsWith(`${action}@`) && /^[^@\s]+@[0-9a-f]{40}$/u.test(step.uses)
  );
}

export function isExplicitOutcomeFailureStep(step) {
  const match = failureCondition(step);
  return match !== null && match[2] === undefined && step?.uses === undefined && command(step?.run) === "exit 1";
}

function aggregateFailureRunnerIds(step) {
  if (
    typeof step?.if !== "string" ||
    !step.if.startsWith(AGGREGATE_FAILURE_PREFIX) ||
    !step.if.endsWith(AGGREGATE_FAILURE_SUFFIX) ||
    step?.uses !== undefined ||
    command(step?.run) !== "exit 1"
  ) {
    return undefined;
  }
  const body = step.if.slice(AGGREGATE_FAILURE_PREFIX.length, -AGGREGATE_FAILURE_SUFFIX.length);
  const clauses = body.split(" || ");
  if (clauses.length < 2) return undefined;
  const runnerIds = clauses.map((clause) => AGGREGATE_FAILURE_CLAUSE.exec(clause)?.[1]);
  if (runnerIds.some((runnerId) => runnerId === undefined) || new Set(runnerIds).size !== runnerIds.length) {
    return undefined;
  }
  return runnerIds;
}

function isAggregateFailureCandidate(step) {
  if (step?.uses !== undefined || command(step?.run) !== "exit 1" || typeof step?.if !== "string") return false;
  return (step.if.match(/steps\.[A-Za-z_][A-Za-z0-9_-]*\.outcome == 'failure'/gu) ?? []).length >= 2;
}

export function inspectDeferredDiagnosticFailures(workflow, uploadAction) {
  const problems = [];
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    const jobSteps = Array.isArray(job?.steps) ? job.steps : [];
    const guardedRunners = new Set();
    const deferredRunners = [];

    for (let index = 0; index < jobSteps.length; index += 1) {
      const upload = jobSteps[index];
      const match = usesPinnedAction(upload, uploadAction) ? failureCondition(upload) : null;
      if (match === null) continue;

      const [, runnerId, evidenceClause] = match;
      const runner = jobSteps[index - 1];
      const failure = jobSteps[index + 1];
      if (
        runner?.id !== runnerId ||
        (evidenceClause !== undefined && upload?.with?.path !== `\${{ steps.${runnerId}.outputs.evidence_path }}`)
      ) {
        problems.push(`${jobName}/${runnerId} must upload diagnostics immediately after its runner.`);
        continue;
      }
      if (runner?.["continue-on-error"] !== true) continue;
      if (
        failure?.if === `\${{ always() && steps.${runnerId}.outcome == 'failure' }}` &&
        failure?.uses === undefined &&
        command(failure?.run) === "exit 1"
      ) {
        guardedRunners.add(runner);
      } else {
        deferredRunners.push({ runner, runnerId, uploadIndex: index });
      }
    }

    const aggregateFailures = jobSteps
      .map((step, index) => ({ index, runnerIds: aggregateFailureRunnerIds(step) }))
      .filter((entry, index) => entry.runnerIds !== undefined || isAggregateFailureCandidate(jobSteps[index]));
    if (deferredRunners.length > 0) {
      const aggregateFailure = aggregateFailures[0];
      const deferredIds = deferredRunners.map(({ runnerId }) => runnerId);
      if (
        aggregateFailures.length !== 1 ||
        aggregateFailure.runnerIds === undefined ||
        aggregateFailure.index <= deferredRunners.at(-1).uploadIndex ||
        aggregateFailure.runnerIds.length !== deferredIds.length ||
        !aggregateFailure.runnerIds.every((runnerId, index) => runnerId === deferredIds[index])
      ) {
        problems.push(
          `${jobName} must report every deferred diagnostic runner through one exact ordered failure fan-in.`
        );
      } else {
        for (const { runner } of deferredRunners) guardedRunners.add(runner);
      }
    } else if (aggregateFailures.length > 0) {
      problems.push(`${jobName} must not retain an aggregate failure without deferred diagnostic runners.`);
    }

    for (const step of jobSteps) {
      if (step?.["continue-on-error"] !== undefined && !guardedRunners.has(step)) {
        problems.push(`${jobName} may defer failure only while immediately uploading diagnostics.`);
      }
    }
  }
  return problems;
}
