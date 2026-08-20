import { describe, expect, it } from "vitest";
import {
  CLEANING_HISTORY_CAPABILITY_AUTHORITY,
  cleaningHistoryActionAvailable
} from "../shared/cleaningHistoryCapabilities";

describe("cleaning-history capability authority", () => {
  it("allows inspection, editing, and deletion for every committed step", () => {
    for (const capability of ["inspect", "edit", "delete"] as const) {
      expect(CLEANING_HISTORY_CAPABILITY_AUTHORITY[capability]).toEqual({
        status: "implemented",
        scope: "any_committed_step"
      });
      expect(cleaningHistoryActionAvailable(capability, { stepCount: 3, stepIndex: 0 })).toBe(true);
      expect(cleaningHistoryActionAvailable(capability, { stepCount: 3, stepIndex: 1 })).toBe(true);
      expect(cleaningHistoryActionAvailable(capability, { stepCount: 3, stepIndex: 2 })).toBe(true);
    }
  });

  it("allows undo only for the most recent committed step", () => {
    expect(CLEANING_HISTORY_CAPABILITY_AUTHORITY.undo).toEqual({
      status: "implemented",
      scope: "most_recent_committed_step"
    });
    expect(cleaningHistoryActionAvailable("undo", { stepCount: 3, stepIndex: 0 })).toBe(false);
    expect(cleaningHistoryActionAvailable("undo", { stepCount: 3, stepIndex: 1 })).toBe(false);
    expect(cleaningHistoryActionAvailable("undo", { stepCount: 3, stepIndex: 2 })).toBe(true);
  });

  it("keeps reorder unavailable and rejects invalid step coordinates", () => {
    expect(CLEANING_HISTORY_CAPABILITY_AUTHORITY.reorder).toEqual({
      status: "not_committed",
      scope: "committed_steps"
    });
    expect(cleaningHistoryActionAvailable("reorder", { stepCount: 3, stepIndex: 2 })).toBe(false);
    expect(cleaningHistoryActionAvailable("inspect", { stepCount: 0, stepIndex: 0 })).toBe(false);
    expect(cleaningHistoryActionAvailable("edit", { stepCount: 3, stepIndex: -1 })).toBe(false);
    expect(cleaningHistoryActionAvailable("delete", { stepCount: 3, stepIndex: 3 })).toBe(false);
  });
});
