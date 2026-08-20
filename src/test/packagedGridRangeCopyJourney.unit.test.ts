import { describe, expect, it, vi } from "vitest";
import {
  packagedGridCopyShortcut,
  runPackagedGridRangeCopyLifecycle,
  runWithPackagedGridClipboardRestoration
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

  it("retains bounded product and cleanup children in the actual packaged result error field", async () => {
    const productFailure = new Error(`pointer assertion failed ${"p".repeat(2_048)}`);
    const cleanupFailure = new Error(`session cleanup failed ${"c".repeat(2_048)}`);

    try {
      await runPackagedGridRangeCopyLifecycle(
        async () => {
          throw productFailure;
        },
        async () => {
          throw cleanupFailure;
        }
      );
      expect.unreachable("The lifecycle must publish its bounded result diagnostic.");
    } catch (error) {
      const resultEnvelope = {
        protocol: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        phase: "platform-smoke",
        ok: false,
        error: error instanceof Error ? error.message : "Non-Error failure."
      };
      const decoded = JSON.parse(JSON.stringify(resultEnvelope)) as typeof resultEnvelope;

      expect(decoded.error).toContain("Product: pointer assertion failed");
      expect(decoded.error).toContain("Cleanup: session cleanup failed");
      expect(new TextEncoder().encode(decoded.error).byteLength).toBeLessThanOrEqual(2 * 1024);
      expect(decoded.error).not.toContain("p".repeat(512));
      expect(decoded.error).not.toContain("c".repeat(512));
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

  it("preserves both the product failure and clipboard restoration failure", async () => {
    const productFailure = new Error("context-menu payload assertion failed");
    const restorationFailure = new Error("host clipboard restoration failed");
    const hostClipboard = {
      readText: vi.fn(async () => "prior clipboard"),
      writeText: vi.fn(async () => {
        throw restorationFailure;
      })
    };

    try {
      await runWithPackagedGridClipboardRestoration(hostClipboard, async () => {
        throw productFailure;
      });
      expect.unreachable("The production clipboard-restoration helper must report both failures.");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([productFailure, restorationFailure]);
    }
    expect(hostClipboard.readText).toHaveBeenCalledTimes(1);
    expect(hostClipboard.writeText).toHaveBeenCalledExactlyOnceWith("prior clipboard");
  });

  it("restores the prior clipboard after a successful packaged journey", async () => {
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(async () => "prior clipboard"),
      writeText: vi.fn(async () => undefined)
    };

    await runWithPackagedGridClipboardRestoration(hostClipboard, exercise);

    expect(exercise).toHaveBeenCalledTimes(1);
    expect(hostClipboard.writeText).toHaveBeenCalledExactlyOnceWith("prior clipboard");
  });

  it("rejects a non-string prior clipboard value before the packaged journey can mutate it", async () => {
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(async () => 42 as unknown as string),
      writeText: vi.fn(async () => undefined)
    };

    await expect(runWithPackagedGridClipboardRestoration(hostClipboard, exercise)).rejects.toThrow(
      "The prior host clipboard value is invalid or exceeds the 4 MiB restoration limit."
    );

    expect(hostClipboard.readText).toHaveBeenCalledTimes(1);
    expect(exercise).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });

  it("rejects an oversized prior clipboard value before the packaged journey can mutate it", async () => {
    const exercise = vi.fn(async () => undefined);
    const hostClipboard = {
      readText: vi.fn(async () => "x".repeat(4 * 1024 * 1024 + 1)),
      writeText: vi.fn(async () => undefined)
    };

    await expect(runWithPackagedGridClipboardRestoration(hostClipboard, exercise)).rejects.toThrow(
      "The prior host clipboard value is invalid or exceeds the 4 MiB restoration limit."
    );

    expect(hostClipboard.readText).toHaveBeenCalledTimes(1);
    expect(exercise).not.toHaveBeenCalled();
    expect(hostClipboard.writeText).not.toHaveBeenCalled();
  });
});
