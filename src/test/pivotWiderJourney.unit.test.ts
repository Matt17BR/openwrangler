import { describe, expect, it, vi } from "vitest";
import {
  consumeLayoutCommittedRendererValue,
  reacquireLayoutCommittedRendererTarget
} from "./extensionHost/acknowledgedRenderer";
import { materializeExactPivotWiderCell } from "./extensionHost/pivotWiderJourney";

const sessionId = "11111111-1111-4111-8111-111111111111";
const pendingA = {
  syncId: "a".repeat(32),
  sessionId,
  revision: 4,
  layoutTransitionPending: true
};
const pendingB = { ...pendingA, syncId: "b".repeat(32) };
const committedA = { ...pendingA, layoutTransitionPending: false };
const committedB = { ...pendingB, layoutTransitionPending: false };

function rendererContext(initial: typeof pendingA | typeof pendingB | typeof committedA | typeof committedB) {
  let current = initial;
  return {
    api: {
      panelHydrated: vi.fn(() => true),
      panelSynchronizationReceipt: vi.fn(() => current)
    },
    set(receipt: typeof current) {
      current = receipt;
    }
  };
}

describe("Pivot wider installed preview synchronization", () => {
  it("reveals and reacquires an exact missing output outside the materialized horizontal window", async () => {
    const offscreen = { count: vi.fn(async () => 0), id: "offscreen" };
    const materialized = { count: vi.fn(async () => 1), id: "materialized" };
    let current = offscreen;
    const reveal = vi.fn(async () => {
      current = materialized;
    });

    await expect(materializeExactPivotWiderCell(() => current, reveal)).resolves.toBe(materialized);
    expect(reveal).toHaveBeenCalledOnce();
    expect(offscreen.count).toHaveBeenCalledOnce();
    expect(materialized.count).toHaveBeenCalledOnce();
  });

  it("does not accept an absent or ambiguous cell after its one reveal", async () => {
    for (const count of [0, 2]) {
      const cell = { count: vi.fn(async () => count) };
      const reveal = vi.fn(async () => undefined);
      await expect(materializeExactPivotWiderCell(() => cell, reveal)).rejects.toThrow("exact Pivot wider cell");
      expect(reveal).toHaveBeenCalledTimes(count === 0 ? 1 : 0);
    }
  });

  it("follows pending replacements, then reads the committed receipt once", async () => {
    const context = rendererContext(pendingA);
    const waitFor = vi.fn(async (predicate: () => boolean) => {
      expect(predicate()).toBe(false);
      context.set(pendingB);
      expect(predicate()).toBe(false);
      context.set(committedB);
      expect(predicate()).toBe(true);
    });
    const consume = vi.fn(async (receipt: typeof committedB) => receipt.syncId);

    await expect(consumeLayoutCommittedRendererValue(context.api, sessionId, 4, waitFor, consume)).resolves.toBe(
      committedB.syncId
    );
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith(committedB);
  });

  it("does not read when a committed receipt is replaced before consumption", async () => {
    const context = rendererContext(committedA);
    const waitFor = vi.fn(async (predicate: () => boolean) => {
      expect(predicate()).toBe(true);
      context.set(committedB);
    });
    const consume = vi.fn(async () => "unreachable");

    await expect(consumeLayoutCommittedRendererValue(context.api, sessionId, 4, waitFor, consume)).rejects.toThrow(
      "committed renderer receipt was superseded"
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it("fails when the committed receipt is replaced during its one read", async () => {
    const context = rendererContext(committedA);
    const waitFor = vi.fn(async (predicate: () => boolean) => {
      expect(predicate()).toBe(true);
    });
    const consume = vi.fn(async () => {
      context.set(committedB);
      return "stale value";
    });

    await expect(consumeLayoutCommittedRendererValue(context.api, sessionId, 4, waitFor, consume)).rejects.toThrow(
      "committed renderer receipt was superseded"
    );
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("does not read the DOM when the receipt is replaced during target reacquisition", async () => {
    const context = rendererContext(committedA);
    const waitFor = vi.fn(async (predicate: () => boolean) => {
      expect(predicate()).toBe(true);
    });
    const readCells = vi.fn(async (_target: string) => "unreachable");

    await expect(
      consumeLayoutCommittedRendererValue(context.api, sessionId, 4, waitFor, async (receipt) => {
        const target = await reacquireLayoutCommittedRendererTarget(context.api, sessionId, receipt, async () => {
          context.set(committedB);
          return "replacement app";
        });
        return readCells(target);
      })
    ).rejects.toThrow("committed renderer receipt was superseded during reacquisition");
    expect(readCells).not.toHaveBeenCalled();
  });

  it("does not read when no renderer commits before the deadline", async () => {
    const context = rendererContext(pendingA);
    const waitFor = vi.fn(async (predicate: () => boolean) => {
      expect(predicate()).toBe(false);
      throw new Error("timed out waiting for a committed renderer");
    });
    const consume = vi.fn(async () => "unreachable");

    await expect(consumeLayoutCommittedRendererValue(context.api, sessionId, 4, waitFor, consume)).rejects.toThrow(
      "timed out waiting for a committed renderer"
    );
    expect(consume).not.toHaveBeenCalled();
  });
});
