const FULL_COMMIT_ACTION = /^(?<action>[^@\s]+)@(?<commit>[0-9a-f]{40})$/u;

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function isLocalReference(value) {
  return typeof value === "string" && value.startsWith("./");
}

function displayReference(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isPinnedExternalActionReference(value) {
  return typeof value === "string" && !isLocalReference(value) && FULL_COMMIT_ACTION.test(value);
}

export function usesPinnedAction(step, action) {
  if (!isPinnedExternalActionReference(step?.uses)) return false;
  return step.uses.slice(0, -41) === action;
}

export function inspectPinnedExternalActions(workflow) {
  const problems = [];
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    const references = [];
    if (job?.uses !== undefined) references.push(job.uses);
    for (const step of steps(job)) {
      if (step?.uses !== undefined) references.push(step.uses);
    }
    for (const reference of references) {
      if (isLocalReference(reference) || isPinnedExternalActionReference(reference)) continue;
      problems.push(
        `${jobName} action ${displayReference(reference)} must use a full 40-character hexadecimal commit SHA.`
      );
    }
  }
  return problems;
}
