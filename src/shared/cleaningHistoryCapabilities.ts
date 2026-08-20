export type CleaningHistoryCapabilityId = "inspect" | "edit" | "delete" | "undo" | "reorder";

export type CleaningHistoryCapabilityScope =
  "any_committed_step" | "latest_committed_step" | "most_recent_committed_step" | "committed_steps";

export interface CleaningHistoryCapabilityContext {
  stepCount: number;
  stepIndex: number;
}

// cleaning-history-capability-authority:start
export const CLEANING_HISTORY_CAPABILITY_AUTHORITY = Object.freeze({
  inspect: Object.freeze({ status: "implemented", scope: "any_committed_step" }),
  edit: Object.freeze({ status: "implemented", scope: "any_committed_step" }),
  delete: Object.freeze({ status: "implemented", scope: "any_committed_step" }),
  undo: Object.freeze({ status: "implemented", scope: "most_recent_committed_step" }),
  reorder: Object.freeze({ status: "not_committed", scope: "committed_steps" })
});
// cleaning-history-capability-authority:end

export function cleaningHistoryActionAvailable(
  capabilityId: CleaningHistoryCapabilityId,
  context: CleaningHistoryCapabilityContext
): boolean {
  const capability: Readonly<{
    status: "implemented" | "not_committed";
    scope: CleaningHistoryCapabilityScope;
  }> = CLEANING_HISTORY_CAPABILITY_AUTHORITY[capabilityId];
  if (capability.status !== "implemented") return false;

  const stepCount = Number.isInteger(context.stepCount) ? context.stepCount : 0;
  const stepIndex = Number.isInteger(context.stepIndex) ? context.stepIndex : -1;
  if (stepCount <= 0 || stepIndex < 0 || stepIndex >= stepCount) return false;

  switch (capability.scope) {
    case "any_committed_step":
      return true;
    case "latest_committed_step":
    case "most_recent_committed_step":
      return stepIndex === stepCount - 1;
    case "committed_steps":
      return stepCount > 1;
  }
}
