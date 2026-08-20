import { describe, expect, it } from "vitest";
import {
  packagedGridCopyShortcut,
  runPackagedGridRangeCopyLifecycle
} from "./extensionHost/packagedGridRangeCopyJourney";

describe("packaged grid range-copy journey", () => {
  it("routes the platform copy modifier without guessing from the editor brand", () => {
    expect(packagedGridCopyShortcut("darwin")).toBe("Meta+c");
    expect(packagedGridCopyShortcut("linux")).toBe("Control+c");
    expect(packagedGridCopyShortcut("win32")).toBe("Control+c");
  });

  it("always performs bounded cleanup and preserves the original journey failure", async () => {
    const journeyFailure = new Error("pointer assertion failed");
    const calls: string[] = [];

    await expect(
      runPackagedGridRangeCopyLifecycle(
        async () => {
          calls.push("exercise");
          throw journeyFailure;
        },
        async () => {
          calls.push("cleanup");
        }
      )
    ).rejects.toBe(journeyFailure);
    expect(calls).toEqual(["exercise", "cleanup"]);
  });

  it("retains both failures without letting cleanup mask the journey failure", async () => {
    const journeyFailure = new Error("clipboard assertion failed");
    const cleanupFailure = new Error("session cleanup failed");

    try {
      await runPackagedGridRangeCopyLifecycle(
        async () => {
          throw journeyFailure;
        },
        async () => {
          throw cleanupFailure;
        }
      );
      expect.unreachable("The lifecycle must report both failures.");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([journeyFailure, cleanupFailure]);
    }
  });

  it("reports a cleanup-only failure after a successful journey", async () => {
    const cleanupFailure = new Error("cleanup failed");
    await expect(
      runPackagedGridRangeCopyLifecycle(
        async () => undefined,
        async () => {
          throw cleanupFailure;
        }
      )
    ).rejects.toBe(cleanupFailure);
  });
});
