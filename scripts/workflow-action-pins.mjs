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

function actionName(reference) {
  if (typeof reference !== "string") return undefined;
  if (isLocalReference(reference)) return reference;
  return FULL_COMMIT_ACTION.exec(reference)?.groups?.action;
}

function inspectAllowedReference(problems, jobName, location, reference, allowed) {
  const name = actionName(reference);
  if (name === undefined || allowed.includes(name)) return;
  problems.push(`${jobName} ${location} ${displayReference(reference)} is not allowed in this workflow.`);
}

export function inspectAllowedWorkflowActions(workflow, allowedByJob) {
  const problems = [];
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    const allowed = allowedByJob[jobName] ?? {};
    if (job?.uses !== undefined) {
      inspectAllowedReference(problems, jobName, "reusable workflow", job.uses, allowed.job ?? []);
    }
    for (const step of steps(job)) {
      if (step?.uses !== undefined) {
        inspectAllowedReference(problems, jobName, "action", step.uses, allowed.steps ?? []);
      }
    }
  }
  return problems;
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
